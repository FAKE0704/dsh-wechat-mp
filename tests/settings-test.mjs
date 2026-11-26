// settings.js 的 keyless 冒烟测试：假 ctx（credentials/configEditor/webServer）驱动桥，
// 零网络。跑法：node tests/settings-test.mjs
import { createSettingsService } from '../settings.js'
import { resolveConfig } from '../core.js'

const assert = (cond, label) => {
  if (!cond) { console.error('FAIL:', label); process.exitCode = 1 } else console.log('ok:', label)
}

function makeFakeCtx() {
  const refs = new Map()
  let edited = null
  return {
    fiber: { entry: 'include:dsh-wechat-mp' },
    get: (key) => (key === 'configEditor' ? { edit: (entry, change) => { edited = change({ appId: 'x' }); return Promise.resolve() } } : undefined),
    credentials: {
      resolve: async (ref) => (refs.has(ref) ? { value: refs.get(ref) } : undefined),
      describe: async (ref) => ({ configured: refs.has(ref), source: refs.has(ref) ? 'file' : undefined, writable: true }),
      set: async (ref, value) => { if (!value) throw new Error('ref value cannot be empty'); refs.set(ref, value) },
      unset: async (ref) => { refs.delete(ref) },
    },
    edited: () => edited,
  }
}

function call(svc, method, args) {
  return svc.rpcInvoke(method, args)
}

const config = resolveConfig({ appId: '', secretRef: 'WECHAT_MP_SECRET', apiBase: 'https://api.weixin.qq.com' })
const ctx = makeFakeCtx()
const svc = createSettingsService({ ctx, config, makeSemantics: (cfg) => ({ status: async () => ({ ok: true, message: `fake-status appId=${cfg.appId}` }) }) })

const get1 = await call(svc, 'get')
assert(get1.ok === true && get1.secret.configured === false, 'get 初始未配置')

const sec = await call(svc, 'setSecret', { secret: '  abc123  ' })
assert(sec.ok === true && sec.message.includes('WECHAT_MP_SECRET'), 'setSecret 写入凭据库')
assert(!sec.message.includes('abc123'), '桥不回显明文')

const get2 = await call(svc, 'get')
assert(get2.secret.configured === true && get2.secret.masked === null, 'get 反映凭据状态（describe 无 masked 时 null）')

const bad = await call(svc, 'setSecret', { secret: '' })
assert(bad.ok === false, '空 Secret 被拒')

const save = await call(svc, 'save', { appId: 'wx1234567890abcdef', apiBase: 'https://api.weixin.qq.com/', timeoutMs: 30000 })
assert(save.ok === true && save.config.appId === 'wx1234567890abcdef' && save.config.apiBase === 'https://api.weixin.qq.com', 'save 归一并写回 configEditor')
assert(ctx.edited().appId === 'wx1234567890abcdef', 'configEditor 收到完整 patch（含其他字段）')

const badSave = await call(svc, 'save', { secretRef: 'bad-ref' })
assert(badSave.ok === false && badSave.message.includes('secretRef'), '非法 secretRef 被拒')

const test = await call(svc, 'test')
assert(test.ok === true, 'test 委托 status')

const unknown = await call(svc, 'nope')
assert(unknown.ok === false, '未知方法 fail-closed')

// ---- 预览流：pushPreview → preview → send（假 draftCreate 语义核） ----
const empty = await call(svc, 'preview')
assert(empty.ok === true && empty.empty === true, '无预览时 preview 返回 empty')

const sendNone = await call(svc, 'send')
assert(sendNone.ok === false && sendNone.message.includes('wechat-mp-preview'), '无预览时 send 被拒并指引工具名')

const draftCalls = []
const svc2 = createSettingsService({
  ctx: makeFakeCtx(), config,
  makeSemantics: (cfg) => ({
    status: async () => ({ ok: true, message: 'fake-status' }),
    draftCreate: async (args) => {
      draftCalls.push(args)
      if (!args.thumbFile && !args.thumbUrl && !args.thumbMediaId) return { ok: false, code: 'missing_thumb', message: '缺少封面' }
      return { ok: true, message: `草稿已创建：${args.title}`, mediaId: 'MEDIA_ID_1' }
    },
  }),
})

const art = { ok: true, message: '预览已推送', title: '测试文章', html: '<p>正文</p>', chars: 2, bytes: 25, warnings: [], author: '甲', digest: '', sourceUrl: '', thumbMediaId: '', thumbFile: '', thumbUrl: '', account: '', inlineImages: true, needOpenComment: false, onlyFansCanComment: false }
svc2.pushPreview(art)
const pv1 = await call(svc2, 'preview')
assert(pv1.ok === true && pv1.empty === false && pv1.html === '<p>正文</p>' && typeof pv1.pushedAt === 'string', 'preview 返回暂存文章')

const sendNoCover = await call(svc2, 'send')
assert(sendNoCover.ok === false && sendNoCover.message.includes('封面'), '封面缺失时 send 给明确指引')

const sendOk = await call(svc2, 'send', { thumbFile: '/tmp/cover.jpg' })
assert(sendOk.ok === true && sendOk.mediaId === 'MEDIA_ID_1', 'send 委托 draftCreate 并回传 media_id')
assert(draftCalls[0].title === '测试文章' && draftCalls[0].thumbFile === '/tmp/cover.jpg' && draftCalls[0].author === '甲', 'send 透传预览参数与封面覆盖')
assert(!JSON.stringify(sendOk).includes('<p>正文'), 'send 响应不回传全文 html')

const sendAgain = await call(svc2, 'send', { thumbFile: '/tmp/cover.jpg' })
assert(sendAgain.ok === false && sendAgain.message.includes('MEDIA_ID_1'), '同一预览不可重复发送（防重）')

const pv2 = await call(svc2, 'preview')
assert(pv2.sent === true && pv2.sentMediaId === 'MEDIA_ID_1', 'preview 反映已发送状态')

svc2.pushPreview({ ...art, title: '第二篇', html: '<p>2</p>' })
const pv3 = await call(svc2, 'preview')
assert(pv3.title === '第二篇' && pv3.sent === false, 'pushPreview 覆盖旧预览并重置发送状态')

// handleRequest 同源守卫与 405
const fakeReq = (method, origin, host, body) => {
  const listeners = { data: [], end: [] }
  return {
    method,
    headers: { origin, host },
    on: (ev, fn) => { listeners[ev] = fn },
    destroy: () => {},
    _emit: (chunk) => listeners.data?.(chunk),
    _end: () => listeners.end?.(),
  }
}
let status = 0
const res = { writeHead: (s) => { status = s }, end: () => {} }
const r405 = fakeReq('GET', undefined, '127.0.0.1:61139', '')
svc.handleRequest(r405, res)
assert(status === 405, '非 POST 返回 405')
status = 0
const rBadOrigin = fakeReq('POST', 'https://evil.example.com', '127.0.0.1:61139', '{}')
svc.handleRequest(rBadOrigin, res)
assert(status === 403, '跨站 Origin 返回 403')
console.log(process.exitCode ? 'SOME FAILED' : 'ALL PASS')
