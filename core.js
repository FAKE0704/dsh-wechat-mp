// dsh-wechat-mp — 微信公众号文章域 dsh 插件的纯语义核（零依赖、零宿主回调）。
//
// 设计纪律（照 dsh-local-llm 的 keyless 先例）：
// - 全部副作用（fetch / 读文件 / 时钟 / 凭据解析）经 opts 注入，纯函数与状态机
//   可直测；index.js 只做工具注册与门控委托。
// - 不依赖 CreatorStack、不依赖 MCP：只认 api.weixin.qq.com（apiBase 可覆盖，测试用）。
// - 凭据只从 dsh 凭据库解析（AppSecret / 可选 AppID），配置里不放明文；
//   token 只在进程内缓存，不落盘、不进日志、不进工具结果。
//
// 已固化的公众号接口坑（来自 CreatorStack 2026-11 实操，勿重新踩）：
// - 草稿接口只认 thumb_media_id（永久素材），thumb_url 传了也会 40007；
// - draft/add 会静默丢弃外域 <img src>，正文图片必须先传素材再改写 src；
// - 素材上传按文件名后缀判类型，URL 末段无扩展名会 40113；
// - 个人主体 freepublish 恒 48001，真发只能后台人工点。

import { readFile as fsReadFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, resolve as resolvePath } from 'node:path'

export const DEFAULT_API_BASE = 'https://api.weixin.qq.com'
export const DEFAULT_SECRET_REF = 'WECHAT_MP_SECRET'
export const DEFAULT_APPID_REF = 'WECHAT_MP_APPID'
export const DEFAULT_TIMEOUT_MS = 20_000
export const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024
export const TOKEN_EXPIRY_MARGIN_MS = 5 * 60 * 1000
export const GATED_TOOL = 'wechat-mp-publish'

const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const TOKEN_INVALID_CODES = new Set([40001, 42001, 40014])
const DRAFT_BATCHGET_MAX = 20

/** 微信接口错误（语义层内部抛出；对外统一转 {ok:false, code, message, hint}）。 */
export class WechatMpError extends Error {
  /**
   * @param {string} code 稳定错误码（wechat_<errcode> / missing_secret / network …）
   * @param {string} message 人读信息
   * @param {string} [hint] 处置建议
   */
  constructor(code, message, hint) {
    super(message)
    this.name = 'WechatMpError'
    this.code = code
    if (hint) this.hint = hint
  }
}

/** 凭据引用名是否合法（环境变量名形态；与 dsh 凭据库 ref 同形）。 */
export function isCredentialRefName(value) {
  return typeof value === 'string' && REF_PATTERN.test(value)
}

/**
 * 解析并校验插件配置（非法即抛——装载期 fail-closed，不静默放行）。
 * @param {unknown} raw cordis 插件行 config
 */
export function resolveConfig(raw) {
  const cfg = (typeof raw === 'object' && raw !== null) ? raw : {}
  const apiBase = normalizeApiBase(cfg.apiBase ?? DEFAULT_API_BASE)
  const appId = typeof cfg.appId === 'string' ? cfg.appId.trim() : ''
  const secretRef = cfg.secretRef ?? DEFAULT_SECRET_REF
  if (!isCredentialRefName(secretRef)) {
    throw new Error(`dsh-wechat-mp: secretRef 必须是环境变量名形态（${REF_PATTERN}），收到 ${JSON.stringify(secretRef)}`)
  }
  const timeoutMs = intInRange(cfg.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, 120_000, 'timeoutMs')
  const maxImageBytes = intInRange(cfg.maxImageBytes, DEFAULT_MAX_IMAGE_BYTES, 64 * 1024, 20 * 1024 * 1024, 'maxImageBytes')
  const impls = (typeof cfg.impls === 'object' && cfg.impls !== null) ? cfg.impls : undefined
  return { apiBase, appId, secretRef, timeoutMs, maxImageBytes, ...(impls ? { impls } : {}) }
}

