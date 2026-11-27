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

  test('webp 图片 + 随包 sharp（optionalDependencies）→ 默认转换器自动转 jpg', async () => {
    // sharp 自 V0.5.0 起随包声明安装；没装的环境自动跳过本用例（见降级契约用例）
    const hasSharp = await import('sharp').then(() => true, () => false)
    const run = hasSharp ? test : test.skip
    const sharp = hasSharp ? (await import('sharp')).default : null
    const webp = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#fff' } }).webp().toBuffer()
    const dataUrl = `data:image/webp;base64,${Buffer.from(webp).toString('base64')}`
    const { sem } = makeRoutedSem([['add_material', { media_id: 'm1', url: 'https://mmbiz.qpic.cn/x.jpg' }]])
    const r = await sem.uploadImage({ dataUrl })
    expect(r.ok).toBe(true)
    expect(r.filename.endsWith('.jpg')).toBe(true)
  })

  test('webp 转换器不可用（手工拷贝安装没带 sharp）→ 明确报错提示安装', async () => {
    // 缺省转换器在 sharp 缺失时抛 webp_convert_unavailable；这里注入同形抛错验证降级契约：
    // 转换器的 WechatMpError 要原样冒泡成 {ok:false, code, hint}，不静默猜测。
    const sem = createSemantics({
      config: resolveConfig({ accounts: [{ name: 'a', appId: 'wxAAA', secretRef: 'SECRET_A' }], apiBase: 'https://fake.invalid' }),
      fetchImpl: async () => new Response(JSON.stringify({ access_token: 'tok', expires_in: 7200 }), { status: 200 }),
      readFileImpl: async () => new Uint8Array([1]),
      resolveCredential: okCred(new Map([['SECRET_A', 'sec-a']])),
      convertWebpImpl: async () => {
        throw new WechatMpError('webp_convert_unavailable',
          'webp 图片需要转换成 jpg，但可选依赖 sharp 未安装',
          '安装一次即可：bun add sharp（或 npm i sharp）；或先把 webp 手工转成 jpg/png 再传')
      },
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

describe('预览推送工具（不发网络、不落盘）', () => {
  test('markdown → 预检通过，返回 html 与草稿参数透传', async () => {
    const sem = createSemantics({ config: resolveConfig({}) })
    const r = await sem.preview({ markdown: '# 标题\n\n正文 **加粗**', title: '预览文', author: '甲', thumbFile: '/tmp/c.jpg' })
    expect(r.ok).toBe(true)
    expect(r.title).toBe('预览文')
    expect(r.html).toContain('<h1')
    expect(r.author).toBe('甲')
    expect(r.thumbFile).toBe('/tmp/c.jpg')
    expect(r.chars).toBeGreaterThan(0)
  })

  test('HTML 正文路径 + 无标题拒绝 + markdown/HTML 互斥', async () => {
    const sem = createSemantics({ config: resolveConfig({}), readFileImpl: async () => '<p>来自文件</p>' })
    const ok = await sem.preview({ contentFile: '/tmp/a.html', title: 'T' })
    expect(ok.ok).toBe(true)
    expect(ok.html).toContain('来自文件')

    const noTitle = await sem.preview({ content: '<p>x</p>' })
    expect(noTitle.ok).toBe(false)
    expect(noTitle.code).toBe('missing_title')

    const both = await sem.preview({ markdown: '# t\n\nx', content: '<p>x</p>', title: 'T' })
    expect(both.ok).toBe(false)
    expect(both.code).toBe('bad_arg')
  })

  test('超限正文 → precheck_failed', async () => {
    const sem = createSemantics({ config: resolveConfig({}) })
    const r = await sem.preview({ content: `<p>${'字'.repeat(PRECHECK_MAX_CHARS + 10)}</p>`, title: 't' })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('precheck_failed')
  })
})

// ---- V0.5.0：lossless 输出边界 / message 摘要 / draft-update 封面沿用与孤儿清理 ----

/** 按路径片段路由的 fetch 注入：记录每次调用（路径+body），命中片段返回 JSON。 */
function makeRoutedSem(routes) {
  const calls = []
  const sem = createSemantics({
    config: resolveConfig({ accounts: [{ name: 'a', appId: 'wxAAA', secretRef: 'SECRET_A' }], apiBase: 'https://fake.invalid' }),
    fetchImpl: async (url, init) => {
      const u = String(url)
      const bodyText = typeof init?.body === 'string' ? init.body : ''
      calls.push(`${u.replace('https://fake.invalid', '').split('?')[0]} ${bodyText}`)
      if (u.includes('stable_token')) {
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 7200 }), { status: 200 })
      }
      for (const [needle, body] of routes) {
        if (u.includes(needle)) {
          const payload = typeof body === 'function' ? body(bodyText) : body
          return new Response(JSON.stringify(payload), { status: 200 })
        }
      }
      return new Response(JSON.stringify({ errcode: 0 }), { status: 200 })
    },
    readFileImpl: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    resolveCredential: okCred(new Map([['SECRET_A', 'sec-a']])),
    now: () => 1_000_000,
  })
  return { sem, calls }
}

const countCalls = (calls, needle) => calls.filter((c) => c.includes(needle)).length

describe('工具输出 lossless 边界 + message 摘要（V0.5.0）', () => {
  test('precheck 通过 → 无显式 hint 键（lossless JSON 可序列化）', async () => {
    const sem = createSemantics({ config: resolveConfig({}) })
    const r = await sem.precheck({ content: '<p>你好</p>' })
    expect(r.ok).toBe(true)
    expect(Object.prototype.hasOwnProperty.call(r, 'hint')).toBe(false)
    // dsh 工具结果边界等价检查：JSON 往返无损
    expect(JSON.parse(JSON.stringify(r))).toEqual(r)
  })

  test('precheck 有问题 → hint 取第一条建议，且整单可无损序列化', async () => {
    const sem = createSemantics({ config: resolveConfig({}) })
    const r = await sem.precheck({ content: `<p>${'字'.repeat(PRECHECK_MAX_CHARS + 1)}</p>` })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('precheck_failed')
    expect(r.hint).toContain('删减')
    expect(JSON.parse(JSON.stringify(r))).toEqual(r)
  })

  test('precheck contentFile 传法同样不再报 invalid output（回归：hint 键）', async () => {
    const sem = createSemantics({ config: resolveConfig({}), readFileImpl: async () => '<p>来自文件</p>' })
    const r = await sem.precheck({ contentFile: '/tmp/a.html' })
    expect(r.ok).toBe(true)
    expect(JSON.parse(JSON.stringify(r))).toEqual(r)
  })

  test('draft-list message 逐篇带「N. 标题（mediaId=…）」', async () => {
    const { sem } = makeRoutedSem([
      ['draft/batchget', {
        total_count: 2,
        item: [
          { media_id: 'mid_1', content: { news_item: [{ title: '第一篇', author: '甲', digest: 'd1', thumb_media_id: 't1' }] } },
          { media_id: 'mid_2', content: { news_item: [{ title: '', author: '', digest: '', thumb_media_id: '' }] } },
        ],
      }],
    ])
    const r = await sem.draftList({})
    expect(r.ok).toBe(true)
    expect(r.total).toBe(2)
    expect(r.message).toContain('草稿箱共 2 篇')
    expect(r.message).toContain('1. 第一篇（mediaId=mid_1）')
    expect(r.message).toContain('2. （无标题）（mediaId=mid_2）')
  })

  test('draft-get message 带 mediaId 与封面 thumbMediaId', async () => {
    const { sem } = makeRoutedSem([
      ['draft/get', { news_item: [{ title: '标题甲', author: '乙', thumb_media_id: 'thumb_9' }] }],
    ])
    const r = await sem.draftGet({ mediaId: 'mid_9' })
    expect(r.ok).toBe(true)
    expect(r.mediaId).toBe('mid_9')
    expect(r.message).toContain('mediaId=mid_9')
    expect(r.message).toContain('封面 thumbMediaId=thumb_9')
    expect(r.message).toContain('作者 乙')
  })

  test('draft-get outFile → 全文 HTML 落盘回路径（改稿拉回全文，吸收 fetch_draft.py）', async () => {
    let written = null
    const sem = createSemantics({
      config: resolveConfig({ accounts: [{ name: 'a', appId: 'wxAAA', secretRef: 'SECRET_A' }], apiBase: 'https://fake.invalid' }),
      fetchImpl: async (url) => {
        const u = String(url)
        if (u.includes('stable_token')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 7200 }), { status: 200 })
        if (u.includes('draft/get')) return new Response(JSON.stringify({ news_item: [{ title: '长文', thumb_media_id: 't1', content: '<p>正文HTML全文</p>' }] }), { status: 200 })
        return new Response(JSON.stringify({ errcode: 0 }), { status: 200 })
      },
      writeFileImpl: async (p, d) => { written = { path: p, data: d } },
      mkdirImpl: async () => {},
      resolveCredential: okCred(new Map([['SECRET_A', 'sec-a']])),
      now: () => 1_000_000,
    })
    const r = await sem.draftGet({ mediaId: 'mid_x', outFile: 'out/draft.html' })
    expect(r.ok).toBe(true)
    expect(r.content).toBe('<p>正文HTML全文</p>')
    expect(r.contentFile).toBe(written.path)
    expect(r.contentFile.endsWith('out/draft.html')).toBe(true)
    expect(r.message).toContain(`全文 ${r.contentChars} 字符已写入`)
    expect(r.message).toContain(r.contentFile)
  })

  test('draft-get 不给 outFile → 不落盘，message 只带 ≤160 字预览', async () => {
    const sem = createSemantics({
      config: resolveConfig({ accounts: [{ name: 'a', appId: 'wxAAA', secretRef: 'SECRET_A' }], apiBase: 'https://fake.invalid' }),
      fetchImpl: async (url) => {
        const u = String(url)
        if (u.includes('stable_token')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 7200 }), { status: 200 })
        if (u.includes('draft/get')) return new Response(JSON.stringify({ news_item: [{ title: '长文', content: `<p>${'字'.repeat(300)}</p>` }] }), { status: 200 })
        return new Response(JSON.stringify({ errcode: 0 }), { status: 200 })
      },
      resolveCredential: okCred(new Map([['SECRET_A', 'sec-a']])),
      now: () => 1_000_000,
    })
    const r = await sem.draftGet({ mediaId: 'mid_x' })
    expect(r.ok).toBe(true)
    expect(r.message).toContain('正文预览：')
    expect(r.message).toContain('…')
    expect(r.contentFile).toBeUndefined() // 没给 outFile 就不落盘
  })
})

