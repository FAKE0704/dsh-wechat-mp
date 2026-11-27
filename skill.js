// dsh-wechat-mp — 内置 skill：公众号文章交付格式规范。
//
// 动机（V0.5.0 实操复盘）：插件工具面齐了，但模型缺一条「交付物是什么」的纪律，
// 写完文章把本地 .md 当成最终交付物收尾，跳过 render/preview/草稿链路。
// 这个 skill 把交付格式固化成模型可见的指令，随插件注册（ctx.skills.register），
// 宿主没有 skill 服务时自动跳过，不影响工具面。
//
// 另有 skills/ 目录下的文件形态 skill（当前 = write-article，公众号长文写作规范）：
// DSH 的 skill 扫描根不含 <包>/skills/，文件形态在 dsh 里不可达，所以这里一并做
// 运行时注册（读包内文件，缺失/损坏时返回 null 跳过，不拖垮插件加载）。

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const WECHAT_MP_SKILL_NAME = 'wechat-mp-article'

export const WECHAT_MP_SKILL_DESCRIPTION =
  '写/改微信公众号文章的交付格式规范（内容/结构/语气规范见 write-article skill，写作任务两者配合读）：最终交付物是公众号草稿箱里的草稿（预览页「推送到草稿箱」或 draft-create 的 media_id），不是本地 .md/.html 文件；标准链路 render → preview → 草稿。'

export const WECHAT_MP_SKILL_WHEN_TO_USE =
  '交付链路问题（渲染/预览/推草稿/封面/mediaId/发布）加载本 skill；写稿的内容、结构、语气先读 write-article。'

export const WECHAT_MP_SKILL_CONTENT = `# 公众号文章交付规范（dsh-wechat-mp）

> 分工：**写什么/怎么写**（骨架、语气、合规）见同插件 skill \`write-article\`——写作任务两个都读；
> 本 skill 只管**怎么交付**。

## 交付物定义

完成态 = **公众号草稿箱里的草稿**（拿到 \`media_id\` 并向用户汇报），不是本地文件。
\`.md\` 源稿和 render 出的 \`.html\` 都是**中间产物**，可以留在工作区（或按 write-article 的约定落盘入库）供复改，
但宣布完成前必须已经推进到草稿箱——不要在写完 Markdown 后就停下交付。

## 标准链路（按序）

1. **写正文**：Markdown（带 \`title\` frontmatter）或直接写 HTML 片段。
2. **渲染**：\`wechat-mp-render\`（md → 全内联样式的公众号兼容 HTML；微信后台会剥 <style>/class，所以必须走它，不能手工贴 md）。
3. **预览**：\`wechat-mp-preview\` 推到 GUI 侧边栏「公众号 → 预览」给用户审查——这是写完正文后的**标准收尾动作**，不要跳过它直接 draft-create（用户明确要求跳过预览时除外）。
4. **成稿**：用户在预览页补封面、点「推送到草稿箱」（或你按用户指示调 \`wechat-mp-draft-create\`），拿到草稿 \`media_id\` 汇报。
5. **发布**（仅当用户明确要求发表）：\`wechat-mp-publish\` 走人工审批门；个人主体公众号恒 48001，只能在公众号后台人工点发表。

## 封面规则（草稿接口只认永久素材）

- 支持格式：jpg/jpeg/png/gif/bmp；**webp 不认**（DSH 附件规范化副本固定是 webp）——本机装了可选依赖 sharp 时插件自动转 jpg，没装则先把图转成 jpg/png 再传。
- 传 \`thumbFile\`/\`thumbUrl\` 自动上传为永久素材；已有素材直接给 \`thumbMediaId\`。
- \`wechat-mp-draft-update\` **不给封面 = 自动沿用旧草稿封面**，不需要重传图片。

## 工具结果读法

- 工具结果对模型只显示 \`message\`（+ \`hint\`）；**mediaId 等关键字段已编进 message**：
  \`draft-list\` 逐篇给「N. 标题（mediaId=xxx）」，\`draft-get\`/\`draft-create\`/\`draft-update\` 的 message 都带 mediaId——直接从 message 取 id，不要试图解析结构化 JSON，也不要翻历史会话。
- 预检（\`wechat-mp-precheck\`）：error 级问题必须处置后再推；warn 级（webp）交给自动转换。

## 改稿（从草稿箱拉回全文）

- \`wechat-mp-draft-get { mediaId, outFile: "<path>" }\`：正文全文 HTML 落盘到该本地文件，message 回路径与字符数——用 read 工具查看后改；不给 outFile 时只有一行摘要（mediaId/封面/作者/160 字预览）。
- md 源稿还在工作区时优先改 md，走 render → preview → draft-update；源稿丢了才从草稿箱拉回全文。
- 改完 \`wechat-mp-draft-update { mediaId, contentFile: <新 HTML> }\`：不给封面自动沿用旧草稿封面，不再被引用的旧封面素材自动清理。

## 红线

- 禁止把本地 \`.md\`/\`.html\` 当最终交付物宣布完成。
- 禁止未经 preview 直接 draft-create（用户明确要求除外）。
- \`publish\` 恒过人工审批门：绝不自动发表，发布后不可撤销。
`

/**
 * 读取包内 skills/<dir>/ 下的文件形态 skill（apply 期同步读一次）。
 * @param {string} dir skills/ 下的子目录名
 * @returns {{name: string, description: string, content: string} | null} 文件缺失/无 frontmatter 时 null
 */
export function loadBundledSkill(dir) {
  try {
    const base = join(dirname(fileURLToPath(import.meta.url)), 'skills', dir)
    const raw = readFileSync(join(base, 'SKILL.md'), 'utf8')
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw)
    if (!match) return null
    const meta = {}
    for (const line of match[1].split(/\r?\n/)) {
      const hit = /^(name|description):\s*(.+)$/.exec(line.trim())
      if (hit) meta[hit[1]] = hit[2].trim()
    }
    if (!meta.name || !meta.description) return null
    const body = raw.slice(match[0].length).trim()
    // instructions.md（旧布局）裸拼。references/ 不内联正文，只注入「带绝对路径的资源
    // 索引」：模型按 SKILL.md 声明的阅读条件用 read 工具按需精读（渐进注入），resourceBase
    // 同时交给宿主做资源定位。全量内联会让每次写稿任务常驻全部参考材料，不值得。
    const parts = [body]
    try {
      parts.push(readFileSync(join(base, 'instructions.md'), 'utf8').trim())
    } catch { /* instructions.md 可选 */ }
    const references = []
    try {
      const refs = readdirSync(join(base, 'references')).filter((f) => f.endsWith('.md')).sort()
      for (const ref of refs) {
        const rawRef = readFileSync(join(base, 'references', ref), 'utf8')
        const heading = /^#\s+(.+)$/m.exec(rawRef)
        const title = (heading ? heading[1] : ref).trim().slice(0, 60)
        references.push({ file: `references/${ref}`, path: join(base, 'references', ref), title })
      }
    } catch { /* references/ 可选 */ }
    if (references.length > 0) {
      const lines = references.map((r) => `- \`${r.file}\` → ${r.path}（${r.title}）`)
      parts.push(`## 资源索引（渐进注入：按正文声明的阅读条件用 read 工具精读对应文件，勿凭记忆复述）\n\n${lines.join('\n')}`)
    }
    return {
      name: meta.name,
      description: meta.description,
      ...(references.length > 0 ? { resourceBase: { kind: 'directory', path: base } } : {}),
      content: parts.filter(Boolean).join('\n\n'),
    }
  } catch {
    return null
  }
}
