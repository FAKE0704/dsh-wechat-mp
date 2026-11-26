// dsh-wechat-mp — 微信公众号文章域 dsh 原生工具插件（自包含 in-child 执行，零宿主回调）。
//
// 形态：语义核整体在 core.js（token 缓存/素材上传/正文图片改写/草稿与发布/错误码映射），
// 本文件只做注册、门控与委托。任何 dsh 宿主装上即用，无宿主侧配套要求；不依赖
// CreatorStack、不依赖 MCP、不依赖 mcp-manager。
//
// 配置面（V0.2.0 新增）：设置页「设置 → 公众号」走 /api/dsh-wechat-mp 桥（settings.js），
// AppID/apiBase 等写进插件 config（configEditor），AppSecret 只写进 dsh 凭据库
// （ctx.credentials.set(secretRef, …)），配置里永远不放明文。
//
// 审批门：wechat-mp-publish 提交的是对外公开发布（不可撤销）——每次 ask；
// 草稿类工具只写公众号草稿箱（未发表，可删可改），免审。
//
// 凭据：AppSecret 只从 dsh 凭据库解析（config.secretRef，缺省 WECHAT_MP_SECRET）；
// AppID 可写 config.appId，缺省从凭据 WECHAT_MP_APPID 解析。secret/token 不进日志、
// 不进工具结果、不落盘（token 仅进程内缓存）。

import { createSemantics, decideWechatMpGate, resolveConfig } from './core.js'
import { createSettingsService, WEB_PATH } from './settings.js'

export const name = 'dsh-wechat-mp'
export const inject = ['tools', 'credentials']

/** 工具输出面（ok/message 双字段 + 文本渲染；hint 给处置建议）。 */
const OUTPUT = {
  schema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      message: { type: 'string' },
      code: { type: 'string' },
      hint: { type: 'string' },
    },
    required: ['ok', 'message'],
  },
  render: (_args, value) => [{ type: 'text', text: [value.message, value.hint].filter(Boolean).join('\n') }],
}

const PUBLISH_ARGS = {
  title: { type: 'string', description: '文章标题（必填，建议 ≤24 字）' },
  content: { type: 'string', description: '正文 HTML（片段或整页文档均可，整页会自动抽 <body>）；与 contentFile 二选一' },
  contentFile: { type: 'string', description: '正文 HTML 文件路径（本地绝对路径或相对当前目录）；与 content 二选一——正文在文件里时用它，省上下文 token' },
  author: { type: 'string', description: '作者署名（可选）' },
  digest: { type: 'string', description: '摘要（可选，留空则用正文开头）' },
  sourceUrl: { type: 'string', description: '原文链接 content_source_url（可选，只对已认证原创账号生效）' },
  thumbMediaId: { type: 'string', description: '封面素材 id（已有永久素材时直接给；三选一）' },
  thumbFile: { type: 'string', description: '封面图片本地路径（自动上传为永久素材；三选一）' },
  thumbUrl: { type: 'string', description: '封面图片网络地址或本地路径（自动上传为永久素材；三选一）' },
  inlineImages: { type: 'boolean', description: '是否把正文里的外域/本地图片自动传成公众号素材并改写 src（缺省 true；草稿接口会静默丢弃外域图片，务必保持开启，除非图片已是 mmbiz.qpic.cn）' },
  needOpenComment: { type: 'boolean', description: '是否开启留言（缺省 false）' },
  onlyFansCanComment: { type: 'boolean', description: '是否仅粉丝可留言（缺省 false）' },
}

const PUBLISH_REQUIRED = ['title']

/** 多账号（V0.3.0）：全部工具可选 account 参数，缺省第一个/默认账号。 */
const ACCOUNT_ARG = {
  account: { type: 'string', description: '公众号账号名（config.accounts 里的 name；缺省 = 第一个/默认账号）' },
}
const WITH_ACCOUNT = (props, required) => ({
  type: 'object',
  properties: { ...props, ...ACCOUNT_ARG },
  ...(required ? { required } : {}),
  additionalProperties: false,
})

