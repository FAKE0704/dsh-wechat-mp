// core.js 的 keyless 测试（bun test）：零网络、零真文件——fetch/readFile/writeFile/时钟/凭据全注入。
import { describe, test, expect } from 'bun:test'
import {
  resolveConfig, resolveAccounts, precheckContent, imageSrcExtension,
  extractBody, maskAppId, mapWxError, isCredentialRefName,
  PRECHECK_MAX_CHARS, PRECHECK_MAX_BYTES, WechatMpError,
} from '../core.js'
import { createSemantics } from '../core.js'

const okCred = (map) => async (ref) => (map.has(ref) ? { value: map.get(ref) } : undefined)

describe('resolveConfig / 多账号', () => {
  test('旧单账号 config 折成一个 default 账号（向后兼容）', () => {
    const cfg = resolveConfig({ appId: 'wx111', secretRef: 'MY_SECRET' })
    expect(cfg.appId).toBe('wx111')
    expect(cfg.secretRef).toBe('MY_SECRET')
    expect(cfg.accounts).toEqual([{ name: 'default', appId: 'wx111', secretRef: 'MY_SECRET' }])
  })

  test('accounts 多账号展开，secretRef 缺省按名派生', () => {
    const cfg = resolveConfig({
      accounts: [
        { name: 'main', appId: 'wxAAA', secretRef: 'SECRET_A' },
        { name: 'side-blog', appId: 'wxBBB' },
      ],
    })
    expect(cfg.accounts[0]).toEqual({ name: 'main', appId: 'wxAAA', secretRef: 'SECRET_A' })
    expect(cfg.accounts[1].secretRef).toBe('WECHAT_MP_SIDE_BLOG_SECRET')
    expect(cfg.secretRef).toBe('SECRET_A') // 兼容面 = 第一个账号
  })

  test('空 accounts 不炸——缺省 default', () => {
    const cfg = resolveConfig({})
    expect(cfg.accounts).toEqual([{ name: 'default', appId: '', secretRef: 'WECHAT_MP_SECRET' }])
  })

  test('重复账号名 / 缺 name / 非法 secretRef 均拒绝', () => {
    expect(() => resolveAccounts({ accounts: [{ name: 'a' }, { name: 'a' }] })).toThrow(/重复/)
    expect(() => resolveAccounts({ accounts: [{ appId: 'x' }] })).toThrow(/name/)
    expect(() => resolveAccounts({ accounts: [{ name: 'a', secretRef: 'bad-ref!' }] })).toThrow(/secretRef/)
  })

  test('isCredentialRefName 基本形态', () => {
    expect(isCredentialRefName('WECHAT_MP_SECRET')).toBe(true)
    expect(isCredentialRefName('bad name')).toBe(false)
  })
})

describe('precheckContent（纯函数）', () => {
  test('正常正文通过', () => {
    const r = precheckContent('<p>你好</p><img src="https://x.cn/a.jpg">')
    expect(r.ok).toBe(true)
    expect(r.issues).toEqual([])
    expect(r.chars).toBe(2)
  })

  test('字符数超限给具体数字与建议', () => {
    const html = `<p>${'字'.repeat(PRECHECK_MAX_CHARS + 1)}</p>`
    const r = precheckContent(html)
    expect(r.ok).toBe(false)
    const issue = r.issues.find((x) => x.code === 'chars_over_limit')
    expect(issue.message).toContain(String(PRECHECK_MAX_CHARS))
    expect(issue.hint).toContain('删减')
  })

  test('体积超 1MB 报错', () => {
    const r = precheckContent(`<p>${'a'.repeat(PRECHECK_MAX_BYTES)}</p>`)
    expect(r.ok).toBe(false)
    expect(r.issues.some((x) => x.code === 'bytes_over_limit')).toBe(true)
  })

  test('webp 图片 → warn 级 + 转换建议（不整体判死）', () => {
    const r = precheckContent('<img src="https://x.cn/pic.webp">')
    expect(r.ok).toBe(true) // warn 不算 error
    const warn = r.issues.find((x) => x.code === 'image_webp')
    expect(warn.level).toBe('warn')
    expect(warn.hint).toContain('sharp')
  })

  test('白名单外格式（svg/无扩展名）→ error', () => {
    expect(precheckContent('<img src="https://x.cn/a.svg">').ok).toBe(false)
    expect(precheckContent('<img src="https://x.cn/noext">').ok).toBe(false)
  })

  test('imageSrcExtension：URL / data URL / 大小写归一', () => {
    expect(imageSrcExtension('https://a.cn/b.PNG')).toBe('png')
    expect(imageSrcExtension('data:image/webp;base64,AAAA')).toBe('webp')
    expect(imageSrcExtension('data:image/jpeG;base64,AA')).toBe('jpg')
    expect(imageSrcExtension('https://a.cn/b')).toBe('')
  })

  test('extractBody / maskAppId / mapWxError 回归', () => {
    expect(extractBody('<html><body><p>x</p></body></html>')).toBe('<p>x</p>')
    expect(maskAppId('wx1234567890abcdef')).toBe('wx12****cdef')
    expect(maskAppId('short')).toBe('****')
    expect(mapWxError(40164).hint).toContain('白名单')
    expect(mapWxError(99999).code).toBe('wechat_99999')
  })
})

