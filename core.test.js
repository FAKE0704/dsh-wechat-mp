// dsh-wechat-mp 语义核 keyless 单测：零网络、零真文件（fetch/readFile/clock 全注入）。
import { describe, expect, test } from 'bun:test'
import {
  createSemantics,
  decideWechatMpGate,
  extractBody,
  mapWxError,
  maskAppId,
  normalizeImageFile,
  resolveConfig,
} from './core.js'

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
})

/** 路由表 mock fetch：key = "METHOD path"；返回 {fetchImpl, calls}。 */
function makeFetch(routes) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url))
    const key = `${init.method ?? 'GET'} ${u.pathname}`
    calls.push({ url: String(url), init, path: u.pathname })
    const handler = routes[key]
    if (!handler) throw new Error(`unexpected fetch: ${key}`)
    if (typeof handler === 'function') return handler({ url: u, init })
    // 同一 route 可能被多次请求：Response body 只能读一次，克隆后再返回。
    return handler instanceof Response ? handler.clone() : handler
  }
  return { fetchImpl, calls }
}

const TOKEN_ROUTE = { 'POST /cgi-bin/stable_token': jsonResponse({ access_token: 'TOKEN', expires_in: 7200 }) }


describe('resolveConfig（装载期 fail-closed）', () => {
  test('缺省值：官方 apiBase / 凭据 ref / 20s 超时', () => {
    const cfg = resolveConfig({})
    expect(cfg.apiBase).toBe('https://api.weixin.qq.com')
    expect(cfg.secretRef).toBe('WECHAT_MP_SECRET')
    expect(cfg.timeoutMs).toBe(20000)
    expect(cfg.appId).toBe('')
  })

  test('apiBase 去尾斜杠；http(s) 之外与非法 URL 拒绝', () => {
    expect(resolveConfig({ apiBase: 'https://api.weixin.qq.com/' }).apiBase).toBe('https://api.weixin.qq.com')
    expect(() => resolveConfig({ apiBase: 'ftp://x' })).toThrow()
    expect(() => resolveConfig({ apiBase: 'not a url' })).toThrow()
  })

  test('secretRef 必须是环境变量名形态；timeout 越界拒绝', () => {
    expect(() => resolveConfig({ secretRef: 'bad-ref' })).toThrow()
    expect(() => resolveConfig({ buffer: 1, timeoutMs: 10 })).toThrow()
    expect(() => resolveConfig({ timeoutMs: 999999 })).toThrow()
  })
})

describe('纯函数', () => {
  test('extractBody：整页抽 body，片段原样', () => {
    expect(extractBody('<html><body><p>hi</p></body></html>')).toBe('<p>hi</p>')
    expect(extractBody('  <p>hi</p>  ')).toBe('<p>hi</p>')
  })

  test('maskAppId：前后各 4 位，短值全掩码', () => {
    expect(maskAppId('wx1234567890abcdef')).toBe('wx12****cdef')
    expect(maskAppId('short')).toBe('****')
    expect(maskAppId('')).toBe('')
  })

  test('normalizeImageFile：后缀优先；无后缀按 content-type 补；webp 拒绝', () => {
    expect(normalizeImageFile({ filename: 'a.JPG' })).toEqual({ filename: 'a.JPG', contentType: 'image/jpeg' })
    expect(normalizeImageFile({ filename: 'noext', contentType: 'image/png' })).toEqual({ filename: 'noext.png', contentType: 'image/png' })
    expect(normalizeImageFile({ filename: 'x.webp', contentType: 'image/webp' })).toBeNull()
  })

  test('mapWxError：个人主体发布 / IP 白名单 / 未知码', () => {
    expect(mapWxError(48001, 'api unauthorized').hint).toContain('个人主体')
    expect(mapWxError(40164, 'invalid ip').hint).toContain('IP 白名单')
    expect(mapWxError(40007, '').code).toBe('wechat_40007')
    const unknown = mapWxError(99999, 'weird')
    expect(unknown.message).toContain('99999')
    expect(unknown.code).toBe('wechat_99999')
  })

  test('decideWechatMpGate：只有 publish 过门', () => {
    expect(decideWechatMpGate({ name: 'wechat-mp-publish' })?.kind).toBe('ask')
    expect(decideWechatMpGate({ name: 'wechat-mp-draft-create' })).toBeNull()
    expect(decideWechatMpGate({})).toBeNull()
  })
})

