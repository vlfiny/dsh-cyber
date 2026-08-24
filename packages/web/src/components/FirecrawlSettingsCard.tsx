import { CheckCircle, WarningCircle } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'

import { api } from '../api.js'

interface FirecrawlStatus {
  configured: boolean
}

type TestOutcome = { ok: boolean; status: string; detail: string } | undefined

/**
 * Fillable, locally-encrypted credential entry for the Firecrawl integration.
 * The key is written to the same local encrypted vault as model keys and is
 * never echoed back or persisted anywhere else.
 */
export function FirecrawlSettingsCard() {
  const [configured, setConfigured] = useState<boolean>()
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState<'save' | 'clear' | 'test'>()
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string }>()
  const [testResult, setTestResult] = useState<TestOutcome>()

  useEffect(() => {
    let cancelled = false
    void api<FirecrawlStatus>('/api/integrations/firecrawl')
      .then((status) => { if (!cancelled) setConfigured(status.configured) })
      .catch((cause: unknown) => { if (!cancelled) setMessage({ kind: 'error', text: cause instanceof Error ? cause.message : '无法读取集成状态' }) })
    return () => { cancelled = true }
  }, [])

  const saveKey = async () => {
    setBusy('save'); setMessage(undefined); setTestResult(undefined)
    try {
      await api('/api/integrations/firecrawl/key', { method: 'PUT', body: JSON.stringify({ apiKey: apiKey.trim() }) })
      setConfigured(true); setApiKey(''); setMessage({ kind: 'ok', text: 'Firecrawl API Key 已保存到本机加密凭据库' })
    } catch (cause) {
      setMessage({ kind: 'error', text: cause instanceof Error ? cause.message : '保存失败' })
    } finally {
      setBusy(undefined)
    }
  }

  const clearKey = async () => {
    setBusy('clear'); setMessage(undefined); setTestResult(undefined)
    try {
      await api('/api/integrations/firecrawl/key', { method: 'DELETE' })
      setConfigured(false); setMessage({ kind: 'ok', text: '已清除本机保存的 Firecrawl API Key' })
    } catch (cause) {
      setMessage({ kind: 'error', text: cause instanceof Error ? cause.message : '清除失败' })
    } finally {
      setBusy(undefined)
    }
  }

  const runTest = async () => {
    setBusy('test'); setMessage(undefined); setTestResult(undefined)
    try {
      const result = await api<TestOutcome & Record<string, unknown>>('/api/integrations/firecrawl/test', { method: 'POST', body: '{}' })
      setTestResult(result)
    } catch (cause) {
      setMessage({ kind: 'error', text: cause instanceof Error ? cause.message : '测试失败' })
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <div className="settings-section" aria-label="Firecrawl 集成">
      <div className="settings-section__heading"><h3>Firecrawl 网络研究</h3><p>为拥有「Firecrawl 网络研究」技能的角色提供真实的联网搜索与网页抓取。API Key 使用本机随机密钥加密后单独保存，不会写入数据库或日志，也不会回显。</p></div>
      <div className="settings-action-list">
        <section className="maintenance-card">
          <p style={{ margin: 0 }}>
            状态：{configured === undefined ? '读取中…' : configured
              ? <span style={{ color: 'var(--accent-strong)' }}><CheckCircle size={15} /> 已配置（密钥保存在本机）</span>
              : <span style={{ color: 'var(--text-muted)' }}><WarningCircle size={15} /> 未配置——相关技能会如实说明限制并拒绝编造结果</span>}
          </p>
          <label style={{ display: 'grid', gap: 6, marginTop: 10 }}>
            <span>Firecrawl API Key（fc-…，可随时在 firecrawl.dev 获取）</span>
            <input
              type="password"
              value={apiKey}
              autoComplete="off"
              placeholder={configured === true ? '••••••••（已保存；如需更换请重新输入）' : 'fc-xxxxxxxx'}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </label>
          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            <button className="primary-button" type="button" disabled={busy !== undefined || apiKey.trim().length === 0} onClick={() => void saveKey()}>
              {busy === 'save' ? '正在保存…' : '保存 Key'}
            </button>
            <button className="secondary-button" type="button" disabled={busy !== undefined || configured !== true} onClick={() => void clearKey()}>
              {busy === 'clear' ? '正在清除…' : '清除已存 Key'}
            </button>
            <button className="text-button" type="button" disabled={busy !== undefined || configured !== true} onClick={() => void runTest()}>
              {busy === 'test' ? '测试中…' : '测试连接（抓取 example.com）'}
            </button>
          </div>
          {message === undefined ? null : <p style={{ margin: '10px 0 0', color: message.kind === 'error' ? 'var(--danger)' : 'var(--text-muted)' }}>{message.text}</p>}
          {testResult === undefined ? null : (
            <div style={{ marginTop: 10, padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 8, maxHeight: 220, overflow: 'auto' }}>
              <strong>{testResult.ok ? '✅ 测试通过' : `⚠️ ${testResult.status}`}</strong>
              <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: '6px 0 0', fontSize: 12 }}>{testResult.detail}</pre>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
