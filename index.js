// dsh-wechat-mp — 微信公众号文章域 dsh 原生工具插件（自包含 in-child 执行，零宿主回调）。
//
// 形态：语义核整体在 core.js（token 缓存/素材上传/正文图片改写/草稿与发布/错误码映射），
// 本文件只做注册、门控与委托。任何 dsh 宿主装上即用，无宿主侧配套要求；不依赖
// CreatorStack、不依赖 MCP、不依赖 mcp-manager。
//
// 审批门：wechat-mp-publish 提交的是对外公开发布（不可撤销）——每次 ask；
// 草稿类工具只写公众号草稿箱（未发表，可删可改），免审。
//
// 凭据：AppSecret 只从 dsh 凭据库解析（config.secretRef，缺省 WECHAT_MP_SECRET）；
// AppID 可写 config.appId，缺省从凭据 WECHAT_MP_APPID 解析。secret/token 不进日志、
// 不进工具结果、不落盘（token 仅进程内缓存）。

import { createSemantics, decideWechatMpGate, resolveConfig } from './core.js'

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
    { type: 'object', properties: {}, additionalProperties: false },
    sem.status)

  register('wechat-mp-upload-image',
    '把一张图片上传为公众号永久素材，返回 media_id 与 mmbiz.qpic.cn 地址。用途：拿封面素材 id（草稿接口只认 thumb_media_id），或先把正文图片转成公众号可显示的内链。支持本地文件（file）/网络地址（url）/data URL（dataUrl）三选一。只写素材库，免审。',
    {
      type: 'object',
      properties: {
        file: { type: 'string', description: '本地图片路径（绝对路径或相对当前目录）' },
        url: { type: 'string', description: '网络图片地址（http/https）' },
        dataUrl: { type: 'string', description: 'data:image/…;base64,… 形式的内联图片' },
      },
      additionalProperties: false,
    },
    sem.uploadImage)

  register('wechat-mp-draft-create',
    '新建公众号草稿（只进草稿箱，不发表）。自动做两件必要的事：①封面必填——给 thumbMediaId/thumbFile/thumbUrl 任一（后两者自动传永久素材）；②把正文外域图片自动上传素材并改写 src（公众号接口会静默丢弃外域图片）。正文可用 content（HTML 字符串）或 contentFile（文件路径）。免审。',
    { type: 'object', properties: PUBLISH_ARGS, required: PUBLISH_REQUIRED, additionalProperties: false },
    sem.draftCreate)

  register('wechat-mp-draft-update',
    '替换一篇已有草稿：按新内容新建一份，成功后再删除旧草稿（新 media_id 取代旧 id；旧稿删除失败只告警不丢新稿）。参数同 draft-create，另加 mediaId。免审。',
    {
      type: 'object',
      properties: { mediaId: { type: 'string', description: '要替换的草稿 media_id（wechat-mp-draft-list 可查）' }, ...PUBLISH_ARGS },
      required: ['mediaId', ...PUBLISH_REQUIRED],
      additionalProperties: false,
    },
    sem.draftUpdate)

  register('wechat-mp-draft-list',
    '列公众号草稿箱（摘要：media_id/标题/作者/摘要/封面素材/更新时间）。分页 offset+count（count ≤20）。免审。',
    {
      type: 'object',
      properties: {
        offset: { type: 'number', description: '偏移（缺省 0）' },
        count: { type: 'number', description: '每页条数（缺省 20，上限 20）' },
      },
      additionalProperties: false,
    },
    sem.draftList)

  register('wechat-mp-draft-delete',
    '删除一篇公众号草稿（未发表内容，可由正文重建）。免审。',
    { type: 'object', properties: { mediaId: { type: 'string', description: '草稿 media_id' } }, required: ['mediaId'], additionalProperties: false },
    sem.draftDelete)

  register('wechat-mp-publish',
    '提交公众号发布（freepublish）：异步审核，返回 publish_id，用 wechat-mp-publish-status 查结果。⚠️ 发布后对外公开且不可撤销，本工具恒过人工审批门。个人主体公众号会 48001（不支持 API 发布），只能草稿箱→后台人工点发表。',
    { type: 'object', properties: { mediaId: { type: 'string', description: '草稿 media_id' } }, required: ['mediaId'], additionalProperties: false },
    sem.publish)

  register('wechat-mp-publish-status',
    '查发布任务状态（发布中/成功/失败/审核不通过/取消），成功时回文章链接。免审。',
    { type: 'object', properties: { publishId: { type: 'string', description: 'wechat-mp-publish 返回的 publish_id' } }, required: ['publishId'], additionalProperties: false },
    sem.publishStatus)
}