describe('token 与状态', () => {
  test('status：换 token 并缓存（第二次不再打 token 接口）', async () => {
    const routes = { ...TOKEN_ROUTE }
    const { fetchImpl, calls } = makeFetch(routes)
    const sem = createSemantics({
      config: { apiBase: 'https://api.weixin.qq.com', appId: 'wx1234567890abcdef', secretRef: 'WECHAT_MP_SECRET', timeoutMs: 5000, maxImageBytes: 10 * 1024 * 1024 },
      fetchImpl,
      resolveCredential: async () => ({ value: 'SECRET' }),
    })
    const first = await sem.status({})
    const second = await sem.status({})
    expect(first.ok).toBe(true)
    expect(first.message).toContain('wx12****cdef')
    expect(second.ok).toBe(true)
    expect(calls.filter((c) => c.path === '/cgi-bin/stable_token')).toHaveLength(1)
  })

  test('缺 Secret：不触网，明确指向凭据库', async () => {
    const sem = createSemantics({
      config: { apiBase: 'https://api.weixin.qq.com', appId: 'wx1', secretRef: 'WECHAT_MP_SECRET', timeoutMs: 5000, maxImageBytes: 1024 * 1024 },
      fetchImpl: async () => { throw new Error('should not fetch') },
      resolveCredential: async () => undefined,
    })
    const result = await sem.status({})
    expect(result.ok).toBe(false)
    expect(result.code).toBe('missing_secret')
    expect(result.hint).toContain('凭据')
  })

  test('AppID 缺省走凭据 WECHAT_MP_APPID', async () => {
    const routes = { ...TOKEN_ROUTE }
    const { fetchImpl } = makeFetch(routes)
    const seen = []
    const sem = createSemantics({
      config: { apiBase: 'https://api.weixin.qq.com', appId: '', secretRef: 'WECHAT_MP_SECRET', timeoutMs: 5000, maxImageBytes: 1024 * 1024 },
      fetchImpl,
      resolveCredential: async (ref) => { seen.push(ref); return { value: ref === 'WECHAT_MP_APPID' ? 'wxAAAAAAAAAAAAAAAA' : 'SECRET' } },
    })
    const result = await sem.status({})
    expect(result.ok).toBe(true)
    expect(seen).toContain('WECHAT_MP_APPID')
  })

  test('网络失败 → code=network；HTTP 非 2xx → http_xxx', async () => {
    const sem = createSemantics({
      config: { apiBase: 'https://api.weixin.qq.com', appId: 'wx1', secretRef: 'WECHAT_MP_SECRET', timeoutMs: 5000, maxImageBytes: 1024 * 1024 },
      fetchImpl: async () => { throw new Error('boom') },
      resolveCredential: async () => ({ value: 'SECRET' }),
    })
    expect((await sem.status({})).code).toBe('network')

    const sem500 = createSemantics({
      config: { apiBase: 'https://api.weixin.qq.com', appId: 'wx1', secretRef: 'WECHAT_MP_SECRET', timeoutMs: 5000, maxImageBytes: 1024 * 1024 },
      fetchImpl: async () => new Response('oops', { status: 502 }),
      resolveCredential: async () => ({ value: 'SECRET' }),
    })
    expect((await sem500.status({})).code).toBe('http_502')
  })

  test('40001：清缓存换新重试一次后成功', async () => {
    let first = true
    const { fetchImpl, calls } = makeFetch({
      ...TOKEN_ROUTE,
      'POST /cgi-bin/draft/batchget': () => {
        if (first) { first = false; return jsonResponse({ errcode: 40001, errmsg: 'invalid credential' }) }
        return jsonResponse({ total_count: 0, item_count: 0, item: [] })
      },
    })
    const sem = createSemantics({
      config: { apiBase: 'https://api.weixin.qq.com', appId: 'wx1', secretRef: 'WECHAT_MP_SECRET', timeoutMs: 5000, maxImageBytes: 1024 * 1024 },
      fetchImpl,
      resolveCredential: async () => ({ value: 'SECRET' }),
    })
    const result = await sem.draftList({})
    expect(result.ok).toBe(true)
    expect(calls.filter((c) => c.path === '/cgi-bin/stable_token')).toHaveLength(2)
  })
})

