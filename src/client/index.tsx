import { useEffect, useState } from 'react'
import en from '../../locale/en.json' with { type: 'json' }
import zh from '../../locale/zh.json' with { type: 'json' }
import { callHost, readHosts, type ClientFace, type HostView, type RunnerView } from './api.ts'
import { installStyles } from './styles.ts'

export const inject = ['remote', 'remote.settings', 'connection', 'slots', 'locale']

const NS = 'permission-remote'

const MANUAL = [
  { title: 'Debian/Ubuntu', command: 'sudo apt-get update && sudo apt-get install -y bubblewrap' },
  { title: 'Fedora/RHEL', command: 'sudo dnf install -y bubblewrap' },
  { title: 'Arch', command: 'sudo pacman -S bubblewrap' },
  { title: 'Alpine', command: 'sudo apk add bubblewrap' },
] as const

interface SectionProps {
  close: () => void
  ctx: ClientFace
  t: (key: string) => string
}

interface LocaleApi {
  register(ns: string, lang: string, dict: Record<string, string>): () => void
  bind(ns: string): (key: string) => string
}

export function apply(ctx: ClientFace & {
  locale: LocaleApi
  slots: {
    inject(name: string, register: () => () => void): () => void
    register(options: object, component: (props: SectionProps) => JSX.Element): () => void
  }
  effect(dispose: () => void, label?: string): void
}): void {
  installStyles()
  ctx.effect(() => ctx.locale.register(NS, 'zh', zh), 'dsh-permission-remote: zh')
  ctx.effect(() => ctx.locale.register(NS, 'en', en), 'dsh-permission-remote: en')
  const nav = ctx.locale.bind(NS)
  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'permission-remote',
    order: 80,
    label: () => nav('nav'),
    locale: NS,
    inject: () => ({ ctx }),
  }, Section)), 'dsh-permission-remote: settings section')
}

