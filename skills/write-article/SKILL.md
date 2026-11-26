---
name: write-article
description: CreatorStack 公众号长文写作——按 editorial 的支柱骨架与语气规范成稿，写前读规范、交付前自检（标题≤24字/导语≤50字/来源/合规/AI标注）。交付链分环境：CreatorStack 真源机走 typeset-article + 两阶段闸；DSH 环境走 wechat-mp-render → 预览 → 草稿箱（配套交付规范 skill：wechat-mp-article）。Use when user say 写稿/写文章/公众号文章/把这个选题写成稿/文章语气/内容编排/改稿/写一篇解读.
---

# write-article（公众号长文写作）

> 只负责**文字与结构**。排版/发布按环境分流：CreatorStack 真源机交 `typeset-article`（保原文不改写）+ 两阶段闸；**DSH 环境**走 `wechat-mp-render → wechat-mp-preview → 草稿箱`（见「交付链 · DSH 分支」），交付格式规范见同插件 skill `wechat-mp-article`。
> 仓库根：CreatorStack 真源机 = `/home/user0704/CreatorStack`（下文该机路径均相对此根）；**DSH 环境没有这个仓库，真源机命令全部不可用，不要尝试执行**——editorial 规范随本 skill 分发在 `references/` 下（绝对路径见文末资源索引）。

## 前置：写之前必读（勿凭记忆复述规则）

1. `references/editorial.md` —— 编辑方针：§3 内容支柱 / §4 语气与品牌边界 / §5 平台格式 / §7 合规红线。
   **渐进阅读条件**（绝对路径见文末「资源索引」，用 read 工具读取）：
   - 写新稿 → **全文精读后再动笔**（这是动笔前的第一步，跳过即违规）
   - 改稿 / 改语气 → 只读 §4 语气与品牌边界 + §7 合规红线
   - 纯排版 / 纯交付 → 只查 §5 平台格式
   - 文件读不到时 → 按本 skill 正文的骨架/语气/合规节执行，勿重试、勿凭记忆复述细节
2. **事实来源纪律**：一手材料优先（官方发布页、官方文档、仓库代码/提交）；查不到就写「待验证/据说」，**不编数字、不伪装实测**
3. 格式硬指标（公众号）：标题 **≤24 字**（按字符计，含英文与标点）、导语 **≤50 字**

## 写作骨架（按支柱选一个，不要混搭）

| 支柱 | 骨架（按顺序写） |
|---|---|
| P1 AI 工作流实操 | 场景痛点 → 可复制步骤（命令/提示词原文） → 结果与代价 → 适用边界 |
| P2 商业案例与转型 | 谁 → 在哪个环节 → 改了什么 → 省了什么/付了什么代价 → 可迁移结论 |
| P3 工具与产品观察 | 一句话是什么 → 这次的真实变化（前后对比） → 对谁有用 → 对谁没用（给不推荐的理由） |
| P4 行业趋势与判断 | 事件（来源+日期） → 变化点 → 为什么重要 → 我的判断 → 边界声明 |

- 热点只作入口：不要写成纯资讯搬运，必须落到「对读者意味着什么」。
- 单篇只服务一个支柱；跨支柱就拆篇。

## 语气（editorial §4 + 既有风格约束）

- **第一人称、口语、短句**；先给结论，再给理由；数字给区间，不造虚假精确值
- **承认不确定**：没实测的写「据说/待验证」；实测过的标「我跑了 N 次」
- **少用比喻**，语气平稳；不喊口号、不制造对立、不贩卖焦虑
- 观点与事实**分段**：观点集中到「我的看法」一节，事实段只写可核内容

## 结构硬约束

- 导语（正文第一段）≤50 字，**第一句就是结论**
- 小节 3-5 个，标题连续编号 `1. / 2. / 3.`，每节先结论后展开
- 段落 ≤3 行（手机屏观感）；列表只用于并列项或步骤
- 引用官方原文用引用块，注明来源与日期；文末列「资料来源」
- 不写「点击下方」「关注我」等诱导话术；不出现站外导流

## 合规自检（逐条打勾，任一不过就不交付）