describe('多账号语义核（token 缓存按账号隔离）', () => {
  function makeSem({ accounts, fetchLog }) {
    return createSemantics({
      config: resolveConfig({
        accounts,
        apiBase: 'https://fake.invalid',
        impls: {},
      }),
      fetchImpl: async (url, init) => {
        fetchLog.push({ url: String(url), body: init?.body })
        return new Response(JSON.stringify({ access_token: `tok-${fetchLog.length}`, expires_in: 7200 }), { status: 200 })
      },
      readFileImpl: async () => new Uint8Array([1]),
      resolveCredential: okCred(new Map([
        ['SECRET_A', 'sec-a'], ['SECRET_B', 'sec-b'], ['WECHAT_MP_APPID', ''],
      ])),
      now: () => 1_000_000,
    })
  }

  test('account 参数选对账号，token 缓存按账号隔离', async () => {
    const fetchLog = []
    const sem = makeSem({
      accounts: [{ name: 'a', appId: 'wxAAA', secretRef: 'SECRET_A' }, { name: 'b', appId: 'wxBBB', secretRef: 'SECRET_B' }],
      fetchLog,
    })
    const r1 = await sem.status({ account: 'a' })
    expect(r1.ok).toBe(true)
    expect(fetchLog[0].body).toContain('wxAAA')
    expect(fetchLog[0].body).toContain('sec-a')
    const r2 = await sem.status({ account: 'b' })
    expect(fetchLog[1].body).toContain('wxBBB')
    expect(fetchLog[1].body).toContain('sec-b')
    // a 再次调用命中缓存（fetch 不再新增 stable_token 请求）
    await sem.status({ account: 'a' })
    expect(fetchLog.length).toBe(2)
  })

  test('缺省账号 = 第一个；未知账号名明确报错', async () => {
    const fetchLog = []
    const sem = makeSem({ accounts: [{ name: 'a', appId: 'wxAAA', secretRef: 'SECRET_A' }], fetchLog })
    const r = await sem.status({})
    expect(r.ok).toBe(true)
    const ghost = await sem.status({ account: 'ghost' })
    expect(ghost.ok).toBe(false)
    expect(ghost.code).toBe('unknown_account')
    expect(ghost.hint).toContain('可用账号')
  })

  test('draft-create 正文预检 fail-fast：超限正文不发起任何微信请求', async () => {
    const fetchLog = []
    const sem = makeSem({ accounts: [{ name: 'a', appId: 'wxAAA', secretRef: 'SECRET_A' }], fetchLog })
    const r = await sem.draftCreate({
      title: 't',
      content: `<p>${'字'.repeat(PRECHECK_MAX_CHARS + 10)}</p>`,
      thumbMediaId: 'thumb_1',
    })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('precheck_failed')
    expect(fetchLog.length).toBe(0) // 一轮草稿往返都省了
  })

  test('draft-create 白名单外图片 fail-fast', async () => {
    const fetchLog = []
    const sem = makeSem({ accounts: [{ name: 'a', appId: 'wxAAA', secretRef: 'SECRET_A' }], fetchLog })
    const r = await sem.draftCreate({
      title: 't',
      content: '<p>hi</p><img src="https://x.cn/a.svg">',
      thumbMediaId: 'thumb_1',
    })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('precheck_failed')
    expect(fetchLog.length).toBe(0)
  })

  test('webp 图片 + 注入转换器 → 自动转 jpg 上传成功', async () => {
    const fetchLog = []
    const sem = makeSem({ accounts: [{ name: 'a', appId: 'wxAAA', secretRef: 'SECRET_A' }], fetchLog })
    // 补素材上传响应：fetch 按序返回 token → add_material
    const sem2 = createSemantics({
      config: resolveConfig({ accounts: [{ name: 'a', appId: 'wxAAA', secretRef: 'SECRET_A' }], apiBase: 'https://fake.invalid' }),
      fetchImpl: async (url, init) => {
        fetchLog.push(String(url))
        if (String(url).includes('stable_token')) {
          return new Response(JSON.stringify({ access_token: 'tok', expires_in: 7200 }), { status: 200 })
        }
        return new Response(JSON.stringify({ media_id: 'm1', url: 'https://mmbiz.qpic.cn/x.jpg' }), { status: 200 })
      },
      readFileImpl: async () => new Uint8Array([1]),
      resolveCredential: okCred(new Map([['SECRET_A', 'sec-a']])),
      convertWebpImpl: async ({ filename }) => ({ bytes: new Uint8Array([9]), filename: String(filename).replace(/\.webp$/, '.jpg'), contentType: 'image/jpeg' }),
      now: () => 1_000_000,
    })
    const dataUrl = 'data:image/webp;base64,AAAA'
    const r = await sem2.draftCreate({ title: 't', content: `<p>x</p><img src="${dataUrl}">`, thumbMediaId: 'thumb_1' })
    expect(r.ok).toBe(true)
    expect(r.uploadedImages[0]).toContain('qpic.cn')
  })

  test('webp 图片 + 未装 sharp → 明确报错提示安装', async () => {
    const sem = createSemantics({
      config: resolveConfig({ accounts: [{ name: 'a', appId: 'wxAAA', secretRef: 'SECRET_A' }], apiBase: 'https://fake.invalid' }),
      fetchImpl: async () => new Response(JSON.stringify({ access_token: 'tok', expires_in: 7200 }), { status: 200 }),
      readFileImpl: async () => new Uint8Array([1]),
      resolveCredential: okCred(new Map([['SECRET_A', 'sec-a']])),
      now: () => 1_000_000,
    })
    const r = await sem.uploadImage({ dataUrl: 'data:image/webp;base64,AAAA' })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('webp_convert_unavailable')
    expect(r.hint).toContain('sharp')
  })
})