/** @param {import('../types.d.ts').PluginCtx} ctx @param {unknown} config */
export function apply(ctx, config) {
  const cfg = resolveConfig(config)
  const impls = cfg.impls ?? {}
  const sem = createSemantics({
    config: cfg,
    ...impls, // 测试缝：注入 fetch/readFile/clock/credential resolver（生产不传）
    resolveCredential: impls.resolveCredential ?? (async (ref) => {
      try {
        return await ctx.credentials.resolve(ref)
      } catch {
        return undefined
      }
    }),
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    return decideWechatMpGate(exec) ?? next()
  })

  const register = (toolName, description, parameters, run) => {
    ctx.tools.register({
      name: toolName,
      description,
      parameters,
      output: OUTPUT,
      async execute(args) {
        return run(args ?? {})
      },
    })
  }

  register('wechat-mp-status',
    '检查微信公众号凭据是否可用：用 AppID/AppSecret 换 access_token，报账号配置状态与 token 剩余时间。首次接入、报 40164/40125 类错误时先跑它定位（凭据缺失/Secret 不匹配/IP 不在白名单会被明确指出来）。只读免审。',
    WITH_ACCOUNT({}),
    sem.status)

  register('wechat-mp-upload-image',
    '把一张图片上传为公众号永久素材，返回 media_id 与 mmbiz.qpic.cn 地址。用途：拿封面素材 id（草稿接口只认 thumb_media_id），或先把正文图片转成公众号可显示的内链。支持本地文件（file）/网络地址（url）/data URL（dataUrl）三选一。只写素材库，免审。',
    WITH_ACCOUNT({
        file: { type: 'string', description: '本地图片路径（绝对路径或相对当前目录）' },
        url: { type: 'string', description: '网络图片地址（http/https）' },
        dataUrl: { type: 'string', description: 'data:image/…;base64,… 形式的内联图片' },
      }),
    sem.uploadImage)

  register('wechat-mp-draft-create',
    '新建公众号草稿（只进草稿箱，不发表）。自动做两件必要的事：①封面必填——给 thumbMediaId/thumbFile/thumbUrl 任一（后两者自动传永久素材）；②把正文外域图片自动上传素材并改写 src（公众号接口会静默丢弃外域图片）。正文可用 content（HTML 字符串）或 contentFile（文件路径）。免审。',
    WITH_ACCOUNT(PUBLISH_ARGS, PUBLISH_REQUIRED),
    sem.draftCreate)

  register('wechat-mp-draft-update',
    '替换一篇已有草稿：按新内容新建一份，成功后再删除旧草稿（新 media_id 取代旧 id；旧稿删除失败只告警不丢新稿）。参数同 draft-create，另加 mediaId。免审。',
    WITH_ACCOUNT({ mediaId: { type: 'string', description: '要替换的草稿 media_id（wechat-mp-draft-list 可查）' }, ...PUBLISH_ARGS }, ['mediaId', ...PUBLISH_REQUIRED]),
    sem.draftUpdate)

  register('wechat-mp-draft-list',
    '列公众号草稿箱（摘要：media_id/标题/作者/摘要/封面素材/更新时间）。分页 offset+count（count ≤20）。免审。',
      WITH_ACCOUNT({
        offset: { type: 'number', description: '偏移（缺省 0）' },
        count: { type: 'number', description: '每页条数（缺省 20，上限 20）' },
      }),
    sem.draftList)

  register('wechat-mp-draft-delete',
    '删除一篇公众号草稿（未发表内容，可由正文重建）。免审。',
    WITH_ACCOUNT({ mediaId: { type: 'string', description: '草稿 media_id' } }, ['mediaId']),
    sem.draftDelete)

  register('wechat-mp-publish',
    '提交公众号发布（freepublish）：异步审核，返回 publish_id，用 wechat-mp-publish-status 查结果。⚠️ 发布后对外公开且不可撤销，本工具恒过人工审批门。个人主体公众号会 48001（不支持 API 发布），只能草稿箱→后台人工点发表。',
    WITH_ACCOUNT({ mediaId: { type: 'string', description: '草稿 media_id' } }, ['mediaId']),
    sem.publish)

  register('wechat-mp-publish-status',
    '查发布任务状态（发布中/成功/失败/审核不通过/取消），成功时回文章链接。免审。',
    WITH_ACCOUNT({ publishId: { type: 'string', description: 'wechat-mp-publish 返回的 publish_id' } }, ['publishId']),
    sem.publishStatus)

  register('wechat-mp-precheck',
    '正文预检（免网络）：校验字符数 ≤20000、体积 <1MB、图片格式白名单（jpg/jpeg/png/gif/bmp）。超限给具体数字与处置建议（webp 给转换建议）。draft-create 入口已内置同一预检（fail-fast），推稿前单独跑它可提前发现正文问题。正文可用 content（HTML 字符串）或 contentFile（文件路径）。',
    WITH_ACCOUNT({
      content: { type: 'string', description: '正文 HTML 字符串；与 contentFile 二选一' },
      contentFile: { type: 'string', description: '正文 HTML 文件路径；与 content 二选一' },
    }),
    sem.precheck)

  register('wechat-mp-render',
    'Markdown → 公众号兼容 HTML 渲染器：所有样式逐元素内联（微信后台会剥离 <style> 与 class），覆盖标题/段落/列表/引用/代码块/表格/图片/链接/加粗斜体。支持 frontmatter 或 title 参数传标题。输出落本地文件，返回绝对路径（可直接当 draft-create 的 contentFile 用）。渲染后自动跑正文预检，超限直接拒绝并给建议。免审。',
    WITH_ACCOUNT({
      markdown: { type: 'string', description: 'Markdown 源文（字符串）；与 mdFile 二选一' },
      mdFile: { type: 'string', description: 'Markdown 文件路径；与 markdown 二选一，省上下文 token' },
      title: { type: 'string', description: '文章标题（缺省取 frontmatter 的 title）' },
      outFile: { type: 'string', description: '输出 HTML 路径（缺省 = Markdown 同目录 <同名>.html 或当前目录 wechat-mp-article.html）' },
    }),
    sem.render)

  // ---------- V0.2.0：设置页 Web 桥（POST /api/dsh-wechat-mp，{ method, args }） ----------
  // 无 webServer 的宿主（如 headless）自动降级——工具面不受影响。
  const settings = createSettingsService({ ctx, config: cfg, makeSemantics: (merged) => createSemantics({
    config: merged,
    ...impls,
    resolveCredential: impls.resolveCredential ?? (async (ref) => {
      try {
        return await ctx.credentials.resolve(ref)
      } catch {
        return undefined
      }
    }),
  }) })
  const webServer = ctx.get('webServer')
  if (webServer && typeof webServer.register === 'function') {
    ctx.effect(() => webServer.register({ kind: 'exact', path: WEB_PATH, handler: settings.handleRequest }))
  }
}