- [ ] 无绝对化用语（最/第一/顶级/全网唯一/100% 等）、无收益承诺
- [ ] 对比、排名、效果均可举证；不能举证就删
- [ ] 每个事实有来源（链接+日期），推断标「我认为/可能」
- [ ] 无站外导流（微信/QQ/手机号/二维码）
- [ ] AI 生成的图/文按要求标注（如「封面由 AI 生成」）
- [ ] 封面大字 ≤8 字，不含未授权商标/人脸/影视截图

## 交付链（写完不要自己发布；按环境二选一，不要混用）

### CreatorStack 真源机

```
1. 草稿落盘      docs/drafts/YYYY-MM-DD-<slug>.md（真源，入库）
2. 排版          cd frontend && npm run typeset -- ../docs/drafts/<file>.md --out ../docs/drafts/<out>
                 （退出码 2 = 内容阻断，按 report.md 行号回原文件改；不删内容、不重试）
3. 直推草稿箱    ./deploy/scripts/run-baremetal.sh ../core/.venv/bin/python ../scripts/push_mp_draft.py \
                   --body <out>/article-body.html --title "标题" --digest "摘要" [--thumb-url 封面] [--content-id 旧稿]
                 （图片自动转永久素材；**不依赖 preview.html 中间态**；脚本不发布）
4. 发布闸        publish_prepare → 把预览（内容/产物/账号/平台/时间/task_ids）完整呈现给人
                 → 明确同意才 publish_confirm；个人主体公众号 API 只能到草稿，真发由人工后台点「发表」
5. 数据回读      个人主体无 datacube → 后台 CSV → scripts/import_mp_stats.py（operations §9）
```

### DSH 环境（本插件工具链；没有 CreatorStack 仓库，上面真源机的命令不要尝试执行）

```
1. 草稿落盘      <当前工作区>/YYYY-MM-DD-<slug>.md（中间产物，title 写进 frontmatter）
2. 渲染排版      wechat-mp-render { mdFile } → 全内联样式 HTML（渲染即预检；**保原文不改写**——文字问题回本 skill 改）
3. 预览审查      wechat-mp-preview 推到 GUI「公众号 → 预览」页——**标准收尾动作**：
                 用户审查正文、补封面，点「推送到草稿箱」；用户明确要求跳过预览时才可 wechat-mp-draft-create
                 （封面 thumbFile/thumbUrl 自动上传永久素材，与真源机 --thumb-url 等价）
4. 发布闸        wechat-mp-publish（恒过人工审批门 = 两阶段闸的人工环节）→ wechat-mp-publish-status 查结果；
                 个人主体公众号 API 只能到草稿，真发由人工后台点「发表」
5. 数据回读      DSH 环境暂无脚本；个人主体无 datacube，后台 CSV 人工处理
```

两个分支共同点：**绝不自动发布不可撤销的内容**；骨架/语气/合规纪律完全一致。

## 交付前自检清单

- [ ] 标题字符数 ≤24、导语 ≤50
- [ ] 事实/数字有来源或「待验证」标记
- [ ] 观点未混进事实段
- [ ] 无诱导关注、站外导流、绝对化用语
- [ ] 排版已过预检（CreatorStack：typeset 的 report.md 无阻断；DSH：wechat-mp-render/precheck 通过）
- [ ] 草稿 md 已落盘（CreatorStack：docs/drafts/ 入库；DSH：工作区留存）

## 与其它 skill 的边界

- `wechat-mp-article`（同插件内置）：**交付格式规范**——完成态=草稿箱草稿、render→preview→草稿链路细节、封面规则、工具结果 mediaId 读法。写公众号文章时**两个都读**：本 skill 管写什么/怎么写，它管怎么交付。
- `typeset-article`：CreatorStack 真源机的排版 skill，只管版式**保原文**——文字问题回本 skill 改，别在排版层动字；DSH 环境没有它，由 `wechat-mp-render` 承担同一原则。
- `dreamina-cli`：CreatorStack 环境的封面/配图生成，消耗积分，生成前须用户确认；DSH 环境没有它，封面直接给本地图（thumbFile/thumbUrl）。
- `creatorstack-ops`：CreatorStack 运营 SOP 与工具地图（DSH 环境不适用）；本 skill 只负责「写」这一环。
