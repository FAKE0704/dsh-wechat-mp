// dsh-wechat-mp — Host 侧设置服务：/api/dsh-wechat-mp 桥，供「设置 → 公众号」页读写配置。
//
// 纪律：
// - AppSecret 只进 dsh 凭据库（ctx.credentials.set/unset），绝不进 config、绝不回传明文；
//   页面上只能看到 describe() 的 { configured, source, masked? } 状态。
// - config 字段（appId/secretRef/apiBase/timeoutMs/maxImageBytes）经 configEditor 写回
//   本插件的 patch 行；普通字段保存后插件重启生效（Loader 语义）。
// - 校验单一真源：core.js 的 resolveConfig（非法值抛错 → 桥返回 {ok:false}）。
// - 桥只做只读/写配置，不执行任何 shell；凭据写入过审批门吗——不需要：UI 路径的授权
//   = 用户在设置页的点击（对齐 dsh-local-llm 的先例）。

import { resolveConfig, isCredentialRefName } from './core.js'

export const WEB_PATH = '/api/dsh-wechat-mp'

const MAX_BODY_BYTES = 1_000_000
const MAX_SECRET_CHARS = 400

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 归一并校验页面可编辑的字段。apiBase/timeoutMs/maxImageBytes 不在设置页开放，
 *  但桥仍接受（恢复/迁移场景需要，且校验单一真源是 resolveConfig）。 */
function normalizePatch(current, args) {
  // 设置页编辑的是默认账号：剥掉 accounts（若有），让旧单账号字段继续作为 default 账号生效
  const base = { ...(typeof current === 'object' && current !== null ? current : {}) }
  delete base.accounts
  const next = { ...base }
  if (args.appId !== undefined) next.appId = typeof args.appId === 'string' ? args.appId.trim() : ''
  if (args.secretRef !== undefined) {
    const ref = String(args.secretRef).trim()
    if (!isCredentialRefName(ref)) throw new Error(`secretRef 必须是环境变量名形态，收到 ${JSON.stringify(args.secretRef)}`)
    next.secretRef = ref
  }
  if (args.apiBase !== undefined) next.apiBase = String(args.apiBase).trim()
  if (args.timeoutMs !== undefined) next.timeoutMs = args.timeoutMs
  if (args.maxImageBytes !== undefined) next.maxImageBytes = args.maxImageBytes
  const validated = resolveConfig(next)
  return {
    appId: validated.appId,
    secretRef: validated.secretRef,
    apiBase: validated.apiBase,
    timeoutMs: validated.timeoutMs,
    maxImageBytes: validated.maxImageBytes,
  }
}

/**
 * @param {{ ctx: unknown, config: object, makeSemantics: (cfg: object) => { status: () => Promise<object> } }} opts
 *   makeSemantics：index.js 传入的语义核工厂（带 fetch/凭据解析等生产注入）
 */
