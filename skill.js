// dsh-wechat-mp — 内置 skill：公众号文章交付格式规范。
//
// 动机（V0.5.0 实操复盘）：插件工具面齐了，但模型缺一条「交付物是什么」的纪律，
// 写完文章把本地 .md 当成最终交付物收尾，跳过 render/preview/草稿链路。
// 这个 skill 把交付格式固化成模型可见的指令，随插件注册（ctx.skills.register），
// 宿主没有 skill 服务时自动跳过，不影响工具面。

export const WECHAT_MP_SKILL_NAME = 'wechat-mp-article'

export const WECHAT_MP_SKILL_DESCRIPTION =
  '写/改微信公众号文章的交付格式规范：最终交付物是公众号草稿箱里的草稿（预览页「推送到草稿箱」或 draft-create 的 media_id），不是本地 .md/.html 文件；标准链路 render → preview → 草稿。'

export const WECHAT_MP_SKILL_WHEN_TO_USE =
  '用户要写、修改、排版公众号文章，或要求推草稿/预览公众号效果时加载。'

export const WECHAT_MP_SKILL_CONTENT = `# 公众号文章交付规范（dsh-wechat-mp）

## 交付物定义

完成态 = **公众号草稿箱里的草稿**（拿到 \`media_id\` 并向用户汇报），不是本地文件。
\`.md\` 源稿和 render 出的 \`.html\` 都是**中间产物**，可以留在工作区供复改，但不能作为收尾——
不要在写完 Markdown 后就停下交付。

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

## 红线

- 禁止把本地 \`.md\`/\`.html\` 当最终交付物宣布完成。
- 禁止未经 preview 直接 draft-create（用户明确要求除外）。
- \`publish\` 恒过人工审批门：绝不自动发表，发布后不可撤销。
`