describe('草稿创建（封面 / 图片改写 / 正文文件）', () => {
  const baseConfig = { apiBase: 'https://api.weixin.qq.com', appId: 'wx1', secretRef: 'WECHAT_MP_SECRET', timeoutMs: 5000, maxImageBytes: 10 * 1024 * 1024 }

  test('纯正文 + thumbMediaId：一次 draft/add，字段齐全', async () => {
    const { fetchImpl, calls } = makeFetch({
      ...TOKEN_ROUTE,
      'POST /cgi-bin/draft/add': jsonResponse({ media_id: 'DRAFT-1' }),
    })
    const sem = createSemantics({ config: baseConfig, fetchImpl, resolveCredential: async () => ({ value: 'SECRET' }) })
    const result = await sem.draftCreate({ title: '标题 A', content: '<p>正文</p>', thumbMediaId: 'THUMB-1', author: '作者', digest: '摘要' })
    expect(result.ok).toBe(true)
    expect(result.mediaId).toBe('DRAFT-1')
    const draftCall = calls.find((c) => c.path === '/cgi-bin/draft/add')
    const payload = JSON.parse(draftCall.init.body)
    expect(payload.articles[0]).toMatchObject({ title: '标题 A', content: '<p>正文</p>', thumb_media_id: 'THUMB-1', author: '作者', digest: '摘要', need_open_comment: 0 })
  })

  test('缺封面：发请求前就失败（missing_thumb），不触网', async () => {
    const sem = createSemantics({ config: baseConfig, fetchImpl: async () => { throw new Error('no fetch') }, resolveCredential: async () => ({ value: 'SECRET' }) })
    const result = await sem.draftCreate({ title: 'T', content: '<p>x</p>' })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('missing_thumb')
  })

  test('外域正文图片：下载→传素材→改写 src；已是 mmbiz 的保留', async () => {
    const { fetchImpl, calls } = makeFetch({
      ...TOKEN_ROUTE,
      'GET /img/a.png': new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } }),
      'POST /cgi-bin/material/add_material': jsonResponse({ media_id: 'MEDIA-1', url: 'https://mmbiz.qpic.cn/ok.png' }),
      'POST /cgi-bin/draft/add': jsonResponse({ media_id: 'DRAFT-2' }),
    })
    const sem = createSemantics({ config: { ...baseConfig, apiBase: 'https://api.weixin.qq.com' }, fetchImpl, resolveCredential: async () => ({ value: 'SECRET' }) })
    const sem2 = createSemantics({
      config: baseConfig,
      fetchImpl: async (url, init) => {
        const u = new URL(String(url))
        // 图片 CDN 与实际 API 分开：图片 URL 是 https://cdn.example.com/img/a.png
        if (u.hostname === 'cdn.example.com') return fetchImpl('https://api.weixin.qq.com/img/a.png', init)
        return fetchImpl(url, init)
      },
      resolveCredential: async () => ({ value: 'SECRET' }),
    })
    const result = await sem2.draftCreate({
      title: 'T', content: '<p><img src="https://cdn.example.com/img/a.png"><img src="https://mmbiz.qpic.cn/keep.png"></p>', thumbMediaId: 'T1',
    })
    expect(result.ok).toBe(true)
    const draftCall = calls.find((c) => c.path === '/cgi-bin/draft/add')
    const content = JSON.parse(draftCall.init.body).articles[0].content
    expect(content).toContain('https://mmbiz.qpic.cn/ok.png')
    expect(content).not.toContain('cdn.example.com')
    expect(content).toContain('https://mmbiz.qpic.cn/keep.png')
    const uploadCall = calls.find((c) => c.path === '/cgi-bin/material/add_material')
    expect(uploadCall.init.body).toBeInstanceOf(FormData)
    expect(uploadCall.init.body.get('media').name).toBe('a.png')
    expect(result.uploadedImages).toEqual(['https://mmbiz.qpic.cn/ok.png'])
    expect(sem.status).toBeFunction()
  })

  test('contentFile：正文读文件，相对图片按文件目录解析', async () => {
    const reads = []
    const files = {
      '/tmp/mp/article.html': Buffer.from('<html><body><img src="./pic.png"></body></html>'),
      '/tmp/mp/pic.png': new Uint8Array([9, 9, 9]),
    }
    const { fetchImpl, calls } = makeFetch({
      ...TOKEN_ROUTE,
      'POST /cgi-bin/material/add_material': jsonResponse({ media_id: 'M2', url: 'https://mmbiz.qpic.cn/pic.png' }),
      'POST /cgi-bin/draft/add': jsonResponse({ media_id: 'DRAFT-3' }),
    })
    const sem = createSemantics({
      config: baseConfig,
      fetchImpl,
      readFileImpl: async (path) => { reads.push(path); if (!(path in files)) throw new Error('ENOENT'); return files[path] },
      resolveCredential: async () => ({ value: 'SECRET' }),
    })
    const result = await sem.draftCreate({ title: 'T', contentFile: '/tmp/mp/article.html', thumbMediaId: 'T1' })
    expect(result.ok).toBe(true)
    expect(reads).toEqual(['/tmp/mp/article.html', '/tmp/mp/pic.png'])
    const content = JSON.parse(calls.find((c) => c.path === '/cgi-bin/draft/add').init.body).articles[0].content
    expect(content).toContain('https://mmbiz.qpic.cn/pic.png')
  })

  test('content 与 contentFile 同给 / 都不给 → content_required', async () => {
    const sem = createSemantics({ config: baseConfig, fetchImpl: async () => { throw new Error('no fetch') }, resolveCredential: async () => ({ value: 'SECRET' }) })
    expect((await sem.draftCreate({ title: 'T' })).code).toBe('content_required')
    expect((await sem.draftCreate({ title: 'T', content: '<p>x</p>', contentFile: '/tmp/a.html' })).code).toBe('content_required')
  })

  test('封面 thumbFile：先传素材再用其 media_id', async () => {
    const { fetchImpl, calls } = makeFetch({
      ...TOKEN_ROUTE,
      'POST /cgi-bin/material/add_material': jsonResponse({ media_id: 'COVER-1', url: 'https://mmbiz.qpic.cn/cover.png' }),
      'POST /cgi-bin/draft/add': jsonResponse({ media_id: 'DRAFT-4' }),
    })
    const sem = createSemantics({
      config: baseConfig,
      fetchImpl,
      readFileImpl: async () => new Uint8Array([1]),
      resolveCredential: async () => ({ value: 'SECRET' }),
    })
    const result = await sem.draftCreate({ title: 'T', content: '<p>x</p>', thumbFile: '/tmp/cover.png' })
    expect(result.ok).toBe(true)
    expect(result.thumbMediaId).toBe('COVER-1')
    expect(calls.find((c) => c.path === '/cgi-bin/material/add_material')).toBeDefined()
  })
})

