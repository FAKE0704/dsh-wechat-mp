# dsh-wechat-mp

微信公众号**文章**域 dsh 插件：在 dsh 会话里直接把文章推进公众号草稿箱、替换/删除草稿、提交发布并跟踪发布状态——八个原生工具，**直连微信开放接口**，不依赖任何宿主平台（不需要 CreatorStack、不需要 MCP server、不需要额外后端）。

真源 = [Genshu monorepo](https://github.com/FAKE0704/Genshu) 的 `packages/dsh-plugins/dsh-wechat-mp`（公共仓 [FAKE0704/dsh-wechat-mp](https://github.com/FAKE0704/dsh-wechat-mp) 为镜像，经 `scripts/publish-dsh-wechat-mp.sh` 幂等组装推送）。

## 它解决什么问题

写公众号最烦的不是写，是「贴进后台」：正文图片要一张张传素材、外域图片会被后台静默丢掉、封面必须是永久素材 id、草稿替换没有干净入口。本插件把这些步骤固化进工具面：

- **正文图片自动转素材**：外域/本地/`data:` 图片先 `material/add_material`，再把 `src` 改写成 `mmbiz.qpic.cn` 地址——公众号接口会**静默丢弃**外域图片，这一步不做就是「草稿里没图」；
- **封面自动兜底**：草稿接口只认 `thumb_media_id`（传 URL 会 `40007`），给本地文件或网络图片即可自动上传换 id；
- **正文可以直接给文件路径**：`contentFile` 由插件自己读，不把整篇 HTML 塞进对话上下文；
- **错误码翻译成人话**：`40164`（IP 不在白名单）、`40125`（Secret 不匹配）、`48001`（个人主体不能 API 发布）等直接给处置动作；
- **发布过审批门**：`wechat-mp-publish` 每次都要人工批准（发布后对外公开且不可撤销）。

## 安装

```bash
# 组合包直装（bundle：装包即启用，无需手改 profile）
dsh plugin --profile <你的profile> add github:FAKE0704/dsh-wechat-mp
```

桌面壳支持插件市场时，也可以从索引安装。手动等价法（不推荐）：

```bash
git clone https://github.com/FAKE0704/dsh-wechat-mp.git ~/.dsh/plugins/dsh-wechat-mp
```

然后在 profile 的 `cordis.patch.yml` 里挂载：

```yaml
- insert:
    - id: dsh-wechat-mp
      name: dsh-wechat-mp
      config:
        appId: ''                      # 留空 = 从凭据 WECHAT_MP_APPID 读
        secretRef: WECHAT_MP_SECRET    # AppSecret 的凭据名
```

## 准备两样东西

### 1. 公众号凭据（推荐：设置页）

装包后打开 **设置 → 公众号**（Settings → WeChat Official Account）：

| 项 | 放哪 | 说明 |
|---|---|---|
| AppID | 设置页直接填（写进插件 `config.appId`），或留空走凭据 `WECHAT_MP_APPID` | 不是机密，但放凭据库可以少改配置 |
| AppSecret | **只放凭据库**（设置页的「保存 Secret」写入 `WECHAT_MP_SECRET`） | 插件从 dsh 凭据服务解析；配置里没有明文字段 |

设置页只显示 Secret 的「已配置/未配置」状态（来自 `describe()`），不回显明文；保存 Secret 后直接点「测试凭据」验证 AppID/Secret/IP 白名单。也可以不走设置页：在 profile 的 `cordis.patch.yml` 里填 `config`，凭据经 dsh 设置 → 凭据手工保存——效果相同。

Secret 只用于换 `access_token`，token 只在进程内缓存，不落盘、不进日志、不进工具结果。

### 2. IP 白名单

公众号后台「开发 → 基本配置 → IP 白名单」必须包含**运行 dsh 这台机器的出口 IP**。家庭宽带 IP 会变——变了就报 `40164`/`61004`，错误串里会带微信看到的真实出口 IP，照着加白名单即可。先跑 `wechat-mp-status` 可以在动文章之前把这个问题暴露出来。

## 八个工具

| 工具 | 作用 | 审批 |
|---|---|---|
| `wechat-mp-status` | 校验凭据、换 token，报 AppID/token 剩余时间 | 免审 |
| `wechat-mp-upload-image` | 图片（本地 / URL / data URL）→ 永久素材，回 `media_id` + `url` | 免审 |
| `wechat-mp-draft-create` | 新建草稿（自动封面 + 正文图片转素材） | 免审 |
| `wechat-mp-draft-update` | 替换草稿（先建新、成功后再删旧；旧稿删不掉只告警） | 免审 |
| `wechat-mp-draft-list` | 草稿箱列表（media_id/标题/作者/更新时间，分页 ≤20） | 免审 |
| `wechat-mp-draft-delete` | 删草稿 | 免审 |
| `wechat-mp-publish` | 提交发布（`freepublish`，异步），回 `publish_id` | **ask** |
| `wechat-mp-publish-status` | 发布状态（发布中/成功/失败/审核不通过）+ 文章链接 | 免审 |

### 典型流程

```text
wechat-mp-status                                   # 先确认凭据与白名单
wechat-mp-draft-create {
  title: "标题", contentFile: "/path/article-body.html",
  thumbFile: "/path/cover.png", digest: "摘要", author: "作者"
}                                                  # → media_id
wechat-mp-draft-list                               # 在草稿箱里核对
wechat-mp-publish { mediaId: "..." }               # 人工批准后提交发布
wechat-mp-publish-status { publishId: "..." }      # 发布成功后拿文章链接
```

改稿 = 重新 `draft-create` 后 `draft-delete` 旧 id，或直接 `draft-update`（一次调用完成替换，返回新 media_id）。

## 正文与图片

- `content`（HTML 字符串）与 `contentFile`（本地文件路径）**二选一**；整页 HTML 会自动抽 `<body>`。
- `contentFile` 模式下，正文里的相对图片路径按**正文文件所在目录**解析。
- `inlineImages`（缺省 `true`）：把 `<img src>` 里的外域 / 本地 / `data:` 图片上传成永久素材并改写地址；`mmbiz.qpic.cn` 的图片原样保留。图片已是公众号素材地址时可以关掉省调用。
- 支持 `jpg/jpeg/png/gif/bmp`；`webp` 会被明确拒绝（微信按文件名后缀判类型，不做猜测转换）。
- 封面三选一：`thumbMediaId`（已有素材）/ `thumbFile`（本地图片）/ `thumbUrl`（网络图片或本地路径），后两者自动上传为永久素材。

## 错误码速查

| errcode | 含义 | 处置 |
|---|---|---|
| `40013` | AppID 无效 | 核对 `config.appId` / 凭据 `WECHAT_MP_APPID` |
| `40125` | AppSecret 不匹配 | 重置后更新凭据 `WECHAT_MP_SECRET` |
| `40164` / `61004` | IP 不在白名单 | 把错误串里的 IP 加进公众号后台白名单 |
| `40243` | Secret 被冻结 | 后台解冻/重置 |
| `48001` | 接口未授权 | **个人主体公众号不支持 API 发布**：只能推草稿，回后台人工点发表 |
| `45009` | 调用超限 | 稍后重试；后台查看每日额度 |
| `40007` | media_id 无效 | 封面先传素材；草稿可能已被删除 |
| `40113` | 文件类型不支持 | 图片用 jpg/png/gif/bmp 且文件名带后缀 |
| `45002` | 正文超限 | 正文 ≤2 万字符且 <1MB |

## 已知限制

- 依赖 dsh 凭据服务（桌面 / web 组合默认自带 `credentials` 服务）；profile 若未挂载凭据提供方，插件不会激活。
- **个人主体**：`freepublish`/群发等接口恒 `48001`（微信认证只对企业/组织开放）——草稿箱可用，发布只能人工在后台点。
- 单账号：一次只配一个公众号 AppID（多账号请用多个 profile 或等待后续版本）。
- 只覆盖**文章域**：不做数据统计（`datacube`）、粉丝/菜单/自动回复、素材库管理、多平台分发。
- 不做公众号 HTML 排版/样式渲染：正文由 agent 或调用方给 HTML（排版是另一层能力，后续按需立项）。

## 配置参考

| 字段 | 缺省 | 说明 |
|---|---|---|
| `appId` | `''` | 公众号 AppID；空 = 凭据 `WECHAT_MP_APPID` |
| `secretRef` | `WECHAT_MP_SECRET` | AppSecret 的凭据名（环境变量名形态） |
| `apiBase` | `https://api.weixin.qq.com` | 微信 API 基址（自建网关/测试时可覆盖） |
| `timeoutMs` | `20000` | 单次 HTTP 超时（1s–120s） |
| `maxImageBytes` | `10485760` | 单张图片上限（64KB–20MB；公众号素材上限 10MB） |

## 安全与隐私

- AppSecret/token 不落盘（token 仅进程内缓存），不进日志、不进工具结果；`wechat-mp-status` 只回脱敏 AppID 与到期时间。
- 只有 `wechat-mp-publish` 有对外副作用，恒过审批门；草稿类工具只写你自己的草稿箱（未发表，可删可改）。
- 正文图片上传会把图片内容发到 `api.weixin.qq.com`（公众号素材库）——这是推草稿的必要动作，正文不打算公开的图片不要放进文章。

## 本地开发与测试

```bash
cd packages/dsh-plugins/dsh-wechat-mp
bun test          # 31 例 keyless：零网络、零真文件（fetch/readFile/时钟全注入）
```

## License

MIT（Copyright (c) 2026 FAKE0704）
