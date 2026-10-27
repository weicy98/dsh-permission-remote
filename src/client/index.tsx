import { useEffect, useState } from 'react'
import { callHost, readHosts, type ClientFace, type HostView, type RunnerView } from './api.ts'
import { MACOS_NOTE, MANUAL_INSTALLS, RIPGREP_NOTE } from './copy.ts'

export const inject = ['remote', 'remote.settings', 'connection', 'slots', 'locale']

const NS = 'permission-remote'

interface SectionProps {
  close: () => void
  ctx: ClientFace
}

export function apply(ctx: ClientFace & {
  locale: { register(ns: string, lang: string, dict: Record<string, string>): () => void }
  slots: { inject(name: string, register: () => () => void): () => void, register(options: object, component: (props: SectionProps) => JSX.Element): () => void }
  effect(dispose: () => void, label?: string): void
}): void {
  ctx.effect(() => ctx.locale.register(NS, 'zh', { title: 'SSH 主机' }), 'dsh-permission-remote: zh')
  ctx.effect(() => ctx.locale.register(NS, 'en', { title: 'SSH hosts' }), 'dsh-permission-remote: en')
  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'permission-remote',
    order: 80,
    label: () => (typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('en') ? 'SSH hosts' : 'SSH 主机'),
    locale: NS,
    inject: () => ({ ctx }),
  }, Section)), 'dsh-permission-remote: settings section')
}

