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

import { readFile as fsReadFile, writeFile as fsWriteFile, mkdir as fsMkdir } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, resolve as resolvePath } from 'node:path'
import { renderMarkdown, extractFrontmatter } from './render.js'

export const DEFAULT_API_BASE = 'https://api.weixin.qq.com'
export const DEFAULT_SECRET_REF = 'WECHAT_MP_SECRET'
export const DEFAULT_APPID_REF = 'WECHAT_MP_APPID'
export const DEFAULT_TIMEOUT_MS = 20_000
export const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024
export const TOKEN_EXPIRY_MARGIN_MS = 5 * 60 * 1000
export const GATED_TOOL = 'wechat-mp-publish'

// ---- 正文预检（V0.3.0）----
export const PRECHECK_MAX_CHARS = 20_000
export const PRECHECK_MAX_BYTES = 1024 * 1024
export const PRECHECK_IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'bmp']
export const DATA_URL_MIME_TO_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/webp': 'webp',
}

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
 * 归一并校验插件配置（非法即抛——装载期 fail-closed，不静默放行）。
 * 支持多账号（V0.3.0）：cfg.accounts = [{ name, appId?, secretRef? }, …]；
 * 向后兼容旧单账号 config（appId/secretRef 视为一个名为 default 的账号）。
 * @param {unknown} raw cordis 插件行 config
 */
export function resolveConfig(raw) {
  const cfg = (typeof raw === 'object' && raw !== null) ? raw : {}
  const apiBase = normalizeApiBase(cfg.apiBase ?? DEFAULT_API_BASE)
  const timeoutMs = intInRange(cfg.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, 120_000, 'timeoutMs')
  const maxImageBytes = intInRange(cfg.maxImageBytes, DEFAULT_MAX_IMAGE_BYTES, 64 * 1024, 20 * 1024 * 1024, 'maxImageBytes')
  const accounts = resolveAccounts(cfg)
  const impls = (typeof cfg.impls === 'object' && cfg.impls !== null) ? cfg.impls : undefined
  return {
    apiBase, timeoutMs, maxImageBytes,
    // 兼容面：旧字段继续暴露（= 第一个账号），settings.js / 旧调用方不受影响
    appId: accounts[0].appId,
    secretRef: accounts[0].secretRef,
    accounts,
    ...(impls ? { impls } : {}),
  }
}

/** 归一账号列表：显式 accounts 优先；否则旧单账号字段折成一个 default 账号。 */
export function resolveAccounts(cfg) {
  const rawList = Array.isArray(cfg?.accounts) ? cfg.accounts : undefined
  const list = rawList ?? [{
    name: 'default',
    appId: typeof cfg?.appId === 'string' ? cfg.appId.trim() : '',
    secretRef: cfg?.secretRef ?? DEFAULT_SECRET_REF,
  }]
  const seen = new Set()
  return list.map((item, index) => {
    const name = typeof item?.name === 'string' && item.name.trim() ? item.name.trim() : (rawList ? '' : 'default')
    if (rawList && !name) {
      throw new Error(`dsh-wechat-mp: accounts[${index}].name 必填（非空字符串）`)
    }
    if (seen.has(name)) throw new Error(`dsh-wechat-mp: 账号名重复：${JSON.stringify(name)}`)
    seen.add(name)
    const appId = typeof item?.appId === 'string' ? item.appId.trim() : ''
    let secretRef = typeof item?.secretRef === 'string' ? item.secretRef.trim() : ''
    if (!secretRef) {
      secretRef = name === 'default' ? DEFAULT_SECRET_REF : `WECHAT_MP_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_SECRET`
    }
    if (!isCredentialRefName(secretRef)) {
      throw new Error(`dsh-wechat-mp: 账号 ${name} 的 secretRef 必须是环境变量名形态（${REF_PATTERN}），收到 ${JSON.stringify(item?.secretRef)}`)
    }
    return { name, appId, secretRef }
  })
}

/**
 * 正文预检（V0.3.0）：字符数 / 体积 / 图片格式白名单。
 * 纯函数。issues 分两级：level 'error' = 必须处置（超限/未知格式），
 * level 'warn' = 可自动处置（webp：装了 sharp 会自动转 jpg）。
 * @returns {{ok: boolean, chars: number, bytes: number, issues: Array<{level:string,code:string,message:string,hint?:string}>, images: Array<{src:string,ext:string,ok:boolean}>}}
 */