describe('渲染器工具（文件读写注入）', () => {
  test('markdown 字符串 → 写文件回绝对路径，可直接当 contentFile', async () => {
    let written = null
    const sem = createSemantics({
      config: resolveConfig({}),
      writeFileImpl: async (path, data) => { written = { path, data } },
      mkdirImpl: async () => {},
      readFileImpl: async () => new Uint8Array([1]),
    })
    const r = await sem.render({ markdown: '# 标题\n\n正文 **加粗**', title: '我的文章' })
    expect(r.ok).toBe(true)
    expect(written.data).toContain('<h1')
    expect(r.outFile).toBe(written.path)
    expect(r.title).toBe('我的文章')
    expect(r.contentFile).toBe(written.path)
  })

  test('mdFile 读取 + frontmatter title + outFile 相对路径解析', async () => {
    let written = null
    const sem = createSemantics({
      config: resolveConfig({}),
      readFileImpl: async () => '---\ntitle: FM 标题\n---\n\n正文',
      writeFileImpl: async (path, data) => { written = { path, data } },
      mkdirImpl: async () => {},
    })
    const r = await sem.render({ mdFile: '/tmp/articles/note.md', outFile: 'out/a.html' })
    expect(r.ok).toBe(true)
    expect(r.title).toBe('FM 标题')
    expect(written.path.endsWith('/out/a.html') || written.path === '/tmp/out/a.html').toBe(true)
  })

  test('无标题（参数与 frontmatter 都没有）拒绝', async () => {
    const sem = createSemantics({ config: resolveConfig({}), writeFileImpl: async () => {}, mkdirImpl: async () => {} })
    const r = await sem.render({ markdown: '正文' })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('missing_title')
  })

  test('渲染结果超限 → 预检拒绝且不落盘', async () => {
    let written = null
    const sem = createSemantics({
      config: resolveConfig({}),
      writeFileImpl: async (p, d) => { written = { p, d } },
      mkdirImpl: async () => {},
    })
    const r = await sem.render({ markdown: `正文 ${'字'.repeat(PRECHECK_MAX_CHARS)}`, title: 't' })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('precheck_failed')
    expect(written).toBe(null)
  })
})