export function createSettingsService({ ctx, config, makeSemantics }) {
  let current = { ...config }
  // 预览暂存区（进程内）：wechat-mp-preview 工具推入，GUI「预览」页拉取与发送。
  // 只留最新一篇；html 不落盘、不进日志。
  let previewState = null

  function pushPreview(payload) {
    previewState = {
      ...(typeof payload === 'object' && payload !== null ? payload : {}),
      pushedAt: new Date().toISOString(),
      sent: false,
      sentMediaId: '',
      sentAt: '',
    }
    return previewState
  }

  async function rpcPreview() {
    if (!previewState || typeof previewState.html !== 'string' || previewState.html === '') {
      return { ok: true, empty: true, message: '暂无预览：让 agent 写完文章后调用 wechat-mp-preview' }
    }
    return { ok: true, empty: false, ...previewState }
  }

  async function rpcGet() {
    let secretInfo = { configured: false }
    try {
      const desc = await ctx.credentials.describe(current.secretRef)
      secretInfo = {
        configured: desc?.configured === true,
        source: desc?.source ?? null,
        masked: desc?.masked ?? null,
      }
    } catch (error) {
      secretInfo = { configured: false, error: messageOf(error) }
    }
    let appidFromCredential = false
    try {
      const hit = await ctx.credentials.resolve('WECHAT_MP_APPID')
      appidFromCredential = Boolean(hit && String(hit.value ?? '').trim() !== '')
    } catch { /* 凭据库不可用不致命 */ }
    return {
      ok: true,
      appId: current.appId,
      appidFromCredential,
      secretRef: current.secretRef,
      secret: secretInfo,
      apiBase: current.apiBase,
      timeoutMs: current.timeoutMs,
      maxImageBytes: current.maxImageBytes,
    }
  }

  async function rpcSave(args) {
    const entry = ctx.fiber?.entry
    const editor = ctx.get?.('configEditor')
    if (entry === undefined || editor === undefined) {
      return { ok: false, message: '当前宿主没有 configEditor——请在 cordis.patch.yml 手工编辑本插件 config' }
    }
    let patch
    try {
      patch = normalizePatch(current, args ?? {})
    } catch (error) {
      return { ok: false, message: `配置校验失败：${messageOf(error)}` }
    }
    await editor.edit(entry, (raw) => ({
      ...(typeof raw === 'object' && raw !== null ? raw : {}),
      appId: patch.appId,
      secretRef: patch.secretRef,
      apiBase: patch.apiBase,
      timeoutMs: patch.timeoutMs,
      maxImageBytes: patch.maxImageBytes,
    }))
    current = patch
    return { ok: true, message: '配置已保存（插件重启后生效）。AppSecret 不在配置里——用「保存 Secret」写入凭据库。', config: patch }
  }

  async function rpcSetSecret(args) {
    const secret = typeof args?.secret === 'string' ? args.secret.trim() : ''
    if (!secret) return { ok: false, message: 'AppSecret 为空——粘贴公众号后台「开发→基本配置→开发者密码」里的 Secret' }
    if (secret.length > MAX_SECRET_CHARS) return { ok: false, message: `AppSecret 过长（>${MAX_SECRET_CHARS} 字符）` }
    try {
      await ctx.credentials.set(current.secretRef, secret)
    } catch (error) {
      return { ok: false, message: `凭据写入失败：${messageOf(error)}`, hint: '空值无法存储；请粘贴完整 Secret' }
    }
    return { ok: true, message: `AppSecret 已保存到凭据库 ${current.secretRef}（不进配置、不进日志）` }
  }

  async function rpcClearSecret() {
    try {
      await ctx.credentials.unset(current.secretRef)
    } catch (error) {
      return { ok: false, message: `凭据删除失败：${messageOf(error)}` }
    }
    return { ok: true, message: `凭据 ${current.secretRef} 已删除` }
  }

  async function rpcTest(args) {
    // 测试用「当前编辑值」组一份临时语义核：save 之后插件重启才生效，
    // 但用户常先填 AppID 再点测试——不能让测试拿旧 config 误报「未配置」。
    const merged = { ...current }
    if (args?.appId !== undefined) merged.appId = String(args.appId).trim()
    let cfg
    try {
      cfg = resolveConfig(merged)
    } catch (error) {
      return { ok: false, message: `配置校验失败：${messageOf(error)}` }
    }
    const sem = makeSemantics(cfg)
    return sem.status()
  }

  async function rpcSend(args) {
    if (!previewState || typeof previewState.html !== 'string' || previewState.html === '') {
      return { ok: false, message: '暂无待发送的预览：先在会话里让 agent 调用 wechat-mp-preview' }
    }
    if (previewState.sent) {
      return { ok: false, message: `这篇预览已推送过草稿箱（media_id=${previewState.sentMediaId}，${previewState.sentAt}）；要重发请让 agent 重新调用 wechat-mp-preview` }
    }
    const cover = previewState.thumbMediaId || args?.thumbMediaId || previewState.thumbFile || args?.thumbFile || previewState.thumbUrl || args?.thumbUrl || ''
    if (!cover) {
      return { ok: false, message: '封面缺失：草稿接口必填封面。在预览页填「封面（本地路径 / 图片 URL / 素材 id 三选一）」后重试，或让 agent 重新预览时带 thumbFile/thumbUrl/thumbMediaId' }
    }
    const sem = makeSemantics({ ...current })
    const res = await sem.draftCreate({
      title: previewState.title,
      content: previewState.html,
      author: previewState.author || undefined,
      digest: previewState.digest || undefined,
      sourceUrl: previewState.sourceUrl || undefined,
      thumbMediaId: args?.thumbMediaId || previewState.thumbMediaId || undefined,
      thumbFile: args?.thumbFile || previewState.thumbFile || undefined,
      thumbUrl: args?.thumbUrl || previewState.thumbUrl || undefined,
      account: previewState.account || args?.account || undefined,
      inlineImages: previewState.inlineImages !== false,
      needOpenComment: previewState.needOpenComment === true,
      onlyFansCanComment: previewState.onlyFansCanComment === true,
    })
    if (res?.ok === true && res.mediaId) {
      previewState.sent = true
      previewState.sentMediaId = String(res.mediaId)
      previewState.sentAt = new Date().toISOString()
    }
    return res
  }

  // ---- 用户自主操作：预览来源不依赖 agent ----
  // loadDraft：从公众号草稿箱拉一篇详情进预览；loadFile：读本地 Markdown/HTML 文件进预览。
  // 都走 makeSemantics（读当前 config），凭据缺失/网络失败会以 {ok:false,message,hint} 返回。

  async function rpcDraftList(args) {
    const sem = makeSemantics({ ...current })
    return sem.draftList({ offset: args?.offset, count: args?.count, account: args?.account })
  }

  async function rpcLoadDraft(args) {
    const mediaId = typeof args?.mediaId === 'string' ? args.mediaId.trim() : ''
    if (!mediaId) return { ok: false, message: '缺少 mediaId：先「拉取草稿列表」再选一篇' }
    const sem = makeSemantics({ ...current })
    const res = await sem.draftGet({ mediaId, account: args?.account })
    if (res?.ok !== true || typeof res.content !== 'string' || res.content === '') return res
    pushPreview({
      title: res.title || '(无标题)',
      html: res.content,
      author: res.author || '',
      digest: res.digest || '',
      sourceUrl: res.sourceUrl || '',
      thumbMediaId: res.thumbMediaId || '',
      thumbFile: '',
      thumbUrl: '',
      account: args?.account || '',
      inlineImages: true,
      needOpenComment: false,
      onlyFansCanComment: false,
      source: `草稿箱 ${mediaId}`,
    })
    return { ok: true, message: `已加载草稿进预览：${res.title || mediaId}` }
  }

  async function rpcLoadFile(args) {
    const file = typeof args?.file === 'string' ? args.file.trim() : ''
    if (!file) return { ok: false, message: '缺少文件路径：支持 .md / .markdown / .txt（按 Markdown 渲染）与 .html（直读正文）' }
    const isHtml = /\.html?$/i.test(file)
    const sem = makeSemantics({ ...current })
    const res = await sem.preview(isHtml
      ? { contentFile: file, title: args?.title }
      : { mdFile: file, title: args?.title })
    if (res?.ok !== true) return res
    pushPreview({
      title: res.title,
      html: res.html,
      author: res.author || '',
      digest: res.digest || '',
      sourceUrl: res.sourceUrl || '',
      thumbMediaId: res.thumbMediaId || '',
      thumbFile: res.thumbFile || '',
      thumbUrl: res.thumbUrl || '',
      account: '',
      inlineImages: true,
      needOpenComment: false,
      onlyFansCanComment: false,
      source: `文件 ${file}`,
    })
    return { ok: true, message: `已加载文件进预览：${res.title}（${res.chars} 字符）` }
  }

  const METHODS = {
    get: rpcGet,
    save: rpcSave,
    setSecret: rpcSetSecret,
    clearSecret: rpcClearSecret,
    test: rpcTest,
    preview: rpcPreview,
    send: rpcSend,
    draftList: rpcDraftList,
    loadDraft: rpcLoadDraft,
    loadFile: rpcLoadFile,
  }

  function handleRequest(req, res) {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' })
      res.end()
      return
    }
    // 同源守卫（对齐 dsh-local-llm/dsh-ship）：带 Origin 的请求必须指向本服务 host
    const origin = req.headers.origin
    const host = req.headers.host
    if (origin !== undefined && host !== undefined) {
      try {
        if (new URL(origin).host !== host) {
          res.writeHead(403)
          res.end()
          return
        }
      } catch {
        res.writeHead(403)
        res.end()
        return
      }
    }
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > MAX_BODY_BYTES) req.destroy()
    })
    req.on('end', async () => {
      let rpc = null
      try { rpc = body === '' ? {} : JSON.parse(body) } catch { rpc = null }
      const fn = rpc !== null && typeof rpc.method === 'string' ? METHODS[rpc.method] : undefined
      let payload
      if (fn === undefined) {
        payload = { ok: false, message: `未知方法（支持：${Object.keys(METHODS).join(' / ')}）` }
      } else {
        try {
          payload = await fn(rpc.args ?? {})
        } catch (error) {
          payload = { ok: false, message: messageOf(error) }
        }
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(payload ?? { ok: false, message: '空响应' }))
    })
  }

  return { WEB_PATH, handleRequest, pushPreview, rpcInvoke: (method, args) => (METHODS[method] ?? (() => ({ ok: false, message: '未知方法' })))((args ?? {})) }
}
