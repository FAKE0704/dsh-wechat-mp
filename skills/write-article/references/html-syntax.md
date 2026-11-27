# 微信公众号 HTML 语法规则（样式存活矩阵）

> 摘自 CreatorStack typeset-article 技能附录 E，2026-11-23 实测校对：手写内联 HTML → `draft/add` → `draft/get` 全链对比。
> 做版式以这张表为边界：卡片用 `<section style>`、徽章用 `<span style="display:inline-block">`、强调用渐变底色、**不要用绝对定位**。
> 实验载荷：`references/style-ceiling.html`（A01–A20 支持性探针，可 `wechat-mp-draft-create` 实机复验）。

### E. 微信端样式存活（2026-11-23 实测：手写内联 HTML → `draft/add` → `draft/get` 对比）

| 保留 | 被剥/被拒 |
|---|---|
| `linear-gradient`、`box-shadow`、`border-radius`、`background-clip:text`、`float`、`border-*`、`display:inline-block`、`font-family`、`overflow:hidden`、`<code>`、`<pre>`、`<table>/<thead>` | **`<a>` 整条剥掉**（内层 span 保留）；**`position:absolute` 被剥**（定位类装饰会错位）；**外域 `<img src>` 静默丢弃**；**`<tr>` 上的背景色不生效**（必须把 `background-color` 写在 `th`/`td` 上）；伪造 `mp.weixin.qq.com` 链接 `draft/add` 直接 `45166` 拒收 |

做「好看的版式」就以这张表为边界：卡片用 `<section style>`、徽章用 `<span style="display:inline-block">`、
强调用渐变底色，**不要用绝对定位**。实验载荷：`references/style-ceiling.html`（A01–A20，本 skill 目录内）。
