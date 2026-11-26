// dsh-wechat-mp — Markdown → 公众号兼容 HTML 渲染器（零依赖纯函数核）。
//
// 硬约束：微信后台会剥离 <style> 标签与 class 属性，所有样式必须逐元素内联
// （style 属性）。单主题，覆盖：标题/段落/列表/引用/代码块/表格/图片/链接/
// 加粗斜体/行内代码/分隔线。frontmatter 支持 title（供 draft-create 用）。
//
// 设计纪律：renderMarkdown / extractFrontmatter 为纯函数可直测；文件读写由
// createSemantics 注入（readFileImpl/writeFileImpl），这里不碰 fs。

/** 微信公众号内联主题（逐元素 style 属性）。 */
export const MP_THEME = {
  h1: 'margin: 24px 0 16px; font-size: 22px; font-weight: 700; line-height: 1.4; color: #1a1a1a;',
  h2: 'margin: 20px 0 12px; font-size: 19px; font-weight: 700; line-height: 1.4; color: #1a1a1a; border-left: 4px solid #07c160; padding-left: 10px;',
  h3: 'margin: 16px 0 10px; font-size: 17px; font-weight: 700; line-height: 1.4; color: #1a1a1a;',
  h4: 'margin: 14px 0 8px; font-size: 15px; font-weight: 700; color: #333333;',
  h5: 'margin: 12px 0 8px; font-size: 14px; font-weight: 700; color: #333333;',
  h6: 'margin: 12px 0 8px; font-size: 13px; font-weight: 700; color: #555555;',
  p: 'margin: 0 0 16px; font-size: 15px; line-height: 1.8; letter-spacing: 0.5px; color: #333333; text-align: justify;',
  ul: 'margin: 0 0 16px; padding-left: 22px; font-size: 15px; line-height: 1.8; color: #333333;',
  ol: 'margin: 0 0 16px; padding-left: 22px; font-size: 15px; line-height: 1.8; color: #333333;',
  li: 'margin: 0 0 6px;',
  blockquote: 'margin: 16px 0; padding: 10px 14px; border-left: 4px solid #07c160; background-color: #f7f7f7; font-size: 14px; line-height: 1.8; color: #666666;',
  pre: 'margin: 16px 0; padding: 12px 14px; background-color: #f6f8fa; border-radius: 4px; overflow-x: auto; font-size: 13px; line-height: 1.6;',
  codeInline: 'padding: 2px 5px; background-color: #f0f0f0; border-radius: 3px; font-size: 13px; color: #c7254e;',
  codeBlock: 'font-family: Menlo, Consolas, monospace; white-space: pre-wrap; word-break: break-all; color: #333333; font-size: 13px; line-height: 1.6;',
  table: 'width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 14px;',
  th: 'border: 1px solid #dddddd; padding: 8px 10px; background-color: #f2f2f2; font-weight: 700; text-align: left; color: #333333;',
  td: 'border: 1px solid #dddddd; padding: 8px 10px; color: #333333;',
  img: 'max-width: 100%; border-radius: 4px; display: block; margin: 16px auto;',
  a: 'color: #576b95; text-decoration: none;',
  strong: 'font-weight: 700; color: #1a1a1a;',
  em: 'font-style: italic;',
  hr: 'border: none; border-top: 1px solid #e5e5e5; margin: 24px 0;',
  figcaption: 'text-align: center; font-size: 12px; color: #999999; margin-top: 4px;',
}

/** 解析 frontmatter（--- 包裹的 key: value 头部）。返回 { attrs, body }。 */
export function extractFrontmatter(markdown) {
  const text = String(markdown ?? '')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!match) return { attrs: {}, body: text }
  const attrs = {}
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line.trim())
    if (kv) attrs[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '')
  }
  return { attrs, body: match[2] }
}

// ---- 行内元素 ----

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function escapeAttr(text) {
  return escapeHtml(text).replace(/'/g, '&#39;')
}

/** 行内语法：code → strong → em → 链接 → 图片。先转义再回填占位。 */
export function renderInline(text) {
  let out = escapeHtml(String(text ?? ''))
  const stash = []
  const keep = (html) => `\u0000${stash.push(html) - 1}\u0000`
  // 行内代码
  out = out.replace(/`([^`]+)`/g, (_, code) => keep(`<code style="${MP_THEME.codeInline}">${code}</code>`))
  // 图片 ![alt](src)
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_, alt, src, title) => {
    const cap = title || alt
    const caption = cap ? `<span style="${MP_THEME.figcaption}">${cap}</span>` : ''
    return keep(`<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}" style="${MP_THEME.img}"/>${caption}`)
  })
  // 链接 [text](href)
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) =>
    keep(`<a href="${escapeAttr(href)}" style="${MP_THEME.a}">${label}</a>`))
  // 加粗 / 斜体
  out = out.replace(/\*\*([^*]+)\*\*/g, (_, t) => keep(`<strong style="${MP_THEME.strong}">${t}</strong>`))
  out = out.replace(/__([^_]+)__/g, (_, t) => keep(`<strong style="${MP_THEME.strong}">${t}</strong>`))
  out = out.replace(/\*([^*]+)\*/g, (_, t) => keep(`<em style="${MP_THEME.em}">${t}</em>`))
  out = out.replace(/(^|[\s(（])_([^_]+)_(?=[\s)。，；！？.、：])/g, (m, pre, t) => pre + keep(`<em style="${MP_THEME.em}">${t}</em>`))
  // 换行
  out = out.replace(/ {2}\n/g, '<br/>')
  // 回填
  out = out.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[Number(i)])
  return out
}

