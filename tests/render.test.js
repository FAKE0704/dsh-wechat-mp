// render.js 的 keyless 测试（bun test）：渲染器纯函数直测——内联样式 / 元素覆盖 / frontmatter。
import { describe, test, expect } from 'bun:test'
import { renderMarkdown, renderInline, extractFrontmatter, MP_THEME } from '../render.js'

const CLASS_OR_STYLE_TAG = /<style\b/i

describe('硬约束：逐元素内联，无 <style>、无 class', () => {
  const md = [
    '# 标题', '', '## 小节', '', '段落 **加粗** *斜体* `code` [链接](https://x.cn)', '',
    '- 项目一', '- 项目二', '', '1. 第一', '2. 第二', '',
    '> 引用文字', '', '```js', 'const a = 1', '```', '',
    '| A | B |', '|---|---|', '| 1 | 2 |', '',
    '![图](https://x.cn/p.png)', '', '---',
  ].join('\n')
  const html = renderMarkdown(md, { title: 'T' })

  test('无 <style> 标签', () => {
    expect(CLASS_OR_STYLE_TAG.test(html)).toBe(false)
  })

  test('无 class 属性', () => {
    expect(html).not.toMatch(/\bclass\s*=/)
  })

  test('主要元素都带 style 属性（内联）', () => {
    for (const tag of ['h1', 'h2', 'p', 'ul', 'ol', 'li', 'blockquote', 'pre', 'table', 'th', 'td', 'img', 'a', 'strong', 'em', 'hr', 'code']) {
      expect(html).toMatch(new RegExp(`<${tag}[^>]*style="`))
    }
  })

  test('段落样式来自主题（内联值正确）', () => {
    expect(html).toContain(`<p style="${MP_THEME.p}">`)
  })
})

describe('各元素类型', () => {
  test('标题层级 h1-h6', () => {
    const html = renderMarkdown('# a\n## b\n### c\n#### d\n##### e\n###### f')
    for (let i = 1; i <= 6; i++) expect(html).toContain(`<h${i} style=`)
  })

  test('加粗/斜体/行内代码/链接/图片', () => {
    const html = renderInline('**b** *i* `c` [l](https://x) ![alt](https://x.cn/a.png)')
    expect(html).toContain('<strong style=')
    expect(html).toContain('<em style=')
    expect(html).toContain('<code style=')
    expect(html).toContain('href="https://x"')
    expect(html).toContain('<img src="https://x.cn/a.png"')
  })

  test('HTML 特殊字符转义', () => {
    const html = renderMarkdown('a < b & c > d')
    expect(html).toContain('&lt;')
    expect(html).toContain('&amp;')
    expect(html).not.toContain('<b &')
  })

  test('代码块内容转义且不解析行内语法', () => {
    const html = renderMarkdown('```\n**not bold** <tag>\n```')
    expect(html).toContain('<pre')
    expect(html).toContain('**not bold**')
    expect(html).toContain('&lt;tag&gt;')
  })

  test('引用块多行', () => {
    const html = renderMarkdown('> 一\n> 二')
    expect(html).toContain('<blockquote')
    expect(html).toContain('一<br/>二')
  })

  test('表格行数与单元格', () => {
    const html = renderMarkdown('| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |')
    expect((html.match(/<td/g) ?? []).length).toBe(4)
    expect((html.match(/<th[\s>]/g) ?? []).length).toBe(2)
  })

  test('分隔线 hr', () => {
    expect(renderMarkdown('---')).toContain('<hr')
  })

  test('frontmatter 被剥出正文', () => {
    const { attrs, body } = extractFrontmatter('---\ntitle: 我的标题\nauthor: 张三\n---\n\n正文')
    expect(attrs.title).toBe('我的标题')
    expect(body.trim()).toBe('正文')
    const html = renderMarkdown('---\ntitle: FM\n---\n正文')
    expect(html).toContain('正文')
    expect(html).not.toContain('title: FM')
  })
})

describe('标题注入', () => {
  test('title 参数 → 顶部 h1', () => {
    const html = renderMarkdown('正文', { title: 'T' })
    expect(html.startsWith('<h1')).toBe(true)
    expect(html).toContain('T</h1>')
  })

  test('frontmatter title 与参数并存时参数优先', () => {
    const html = renderMarkdown('---\ntitle: FM\n---\n正文', { title: 'ARG' })
    expect(html).toContain('ARG</h1>')
    expect(html).not.toContain('FM</h1>')
  })

  test('无标题时不注入 h1', () => {
    expect(renderMarkdown('正文').startsWith('<p')).toBe(true)
  })
})