export function precheckContent(html) {
  const text = typeof html === 'string' ? html : ''
  const plain = text.replace(/<[^>]*>/g, '')
  const chars = [...plain].length
  const bytes = Buffer.byteLength(text, 'utf8')
  const issues = []
  const images = []
  if (chars > PRECHECK_MAX_CHARS) {
    issues.push({
      level: 'error', code: 'chars_over_limit',
      message: `正文字符数 ${chars} 超过公众号上限 ${PRECHECK_MAX_CHARS}`,
      hint: `删减约 ${chars - PRECHECK_MAX_CHARS} 字符后再推（45002 就是这个原因）`,
    })
  }
  if (bytes >= PRECHECK_MAX_BYTES) {
    issues.push({
      level: 'error', code: 'bytes_over_limit',
      message: `正文体积 ${(bytes / 1024 / 1024).toFixed(2)}MB 超过公众号上限 ${PRECHECK_MAX_BYTES / 1024 / 1024}MB`,
      hint: '压缩图片、拆分章节后再推',
    })
  }
  const srcRe = /<img\b[^>]*?\bsrc\s*=\s*"([^"]+)"/gi
  for (const match of text.matchAll(srcRe)) {
    const src = match[1]
    const ext = imageSrcExtension(src)
    const ok = PRECHECK_IMAGE_EXTENSIONS.includes(ext)
    images.push({ src, ext, ok })
    if (!ok) {
      if (ext === 'webp') {
        issues.push({
          level: 'warn', code: 'image_webp',
          message: `正文含 webp 图片：${src}`,
          hint: '安装可选依赖 sharp（bun add sharp / npm i sharp）后 draft-create 会自动转 jpg；否则请手工转成 jpg/png',
        })
      } else {
        issues.push({
          level: 'error', code: `image_bad_format${ext ? `_${ext}` : ''}`,
          message: `正文图片格式不在白名单（jpg/jpeg/png/gif/bmp）：${src}${ext ? `（识别为 ${ext}）` : '（无法识别格式）'}`,
          hint: ext === 'svg' ? '公众号不支持 svg，转成 png/jpg' : '转成 jpg/png/gif/bmp 且文件名带扩展名',
        })
      }
    }
  }
  return { ok: issues.every((x) => x.level !== 'error'), chars, bytes, issues, images }
}