describe('draft-update 封面沿用与孤儿素材清理（V0.5.0）', () => {
  const BASE_ROUTES = (extra = []) => [
    ['draft/get', { news_item: [{ title: '旧标题', thumb_media_id: 'old_thumb' }] }],
    ['draft/add', { media_id: 'new_mid' }],
    ['draft/delete', { errcode: 0 }],
    ['del_material', { errcode: 0 }],
    ...extra,
  ]

  test('缺 thumb 参数 → 回读旧草稿封面沿用，不新传素材', async () => {
    const { sem, calls } = makeRoutedSem(BASE_ROUTES())
    const r = await sem.draftUpdate({ mediaId: 'old_mid', title: '新标题', content: '<p>x</p>' })
    expect(r.ok).toBe(true)
    expect(r.mediaId).toBe('new_mid')
    expect(r.thumbMediaId).toBe('old_thumb')
    expect(r.reusedThumbMediaId).toBe('old_thumb')
    expect(r.message).toContain('封面沿用旧草稿素材')
    // draft/get 读旧封面；draft/add 的 articles 里 thumb_media_id = 旧值
    expect(countCalls(calls, 'draft/get')).toBe(1)
    const addCall = calls.find((c) => c.includes('draft/add'))
    expect(addCall).toContain('old_thumb')
    expect(countCalls(calls, 'add_material')).toBe(0) // 没有重传封面素材
    expect(countCalls(calls, 'del_material')).toBe(0) // 沿用中的素材不清理
  })

  test('给了新封面 thumbFile → 上传新素材；旧素材无其他引用时被清理', async () => {
    const { sem, calls } = makeRoutedSem(BASE_ROUTES([
      ['add_material', { media_id: 'new_thumb', url: 'https://mmbiz.qpic.cn/new.jpg' }],
      ['draft/batchget', { total_count: 0, item: [] }], // 箱里已无其他草稿引用旧封面
    ]))
    const r = await sem.draftUpdate({ mediaId: 'old_mid', title: '新标题', content: '<p>x</p>', thumbFile: '/tmp/cover.png' })
    expect(r.ok).toBe(true)
    expect(r.thumbMediaId).toBe('new_thumb')
    expect(r.releasedThumbMediaId).toBe('old_thumb')
    expect(r.message).toContain('旧封面素材已清理')
    expect(countCalls(calls, 'add_material')).toBe(1)
    const delCall = calls.find((c) => c.includes('del_material'))
    expect(delCall).toContain('old_thumb')
  })

  test('旧封面仍被其他草稿引用 → 不清理（防误删共享素材）', async () => {
    const { sem, calls } = makeRoutedSem(BASE_ROUTES([
      ['add_material', { media_id: 'new_thumb', url: 'https://mmbiz.qpic.cn/new.jpg' }],
      ['draft/batchget', {
        total_count: 1,
        item: [{ media_id: 'other_mid', content: { news_item: [{ title: '别的稿', thumb_media_id: 'old_thumb' }] } }],
      }],
    ]))
    const r = await sem.draftUpdate({ mediaId: 'old_mid', title: '新标题', content: '<p>x</p>', thumbFile: '/tmp/cover.png' })
    expect(r.ok).toBe(true)
    expect(r.thumbMediaId).toBe('new_thumb')
    expect(r.releasedThumbMediaId).toBeUndefined()
    expect(countCalls(calls, 'del_material')).toBe(0)
  })

  test('旧草稿删除失败 → 旧稿仍引用封面，跳过清理', async () => {
    const routes = [
      ['draft/get', { news_item: [{ title: '旧标题', thumb_media_id: 'old_thumb' }] }],
      ['add_material', { media_id: 'new_thumb', url: 'https://mmbiz.qpic.cn/new.jpg' }],
      ['draft/add', { media_id: 'new_mid' }],
      ['draft/delete', { errcode: 40007, errmsg: 'invalid media_id' }],
      ['del_material', { errcode: 0 }],
    ]
    const { sem, calls } = makeRoutedSem(routes)
    const r = await sem.draftUpdate({ mediaId: 'old_mid', title: '新标题', content: '<p>x</p>', thumbFile: '/tmp/cover.png' })
    expect(r.ok).toBe(true)
    expect(r.removed).toBe(false)
    expect(r.warning).toContain('旧草稿删除失败')
    expect(countCalls(calls, 'del_material')).toBe(0)
    expect(countCalls(calls, 'draft/batchget')).toBe(0)
  })

  test('旧草稿已不存在（封面读不到）+ 缺 thumb → 原样报 missing_thumb', async () => {
    const { sem, calls } = makeRoutedSem([
      ['draft/get', { errcode: 40007, errmsg: 'invalid media_id' }],
      ['draft/add', { media_id: 'new_mid' }],
    ])
    const r = await sem.draftUpdate({ mediaId: 'ghost_mid', title: '新标题', content: '<p>x</p>' })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('missing_thumb')
    expect(countCalls(calls, 'draft/add')).toBe(0)
  })
})
