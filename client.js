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

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = makeT(ctx)
        const Page = makePage(ctx, t)
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'dsh-wechat-mp', order: 65, label: () => t.t('section'),
        }, Page))
        ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
          name: 'settings.section.icon', id: 'dsh-wechat-mp',
        }, SectionIcon))
      },
    }
  },
})