/** 单主题 Markdown → 公众号兼容 HTML（逐元素内联样式；无 <style>、无 class）。 */
export function renderMarkdown(markdown, { title } = {}) {
  const { attrs, body } = extractFrontmatter(markdown)
  const docTitle = String(title ?? attrs.title ?? '').trim()
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const blocks = []
  let i = 0

  const flushList = (ordered) => {
    const tag = ordered ? 'ol' : 'ul'
    const items = []
    const itemRe = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/
    while (i < lines.length && itemRe.test(lines[i])) {
      let content = lines[i].replace(itemRe, '')
      // 同一条目的续行（缩进非空且非列表符）
      while (i + 1 < lines.length && lines[i + 1].trim() !== '' && !itemRe.test(lines[i + 1]) && !/^\s*\S/.test(lines[i + 1]) === false) {
        i += 1
        content += ` ${lines[i].trim()}`
      }
      // 宽松处理：非空、非新块开头的缩进续行并入
      while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1])) {
        i += 1
        content += ` ${lines[i].trim()}`
      }
      items.push(`<li style="${MP_THEME.li}">${renderInline(content.trim())}</li>`)
      i += 1
    }
    blocks.push(`<${tag} style="${MP_THEME[tag]}">${items.join('')}</${tag}>`)
  }

  const flushTable = () => {
    const cells = (line) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim())
    const head = cells(lines[i])
    i += 2 // 跳过 |---|---| 分隔行
    const rows = []
    while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
      rows.push(cells(lines[i]))
      i += 1
    }
    const thead = `<tr>${head.map((c) => `<th style="${MP_THEME.th}">${renderInline(c)}</th>`).join('')}</tr>`
    const tbody = rows.map((r) => `<tr>${r.map((c) => `<td style="${MP_THEME.td}">${renderInline(c)}</td>`).join('')}</tr>`).join('')
    blocks.push(`<table style="${MP_THEME.table}"><thead>${thead}</thead><tbody>${tbody}</tbody></table>`)
  }

  const flushFence = () => {
    const langMatch = /^```(\w*)/.exec(lines[i])
    const lang = langMatch?.[1] ?? ''
    i += 1
    const codeLines = []
    while (i < lines.length && !/^```/.test(lines[i])) {
      codeLines.push(lines[i])
      i += 1
    }
    i += 1 // 跳过闭合 ```
    const code = escapeHtml(codeLines.join('\n'))
    const label = lang ? `<span style="display:block;font-size:11px;color:#999999;margin-bottom:6px;">${escapeHtml(lang)}</span>` : ''
    blocks.push(`<pre style="${MP_THEME.pre}">${label}<code style="${MP_THEME.codeBlock}">${code}</code></pre>`)
  }

  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') { i += 1; continue }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const level = heading[1].length
      blocks.push(`<h${level} style="${MP_THEME[`h${level}`]}">${renderInline(heading[2].trim())}</h${level}>`)
      i += 1
      continue
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push(`<hr style="${MP_THEME.hr}"/>`)
      i += 1
      continue
    }
    if (/^\s*[-*+]\s+/.test(line)) { flushList(false); continue }
    if (/^\s*\d+[.)]\s+/.test(line)) { flushList(true); continue }
    if (/^\s*>/.test(line)) {
      const quote = []
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ''))
        i += 1
      }
      blocks.push(`<blockquote style="${MP_THEME.blockquote}">${quote.map((l) => renderInline(l)).join('<br/>')}</blockquote>`)
      continue
    }
    if (/^```/.test(line)) { flushFence(); continue }
    if (line.trim().startsWith('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      flushTable(); continue
    }
    // 段落：合并后续非空且非块级开头的行
    const para = [line]
    while (i + 1 < lines.length && lines[i + 1].trim() !== '' && !/^(#{1,6}\s|```|\s*>|\s*[-*+]\s|\s*\d+[.)]\s|\s*(-{3,}|\*{3,}|_{3,})\s*$)/.test(lines[i + 1])) {
      i += 1
      para.push(lines[i])
    }
    const inner = para.join('\n').split(/\n{1}/).map((l) => renderInline(l)).join('<br/>')
    blocks.push(`<p style="${MP_THEME.p}">${inner}</p>`)
    i += 1
  }

  const bodyHtml = blocks.join('\n')
  if (docTitle) {
    return `<h1 style="${MP_THEME.h1}">${renderInline(docTitle)}</h1>\n${bodyHtml}`
  }
  return bodyHtml
}

/** 抽取正文用的标题（frontmatter title 或参数 title）。 */
export function extractTitle(markdown, argTitle) {
  const { attrs } = extractFrontmatter(markdown)
  return String(argTitle ?? attrs.title ?? '').trim()
}