function Section(props: SectionProps): JSX.Element {
  const { ctx } = props
  const [hosts, setHosts] = useState<HostView[]>([])
  const [draft, setDraft] = useState<HostView>(blankHost())
  const [secret, setSecret] = useState('')
  const [message, setMessage] = useState('')
  const [selected, setSelected] = useState('')
  const [status, setStatus] = useState<RunnerView | null>(null)
  const [installLog, setInstallLog] = useState('')
  const [dir, setDir] = useState('/')
  const [entries, setEntries] = useState<Array<{ name: string, path: string }>>([])
  const [busy, setBusy] = useState(false)

  async function reload(): Promise<void> {
    const loaded = await readHosts(ctx)
    setHosts(loaded.hosts)
  }

  useEffect(() => {
    void reload().catch(error => setMessage(error instanceof Error ? error.message : String(error)))
  }, [])

  async function saveDraft(): Promise<void> {
    setBusy(true)
    setMessage('')
    try {
      const id = draft.id || newId()
      const next = { ...draft, id, port: Number(draft.port) || 22 }
      if (next.auth === 'password' || secret.trim().length > 0) {
        await callHost(ctx, 'saveSecret', {
          hostId: id,
          password: next.auth === 'password' ? secret : undefined,
          passphrase: next.auth === 'key' ? secret : undefined,
        })
      }
      await callHost(ctx, 'saveHost', next)
      setSecret('')
      setDraft(blankHost())
      await reload()
      setMessage('主机已保存。口令和私钥口令只进凭据存储。')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function test(host: HostView): Promise<void> {
    setBusy(true)
    setMessage('')
    setSelected(host.id)
    try {
      const offered = await callHost<{ fingerprint: string, trusted: boolean, banner: string }>(ctx, 'testConnection', { hostId: host.id })
      if (!offered.trusted) {
        setMessage(`首次连接，指纹 ${offered.fingerprint}。确认这是你的机器后再信任。`)
        setDraft({ ...host, fingerprint: offered.fingerprint })
        return
      }
      setMessage(offered.banner.length > 0 ? `连接成功：${offered.banner}` : '连接成功。')
      const probed = await callHost<RunnerView>(ctx, 'probe', { hostId: host.id, refresh: true })
      setStatus(probed)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function trust(host: HostView): Promise<void> {
    if (host.fingerprint.trim().length === 0) return
    setBusy(true)
    try {
      await callHost(ctx, 'trustFingerprint', { hostId: host.id, fingerprint: host.fingerprint })
      await reload()
      setMessage('已信任该指纹。')
      const probed = await callHost<RunnerView>(ctx, 'probe', { hostId: host.id, refresh: true })
      setStatus(probed)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function install(hostId: string): Promise<void> {
    setBusy(true)
    setInstallLog('')
    try {
      const result = await callHost<{ code: number | null, stdout: string, stderr: string, status: RunnerView }>(ctx, 'installDeps', { hostId })
      setStatus(result.status)
      setInstallLog([result.stdout, result.stderr].filter(Boolean).join('\n') || `exit ${result.code ?? 'null'}`)
    } catch (error) {
      setInstallLog(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function removeHost(hostId: string): Promise<void> {
    setBusy(true)
    try {
      await callHost(ctx, 'deleteHost', { hostId })
      if (selected === hostId) {
        setSelected('')
        setStatus(null)
        setEntries([])
      }
      await reload()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function browse(hostId: string, path: string): Promise<void> {
    setBusy(true)
    try {
      const listed = await callHost<{ path: string, entries: Array<{ name: string, path: string }> }>(ctx, 'listDir', { hostId, path })
      setDir(listed.path)
      setEntries(listed.entries)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function createWorkspace(hostId: string, path: string): Promise<void> {
    setBusy(true)
    try {
      const created = await callHost<{ path: string }>(ctx, 'createWorkspace', { hostId, path })
      setMessage(`工作区已创建：${created.path}`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const current = hosts.find(item => item.id === selected)

  return (
    <section style={{ display: 'grid', gap: 16, maxWidth: 720 }}>
      <h2 style={{ margin: 0 }}>SSH 主机</h2>
      <p style={{ margin: 0 }}>远端目录会做成工作区。文件和命令工具在那台机器上执行，权限仍是会话里现有的沙箱档位和审批。</p>
      {message.length > 0 ? <p>{message}</p> : null}
      <ul style={{ paddingLeft: 18 }}>
        {hosts.map(host => (
          <li key={host.id}>
            {host.name || host.host} ({host.username}@{host.host}:{host.port}){' '}
            <button type="button" disabled={busy} onClick={() => void test(host)}>测试连接</button>{' '}
            <button type="button" disabled={busy} onClick={() => void browse(host.id, '/')}>浏览目录</button>{' '}
            <button type="button" disabled={busy} onClick={() => void removeHost(host.id)}>删除</button>
          </li>
        ))}
      </ul>
      <fieldset style={{ display: 'grid', gap: 8 }}>
        <legend>添加主机</legend>
        <label>名称 <input value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
        <label>地址 <input value={draft.host} onChange={event => setDraft({ ...draft, host: event.target.value })} /></label>
        <label>端口 <input value={String(draft.port)} onChange={event => setDraft({ ...draft, port: Number(event.target.value) || 22 })} /></label>
        <label>用户 <input value={draft.username} onChange={event => setDraft({ ...draft, username: event.target.value })} /></label>
        <label>认证
          <select value={draft.auth} onChange={event => setDraft({ ...draft, auth: event.target.value === 'password' ? 'password' : 'key' })}>
            <option value="key">私钥路径</option>
            <option value="password">口令</option>
          </select>
        </label>
        {draft.auth === 'key'
          ? <label>私钥路径 <input value={draft.privateKeyPath} onChange={event => setDraft({ ...draft, privateKeyPath: event.target.value })} /></label>
          : null}
        <label>{draft.auth === 'password' ? '口令' : '私钥口令（可空）'}
          <input type="password" value={secret} onChange={event => setSecret(event.target.value)} />
        </label>
        <button type="button" disabled={busy || draft.host.trim().length === 0 || draft.username.trim().length === 0} onClick={() => void saveDraft()}>保存</button>
      </fieldset>
      {draft.fingerprint.length > 0 && selected.length > 0
        ? <button type="button" disabled={busy} onClick={() => void trust({ ...(current ?? draft), fingerprint: draft.fingerprint })}>信任指纹 {draft.fingerprint}</button>
        : null}
      {status !== null && current !== undefined ? (
        <div>
          <p>沙箱：{status.sandboxTool} {status.sandbox.available ? '可用' : `不可用（${status.sandbox.reason}）`}</p>
          <p>ripgrep：{status.ripgrep}</p>
          {status.os === 'linux' && !status.sandbox.available
            ? <button type="button" disabled={busy || status.install === null} onClick={() => void install(current.id)}>安装远端沙箱依赖</button>
            : null}
          {status.os === 'darwin' ? <p>{MACOS_NOTE}</p> : null}
          {installLog.length > 0 ? <pre>{installLog}</pre> : null}
        </div>
      ) : null}
      <div>
        <h3 style={{ marginBottom: 8 }}>自行安装 bubblewrap</h3>
        {MANUAL_INSTALLS.map(item => (
          <p key={item.title}>
            {item.title} <code>{item.command}</code>{' '}
            <button type="button" onClick={() => void navigator.clipboard.writeText(item.command)}>复制</button>
          </p>
        ))}
        <p>{MACOS_NOTE}</p>
        <p>{RIPGREP_NOTE}</p>
      </div>
      {selected.length > 0 ? (
        <div>
          <h3 style={{ marginBottom: 8 }}>远端目录 {dir}</h3>
          {dir !== '/' ? <button type="button" disabled={busy} onClick={() => void browse(selected, parentDir(dir))}>上一级</button> : null}{' '}
          <button type="button" disabled={busy} onClick={() => void createWorkspace(selected, dir)}>把当前目录作成工作区</button>
          <ul>
            {entries.map(entry => (
              <li key={entry.path}>
                <button type="button" disabled={busy} onClick={() => void browse(selected, entry.path)}>{entry.name}</button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}

function blankHost(): HostView {
  return { id: '', name: '', host: '', port: 22, username: '', auth: 'key', privateKeyPath: '', fingerprint: '' }
}

function parentDir(dir: string): string {
  const trimmed = dir.replace(/\/+$/, '')
  const slash = trimmed.lastIndexOf('/')
  if (slash <= 0) return '/'
  return trimmed.slice(0, slash)
}

function newId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(8))
  return `h${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`
}