describe('草稿更新 / 列表 / 删除 / 发布', () => {
  const baseConfig = { apiBase: 'https://api.weixin.qq.com', appId: 'wx1', secretRef: 'WECHAT_MP_SECRET', timeoutMs: 5000, maxImageBytes: 10 * 1024 * 1024 }

  test('update：先建新再删旧，旧稿删除失败只告警', async () => {
    const { fetchImpl, calls } = makeFetch({
      ...TOKEN_ROUTE,
      'POST /cgi-bin/draft/add': jsonResponse({ media_id: 'NEW-1' }),
      'POST /cgi-bin/draft/delete': jsonResponse({ errcode: 40007, errmsg: 'invalid media_id' }),
    })
    const sem = createSemantics({ config: baseConfig, fetchImpl, resolveCredential: async () => ({ value: 'SECRET' }) })
    const result = await sem.draftUpdate({ mediaId: 'OLD-1', title: 'T', content: '<p>x</p>', thumbMediaId: 'T1' })
    expect(result.ok).toBe(true)
    expect(result.mediaId).toBe('NEW-1')
    expect(result.removed).toBe(false)
    expect(result.warning).toContain('旧草稿删除失败')
    const order = calls.filter((c) => c.path.startsWith('/cgi-bin/draft/')).map((c) => c.path)
    expect(order).toEqual(['/cgi-bin/draft/add', '/cgi-bin/draft/delete'])
  })

  test('list：摘要化草稿（分页参数校验）', async () => {
    const { fetchImpl, calls } = makeFetch({
      ...TOKEN_ROUTE,
      'POST /cgi-bin/draft/batchget': jsonResponse({
        total_count: 3,
        item_count: 1,
        item: [{ media_id: 'M1', update_time: 1700000000, content: { news_item: [{ title: 'T', author: 'A', digest: 'D', thumb_media_id: 'TH' }] } }],
      }),
    })
    const sem = createSemantics({ config: baseConfig, fetchImpl, resolveCredential: async () => ({ value: 'SECRET' }) })
    const result = await sem.draftList({ offset: 0, count: 20 })
    expect(result.ok).toBe(true)
    expect(result.total).toBe(3)
    expect(result.items[0]).toMatchObject({ mediaId: 'M1', title: 'T', author: 'A', thumbMediaId: 'TH' })
    expect(JSON.parse(calls.find((c) => c.path === '/cgi-bin/draft/batchget').init.body)).toEqual({ offset: 0, count: 20 })
    expect((await sem.draftList({ count: 99 })).code).toBe('bad_arg')
  })

  test('delete：正常返回', async () => {
    const { fetchImpl, calls } = makeFetch({ ...TOKEN_ROUTE, 'POST /cgi-bin/draft/delete': jsonResponse({ errcode: 0, errmsg: 'ok' }) })
    const sem = createSemantics({ config: baseConfig, fetchImpl, resolveCredential: async () => ({ value: 'SECRET' }) })
    const result = await sem.draftDelete({ mediaId: 'M1' })
    expect(result.ok).toBe(true)
    expect(JSON.parse(calls.find((c) => c.path === '/cgi-bin/draft/delete').init.body)).toEqual({ media_id: 'M1' })
  })

  test('publish：48001 转个人主体指引', async () => {
    const { fetchImpl } = makeFetch({ ...TOKEN_ROUTE, 'POST /cgi-bin/freepublish/submit': jsonResponse({ errcode: 48001, errmsg: 'api unauthorized' }) })
    const sem = createSemantics({ config: baseConfig, fetchImpl, resolveCredential: async () => ({ value: 'SECRET' }) })
    const result = await sem.publish({ mediaId: 'M1' })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('wechat_48001')
    expect(result.hint).toContain('个人主体')
  })

  test('publish-status：状态码转人话 + 文章链接', async () => {
    const { fetchImpl } = makeFetch({
      ...TOKEN_ROUTE,
      'POST /cgi-bin/freepublish/get': jsonResponse({ publish_status: 0, article_id: 'A1', article_detail: { item: [{ article_url: 'https://mp.weixin.qq.com/s/x' }] } }),
    })
    const sem = createSemantics({ config: baseConfig, fetchImpl, resolveCredential: async () => ({ value: 'SECRET' }) })
    const result = await sem.publishStatus({ publishId: 'P1' })
    expect(result.ok).toBe(true)
    expect(result.statusText).toBe('发布成功')
    expect(result.articleUrl).toBe('https://mp.weixin.qq.com/s/x')
  })

  test('upload-image：本地文件 → FormData 上传素材', async () => {
    const { fetchImpl, calls } = makeFetch({ ...TOKEN_ROUTE, 'POST /cgi-bin/material/add_material': jsonResponse({ media_id: 'MI', url: 'https://mmbiz.qpic.cn/i.png' }) })
    const sem = createSemantics({
      config: baseConfig,
      fetchImpl,
      readFileImpl: async () => new Uint8Array([1, 2]),
      resolveCredential: async () => ({ value: 'SECRET' }),
    })
    const result = await sem.uploadImage({ file: '/tmp/pic.jpg' })
    expect(result.ok).toBe(true)
    expect(result.mediaId).toBe('MI')
    expect(calls.find((c) => c.path === '/cgi-bin/material/add_material').url).toContain('type=image')
  })

  test('upload-image：webp 明确拒绝', async () => {
    const sem = createSemantics({
      config: baseConfig,
      fetchImpl: async () => { throw new Error('no fetch') },
      readFileImpl: async () => new Uint8Array([1]),
      resolveCredential: async () => ({ value: 'SECRET' }),
    })
    const result = await sem.uploadImage({ file: '/tmp/pic.webp' })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('unsupported_image')
  })
})