function Section(props: SectionProps): JSX.Element {
  const { ctx, t } = props
  const [hosts, setHosts] = useState<HostView[]>([])
  const [draft, setDraft] = useState<HostView>(blankHost())
  const [secret, setSecret] = useState('')
  const [message, setMessage] = useState('')
  const [tone, setTone] = useState<'ok' | 'warn'>('ok')
  const [selected, setSelected] = useState('')
  const [status, setStatus] = useState<RunnerView | null>(null)
  const [installLog, setInstallLog] = useState('')
  const [dir, setDir] = useState('/')
  const [entries, setEntries] = useState<Array<{ name: string, path: string }>>([])
  const [busy, setBusy] = useState(false)
  const [pendingTrust, setPendingTrust] = useState('')

  async function reload(): Promise<void> {
    const loaded = await readHosts(ctx)
    setHosts(loaded.hosts)
  }

  useEffect(() => {
    void reload().catch(error => fail(error))
  }, [])

  function fail(error: unknown): void {
    setTone('warn')
    setMessage(error instanceof Error ? error.message : String(error))
  }

  function note(text: string): void {
    setTone('ok')
    setMessage(text)
  }

  async function saveDraft(): Promise<void> {
    setBusy(true)
    setMessage('')
    try {
      const id = draft.id || newId()
      const next = { ...draft, id, port: Number(draft.port) || 22 }
      await callHost(ctx, 'saveHost', next)
      setDraft(next)
      if (next.auth === 'password' || secret.trim().length > 0) {
        await callHost(ctx, 'saveSecret', {
          hostId: id,
          password: next.auth === 'password' ? secret : undefined,
          passphrase: next.auth === 'key' && secret.trim().length > 0 ? secret : undefined,
        })
      }
      setSecret('')
      setDraft(blankHost())
      await reload()
      note(t('saved'))
    } catch (error) {
      fail(error)
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
        setPendingTrust(offered.fingerprint)
        setTone('warn')
        setMessage(`${t('untrusted')} ${offered.fingerprint}`)
        return
      }
      setPendingTrust('')
      note(offered.banner.length > 0 ? `${t('connected')} ${offered.banner}` : t('connected'))
      setStatus(await callHost<RunnerView>(ctx, 'probe', { hostId: host.id, refresh: true }))
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }

  async function trust(host: HostView): Promise<void> {
    if (pendingTrust.trim().length === 0) return
    setBusy(true)
    try {
      await callHost(ctx, 'trustFingerprint', { hostId: host.id, fingerprint: pendingTrust })
      setPendingTrust('')
      await reload()
      note(t('trusted'))
      setStatus(await callHost<RunnerView>(ctx, 'probe', { hostId: host.id, refresh: true }))
    } catch (error) {
      fail(error)
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

  async function savePolicy(host: HostView, opsPolicy: HostView['opsPolicy']): Promise<void> {
    setBusy(true)
    try {
      await callHost(ctx, 'saveHost', { ...host, opsPolicy })
      await reload()
      note(t('policySaved'))
    } catch (error) {
      fail(error)
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
      fail(error)
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
      fail(error)
    } finally {
      setBusy(false)
    }
  }

  async function createWorkspace(hostId: string, path: string): Promise<void> {
    setBusy(true)
    try {
      const created = await callHost<{ path: string }>(ctx, 'createWorkspace', { hostId, path })
      note(`${t('workspaceCreated')} ${created.path}`)
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }

  const current = hosts.find(item => item.id === selected)

  return (
    <section className="dsh-ssh-page">
      <h2 className="dsh-ssh-title">{t('title')}</h2>
      <p className="dsh-ssh-intro">{t('description')}</p>
      {message.length > 0 ? <p className="dsh-ssh-status" data-tone={tone === 'warn' ? 'warn' : undefined}>{message}</p> : null}
      {hosts.length > 0 ? (
        <ul className="dsh-ssh-hosts">
          {hosts.map(host => (
            <li key={host.id} className="dsh-ssh-host">
              <div>
                <div className="dsh-ssh-host-name">{host.name || host.host}</div>
                <div className="dsh-ssh-host-meta">{host.username}@{host.host}:{host.port}</div>
              </div>
              <div className="dsh-ssh-row-actions">
                <select
                  className="dsh-ssh-select dsh-ssh-policy"
                  aria-label={t('opsPolicy')}
                  value={host.opsPolicy ?? 'ask'}
                  disabled={busy}
                  onChange={event => void savePolicy(host, event.target.value as HostView['opsPolicy'])}
                >
                  <option value="ask">{t('opsAsk')}</option>
                  <option value="trust">{t('opsTrust')}</option>
                  <option value="deny">{t('opsDeny')}</option>
                </select>
                <button type="button" className="dsh-ssh-button" disabled={busy} onClick={() => void test(host)}>{t('test')}</button>
                <button type="button" className="dsh-ssh-button" disabled={busy} onClick={() => void browse(host.id, '/')}>{t('browse')}</button>
                <button type="button" className="dsh-ssh-button" disabled={busy} onClick={() => void removeHost(host.id)}>{t('remove')}</button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      <form className="dsh-ssh-card" onSubmit={event => { event.preventDefault(); void saveDraft() }}>
        <div className="dsh-ssh-legend">{t('addHost')}</div>
        <div className="dsh-ssh-grid">
          <Field label={t('name')} value={draft.name} onChange={value => setDraft({ ...draft, name: value })} />
          <Field label={t('address')} value={draft.host} onChange={value => setDraft({ ...draft, host: value })} />
        </div>
        <div className="dsh-ssh-grid">
          <Field label={t('port')} value={String(draft.port)} onChange={value => setDraft({ ...draft, port: Number(value) || 22 })} />
          <Field label={t('user')} value={draft.username} onChange={value => setDraft({ ...draft, username: value })} />
        </div>
        <label className="dsh-ssh-field" htmlFor="dsh-ssh-auth">
          <span className="dsh-ssh-label">{t('auth')}</span>
          <select id="dsh-ssh-auth" className="dsh-ssh-select" value={draft.auth} onChange={event => setDraft({ ...draft, auth: event.target.value === 'password' ? 'password' : 'key' })}>
            <option value="key">{t('authKey')}</option>
            <option value="password">{t('authPassword')}</option>
          </select>
        </label>
        {draft.auth === 'key'
          ? <Field label={t('keyPath')} value={draft.privateKeyPath} onChange={value => setDraft({ ...draft, privateKeyPath: value })} />
          : null}
        <label className="dsh-ssh-field" htmlFor="dsh-ssh-policy">
          <span className="dsh-ssh-label">{t('opsPolicy')}</span>
          <select id="dsh-ssh-policy" className="dsh-ssh-select" value={draft.opsPolicy} onChange={event => setDraft({ ...draft, opsPolicy: event.target.value as HostView['opsPolicy'] })}>
            <option value="ask">{t('opsAsk')}</option>
            <option value="trust">{t('opsTrust')}</option>
            <option value="deny">{t('opsDeny')}</option>
          </select>
        </label>
        <p className="dsh-ssh-note">{t('opsNote')}</p>
        <Field label={draft.auth === 'password' ? t('password') : t('passphrase')} value={secret} secret onChange={setSecret} />
        <div className="dsh-ssh-actions">
          <button type="submit" className="dsh-ssh-button" data-primary="true" disabled={busy || draft.host.trim().length === 0 || draft.username.trim().length === 0}>{t('save')}</button>
        </div>
      </form>
      {pendingTrust.length > 0 && current !== undefined
        ? <button type="button" className="dsh-ssh-button" data-primary="true" disabled={busy} onClick={() => void trust(current)}>{t('trust')} {pendingTrust}</button>
        : null}
      {status !== null && current !== undefined ? (
        <div className="dsh-ssh-host">
          <div>
            <div className="dsh-ssh-host-name">{t('sandbox')}: {status.sandboxTool} {status.sandbox.available ? t('available') : `${t('unavailable')} (${status.sandbox.reason})`}</div>
            <div className="dsh-ssh-host-meta">{t('ripgrep')}: {status.ripgrep}</div>
          </div>
          {status.os === 'linux' && !status.sandbox.available
            ? <button type="button" className="dsh-ssh-button" disabled={busy || status.install === null} onClick={() => void install(current.id)}>{t('install')}</button>
            : null}
        </div>
      ) : null}
      {installLog.length > 0 ? <pre className="dsh-ssh-log">{installLog}</pre> : null}
      <h3 className="dsh-ssh-section-title">{t('manualTitle')}</h3>
      <div className="dsh-ssh-manual">
        {MANUAL.map(item => (
          <div key={item.title} className="dsh-ssh-command">
            <div className="dsh-ssh-command-text">
              <span className="dsh-ssh-label">{item.title}</span>
              <code>{item.command}</code>
            </div>
            <button type="button" className="dsh-ssh-button" onClick={() => void navigator.clipboard.writeText(item.command)}>{t('copy')}</button>
          </div>
        ))}
      </div>
      <p className="dsh-ssh-note">{t('macosNote')}</p>
      <p className="dsh-ssh-note">{t('ripgrepNote')}</p>
      {selected.length > 0 ? (
        <div>
          <h3 className="dsh-ssh-section-title">{t('directory')} {dir}</h3>
          <div className="dsh-ssh-inline">
            {dir !== '/' ? <button type="button" className="dsh-ssh-button" disabled={busy} onClick={() => void browse(selected, parentDir(dir))}>{t('up')}</button> : null}
            <button type="button" className="dsh-ssh-button" data-primary="true" disabled={busy} onClick={() => void createWorkspace(selected, dir)}>{t('createWorkspace')}</button>
          </div>
          <ul className="dsh-ssh-dirs">
            {entries.map(entry => (
              <li key={entry.path}>
                <button type="button" className="dsh-ssh-button dsh-ssh-dir" disabled={busy} onClick={() => void browse(selected, entry.path)}>{entry.name}</button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}

function Field(props: { label: string, value: string, secret?: boolean, onChange: (value: string) => void }): JSX.Element {
  const id = `dsh-ssh-${props.label}`
  return (
    <label className="dsh-ssh-field" htmlFor={id}>
      <span className="dsh-ssh-label">{props.label}</span>
      <input id={id} className="dsh-ssh-input" type={props.secret ? 'password' : 'text'} value={props.value} onChange={event => props.onChange(event.target.value)} />
    </label>
  )
}

function blankHost(): HostView {
  return { id: '', name: '', host: '', port: 22, username: '', auth: 'key', privateKeyPath: '', fingerprint: '', opsPolicy: 'ask' }
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
