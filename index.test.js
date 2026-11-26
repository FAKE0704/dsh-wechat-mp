// dsh-wechat-mp 面层 keyless 单测：插件名/注入面/八工具注册/审批门/execute 委托。
// 语义分支覆盖在 core.test.js（config.impls 测试缝注入 fetch，不触网）。
import { describe, expect, test } from 'bun:test'
import { apply, inject, name } from './index.js'

const TOOL_NAMES = [
  'wechat-mp-status',
  'wechat-mp-upload-image',
  'wechat-mp-draft-create',
  'wechat-mp-draft-update',
  'wechat-mp-draft-list',
  'wechat-mp-draft-delete',
  'wechat-mp-publish',
  'wechat-mp-publish-status',
]

function makeCtx() {
  const registered = new Map()
  const hooks = new Map()
  const credentialCalls = []
  return {
    registered,
    hooks,
    credentialCalls,
    tools: { register: (tool) => registered.set(tool.name, tool) },
    on: (event, fn) => hooks.set(event, fn),
    credentials: {
      resolve: async (ref) => {
        credentialCalls.push(ref)
        return { value: ref === 'WECHAT_MP_APPID' ? 'wxAAAAAAAAAAAAAAAA' : 'SECRET' }
      },
    },
  }
}

const tokenResponse = () => new Response(JSON.stringify({ access_token: 'TOKEN', expires_in: 7200 }), {
  status: 200,
  headers: { 'content-type': 'application/json' },
})

describe('dsh-wechat-mp 面层', () => {
  test('插件名与注入面：tools + credentials（不依赖 mcpManager）', () => {
    expect(name).toBe('dsh-wechat-mp')
    expect(inject).toEqual(['tools', 'credentials'])
  })

  test('注册八个工具且都带参数 schema / 输出渲染', () => {
    const ctx = makeCtx()
    apply(ctx, {})
    expect([...ctx.registered.keys()]).toEqual(TOOL_NAMES)
    for (const tool of ctx.registered.values()) {
      expect(tool.parameters.type).toBe('object')
      expect(typeof tool.description).toBe('string')
      expect(tool.output.render({}, { ok: true, message: 'x' })[0].text).toBe('x')
    }
    expect(ctx.registered.get('wechat-mp-publish').description).toContain('审批')
  })

  test('pre-execute：publish → ask；草稿工具 → next()', async () => {
    const ctx = makeCtx()
    apply(ctx, {})
    const hook = ctx.hooks.get('tools/pre-execute')
    expect(typeof hook).toBe('function')
    const decision = await hook({ name: 'wechat-mp-publish' }, async () => ({ kind: 'next' }))
    expect(decision.kind).toBe('ask')
    expect(decision.reason).toContain('公众号发布')

    let passed = false
    await hook({ name: 'wechat-mp-draft-create' }, async () => { passed = true; return { kind: 'accept' } })
    expect(passed).toBe(true)
  })

  test('execute 委托语义核：status 走注入 fetch + 凭据解析', async () => {
    const ctx = makeCtx()
    apply(ctx, {
      appId: 'wxAAAAAAAAAAAAAAAA',
      impls: {
        fetchImpl: async (url, init = {}) => {
          if (String(url).includes('/cgi-bin/stable_token') && init.method === 'POST') return tokenResponse()
          throw new Error(`unexpected fetch ${url}`)
        },
      },
    })
    const status = ctx.registered.get('wechat-mp-status')
    const result = await status.execute({})
    expect(result.ok).toBe(true)
    expect(result.message).toContain('access_token')
    expect(ctx.credentialCalls).toContain('WECHAT_MP_SECRET')
  })

  test('非法配置在装载期抛错（fail-closed）', () => {
    const ctx = makeCtx()
    expect(() => apply(ctx, { secretRef: 'bad-ref' })).toThrow()
  })
})
