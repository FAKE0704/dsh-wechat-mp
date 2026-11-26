// dsh-wechat-mp — Client 半：「设置 → 公众号」页 + 分区图标。
//
// 槽位契约（已对照运行时核实，同 dsh-local-llm 先例）：
//   settings.section       list  — 一节一页（id/order/label，label 可为函数）
//   settings.section.icon  list  — 与 section 同 id 寻址；组件收 { size, active }
// 样式只用 --dsw-alias-* 主题 token；不 import 任何 Harness Client 包；组件内 <style>
// 随卸载移除。桥：POST /api/dsh-wechat-mp（{ method, args }）。
// Secret 只经 Host 写入凭据库；页面只读 describe() 的状态，不回显明文。

window.__ModuleLoader__.load({
  id: 'dsh-wechat-mp',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const STRINGS = {
      zh: {
        section: '公众号',
        pageLead: '微信公众号文章工具：草稿箱、发布、图片素材。AppSecret 只存 dsh 凭据库，配置文件里永远不放明文。',
        appIdLabel: 'AppID',
        appIdHint: '公众号后台「开发 → 基本配置」的 AppID。留空则从凭据 WECHAT_MP_APPID 读取。',
        appIdFromCredential: 'AppID 已由凭据 WECHAT_MP_APPID 提供',
        secretLabel: 'AppSecret',
        secretConfigured: '已配置',
        secretMissing: '未配置',
        secretUnknown: '状态未知',
        secretSource: (src) => `来源：${src}`,
        secretPaste: '粘贴新的 AppSecret',
        secretSave: '保存 Secret',
        secretClear: '删除凭据',
        secretClearConfirm: '确认删除',
        secretClearHint: '删除后必须重新粘贴 Secret 才能调用任何工具。',
        test: '测试凭据',
        testing: (s) => `测试中… ${s}s`,
        save: '保存配置',
        saving: '保存中…',
        refresh: '刷新',
        resultNone: '填写 AppID 与 AppSecret 后，点「测试凭据」验证（换 token 会真调用微信接口）。',
        hintIp: '若报 40164/61004：把错误里的出口 IP 加入公众号后台「开发 → 基本配置 → IP 白名单」。',
        hintPersonal: '若报 48001：个人主体公众号不支持 API 发布，只能推草稿后在后台人工发表。',
        loadFailed: '读取配置失败：',
        saveOk: '配置已保存（普通字段会重启插件生效）。',
        saveFail: '保存失败：',
        secretOk: 'AppSecret 已写入凭据库。',
        secretFail: 'AppSecret 保存失败：',
        clearOk: '凭据已删除。',
        clearFail: '凭据删除失败：',
        testOk: '凭据可用（能换到 access_token）。',
        testFail: '凭据不可用：',
        testWarn: '测试返回异常：',
        previewSection: '预览',
        previewLead: 'agent 写完文章会自动把预览推到这里。审查正文与封面，没问题就点「推送到草稿箱」（只进草稿箱，不发表）。',
        previewEmpty: '暂无待审查的预览。在会话里让 agent 写文章，写完它会调用 wechat-mp-preview 把预览推到这里。',
        previewNone: '读取预览失败：',
        previewRefresh: '刷新',
        previewChars: (c, kb) => `${c} 字符 / ${kb}KB`,
        previewWarn: (n) => `${n} 条警告`,
        previewAuthor: (a) => `作者：${a}`,
        previewDigest: (d) => `摘要：${d}`,
        previewCoverMissing: '封面未提供',
        previewCoverOk: '封面已提供',
        previewCoverLabel: '封面（本地路径 / 图片 URL，发送时自动处理）',
        previewCoverPlaceholder: '/path/to/cover.jpg 或 https://…',
        previewCoverMediaId: '封面素材 id（可选，优先于上面两项）',
        previewSend: '推送到草稿箱',
        previewSendConfirm: '确认推送？',
        previewSending: '推送中…',
        previewSent: (id) => `已推送草稿箱：media_id=${id}`,
        previewSendOkLead: '已推送到草稿箱（未发表）：',
        previewSendFail: '推送失败：',
        previewSentBadge: '已推送',
      },
      en: {
        section: "WeChat Official Account",
        pageLead: "WeChat Official Account article tools: drafts, publishing, image assets. The AppSecret lives only in the dsh credential store, never in config.",
        appIdLabel: 'AppID',
        appIdHint: "The AppID from the account's Developer settings. Leave empty to read credential WECHAT_MP_APPID.",
        appIdFromCredential: 'AppID is already supplied by credential WECHAT_MP_APPID',
        secretLabel: 'AppSecret',
        secretConfigured: 'Configured',
        secretMissing: 'Not configured',
        secretUnknown: 'Status unknown',
        secretSource: (src) => `Source: ${src}`,
        secretPaste: 'Paste a new AppSecret',
        secretSave: 'Save secret',
        secretClear: 'Delete credential',
        secretClearConfirm: 'Confirm delete',
        secretClearHint: 'After deleting, you must paste the secret again before any tool works.',
        test: 'Test credentials',
        testing: (s) => `Testing… ${s}s`,
        save: 'Save config',
        saving: 'Saving…',
        refresh: 'Refresh',
        resultNone: "Fill in the AppID and AppSecret, then run Test credentials (it calls WeChat for an access_token).",
        hintIp: "If you see 40164/61004: add the reported exit IP to the account's IP allowlist.",
        hintPersonal: 'If you see 48001: personal accounts cannot publish via API; use drafts and publish manually.',
        loadFailed: 'Failed to load config: ',
        saveOk: 'Configuration saved (plain fields restart the plugin to apply).',
        saveFail: 'Save failed: ',
        secretOk: 'AppSecret written to the credential store.',
        secretFail: 'AppSecret save failed: ',
        clearOk: 'Credential deleted.',
        clearFail: 'Credential delete failed: ',
        testOk: 'Credentials work (an access_token was obtained).',
        testFail: 'Credentials failed: ',
        testWarn: 'Test returned an error: ',
        previewSection: 'Preview',
        previewLead: "When the agent finishes an article it pushes a preview here. Review the body and cover, then click Send to drafts (draft box only, never published).",
        previewEmpty: 'No preview waiting for review. Ask the agent to write an article; it calls wechat-mp-preview when done and the preview lands here.',
        previewNone: 'Failed to load preview: ',
        previewRefresh: 'Refresh',
        previewChars: (c, kb) => `${c} chars / ${kb}KB`,
        previewWarn: (n) => `${n} warning(s)`,
        previewAuthor: (a) => `Author: ${a}`,
        previewDigest: (d) => `Digest: ${d}`,
        previewCoverMissing: 'No cover yet',
        previewCoverOk: 'Cover provided',
        previewCoverLabel: 'Cover (local path / image URL, resolved on send)',
        previewCoverPlaceholder: '/path/to/cover.jpg or https://…',
        previewCoverMediaId: 'Cover media_id (optional, takes priority)',
        previewSend: 'Send to drafts',
        previewSendConfirm: 'Confirm send?',
        previewSending: 'Sending…',
        previewSent: (id) => `Sent to drafts: media_id=${id}`,
        previewSendOkLead: 'Pushed to the draft box (not published): ',
        previewSendFail: 'Send failed: ',
        previewSentBadge: 'Sent',
      },
    }

    function makeT(ctx) {
      const state = { lang: 'en' }
      const detect = () => {
        let lang = 'en'
        try {
          const svc = ctx.get('locale')
          const snap = svc?.getLocale?.() ?? svc?.getSnapshot?.()
          const cands = [snap?.active, snap?.locale, snap?.id, snap?.current, snap?.resolved, snap?.language]
          if (cands.some((c) => typeof c === 'string' && c.toLowerCase().startsWith('zh'))) lang = 'zh'
        } catch { /* 继续探测浏览器语言 */ }
        if (lang !== 'zh') {
          try {
            const nav = Array.isArray(navigator?.languages) && navigator.languages.length > 0 ? navigator.languages[0] : navigator?.language
            if (typeof nav === 'string' && nav.toLowerCase().startsWith('zh')) lang = 'zh'
          } catch { /* 缺省英文 */ }
        }
        state.lang = lang
      }
      detect()
      return {
        t: (key) => {
          const v = STRINGS[state.lang][key] ?? STRINGS.en[key] ?? key
          return v
        },
        refreshLang: detect,
      }
    }

    function makeLocaleTick(ctx, refreshLang) {
      return function useLocaleTick() {
        const [tick, setTick] = useState(0)
        useEffect(() => {
          try {
            const off = ctx.on('locale/change', () => { refreshLang(); setTick((n) => n + 1) })
            return off
          } catch { return undefined }
        }, [])
        return tick
      }
    }

    async function apiCall(method, args) {
      try {
        const res = await fetch('/api/dsh-wechat-mp', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ method, args: args ?? {} }),
        })
        if (!res.ok) return { ok: false, message: `HTTP ${res.status}` }
        return await res.json()
      } catch (error) {
        return { ok: false, message: `${error instanceof Error ? error.message : String(error)}` }
      }
    }

    const CSS = `
.dshwmp { display: flex; flex-direction: column; gap: 14px; max-width: 640px; }
.dshwmp-lead { color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 1.5; }
.dshwmp-card { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
.dshwmp-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dshwmp-label { font-size: 13px; color: var(--dsw-alias-label-primary); font-weight: 600; }
.dshwmp-hint { font-size: 12px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.dshwmp-input { flex: 1 1 220px; min-width: 180px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-size: 13px; font-family: inherit; }
.dshwmp-input:focus { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dshwmp-badge { font-size: 12px; padding: 4px 9px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); }
.dshwmp-badge-ok { color: var(--dsw-alias-state-success-primary); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent); }
.dshwmp-badge-bad { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); }
.dshwmp-badge-neutral { color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); }
.dshwmp-btn { padding: 8px 12px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, var(--dsw-alias-bg-layer-1)); color: var(--dsw-alias-label-primary); font-size: 13px; cursor: pointer; }
.dshwmp-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dshwmp-btn:hover { background: var(--dsw-alias-bg-overlay); }
.dshwmp-btn:disabled { opacity: 0.55; cursor: not-allowed; }
.dshwmp-btn-danger { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, var(--dsw-alias-bg-layer-1)); }
.dshwmp-result { font-size: 12px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 10px 12px; }
.dshwmp-result-ok { color: var(--dsw-alias-state-success-primary); }
.dshwmp-result-bad { color: var(--dsw-alias-state-error-primary); }
.dshwmp-note { font-size: 12px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.dshwmp-frame-wrap { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-2); padding: 12px; display: flex; justify-content: center; }
.dshwmp-frame { width: 378px; max-width: 100%; height: 520px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: #ffffff; }
.dshwmp-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dshwmp-title { font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); line-height: 1.4; }
    `

    function makePage(ctx, t) {
      const useLocaleTick = makeLocaleTick(ctx, t.refreshLang)

      function Page() {
        useLocaleTick()
        const [cfg, setCfg] = useState(null)
        const [loadError, setLoadError] = useState('')
        const [appId, setAppId] = useState('')
        const [secret, setSecret] = useState('')
        const [busy, setBusy] = useState(null)
        const [result, setResult] = useState(null) // { ok, text }
        const [confirmClear, setConfirmClear] = useState(false)
        const [testElapsed, setTestElapsed] = useState(0)
        const testTimerRef = useRef(null)

        const refresh = useCallback(async () => {
          const res = await apiCall('get')
          if (res.ok === true) {
            setCfg(res)
            setAppId(res.appId ?? '')
            setLoadError('')
          } else {
            setLoadError(`${t.t('loadFailed')}${String(res.message ?? 'failed')}`)
          }
        }, [t])

        useEffect(() => { void refresh() }, [refresh])

        async function onSave() {
          setBusy('save')
          try {
            const res = await apiCall('save', { appId })
            setResult({ ok: res.ok === true, text: res.ok ? t.t('saveOk') : `${t.t('saveFail')}${String(res.message ?? 'failed')}` })
            if (res.ok === true) await refresh()
          } finally {
            setBusy(null)
          }
        }

        async function onSecretSave() {
          const value = secret.trim()
          if (!value) {
            setResult({ ok: false, text: t.t('secretPaste') })
            return
          }
          setBusy('secret')
          try {
            const res = await apiCall('setSecret', { secret: value })
            setResult({ ok: res.ok === true, text: res.ok ? t.t('secretOk') : `${t.t('secretFail')}${String(res.message ?? 'failed')}` })
            if (res.ok === true) {
              setSecret('')
              setConfirmClear(false)
              await refresh()
            }
          } finally {
            setBusy(null)
          }
        }

        async function onSecretClear() {
          if (!confirmClear) {
            setConfirmClear(true)
            return
          }
          setConfirmClear(false)
          setBusy('clear')
          try {
            const res = await apiCall('clearSecret')
            setResult({ ok: res.ok === true, text: res.ok ? `${t.t('clearOk')}\n${t.t('secretClearHint')}` : `${t.t('clearFail')}${String(res.message ?? 'failed')}` })
            if (res.ok === true) await refresh()
          } finally {
            setBusy(null)
          }
        }

        async function onTest() {
          setBusy('test')
          setTestElapsed(0)
          testTimerRef.current = setInterval(() => setTestElapsed((n) => n + 1), 1000)
          try {
            // 传当前页的 AppID：用户常先填 AppID 再点测试（save 需重启才生效，
            // 测试用临时语义核避免误报「未配置」）
            const res = await apiCall('test', { appId })
            let text
            if (res.ok === true) text = `${t.t('testOk')}\n${String(res.message ?? '')}`
            else if (res.code === 'missing_appid' || res.code === 'missing_secret') text = `${t.t('testFail')}${String(res.message ?? '')}\n${String(res.hint ?? '')}`
            else text = `${t.t('testWarn')}${String(res.message ?? 'failed')}${res.hint ? `\n${res.hint}` : ''}`
            setResult({ ok: res.ok === true, text })
          } finally {
            clearInterval(testTimerRef.current)
            testTimerRef.current = null
            setBusy(null)
          }
        }

        const secretOk = cfg?.secret?.configured === true
        const badge = cfg === null ? t.t('secretUnknown') : secretOk ? t.t('secretConfigured') : t.t('secretMissing')
        return h('div', { className: 'dshwmp' },
          h('style', null, CSS),
          h('div', { className: 'dshwmp-lead' }, t.t('pageLead')),
          loadError
            ? h('div', { className: 'dshwmp-result dshwmp-result-bad', role: 'alert' },
                loadError,
                h('button', { className: 'dshwmp-btn', type: 'button', onClick: () => { void refresh() } }, t.t('refresh')))
            : null,

          h('div', { className: 'dshwmp-card' },
            h('div', { className: 'dshwmp-head' },
              h('label', { className: 'dshwmp-label', htmlFor: 'dshwmp-appid' }, t.t('appIdLabel')),
              h('input', {
                id: 'dshwmp-appid', className: 'dshwmp-input', value: appId,
                onChange: (e) => setAppId(e.target.value), placeholder: 'wx1234567890abcdef', autocomplete: 'off',
              }),
              h('button', { className: 'dshwmp-btn', type: 'button', disabled: busy !== null, onClick: () => { void onSave() } },
                busy === 'save' ? t.t('saving') : t.t('save'))),
            cfg?.appidFromCredential ? h('div', { className: 'dshwmp-hint' }, t.t('appIdFromCredential')) : h('div', { className: 'dshwmp-hint' }, t.t('appIdHint')),

            h('div', { className: 'dshwmp-head' },
              h('span', { className: 'dshwmp-label' }, t.t('secretLabel')),
              h('span', { className: `dshwmp-badge ${cfg === null ? 'dshwmp-badge-neutral' : secretOk ? 'dshwmp-badge-ok' : 'dshwmp-badge-bad'}`, role: 'status' }, badge),
              secretOk && cfg?.secret?.source ? h('span', { className: 'dshwmp-hint' }, t.t('secretSource')(cfg.secret.source)) : null),
            h('div', { className: 'dshwmp-head' },
              h('input', {
                className: 'dshwmp-input', type: 'password', value: secret,
                'aria-label': t.t('secretLabel'), onChange: (e) => setSecret(e.target.value),
                placeholder: t.t('secretPaste'), autocomplete: 'new-password',
              }),
              h('button', { className: 'dshwmp-btn', type: 'button', disabled: busy !== null, onClick: () => { void onSecretSave() } }, t.t('secretSave')),
              secretOk ? h('button', {
                className: `dshwmp-btn ${confirmClear ? 'dshwmp-btn-danger' : ''}`, type: 'button',
                disabled: busy !== null, onClick: () => { void onSecretClear() },
              }, confirmClear ? t.t('secretClearConfirm') : t.t('secretClear')) : null),
            h('div', { className: 'dshwmp-hint' }, `secretRef = ${cfg?.secretRef ?? 'WECHAT_MP_SECRET'}`),
            h('div', { className: 'dshwmp-head' },
              h('button', { className: 'dshwmp-btn', type: 'button', disabled: busy !== null, onClick: () => { void onTest() } },
                busy === 'test' ? t.t('testing')(testElapsed) : t.t('test')))),

          h('div', { className: `dshwmp-result ${result ? (result.ok ? 'dshwmp-result-ok' : 'dshwmp-result-bad') : ''}`, role: 'status' },
            result ? result.text : t.t('resultNone')),
          h('div', { className: 'dshwmp-note' }, t.t('hintIp')),
          h('div', { className: 'dshwmp-note' }, t.t('hintPersonal')))
      }
      return Page
    }

    function makePreviewPage(ctx, t) {
      const useLocaleTick = makeLocaleTick(ctx, t.refreshLang)

      function PreviewPage() {
        useLocaleTick()
        const [pv, setPv] = useState(null) // 最新预览（含 html）
        const [loadError, setLoadError] = useState('')
        const [cover, setCover] = useState('')
        const [coverMediaId, setCoverMediaId] = useState('')
        const [busy, setBusy] = useState(null)
        const [result, setResult] = useState(null) // { ok, text }
        const [confirmSend, setConfirmSend] = useState(false)

        const refresh = useCallback(async () => {
          const res = await apiCall('preview')
          if (res.ok === true) {
            setPv(res.empty === true ? null : res)
            setLoadError('')
            setConfirmSend(false)
          } else {
            setLoadError(`${t.t('previewNone')}${String(res.message ?? 'failed')}`)
          }
        }, [t])

        // 预览是 agent 推过来的：挂载期间轮询，写完文章几秒内自动出现
        useEffect(() => {
          void refresh()
          const timer = setInterval(() => { void refresh() }, 4000)
          return () => clearInterval(timer)
        }, [refresh])

        async function onSend() {
          if (!confirmSend) {
            setConfirmSend(true)
            return
          }
          setConfirmSend(false)
          setBusy('send')
          try {
            const res = await apiCall('send', { thumbFile: cover.trim() || undefined, thumbUrl: cover.trim() || undefined, thumbMediaId: coverMediaId.trim() || undefined })
            if (res.ok === true) {
              setResult({ ok: true, text: `${t.t('previewSendOkLead')}${String(res.message ?? t.t('previewSent')(String(res.mediaId ?? '')))}` })
              setCover('')
              setCoverMediaId('')
              await refresh()
            } else {
              setResult({ ok: false, text: `${t.t('previewSendFail')}${String(res.message ?? 'failed')}` })
            }
          } finally {
            setBusy(null)
          }
        }

        const hasCover = Boolean(pv && (pv.thumbMediaId || pv.thumbFile || pv.thumbUrl))
        const sent = pv?.sent === true
        return h('div', { className: 'dshwmp' },
          h('style', null, CSS),
          h('div', { className: 'dshwmp-lead' }, t.t('previewLead')),
          loadError
            ? h('div', { className: 'dshwmp-result dshwmp-result-bad', role: 'alert' },
                loadError,
                h('button', { className: 'dshwmp-btn', type: 'button', onClick: () => { void refresh() } }, t.t('previewRefresh')))
            : null,
          !pv && !loadError
            ? h('div', { className: 'dshwmp-result', role: 'status' }, t.t('previewEmpty'))
            : null,
          pv ? [
            h('div', { className: 'dshwmp-card', key: 'meta' },
              h('div', { className: 'dshwmp-meta' },
                h('span', { className: 'dshwmp-title' }, String(pv.title ?? '')),
                sent ? h('span', { className: 'dshwmp-badge dshwmp-badge-ok', role: 'status' }, t.t('previewSentBadge')) : null,
                h('span', { className: `dshwmp-badge ${hasCover ? 'dshwmp-badge-ok' : 'dshwmp-badge-bad'}` }, hasCover ? t.t('previewCoverOk') : t.t('previewCoverMissing')),
                typeof pv.chars === 'number' ? h('span', { className: 'dshwmp-badge dshwmp-badge-neutral' }, t.t('previewChars')(pv.chars, ((pv.bytes ?? 0) / 1024).toFixed(1))) : null,
                Array.isArray(pv.warnings) && pv.warnings.length > 0 ? h('span', { className: 'dshwmp-badge dshwmp-badge-bad' }, t.t('previewWarn')(pv.warnings.length)) : null),
              pv.author ? h('div', { className: 'dshwmp-note' }, t.t('previewAuthor')(pv.author)) : null,
              pv.digest ? h('div', { className: 'dshwmp-note' }, t.t('previewDigest')(pv.digest)) : null),

            h('div', { className: 'dshwmp-frame-wrap', key: 'body' },
              h('iframe', {
                className: 'dshwmp-frame', title: String(pv.title ?? 'preview'),
                sandbox: '', // 纯静态正文：禁脚本/表单，图片可显示
                srcDoc: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;padding:16px;font:15px/1.75 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;color:#333;background:#fff;word-break:break-word;">${pv.html ?? ''}</body></html>`,
              })),

            h('div', { className: 'dshwmp-card', key: 'send' },
              h('div', { className: 'dshwmp-head' },
                h('label', { className: 'dshwmp-label', htmlFor: 'dshwmp-cover' }, t.t('previewCoverLabel')),
                h('input', {
                  id: 'dshwmp-cover', className: 'dshwmp-input', value: cover,
                  onChange: (e) => setCover(e.target.value), placeholder: t.t('previewCoverPlaceholder'), autocomplete: 'off',
                })),
              h('div', { className: 'dshwmp-head' },
                h('label', { className: 'dshwmp-label', htmlFor: 'dshwmp-cover-mid' }, t.t('previewCoverMediaId')),
                h('input', {
                  id: 'dshwmp-cover-mid', className: 'dshwmp-input', value: coverMediaId,
                  onChange: (e) => setCoverMediaId(e.target.value), placeholder: 'thumb_media_id', autocomplete: 'off',
                })),
              h('div', { className: 'dshwmp-head' },
                h('button', {
                  className: `dshwmp-btn ${confirmSend ? 'dshwmp-btn-danger' : ''}`, type: 'button',
                  disabled: busy !== null || sent, onClick: () => { void onSend() },
                }, busy === 'send' ? t.t('previewSending') : confirmSend ? t.t('previewSendConfirm') : t.t('previewSend'))),
              sent ? h('div', { className: 'dshwmp-note' }, t.t('previewSent')(String(pv.sentMediaId ?? ''))) : null),

            h('div', { className: `dshwmp-result ${result ? (result.ok ? 'dshwmp-result-ok' : 'dshwmp-result-bad') : ''}`, key: 'result', role: 'status' },
              result ? result.text : t.t('previewLead')),
          ] : null)
      }
      return PreviewPage
    }

    function SectionIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 16
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('path', { d: 'M4.5 6.5h11a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2z' }),
        h('path', { d: 'M8.5 16.5l2 3 2-3' }),
        h('path', { d: 'M7 9.5h7M7 12.5h5' }))
    }

    function PreviewIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 16
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('path', { d: 'M3 12s3.2-5.5 9-5.5S21 12 21 12s-3.2 5.5-9 5.5S3 12 3 12z' }),
        h('circle', { cx: 12, cy: 12, r: 2.6 }))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = makeT(ctx)
        const Page = makePage(ctx, t)
        const PreviewPage = makePreviewPage(ctx, t)
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'dsh-wechat-mp-preview', order: 64, label: () => t.t('previewSection'),
        }, PreviewPage))
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'dsh-wechat-mp', order: 65, label: () => t.t('section'),
        }, Page))
        ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
          name: 'settings.section.icon', id: 'dsh-wechat-mp-preview',
        }, PreviewIcon))
        ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
          name: 'settings.section.icon', id: 'dsh-wechat-mp',
        }, SectionIcon))
      },
    }
  },
})