/** 从图片 src 猜扩展名（URL 路径 / data URL mime）。猜不出返回 ''。 */
export function imageSrcExtension(src) {
  const text = String(src ?? '')
  const data = /^data:image\/([a-z0-9.+-]+)[;,]/i.exec(text)
  if (data) return (DATA_URL_MIME_TO_EXT[data[1].toLowerCase()] ?? data[1].toLowerCase()).replace('jpeg', 'jpg')
  let pathname = text
  try { pathname = new URL(text, 'http://placeholder.invalid').pathname } catch { /* 相对路径原样 */ }
  const ext = extname(pathname).toLowerCase().replace(/^\./, '').replace('jpeg', 'jpg')
  return /^[a-z0-9]{1,5}$/.test(ext) ? ext : ''
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
    40013: { message: 'AppID 无效：与公众号后台「开发→基本配置」不一致', hint: '在「设置 → 公众号」核对 AppID（或凭据 WECHAT_MP_APPID）是否填成了另一个公众号的值' },
    40125: { message: 'AppSecret 不匹配：当前 Secret 与该 AppID 不配对', hint: '在「设置 → 公众号」重新保存 AppSecret（公众号后台可重置 Secret）' },
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
 *   writeFileImpl?: (path: string, data: string|Uint8Array) => Promise<void>,
 *   mkdirImpl?: (dir: string) => Promise<void>,
 *   convertWebpImpl?: (input: {bytes: Uint8Array, filename: string}) => Promise<{bytes: Uint8Array, filename: string, contentType: string}>,
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
  const writeFile = opts.writeFileImpl ?? (async (path, data) => { await fsWriteFile(path, data) })
  const mkdir = opts.mkdirImpl ?? (async (dir) => { await fsMkdir(dir, { recursive: true }) })
  const convertWebp = opts.convertWebpImpl ?? defaultConvertWebp
  const shrinkImage = opts.shrinkImageImpl ?? defaultShrinkImage
  const resolveCredential = opts.resolveCredential ?? (async () => undefined)
  const now = opts.now ?? Date.now
  /** @type {Map<string, {token: string, expiresAt: number}>} */
  const tokenCache = new Map()
  // 账号表（多账号）：resolveConfig 已归一；兜底一份旧形态
  const accounts = Array.isArray(config.accounts) && config.accounts.length
    ? config.accounts
    : [{ name: 'default', appId: config.appId ?? '', secretRef: config.secretRef ?? DEFAULT_SECRET_REF }]

  const success = (message, data) => ({ ok: true, message, ...(data ?? {}) })
  const failure = (code, message, hint) => ({ ok: false, code, message, ...(hint ? { hint } : {}) })

  function toFailure(error) {
    if (error instanceof WechatMpError) return failure(error.code, error.message, error.hint)
    const message = error instanceof Error ? error.message : String(error)
    return failure('unexpected', `dsh-wechat-mp 内部错误：${message}`)
  }

  const guard = (impl) => async (args, call) => {
    try {
      return await impl(args ?? {}, call)
    } catch (error) {
      return toFailure(error)
    }
  }

  /**
   * 会话工作目录锚定：index.js 经 working-directory 服务解析 exec.agent 的会话目录，
   * 以 call.anchor 传入；服务缺失/测试注入时回退进程 cwd。
   */
  function cwdOf(call) {
    return typeof call?.anchor === 'string' && isAbsolute(call.anchor) ? call.anchor : process.cwd()
  }

  // ---- 凭据（多账号：args.account 选账号，缺省第一个） ----

  /** 按名字选账号；缺省 = 第一个（旧单账号即 default）。未知名字明确报错并列出可用账号。 */
  function pickAccount(args) {
    const wanted = typeof args?.account === 'string' ? args.account.trim() : ''
    if (!wanted) return accounts[0]
    const hit = accounts.find((a) => a.name === wanted)
    if (!hit) {
      throw new WechatMpError('unknown_account', `未知公众号账号：${JSON.stringify(wanted)}`, `可用账号：${accounts.map((a) => a.name).join('、')}`)
    }
    return hit
  }

  async function appIdValue(account) {
    if (account.appId) return account.appId
    const resolved = await resolveCredential(account.appIdRef ?? DEFAULT_APPID_REF)
    const value = String((resolved && typeof resolved === 'object' ? resolved.value : resolved) ?? '').trim()
    if (!value) {
      throw new WechatMpError('missing_appid', `未配置公众号 AppID（账号 ${account.name}）`, '打开「设置 → 公众号」填写 AppID，或在凭据中保存 WECHAT_MP_APPID')
    }
    return value
  }

  async function secretValue(account) {
    const resolved = await resolveCredential(account.secretRef)
    const value = String((resolved && typeof resolved === 'object' ? resolved.value : resolved) ?? '').trim()
    if (!value) {
      throw new WechatMpError('missing_secret', `未配置公众号 AppSecret（账号 ${account.name}）：凭据 ${account.secretRef} 为空`, '打开「设置 → 公众号」粘贴并保存 AppSecret（插件只从凭据库读取，配置里不存明文）')
    }
    return value
  }

  // ---- HTTP ----

  function wxError(body) {
    const mapped = mapWxError(body?.errcode, body?.errmsg)
    return new WechatMpError(mapped.code, mapped.message, mapped.hint)
  }

  async function requestJson(url, { method = 'GET', json, form } = {}) {
    const headers = { 'User-Agent': 'dsh-wechat-mp/0.3.0' }
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

  async function getToken({ account, force = false } = {}) {
    const acct = account ?? accounts[0]
    const appId = await appIdValue(acct)
    // token 缓存按账号隔离（apiBase + 账号名 + appId）
    const key = `${config.apiBase}\u0000${acct.name}\u0000${appId}`
    const cached = tokenCache.get(key)
    if (!force && cached && cached.expiresAt - TOKEN_EXPIRY_MARGIN_MS > now()) {
      return { appId, key, token: cached.token, expiresAt: cached.expiresAt }
    }
    const secret = await secretValue(acct)
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

  async function apiCall(path, { method = 'POST', json, form, query } = {}, account) {
    let lastAppId = ''
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { appId, key, token } = await getToken({ account, force: attempt > 0 })
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

  // ---- webp → jpg（可选依赖 sharp；缺失时明确报错，不做硬依赖） ----

  /** webp 侦测：magic bytes 优先，其次扩展名/content-type。 */
  function isWebp({ bytes, filename, contentType }) {
    if (bytes instanceof Uint8Array && bytes.length > 12
      && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
      && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return true
    if (String(contentType ?? '').toLowerCase() === 'image/webp') return true
    return extname(String(filename ?? '')).toLowerCase() === '.webp'
  }

  /** 缺省转换实现：动态 import('sharp')——装了就自动转 jpg，没装明确报错提示安装。 */
  async function defaultConvertWebp({ bytes, filename }) {
    let sharp
    try {
      sharp = (await import('sharp')).default
    } catch {
      throw new WechatMpError('webp_convert_unavailable',
        'webp 图片需要转换成 jpg，但可选依赖 sharp 未安装',
        '安装一次即可：bun add sharp（或 npm i sharp）；或先把 webp 手工转成 jpg/png 再传')
    }
    const stem = basename(String(filename || 'image')).replace(/\.webp$/i, '') || 'image'
    const jpeg = await sharp(Buffer.from(bytes)).jpeg({ quality: 90 }).toBuffer()
    return { bytes: new Uint8Array(jpeg), filename: `${stem}.jpg`, contentType: 'image/jpeg' }
  }

  /** gif 会丢动画、bmp 转码无收益——这两类不自动压缩；其余格式（jpg/png/webp/未知）都可试。 */
  function shrinkable(image) {
    const kind = String(image?.contentType ?? '').toLowerCase()
    const name = String(image?.filename ?? '').toLowerCase()
    return !(kind === 'image/gif' || kind === 'image/bmp' || /\.gif$|\.bmp$/i.test(name))
  }

  /** 缺省大图压缩实现：动态 import('sharp')——>10MB 时降采样+降质转 jpg，失败返回 null。 */
  async function defaultShrinkImage({ bytes, filename, contentType }) {
    let sharp
    try {
      sharp = (await import('sharp')).default
    } catch {
      return null
    }
    const stem = basename(String(filename || 'image')).replace(/\.(jpe?g|png|webp)$/i, '') || 'image'
    for (const quality of [85, 70, 60]) {
      const out = await sharp(Buffer.from(bytes))
        .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality })
        .toBuffer()
      if (out.length <= config.maxImageBytes) {
        return { bytes: new Uint8Array(out), filename: `${stem}.jpg`, contentType: 'image/jpeg', compressedFromBytes: bytes.length }
      }
    }
    return null
  }

  /** 上传前归一：webp 自动转 jpg（转换器可用时），其余原样。 */
  async function normalizeForUpload(image) {
    if (!isWebp(image)) return image
    const converted = await convertWebp({ bytes: image.bytes, filename: image.filename || 'image.webp' })
    return { ...image, ...converted }
  }

  async function uploadImage(image, account) {
    let payload = image
    // 超限先尝试自动压缩（sharp 可用时；gif 会丢动画、bmp 无收益，不压）；压缩抛错也
    // 只当作「不可压缩」处理，回落到原始超限错误，不掩盖真实失败原因
    if (payload.bytes.length > config.maxImageBytes && shrinkable(payload)) {
      let shrunk = null
      try {
        shrunk = await shrinkImage(payload)
      } catch { /* 当作不可压缩 */ }
      if (shrunk) payload = { ...payload, ...shrunk }
    }
    const data = payload.bytes instanceof Uint8Array ? payload.bytes : new Uint8Array(payload.bytes ?? [])
    if (data.length === 0) throw new WechatMpError('empty_image', '图片内容为空')
    if (data.length > config.maxImageBytes) {
      const limitMb = Math.floor(config.maxImageBytes / 1024 / 1024)
      throw new WechatMpError('image_too_large', `图片超过 ${limitMb}MB 上限`, '压缩后再传（公众号素材图片上限 10MB）；安装可选依赖 sharp 后插件会自动压缩')
    }
    const normalized = normalizeImageFile({ filename: payload.filename, contentType: payload.contentType })
    if (!normalized) {
      throw new WechatMpError('unsupported_image', `不支持的图片类型：${payload.filename || payload.contentType || '未知'}`, '公众号素材仅支持 jpg/png/gif/bmp；webp 请先转 png/jpg')
    }
    const form = new FormData()
    form.append('media', new Blob([data], { type: normalized.contentType }), normalized.filename)
    const { body } = await apiCall('/cgi-bin/material/add_material', { form, query: { type: 'image' } }, account)
    const mediaId = String(body?.media_id ?? '')
    const url = String(body?.url ?? '')
    if (!mediaId || !url) throw new WechatMpError('upload_missing_fields', '素材上传响应缺少 media_id/url', '微信接口异常，稍后重试')
    return {
      mediaId,
      url,
      filename: normalized.filename,
      ...(payload.compressedFromBytes ? { compressedFromBytes: payload.compressedFromBytes, compressedToBytes: data.length } : {}),
    }
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

  async function localizeImages(html, baseDir, account) {
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
      const up = await uploadImage(await normalizeForUpload(image), account)
      out = out.split(src).join(up.url)
      uploaded.push({ source: src, url: up.url, mediaId: up.mediaId })
    }
    return { html: out, uploaded }
  }

  async function ensureThumb(args, baseDir, account) {
    const mediaId = strArg(args.thumbMediaId)
    if (mediaId) return { mediaId, uploaded: null }
    const thumbFile = strArg(args.thumbFile)
    if (thumbFile) {
      const up = await uploadImage(await normalizeForUpload(await loadImage(thumbFile, baseDir)), account)
      return { mediaId: up.mediaId, uploaded: up }
    }
    const thumbUrl = strArg(args.thumbUrl)
    if (thumbUrl) {
      const up = await uploadImage(await normalizeForUpload(await loadImage(thumbUrl, baseDir)), account)
      return { mediaId: up.mediaId, uploaded: up }
    }
    throw new WechatMpError('missing_thumb', '缺少封面：公众号草稿接口要求 thumb_media_id（永久素材）', '提供 thumbMediaId（已有素材）/ thumbFile（本地图片）/ thumbUrl（网络图片，后两者自动上传为永久素材）')
  }

  /** 读一篇草稿的封面 thumb_media_id；草稿已删/接口失败等读不到的情况返回 ''。 */
  async function fetchDraftThumb(mediaId, account) {
    try {
      const { body } = await apiCall('/cgi-bin/draft/get', { json: { media_id: mediaId } }, account)
      const news = Array.isArray(body?.news_item) ? body.news_item[0] : undefined
      return String(news?.thumb_media_id ?? '')
    } catch {
      return ''
    }
  }

  /** 分页扫草稿箱：是否仍有草稿（排除 exclude 集合里的 media_id）引用该封面素材。 */
  async function draftThumbInUse(thumbMediaId, account, exclude) {
    for (let page = 0, offset = 0; page < 250; page += 1, offset += DRAFT_BATCHGET_MAX) {
      const { body } = await apiCall('/cgi-bin/draft/batchget', { json: { offset, count: DRAFT_BATCHGET_MAX } }, account)
      const items = Array.isArray(body?.item) ? body.item : []
      for (const item of items) {
        if (exclude.has(String(item?.media_id ?? ''))) continue
        const newsItems = Array.isArray(item?.content?.news_item) ? item.content.news_item : []
        if (newsItems.some((n) => String(n?.thumb_media_id ?? '') === thumbMediaId)) return true
      }
      const total = Number(body?.total_count ?? 0) || 0
      if (items.length === 0 || offset + items.length >= total) return false
    }
    return false
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

  async function resolveContent(args, call) {
    const content = typeof args.content === 'string' && args.content.trim().length > 0 ? args.content : ''
    const contentFile = strArg(args.contentFile)
    if ((content && contentFile) || (!content && !contentFile)) {
      throw new WechatMpError('content_required', content ? 'content 与 contentFile 只能给一个' : '缺少正文：content（HTML 字符串）或 contentFile（本地文件路径）二选一')
    }
    if (content) return { html: content, baseDir: cwdOf(call) }
    const filePath = isAbsolute(contentFile) ? contentFile : resolvePath(cwdOf(call), contentFile)
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

  async function prepareDraft(args, call) {
    const title = strArg(args.title)
    if (!title) throw new WechatMpError('missing_title', '缺少标题 title', '公众号标题必填（建议 ≤24 字）')
    const { html, baseDir } = await resolveContent(args, call)
    const body = extractBody(html)
    if (!body) throw new WechatMpError('empty_content', '正文为空')
    // fail-fast 预检（error 级问题直接拒，省一轮草稿往返；warn 级 webp 交给自动转换）
    const report = precheckContent(body)
    const errors = report.issues.filter((x) => x.level === 'error')
    if (errors.length > 0) {
      throw new WechatMpError('precheck_failed',
        `正文预检未通过：${errors[0].message}`,
        errors.map((x) => x.hint).filter(Boolean).join('；') || '按提示处置正文后重试')
    }
    const account = pickAccount(args)
    const localized = args.inlineImages === false ? { html: body, uploaded: [] } : await localizeImages(body, baseDir, account)
    const thumb = await ensureThumb(args, baseDir, account)
    return { title, body: localized.html, uploaded: localized.uploaded, thumbMediaId: thumb.mediaId, article: buildArticle({ title, body: localized.html, mediaId: thumb.mediaId, args }) }
  }

  // ---- 工具语义 ----

  const status = guard(async (args) => {
    const account = pickAccount(args)
    const { appId, expiresAt } = await getToken({ account })
    const minutes = Math.max(0, Math.round((expiresAt - now()) / 60_000))
    return success(`公众号凭据可用：appId=${maskAppId(appId)}，access_token 约剩 ${minutes} 分钟`, {
      appId: maskAppId(appId),
      apiBase: config.apiBase,
      tokenExpiresAt: new Date(expiresAt).toISOString(),
    })
  })

  const uploadImageTool = guard(async (args, call) => {
    const sources = ['file', 'url', 'dataUrl'].map((k) => strArg(args[k])).filter(Boolean)
    if (sources.length !== 1) throw new WechatMpError('bad_source', 'file / url / dataUrl 必须且只能给一个')
    const account = pickAccount(args)
    const up = await uploadImage(await normalizeForUpload(await loadImage(sources[0], cwdOf(call))), account)
    const compressedNote = up.compressedFromBytes
      ? `（原图 ${(up.compressedFromBytes / 1024 / 1024).toFixed(1)}MB 超限，已自动压缩为 ${Math.max(1, Math.round(up.compressedToBytes / 1024))}KB jpg）`
      : ''
    return success(`图片已上传为永久素材：media_id=${up.mediaId}${compressedNote}`, {
      mediaId: up.mediaId,
      url: up.url,
      filename: up.filename,
      ...(up.compressedFromBytes ? { compressedFromBytes: up.compressedFromBytes, compressedToBytes: up.compressedToBytes } : {}),
    })
  })

  const draftCreate = guard(async (args, call) => {
    const prepared = await prepareDraft(args, call)
    const { body } = await apiCall('/cgi-bin/draft/add', { json: { articles: [prepared.article] } }, pickAccount(args))
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

  const draftUpdate = guard(async (args, call) => {
    const oldMediaId = strArg(args.mediaId)
    if (!oldMediaId) throw new WechatMpError('missing_media_id', '缺少 mediaId', '先用 wechat-mp-draft-list 查目标草稿的 media_id')
    const title = strArg(args.title)
    if (!title) throw new WechatMpError('missing_title', '缺少标题 title', '公众号标题必填（建议 ≤24 字）')
    const account = pickAccount(args)
    // 封面策略：缺 thumb 参数时回读旧草稿封面沿用（不再逼调用方重传素材，也杜绝旧素材孤儿化）；
    // 显式给了新封面时也读一次旧封面——更新成功后顺带清理不再被引用的旧永久素材。
    const hasThumbArg = Boolean(strArg(args.thumbMediaId) || strArg(args.thumbFile) || strArg(args.thumbUrl))
    const oldThumbMediaId = await fetchDraftThumb(oldMediaId, account)
    let preparedArgs = args
    if (!hasThumbArg && oldThumbMediaId) preparedArgs = { ...args, thumbMediaId: oldThumbMediaId }
    const prepared = await prepareDraft(preparedArgs, call)
    // 首选官方原位更新（/cgi-bin/draft/update）：media_id 保持不变，外部引用不断链，
    // 也没有先建后删的失败窗口。接口不可用/报错时回落到 add+delete 重建。
    let inplaceError
    try {
      await apiCall('/cgi-bin/draft/update', { json: { media_id: oldMediaId, index: 0, articles: prepared.article } }, account)
      // 原位更新成功：换过封面且旧封面不再被任何草稿引用 → 尽力清理孤儿素材
      let releasedThumbMediaId = ''
      if (oldThumbMediaId && oldThumbMediaId !== prepared.thumbMediaId) {
        try {
          if (!(await draftThumbInUse(oldThumbMediaId, account, new Set([oldMediaId])))) {
            await apiCall('/cgi-bin/material/del_material', { json: { media_id: oldThumbMediaId } }, account)
            releasedThumbMediaId = oldThumbMediaId
          }
        } catch { /* 清理失败不影响结果，素材留存无害 */ }
      }
      const thumbNote = releasedThumbMediaId ? `，旧封面素材已清理（media_id=${releasedThumbMediaId}）` : ''
      return success(`草稿已原位更新：${prepared.title}（media_id 不变=${oldMediaId}${thumbNote}）`, {
        mediaId: oldMediaId,
        mode: 'inplace',
        thumbMediaId: prepared.thumbMediaId,
        ...(oldThumbMediaId !== '' && prepared.thumbMediaId === oldThumbMediaId ? { reusedThumbMediaId: oldThumbMediaId } : {}),
        ...(oldThumbMediaId && oldThumbMediaId !== prepared.thumbMediaId ? { replacedThumbMediaId: oldThumbMediaId } : {}),
        ...(releasedThumbMediaId ? { releasedThumbMediaId } : {}),
      })
    } catch (error) {
      inplaceError = error
    }
    // 回落：先建新、再删旧（add 失败时旧草稿仍在；delete 失败只告警不丢新稿）
    const fallbackNote = inplaceError instanceof WechatMpError ? `（原位更新失败 ${inplaceError.code}，已回落重建）` : ''
    const { body } = await apiCall('/cgi-bin/draft/add', { json: { articles: [prepared.article] } }, account)
    const newMediaId = String(body?.media_id ?? '')
    if (!newMediaId) throw new WechatMpError('draft_missing_media_id', '草稿创建响应缺少 media_id', '微信接口异常，稍后重试')
    let removed = true
    let warning
    try {
      await apiCall('/cgi-bin/draft/delete', { json: { media_id: oldMediaId } }, account)
    } catch (error) {
      removed = false
      warning = error instanceof WechatMpError ? `旧草稿删除失败（${error.code}）：草稿箱里可能同时存在新旧两份，可手工删除` : '旧草稿删除失败'
    }
    // 孤儿封面清理（尽力而为）：旧封面没被沿用、旧稿已删成功、且箱里再无其他草稿引用它 → 删除该永久素材。
    // 任一前提不满足（尤其旧稿删除失败时旧稿仍引用它）就跳过，宁可留着也不误删共享素材。
    let releasedThumbMediaId = ''
    if (oldThumbMediaId && removed && oldThumbMediaId !== prepared.thumbMediaId) {
      try {
        const inUse = await draftThumbInUse(oldThumbMediaId, account, new Set([oldMediaId, newMediaId]))
        if (!inUse) {
          await apiCall('/cgi-bin/material/del_material', { json: { media_id: oldThumbMediaId } }, account)
          releasedThumbMediaId = oldThumbMediaId
        }
      } catch { /* 清理失败不影响替换结果，素材留存无害 */ }
    }
    const reusedThumb = oldThumbMediaId !== '' && prepared.thumbMediaId === oldThumbMediaId
    const thumbNote = reusedThumb
      ? '，封面沿用旧草稿素材'
      : (releasedThumbMediaId ? `，旧封面素材已清理（media_id=${releasedThumbMediaId}）` : '')
    return success(`草稿已替换（重建）：${prepared.title}${fallbackNote}（新 media_id=${newMediaId}${removed ? `，旧 ${oldMediaId} 已删除` : '，旧草稿未删'}${thumbNote}）`, {
      mediaId: newMediaId,
      mode: 'recreate',
      replacedMediaId: oldMediaId,
      removed,
      thumbMediaId: prepared.thumbMediaId,
      ...(reusedThumb ? { reusedThumbMediaId: oldThumbMediaId } : {}),
      ...(releasedThumbMediaId ? { releasedThumbMediaId } : {}),
      ...(warning ? { warning } : {}),
    })
  })

  const draftList = guard(async (args) => {
    const offset = intArg(args.offset, 0, 0, 1_000_000, 'offset')
    const count = intArg(args.count, DRAFT_BATCHGET_MAX, 1, DRAFT_BATCHGET_MAX, 'count')
    const { body } = await apiCall('/cgi-bin/draft/batchget', { json: { offset, count } }, pickAccount(args))
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
    // 工具结果的结构化字段模型侧不可见（只见 output.render 的 message），把
    // 「标题（mediaId）」逐篇编进 message：后续 draft-get/update 直接从 message 取 id，
    // 不必解析 JSON 或翻会话日志。
    const summary = list.map((item, index) => `${offset + index + 1}. ${item.title || '（无标题）'}（mediaId=${item.mediaId}）`).join('；')
    return success(`草稿箱共 ${total} 篇（本页 ${list.length} 篇）：${summary || '（草稿箱为空）'}`, { total, items: list })
  })

  const draftGet = guard(async (args, call) => {
    const mediaId = strArg(args.mediaId)
    if (!mediaId) throw new WechatMpError('missing_media_id', '缺少 mediaId', '先用 wechat-mp-draft-list 查草稿 id')
    const { body } = await apiCall('/cgi-bin/draft/get', { json: { media_id: mediaId } }, pickAccount(args))
    const news = Array.isArray(body?.news_item) ? body.news_item[0] : undefined
    if (!news) throw new WechatMpError('draft_empty', '草稿详情为空或结构不符', '确认 media_id 存在（wechat-mp-draft-list 核对）')
    const title = String(news.title ?? '')
    const author = String(news.author ?? '')
    const thumbMediaId = String(news.thumb_media_id ?? '')
    const content = String(news.content ?? '')
    // message 带关键字段 + 短正文预览（去标签截 160 字，模型不落盘也能认出是哪篇）；
    // 全文 HTML 太长不进 message——给 outFile 时落盘回路径（改稿拉回全文的正路）
    const preview = content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)
    let outFile = ''
    const outRaw = strArg(args.outFile)
    if (outRaw) {
      outFile = isAbsolute(outRaw) ? outRaw : resolvePath(cwdOf(call), outRaw)
      await mkdir(dirname(outFile))
      await writeFile(outFile, content, 'utf8')
    }
    const outFileNote = outFile ? `；全文 ${content.length} 字符已写入 ${outFile}（read 工具查看/改稿）` : (preview ? `；正文预览：${preview}${content.length > preview.length ? '…' : ''}` : '')
    return success(
      `草稿详情：${title || '（无标题）'}（mediaId=${mediaId}${thumbMediaId ? `，封面 thumbMediaId=${thumbMediaId}` : '，无封面'}${author ? `，作者 ${author}` : ''}）${outFileNote}`,
      {
        mediaId,
        title,
        author,
        digest: String(news.digest ?? ''),
        content,
        thumbMediaId,
        sourceUrl: String(news.content_source_url ?? ''),
        url: String(news.url ?? ''),
        ...(outFile ? { contentFile: outFile, contentChars: content.length } : {}),
      },
    )
  })

  const draftDelete = guard(async (args) => {
    const mediaId = strArg(args.mediaId)
    if (!mediaId) throw new WechatMpError('missing_media_id', '缺少 mediaId', '先用 wechat-mp-draft-list 查草稿 id')
    await apiCall('/cgi-bin/draft/delete', { json: { media_id: mediaId } }, pickAccount(args))
    return success(`草稿已删除：media_id=${mediaId}`, { mediaId })
  })

  const publish = guard(async (args) => {
    const mediaId = strArg(args.mediaId)
    if (!mediaId) throw new WechatMpError('missing_media_id', '缺少 mediaId', '先建草稿（wechat-mp-draft-create）或从草稿箱列表取 id')
    const { body } = await apiCall('/cgi-bin/freepublish/submit', { json: { media_id: mediaId } }, pickAccount(args))
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
    const { body } = await apiCall('/cgi-bin/freepublish/get', { json: { publish_id: publishId } }, pickAccount(args))
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

  // ---- V0.3.0 新工具：正文预检 + Markdown 渲染 ----

  const precheck = guard(async (args) => {
    const { html, baseDir } = await resolveContent(args)
    const report = precheckContent(html)
    const errorCount = report.issues.filter((x) => x.level === 'error').length
    const warnCount = report.issues.filter((x) => x.level === 'warn').length
    const message = errorCount + warnCount === 0
      ? `预检通过：正文 ${report.chars} 字符（上限 ${PRECHECK_MAX_CHARS}），体积 ${(report.bytes / 1024).toFixed(1)}KB（上限 1MB），${report.images.length} 张图片全部在格式白名单内`
      : `预检发现问题：${errorCount} 个错误、${warnCount} 个警告（正文 ${report.chars} 字符 / ${(report.bytes / 1024).toFixed(1)}KB）`
    // dsh 工具结果边界要求 lossless JSON：显式 undefined 键（hint: undefined）会被整单拒收
    // （pipeline.ts snapshotJsonValue 返回 undefined → "value is not lossless JSON"），
    // 所以 hint 只在确有建议时以条件展开出现，绝不留 undefined 键位。
    const firstHint = report.issues.find((x) => x.hint)?.hint
    return {
      ok: errorCount === 0,
      code: errorCount > 0 ? 'precheck_failed' : 'precheck_passed',
      message,
      chars: report.chars,
      bytes: report.bytes,
      issues: report.issues,
      images: report.images,
      ...(firstHint ? { hint: firstHint } : {}),
    }
  })

  const render = guard(async (args, call) => {
    const markdown = typeof args.markdown === 'string' && args.markdown.trim() ? args.markdown : ''
    const mdFile = strArg(args.mdFile)
    if ((markdown && mdFile) || (!markdown && !mdFile)) {
      throw new WechatMpError('bad_arg', 'markdown（字符串）与 mdFile（文件路径）二选一')
    }
    let source = markdown
    let baseDir = cwdOf(call)
    let defaultStem = 'wechat-mp-article'
    if (mdFile) {
      const filePath = isAbsolute(mdFile) ? mdFile : resolvePath(cwdOf(call), mdFile)
      let raw
      try {
        raw = await readFile(filePath)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new WechatMpError('md_read_failed', `读取 Markdown 文件失败：${filePath}（${message}）`)
      }
      source = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')
      baseDir = dirname(filePath)
      defaultStem = basename(filePath).replace(/\.(md|markdown|txt)$/i, '') || defaultStem
    }
    const title = strArg(args.title) || extractFrontmatter(source).attrs.title || ''
    if (!title) {
      throw new WechatMpError('missing_title', '缺少标题：title 参数或 frontmatter 的 title 字段至少给一个', '公众号草稿标题必填')
    }
    const html = renderMarkdown(source, { title })
    // 渲染即预检：error 级问题拒绝落文件（warn 级 webp 只提醒）
    const report = precheckContent(html)
    const errors = report.issues.filter((x) => x.level === 'error')
    if (errors.length > 0) {
      throw new WechatMpError('precheck_failed', `渲染结果预检未通过：${errors[0].message}`, errors.map((x) => x.hint).filter(Boolean).join('；'))
    }
    const outFileRaw = strArg(args.outFile) || resolvePath(baseDir, `${defaultStem}.html`)
    const outPath = isAbsolute(outFileRaw) ? outFileRaw : resolvePath(cwdOf(call), outFileRaw)
    await mkdir(dirname(outPath))
    await writeFile(outPath, html, 'utf8')
    const warns = report.issues.filter((x) => x.level === 'warn')
    const message = `已渲染公众号 HTML：${outPath}（${report.chars} 字符 / ${(report.bytes / 1024).toFixed(1)}KB${warns.length ? `；${warns.length} 条警告：${warns.map((w) => w.code).join('、')}` : ''}）`
    return success(message, {
      outFile: outPath,
      title,
      chars: report.chars,
      bytes: report.bytes,
      warnings: warns,
      contentFile: outPath,
    })
  })

  // ---- V0.4.0 新工具：预览推送（渲染/预检通过后交 GUI 侧边栏，不发网络）----

  const preview = guard(async (args, call) => {
    const markdown = typeof args.markdown === 'string' && args.markdown.trim() ? args.markdown : ''
    const mdFile = strArg(args.mdFile)
    const hasMd = Boolean(markdown || mdFile)
    const hasHtml = Boolean(strArg(args.content) || strArg(args.contentFile))
    if (hasMd && hasHtml) {
      throw new WechatMpError('bad_arg', 'markdown/mdFile 与 content/contentFile 只能给一组')
    }
    let html = ''
    let title = strArg(args.title)
    if (hasMd) {
      let source = markdown
      if (mdFile) {
        const filePath = isAbsolute(mdFile) ? mdFile : resolvePath(cwdOf(call), mdFile)
        let raw
        try {
          raw = await readFile(filePath)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          throw new WechatMpError('md_read_failed', `读取 Markdown 文件失败：${filePath}（${message}）`)
        }
        source = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')
      }
      const fm = extractFrontmatter(source)
      title = title || fm.attrs.title || ''
      if (!title) {
        throw new WechatMpError('missing_title', '缺少标题：title 参数或 frontmatter 的 title 字段至少给一个', '公众号草稿标题必填')
      }
      html = renderMarkdown(source, { title })
    } else {
      if (!title) throw new WechatMpError('missing_title', '缺少标题 title', '公众号标题必填（建议 ≤24 字）')
      const resolved = await resolveContent(args)
      html = resolved.html
    }
    const body = extractBody(html)
    if (!body) throw new WechatMpError('empty_content', '正文为空')
    const report = precheckContent(body)
    const errors = report.issues.filter((x) => x.level === 'error')
    if (errors.length > 0) {
      throw new WechatMpError('precheck_failed',
        `正文预检未通过：${errors[0].message}`,
        errors.map((x) => x.hint).filter(Boolean).join('；') || '按提示处置正文后重试')
    }
    const warns = report.issues.filter((x) => x.level === 'warn')
    return success(`预览已推送到 GUI 侧边栏「公众号 → 预览」：${title}（${report.chars} 字符${warns.length ? `，${warns.length} 条警告` : ''}）。请在界面里审查正文与封面，确认后点「推送到草稿箱」。`, {
      title,
      html: body,
      chars: report.chars,
      bytes: report.bytes,
      warnings: warns,
      // 发送时要用到的草稿参数原样带给 GUI（封面缺失时用户可在预览页补）
      author: strArg(args.author) || '',
      digest: strArg(args.digest) || '',
      sourceUrl: strArg(args.sourceUrl) || '',
      thumbMediaId: strArg(args.thumbMediaId) || '',
      thumbFile: strArg(args.thumbFile) || '',
      thumbUrl: strArg(args.thumbUrl) || '',
      account: strArg(args.account) || '',
      inlineImages: args.inlineImages !== false,
      needOpenComment: args.needOpenComment === true,
      onlyFansCanComment: args.onlyFansCanComment === true,
    })
  })

  
  // ---- V0.6.0 新工具：已发布列表（freepublish/batchget；仅认证账号可用，个人主体 48001）----

  const publishList = guard(async (args) => {
    const offset = intArg(args.offset, 0, 0, 1_000_000, 'offset')
    const count = intArg(args.count, 10, 1, 20, 'count')
    const { body } = await apiCall('/cgi-bin/freepublish/batchget', { json: { offset, count, no_content: 1 } }, pickAccount(args))
    const items = Array.isArray(body?.item) ? body.item : []
    const total = Number(body?.total_count ?? 0) || 0
    const list = items.map((item) => {
      const news = Array.isArray(item?.content?.news_item) ? item.content.news_item[0] : undefined
      return {
        articleId: String(item?.article_id ?? ''),
        title: String(news?.title ?? ''),
        url: String(news?.url ?? ''),
        isDeleted: news?.is_deleted === true,
        updateTime: typeof item?.update_time === 'number' ? new Date(item.update_time * 1000).toISOString() : '',
      }
    })
    // 结构化字段模型侧不可见，逐篇「N. 标题（articleId=…，链接）」编进 message
    const summary = list.map((x, i) => `${offset + i + 1}. ${x.title || '（无标题）'}${x.isDeleted ? '【已删除】' : ''}（articleId=${x.articleId}${x.url ? `，${x.url}` : ''}）`).join('；')
    return success(`已发布列表共 ${total} 篇（本页 ${list.length} 篇）：${summary || '（空）'}`, { total, items: list })
  })

return { status, uploadImage: uploadImageTool, draftCreate, draftUpdate, draftList, draftGet, draftDelete, publish, publishStatus, publishList, precheck, render, preview }
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