function normalizeApiBase(raw) {
  const text = String(raw ?? '').trim()
  if (!text) throw new Error('dsh-wechat-mp: apiBase 不能为空')
  let url
  try {
    url = new URL(text)
  } catch {
    throw new Error(`dsh-wechat-mp: apiBase 不是合法 URL：${text}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`dsh-wechat-mp: apiBase 只支持 http/https：${text}`)
  }
  const pathname = url.pathname.replace(/\/+$/, '')
  return `${url.origin}${pathname}`
}

function intInRange(value, fallback, min, max, name) {
  if (value === undefined || value === null) return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`dsh-wechat-mp: ${name} 必须是 ${min}-${max} 的整数，收到 ${JSON.stringify(value)}`)
  }
  return n
}

/** 抽取整页 HTML 的 <body> 内容；已是片段则原样（去首尾空白）。 */
export function extractBody(html) {
  if (typeof html !== 'string') throw new WechatMpError('bad_content', '正文必须是 HTML 字符串')
  const match = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)
  return (match ? match[1] : html).trim()
}

/** AppID 脱敏展示（前 4 + 后 4；短值整体掩码）。 */
export function maskAppId(appId) {
  const text = String(appId ?? '')
  if (!text) return ''
  if (text.length <= 8) return '****'
  return `${text.slice(0, 4)}****${text.slice(-4)}`
}

const EXT_TO_TYPE = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
}
const TYPE_TO_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
}

/**
 * 归一素材文件名/类型：微信按文件名后缀判类型，无后缀或 webp 一律拒绝（不静默猜）。
 * @returns {{filename: string, contentType: string} | null} null = 不支持
 */
export function normalizeImageFile({ filename, contentType } = {}) {
  const name = typeof filename === 'string' ? filename.trim() : ''
  const ctype = typeof contentType === 'string' ? contentType.split(';')[0].trim().toLowerCase() : ''
  const ext = name ? extname(name).toLowerCase() : ''
  if (EXT_TO_TYPE[ext]) return { filename: name, contentType: EXT_TO_TYPE[ext] }
  if (TYPE_TO_EXT[ctype]) {
    const stem = name && ext ? name.slice(0, -ext.length) : (name || 'image')
    return { filename: `${stem}${TYPE_TO_EXT[ctype]}`, contentType: ctype }
  }
  return null
}

/**
 * 微信 errcode → 人读信息 + 处置建议（错误码表来自 CreatorStack 实操记录）。
 * @param {number|string} errcode
 * @param {string} [errmsg]
 */
export function mapWxError(errcode, errmsg) {
  const code = Number(errcode)
  const raw = String(errmsg ?? '').trim()
  const base = `微信接口错误 ${Number.isFinite(code) ? code : errcode}${raw ? `：${raw}` : ''}`
  const table = {
    40013: { message: 'AppID 无效：与公众号后台「开发→基本配置」不一致', hint: '检查插件 config.appId / 凭据 WECHAT_MP_APPID 是否填成了另一个公众号的值' },
    40125: { message: 'AppSecret 不匹配：当前 Secret 与该 AppID 不配对', hint: '在 dsh 设置→凭据中重新保存 WECHAT_MP_SECRET（公众号后台可重置 Secret）' },
    40164: { message: '调用 IP 不在公众号后台白名单', hint: '把微信返回的出口 IP 加入「开发→基本配置→IP 白名单」（错误串里的 IP 就是真实出口 IP）' },
    61004: { message: '调用 IP 不在公众号后台白名单', hint: '把微信返回的出口 IP 加入「开发→基本配置→IP 白名单」（错误串里的 IP 就是真实出口 IP）' },
    40243: { message: 'AppSecret 已被冻结', hint: '在公众号后台解冻或重置 Secret 后更新凭据' },
    48001: { message: '接口未授权：当前公众号主体不支持该接口', hint: '个人主体不支持 freepublish/camel 发布；可先推草稿（wechat-mp-draft-create）再到公众号后台人工发表' },
    45009: { message: '接口调用超过限额', hint: '稍后重试；公众号后台「开发→接口权限」可查看每日额度' },
    40007: { message: 'media_id 无效', hint: '封面需先上传永久素材（thumbFile/thumbUrl 会自动上传）；草稿可能已被删除' },
    40113: { message: '文件类型不支持', hint: '素材图片仅支持 jpg/png/gif/bmp，且文件名要带正确扩展名' },
    45002: { message: '正文超限', hint: '公众号正文不超过 2 万字符且小于 1MB，压缩后再推' },
    40001: { message: 'access_token 失效（插件已自动换新重试一次）', hint: '仍失败请检查 AppSecret 与 IP 白名单' },
    42001: { message: 'access_token 过期（插件已自动换新重试一次）', hint: '仍失败请检查 AppSecret 与 IP 白名单' },
    40014: { message: 'access_token 非法（插件已自动换新重试一次）', hint: '仍失败请检查 AppSecret 与 IP 白名单' },
  }
  const hit = table[code]
  return {
    code: `wechat_${Number.isFinite(code) ? code : 'unknown'}`,
    message: hit ? `${hit.message}（errcode=${code}${raw ? `，${raw}` : ''}）` : base,
    ...(hit?.hint ? { hint: hit.hint } : {}),
  }
}

/**
 * 创建语义核。
 * @param {{
 *   config?: object,
 *   fetchImpl?: typeof fetch,
 *   readFileImpl?: (path: string) => Promise<Uint8Array|string>,
 *   resolveCredential?: (ref: string) => Promise<{value?: string}|string|undefined>,
 *   now?: () => number,
 * }} [opts]
 */
export function createSemantics(opts = {}) {
  const config = (opts.config && typeof opts.config.secretRef === 'string')
    ? opts.config
    : resolveConfig(opts.config ?? {})
  const doFetch = opts.fetchImpl ?? globalThis.fetch
  const readFile = opts.readFileImpl ?? (async (path) => new Uint8Array(await fsReadFile(path)))
  const resolveCredential = opts.resolveCredential ?? (async () => undefined)
  const now = opts.now ?? Date.now
  /** @type {Map<string, {token: string, expiresAt: number}>} */
  const tokenCache = new Map()

  const success = (message, data) => ({ ok: true, message, ...(data ?? {}) })
  const failure = (code, message, hint) => ({ ok: false, code, message, ...(hint ? { hint } : {}) })

  function toFailure(error) {
    if (error instanceof WechatMpError) return failure(error.code, error.message, error.hint)
    const message = error instanceof Error ? error.message : String(error)
    return failure('unexpected', `dsh-wechat-mp 内部错误：${message}`)
  }

  const guard = (impl) => async (args) => {
    try {
      return await impl(args ?? {})
    } catch (error) {
      return toFailure(error)
    }
  }

  // ---- 凭据 ----

  async function appIdValue() {
    if (config.appId) return config.appId
    const resolved = await resolveCredential(DEFAULT_APPID_REF)
    const value = String((resolved && typeof resolved === 'object' ? resolved.value : resolved) ?? '').trim()
    if (!value) {
      throw new WechatMpError('missing_appid', '未配置公众号 AppID', '在插件 config.appId 填写，或在 dsh 设置→凭据中保存 WECHAT_MP_APPID')
    }
    return value
  }

  async function secretValue() {
    const resolved = await resolveCredential(config.secretRef)
    const value = String((resolved && typeof resolved === 'object' ? resolved.value : resolved) ?? '').trim()
    if (!value) {
      throw new WechatMpError('missing_secret', `未配置公众号 AppSecret：凭据 ${config.secretRef} 为空`, '在 dsh 设置→凭据中保存该 Secret（插件只从凭据库读取，配置里不存明文）')
    }
    return value
  }

  // ---- HTTP ----

  function wxError(body) {
    const mapped = mapWxError(body?.errcode, body?.errmsg)
    return new WechatMpError(mapped.code, mapped.message, mapped.hint)
  }

  async function requestJson(url, { method = 'GET', json, form } = {}) {
    const headers = { 'User-Agent': 'dsh-wechat-mp/0.1.0' }
    let body
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(json)
    } else if (form !== undefined) {
      body = form
    }
    let response
    try {
      response = await doFetch(url, { method, headers, body, signal: AbortSignal.timeout(config.timeoutMs) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new WechatMpError('network', `微信接口网络请求失败：${message}`, '检查本机网络、代理与 api.weixin.qq.com 可达性')
    }
    const text = await response.text()
    if (!response.ok) {
      throw new WechatMpError(`http_${response.status}`, `微信接口 HTTP ${response.status}：${text.slice(0, 200)}`, '微信网关异常，稍后重试')
    }
    try {
      return JSON.parse(text)
    } catch {
      throw new WechatMpError('bad_response', `微信响应不是 JSON：${text.slice(0, 200)}`, '可能被网关/代理拦截，检查网络出口')
    }
  }

  async function getToken({ force = false } = {}) {
    const appId = await appIdValue()
    const key = `${config.apiBase}\u0000${appId}`
    const cached = tokenCache.get(key)
    if (!force && cached && cached.expiresAt - TOKEN_EXPIRY_MARGIN_MS > now()) {
      return { appId, key, token: cached.token, expiresAt: cached.expiresAt }
    }
    const secret = await secretValue()
    const body = await requestJson(`${config.apiBase}/cgi-bin/stable_token`, {
      method: 'POST',
      json: { grant_type: 'client_credential', appid: appId, secret, force_refresh: false },
    })
    if (Number(body?.errcode ?? 0) !== 0) throw wxError(body)
    const token = String(body?.access_token ?? '')
    if (!token) {
      throw new WechatMpError('token_missing', '微信未返回 access_token', '检查 AppID/Secret 是否正确、运行机 IP 是否在公众号白名单')
    }
    const expiresIn = Number(body?.expires_in) || 7200
    const expiresAt = now() + Math.max(60, expiresIn) * 1000
    tokenCache.set(key, { token, expiresAt })
    return { appId, key, token, expiresAt }
  }

  async function apiCall(path, { method = 'POST', json, form, query } = {}) {
    let lastAppId = ''
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { appId, key, token } = await getToken({ force: attempt > 0 })
      lastAppId = appId
      const url = new URL(`${config.apiBase}${path}`)
      if (query) {
        for (const [k, v] of Object.entries(query)) {
          if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
        }
      }
      url.searchParams.set('access_token', token)
      const body = await requestJson(url.href, { method, json, form })
      const errcode = Number(body?.errcode ?? 0)
      if (errcode === 0) return { body, appId }
      if (TOKEN_INVALID_CODES.has(errcode) && attempt === 0) {
        tokenCache.delete(key)
        continue
      }
      throw wxError(body)
    }
    throw new WechatMpError('token_retry_exhausted', `access_token 失效且换新重试后仍失败（appId=${maskAppId(lastAppId)}）`, '检查凭据与 IP 白名单')
  }

  // ---- 图片 ----

  async function uploadImage({ bytes, filename, contentType }) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? [])
    if (data.length === 0) throw new WechatMpError('empty_image', '图片内容为空')
    if (data.length > config.maxImageBytes) {
      const limitMb = Math.floor(config.maxImageBytes / 1024 / 1024)
      throw new WechatMpError('image_too_large', `图片超过 ${limitMb}MB 上限`, '压缩后再传（公众号素材图片上限 10MB）')
    }
    const normalized = normalizeImageFile({ filename, contentType })
    if (!normalized) {
      throw new WechatMpError('unsupported_image', `不支持的图片类型：${filename || contentType || '未知'}`, '公众号素材仅支持 jpg/png/gif/bmp；webp 请先转 png/jpg')
    }
    const form = new FormData()
    form.append('media', new Blob([data], { type: normalized.contentType }), normalized.filename)
    const { body } = await apiCall('/cgi-bin/material/add_material', { form, query: { type: 'image' } })
    const mediaId = String(body?.media_id ?? '')
    const url = String(body?.url ?? '')
    if (!mediaId || !url) throw new WechatMpError('upload_missing_fields', '素材上传响应缺少 media_id/url', '微信接口异常，稍后重试')
    return { mediaId, url, filename: normalized.filename }
  }

  function decodeDataUrl(src) {
    const match = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(src)
    if (!match) throw new WechatMpError('bad_data_url', 'data URL 不是 base64 图片（data:image/…;base64,…）')
    const contentType = match[1].toLowerCase()
    const bytes = new Uint8Array(Buffer.from(match[2], 'base64'))
    return { bytes, contentType, filename: `image${TYPE_TO_EXT[contentType] ?? ''}` }
  }

  async function loadImage(src, baseDir) {
    const text = typeof src === 'string' ? src.trim() : ''
    if (!text) throw new WechatMpError('bad_image_src', '图片 src 为空')
    if (/^data:image\//i.test(text)) return decodeDataUrl(text)
    if (/^https?:\/\//i.test(text)) {
      let response
      try {
        response = await doFetch(text, { signal: AbortSignal.timeout(config.timeoutMs) })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new WechatMpError('image_fetch_failed', `图片下载失败：${text}（${message}）`, '检查图片地址是否可访问')
      }
      if (!response.ok) {
        throw new WechatMpError('image_fetch_failed', `图片下载失败：${text}（HTTP ${response.status}）`, '检查图片地址是否可访问')
      }
      const bytes = new Uint8Array(await response.arrayBuffer())
      const contentType = String(response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
      let name = 'image'
      try {
        const pathname = new URL(text).pathname
        name = basename(pathname) || 'image'
      } catch { /* 保留缺省名 */ }
      return { bytes, contentType, filename: name }
    }
    const filePath = isAbsolute(text) ? text : resolvePath(baseDir ?? process.cwd(), text)
    let raw
    try {
      raw = await readFile(filePath)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new WechatMpError('image_read_failed', `读取本地图片失败：${filePath}（${message}）`)
    }
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw)
    return { bytes, contentType: EXT_TO_TYPE[extname(filePath).toLowerCase()] ?? '', filename: basename(filePath) }
  }

  const IMG_SRC_PATTERN = /<img\b[^>]*?\bsrc\s*=\s*"([^"]+)"/gi

  async function localizeImages(html, baseDir) {
    const sources = []
    for (const match of html.matchAll(IMG_SRC_PATTERN)) {
      const src = match[1]
      if (!src || src.includes('mmbiz.qpic.cn') || sources.includes(src)) continue
      sources.push(src)
    }
    let out = html
    const uploaded = []
    for (const src of sources) {
      const image = await loadImage(src, baseDir)
      const up = await uploadImage(image)
      out = out.split(src).join(up.url)
      uploaded.push({ source: src, url: up.url, mediaId: up.mediaId })
    }
    return { html: out, uploaded }
  }

  async function ensureThumb(args, baseDir) {
    const mediaId = strArg(args.thumbMediaId)
    if (mediaId) return { mediaId, uploaded: null }
    const thumbFile = strArg(args.thumbFile)
    if (thumbFile) {
      const up = await uploadImage(await loadImage(thumbFile, baseDir))
      return { mediaId: up.mediaId, uploaded: up }
    }
    const thumbUrl = strArg(args.thumbUrl)
    if (thumbUrl) {
      const up = await uploadImage(await loadImage(thumbUrl, baseDir))
      return { mediaId: up.mediaId, uploaded: up }
    }
    throw new WechatMpError('missing_thumb', '缺少封面：公众号草稿接口要求 thumb_media_id（永久素材）', '提供 thumbMediaId（已有素材）/ thumbFile（本地图片）/ thumbUrl（网络图片，后两者自动上传为永久素材）')
  }

  // ---- 参数小工具 ----

  function strArg(value) {
    return typeof value === 'string' ? value.trim() : ''
  }

  function intArg(value, fallback, min, max, name) {
    if (value === undefined || value === null) return fallback
    const n = Number(value)
    if (!Number.isInteger(n) || n < min || n > max) {
      throw new WechatMpError('bad_arg', `${name} 必须是 ${min}-${max} 的整数，收到 ${JSON.stringify(value)}`)
    }
    return n
  }

  async function resolveContent(args) {
    const content = typeof args.content === 'string' && args.content.trim().length > 0 ? args.content : ''
    const contentFile = strArg(args.contentFile)
    if ((content && contentFile) || (!content && !contentFile)) {
      throw new WechatMpError('content_required', content ? 'content 与 contentFile 只能给一个' : '缺少正文：content（HTML 字符串）或 contentFile（本地文件路径）二选一')
    }
    if (content) return { html: content, baseDir: process.cwd() }
    const filePath = isAbsolute(contentFile) ? contentFile : resolvePath(process.cwd(), contentFile)
    let raw
    try {
      raw = await readFile(filePath)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new WechatMpError('content_read_failed', `读取正文文件失败：${filePath}（${message}）`)
    }
    const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')
    return { html: text, baseDir: dirname(filePath) }
  }

  function buildArticle({ title, body, mediaId, args }) {
    const article = {
      title,
      content: body,
      thumb_media_id: mediaId,
      need_open_comment: args.needOpenComment ? 1 : 0,
      only_fans_can_comment: args.onlyFansCanComment ? 1 : 0,
    }
    const author = strArg(args.author)
    if (author) article.author = author
    const digest = strArg(args.digest)
    if (digest) article.digest = digest
    const sourceUrl = strArg(args.sourceUrl)
    if (sourceUrl) article.content_source_url = sourceUrl
    return article
  }

  async function prepareDraft(args) {
    const title = strArg(args.title)
    if (!title) throw new WechatMpError('missing_title', '缺少标题 title', '公众号标题必填（建议 ≤24 字）')
    const { html, baseDir } = await resolveContent(args)
    const body = extractBody(html)
    if (!body) throw new WechatMpError('empty_content', '正文为空')
    const localized = args.inlineImages === false ? { html: body, uploaded: [] } : await localizeImages(body, baseDir)
    const thumb = await ensureThumb(args, baseDir)
    return { title, body: localized.html, uploaded: localized.uploaded, thumbMediaId: thumb.mediaId, article: buildArticle({ title, body: localized.html, mediaId: thumb.mediaId, args }) }
  }

  // ---- 工具语义 ----

  const status = guard(async () => {
    const { appId, expiresAt } = await getToken()
    const minutes = Math.max(0, Math.round((expiresAt - now()) / 60_000))
    return success(`公众号凭据可用：appId=${maskAppId(appId)}，access_token 约剩 ${minutes} 分钟`, {
      appId: maskAppId(appId),
      apiBase: config.apiBase,
      tokenExpiresAt: new Date(expiresAt).toISOString(),
    })
  })

  const uploadImageTool = guard(async (args) => {
    const sources = ['file', 'url', 'dataUrl'].map((k) => strArg(args[k])).filter(Boolean)
    if (sources.length !== 1) throw new WechatMpError('bad_source', 'file / url / dataUrl 必须且只能给一个')
    const up = await uploadImage(await loadImage(sources[0], process.cwd()))
    return success(`图片已上传为永久素材：media_id=${up.mediaId}`, { mediaId: up.mediaId, url: up.url, filename: up.filename })
  })

  const draftCreate = guard(async (args) => {
    const prepared = await prepareDraft(args)
    const { body } = await apiCall('/cgi-bin/draft/add', { json: { articles: [prepared.article] } })
    const mediaId = String(body?.media_id ?? '')
    if (!mediaId) throw new WechatMpError('draft_missing_media_id', '草稿创建响应缺少 media_id', '微信接口异常，稍后重试')
    const images = prepared.uploaded.length ? `，替换正文图片 ${prepared.uploaded.length} 张` : ''
    return success(`草稿已创建：${prepared.title}（media_id=${mediaId}${images}）`, {
      mediaId,
      title: prepared.title,
      thumbMediaId: prepared.thumbMediaId,
      uploadedImages: prepared.uploaded.map((x) => x.url),
    })
  })

  const draftUpdate = guard(async (args) => {
    const oldMediaId = strArg(args.mediaId)
    if (!oldMediaId) throw new WechatMpError('missing_media_id', '缺少 mediaId', '先用 wechat-mp-draft-list 查目标草稿的 media_id')
    const prepared = await prepareDraft(args)
    // 先建新、再删旧：add 失败时旧草稿仍在（delete+add 顺序会在失败窗口里丢稿）
    const { body } = await apiCall('/cgi-bin/draft/add', { json: { articles: [prepared.article] } })
    const newMediaId = String(body?.media_id ?? '')
    if (!newMediaId) throw new WechatMpError('draft_missing_media_id', '草稿创建响应缺少 media_id', '微信接口异常，稍后重试')
    let removed = true
    let warning
    try {
      await apiCall('/cgi-bin/draft/delete', { json: { media_id: oldMediaId } })
    } catch (error) {
      removed = false
      warning = error instanceof WechatMpError ? `旧草稿删除失败（${error.code}）：草稿箱里可能同时存在新旧两份，可手工删除` : '旧草稿删除失败'
    }
    return success(`草稿已替换：${prepared.title}（新 media_id=${newMediaId}${removed ? `，旧 ${oldMediaId} 已删除` : '，旧草稿未删' }）`, {
      mediaId: newMediaId,
      replacedMediaId: oldMediaId,
      removed,
      ...(warning ? { warning } : {}),
    })
  })

  const draftList = guard(async (args) => {
    const offset = intArg(args.offset, 0, 0, 1_000_000, 'offset')
    const count = intArg(args.count, DRAFT_BATCHGET_MAX, 1, DRAFT_BATCHGET_MAX, 'count')
    const { body } = await apiCall('/cgi-bin/draft/batchget', { json: { offset, count } })
    const items = Array.isArray(body?.item) ? body.item : []
    const list = items.map((item) => {
      const news = Array.isArray(item?.content?.news_item) ? item.content.news_item[0] : undefined
      return {
        mediaId: String(item?.media_id ?? ''),
        title: String(news?.title ?? ''),
        author: String(news?.author ?? ''),
        digest: String(news?.digest ?? ''),
        thumbMediaId: String(news?.thumb_media_id ?? ''),
        updateTime: typeof item?.update_time === 'number' ? new Date(item.update_time * 1000).toISOString() : '',
      }
    })
    const total = Number(body?.total_count ?? list.length) || list.length
    return success(`草稿箱共 ${total} 篇（本页 ${list.length} 篇）`, { total, items: list })
  })

  const draftDelete = guard(async (args) => {
    const mediaId = strArg(args.mediaId)
    if (!mediaId) throw new WechatMpError('missing_media_id', '缺少 mediaId', '先用 wechat-mp-draft-list 查草稿 id')
    await apiCall('/cgi-bin/draft/delete', { json: { media_id: mediaId } })
    return success(`草稿已删除：media_id=${mediaId}`, { mediaId })
  })

  const publish = guard(async (args) => {
    const mediaId = strArg(args.mediaId)
    if (!mediaId) throw new WechatMpError('missing_media_id', '缺少 mediaId', '先建草稿（wechat-mp-draft-create）或从草稿箱列表取 id')
    const { body } = await apiCall('/cgi-bin/freepublish/submit', { json: { media_id: mediaId } })
    const publishId = String(body?.publish_id ?? '')
    if (!publishId) throw new WechatMpError('publish_missing_id', '发布提交响应缺少 publish_id', '微信接口异常，稍后重试')
    return success(`已提交发布：publish_id=${publishId}（异步审核/发布中，用 wechat-mp-publish-status 查结果）`, { publishId, mediaId })
  })

  const PUBLISH_STATE = {
    0: '发布成功',
    1: '发布中',
    2: '原创失败',
    3: '常规失败',
    4: '平台审核不通过',
    5: '用户取消',
    6: '平台取消',
  }

  const publishStatus = guard(async (args) => {
    const publishId = strArg(args.publishId)
    if (!publishId) throw new WechatMpError('missing_publish_id', '缺少 publishId', 'wechat-mp-publish 返回的 publish_id')
    const { body } = await apiCall('/cgi-bin/freepublish/get', { json: { publish_id: publishId } })
    const statusCode = Number(body?.publish_status ?? -1)
    const articleUrl = String(body?.article_detail?.item?.[0]?.article_url ?? '')
    const text = PUBLISH_STATE[statusCode] ?? `未知状态（publish_status=${body?.publish_status ?? '?'}）`
    return success(`发布状态：${text}${articleUrl ? `，文章链接 ${articleUrl}` : ''}`, {
      publishId,
      publishStatus: statusCode,
      statusText: text,
      articleUrl,
      articleId: String(body?.article_id ?? ''),
    })
  })

  return { status, uploadImage: uploadImageTool, draftCreate, draftUpdate, draftList, draftDelete, publish, publishStatus }
}

/**
 * 审批门决策核（纯函数，keyless 单测面）：只有发布提交过门；其余工具不干预。
 * @param {{name?: unknown}} exec
 */
export function decideWechatMpGate(exec) {
  if (typeof exec?.name !== 'string' || exec.name !== GATED_TOOL) return null
  return {
    kind: 'ask',
    reason: 'dsh-wechat-mp: 提交公众号发布（freepublish，发布后对外公开且不可撤销）',
    displayReason: { en: 'dsh-wechat-mp: submit this WeChat article for publication (public and irreversible). Approve?' },
  }
}
