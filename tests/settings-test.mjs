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
