import { useEffect, useState } from 'react'
import en from '../../locale/en.json' with { type: 'json' }
import zh from '../../locale/zh.json' with { type: 'json' }
import { callHost, readHosts, readWorkspaces, type ClientFace, type HostView, type RemoteWorkspaceView, type RunnerView } from './api.ts'
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
  const [workspaces, setWorkspaces] = useState<RemoteWorkspaceView[]>([])
  const [openWorkspaces, setOpenWorkspaces] = useState<Record<string, boolean>>({})

  async function reload(): Promise<void> {
    const loaded = await readHosts(ctx)
    setHosts(loaded.hosts)
  }

  async function reloadWorkspaces(): Promise<void> {
    setWorkspaces(await readWorkspaces(ctx))
  }

  useEffect(() => {
    void Promise.all([reload(), reloadWorkspaces()]).catch(error => fail(error))
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
      const port = Number(draft.port) || 22
      const previous = hosts.find(item => item.id === id)
      // A different machine at this address must prove its key again.
      const moved = previous !== undefined && (previous.host !== draft.host || previous.port !== port)
      const next = { ...draft, id, port, fingerprint: moved ? '' : draft.fingerprint }
      await callHost(ctx, 'saveHost', next)
      setDraft(next)
      if (next.auth === 'password' || secret.trim().length > 0) {
        await callHost(ctx, 'saveSecret', {
          hostId: id,
          password: next.auth === 'password' && secret.trim().length > 0 ? secret : undefined,
          passphrase: next.auth === 'key' && secret.trim().length > 0 ? secret : undefined,
        })
      }
      setSecret('')
      setDraft(blankHost())
      if (moved && selected === id) setStatus(null)
      await Promise.all([reload(), reloadWorkspaces()])
      note(moved ? `${t('saved')} ${t('retrust')}` : t('saved'))
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }

  function beginEdit(host: HostView): void {
    setDraft({ ...host })
    setSecret('')
    setPendingTrust('')
    setMessage('')
    setTone('ok')
    const form = document.getElementById('dsh-ssh-form')
    if (form !== null && typeof form.scrollIntoView === 'function') form.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }

  function cancelEdit(): void {
    setDraft(blankHost())
    setSecret('')
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
      if (draft.id === hostId) cancelEdit()
      await Promise.all([reload(), reloadWorkspaces()])
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }

  async function browse(hostId: string, path: string): Promise<void> {
    setBusy(true)
    setSelected(hostId)
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
      const created = await callHost<{ path: string, title?: string }>(ctx, 'createWorkspace', { hostId, path })
      note(`${t('workspaceCreated')} ${created.title ?? created.path}`)
      await reloadWorkspaces()
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }

  async function tagWorkspaces(hostId?: string, workspaceId?: string): Promise<void> {
    setBusy(true)
    try {
      const tagged = await callHost<{ items?: RemoteWorkspaceView[] }>(ctx, 'tagWorkspaces', { hostId, workspaceId })
      if (Array.isArray(tagged.items)) setWorkspaces(tagged.items)
      note(t('taggedSidebar'))
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }

  async function removeWorkspace(workspaceId: string): Promise<void> {
    setBusy(true)
    try {
      await callHost(ctx, 'removeWorkspace', { workspaceId })
      await reloadWorkspaces()
      note(t('workspaceRemoved'))
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }

  const current = hosts.find(item => item.id === selected)
  const crumbs = dir.split('/').filter(Boolean)
  const byHost = new Map<string, RemoteWorkspaceView[]>()
  for (const workspace of workspaces) {
    const rows = byHost.get(workspace.hostId)
    if (rows === undefined) byHost.set(workspace.hostId, [workspace])
    else rows.push(workspace)
  }

  return (
    <section className="dsh-ssh-page">
      <h2 className="dsh-ssh-title">{t('title')}</h2>
      <p className="dsh-ssh-intro">{t('description')}</p>
      {message.length > 0 ? <p className="dsh-ssh-status" data-tone={tone === 'warn' ? 'warn' : undefined}>{message}</p> : null}
      {hosts.length > 0 ? (
        <ul className="dsh-ssh-hosts">
          {hosts.map(host => {
            const owned = byHost.get(host.id) ?? []
            const expanded = openWorkspaces[host.id] ?? owned.length > 0
            return (
              <li key={host.id} className="dsh-ssh-host" data-editing={draft.id === host.id ? 'true' : undefined}>
                <div className="dsh-ssh-host-head">
                  <div className="dsh-ssh-host-identity">
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
                    <button type="button" className="dsh-ssh-button" disabled={busy} onClick={() => beginEdit(host)}>{t('edit')}</button>
                    <button type="button" className="dsh-ssh-button" disabled={busy} onClick={() => void test(host)}>{t('test')}</button>
                    <button type="button" className="dsh-ssh-button" disabled={busy} onClick={() => void browse(host.id, '/')}>{t('browse')}</button>
                    <button type="button" className="dsh-ssh-button" disabled={busy} onClick={() => void removeHost(host.id)}>{t('remove')}</button>
                  </div>
                </div>
                <div className="dsh-ssh-workspaces">
                  <div className="dsh-ssh-workspaces-head">
                    <button
                      type="button"
                      className="dsh-ssh-disclosure"
                      aria-expanded={expanded}
                      onClick={() => setOpenWorkspaces({ ...openWorkspaces, [host.id]: !expanded })}
                    >
                      <span className="dsh-ssh-chevron" data-open={expanded ? 'true' : undefined} aria-hidden="true">▸</span>
                      <span>{t('workspaces')}</span>
                      <span className="dsh-ssh-count">{owned.length}</span>
                    </button>
                    <button type="button" className="dsh-ssh-button" disabled={busy || owned.length === 0} onClick={() => void tagWorkspaces(host.id)}>{t('tagSidebar')}</button>
                  </div>
                  {expanded ? (
                    owned.length > 0 ? (
                      <ul className="dsh-ssh-workspace-list">
                        {owned.map(workspace => (
                          <li key={workspace.workspaceId} className="dsh-ssh-workspace">
                            <div className="dsh-ssh-workspace-text">
                              <span className="dsh-ssh-workspace-title" title={workspace.title}>{workspace.title}</span>
                              <span className="dsh-ssh-workspace-path" title={workspace.remotePath}>{workspace.remotePath}</span>
                            </div>
                            <div className="dsh-ssh-inline">
                              <span className="dsh-ssh-workspace-meta">{workspace.sessions} {t('sessions')}</span>
                              <button type="button" className="dsh-ssh-button" disabled={busy} onClick={() => void removeWorkspace(workspace.workspaceId)}>{t('unregister')}</button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    ) : <p className="dsh-ssh-note dsh-ssh-workspaces-empty">{t('noWorkspaces')}</p>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      ) : null}
      {hosts.length > 0 ? <p className="dsh-ssh-note">{t('workspacesNote')}</p> : null}
      {selected.length > 0 && current !== undefined ? (
        <div className="dsh-ssh-browser">
          <div className="dsh-ssh-browser-head">
            <div className="dsh-ssh-browser-heading">
              <span className="dsh-ssh-legend">{t('directory')}</span>
              <span className="dsh-ssh-browser-host">{current.name || current.host}</span>
            </div>
            <div className="dsh-ssh-inline">
              <button type="button" className="dsh-ssh-button" disabled={busy || dir === '/'} onClick={() => void browse(selected, parentDir(dir))}>{t('up')}</button>
              <button type="button" className="dsh-ssh-button" disabled={busy} onClick={() => void browse(selected, dir)}>{t('refresh')}</button>
              <button type="button" className="dsh-ssh-button" data-primary="true" disabled={busy} onClick={() => void createWorkspace(selected, dir)}>{t('createWorkspace')}</button>
            </div>
          </div>
          <div className="dsh-ssh-breadcrumb">
            <button type="button" className="dsh-ssh-crumb" disabled={busy} onClick={() => void browse(selected, '/')}>/</button>
            {crumbs.map((name, index) => (
              <span key={`${name}-${index}`} className="dsh-ssh-crumb-part">
                <span className="dsh-ssh-crumb-sep">/</span>
                <button type="button" className="dsh-ssh-crumb" disabled={busy} onClick={() => void browse(selected, `/${crumbs.slice(0, index + 1).join('/')}`)}>{name}</button>
              </span>
            ))}
          </div>
          <ul className="dsh-ssh-dirs">
            {entries.map(entry => (
              <li key={entry.path}>
                <button type="button" className="dsh-ssh-dir" disabled={busy} onClick={() => void browse(selected, entry.path)}>
                  <span className="dsh-ssh-dir-icon" aria-hidden="true">▸</span>
                  <span className="dsh-ssh-dir-name">{entry.name}</span>
                </button>
              </li>
            ))}
            {entries.length === 0 ? <li className="dsh-ssh-empty">{t('emptyDir')}</li> : null}
          </ul>
        </div>
      ) : null}
      <form id="dsh-ssh-form" className="dsh-ssh-card" data-editing={draft.id.length > 0 ? 'true' : undefined} onSubmit={event => { event.preventDefault(); void saveDraft() }}>
        <div className="dsh-ssh-legend">{draft.id.length > 0 ? t('editHost') : t('addHost')}</div>
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
        {draft.id.length > 0 ? <p className="dsh-ssh-note">{t('secretKeep')}</p> : null}
        <div className="dsh-ssh-actions">
          {draft.id.length > 0 ? <button type="button" className="dsh-ssh-button" disabled={busy} onClick={cancelEdit}>{t('cancel')}</button> : null}
          <button type="submit" className="dsh-ssh-button" data-primary="true" disabled={busy || draft.host.trim().length === 0 || draft.username.trim().length === 0}>{t('save')}</button>
        </div>
      </form>
      {pendingTrust.length > 0 && current !== undefined
        ? <button type="button" className="dsh-ssh-button" data-primary="true" disabled={busy} onClick={() => void trust(current)}>{t('trust')} {pendingTrust}</button>
        : null}
      {status !== null && current !== undefined ? (
        <div className="dsh-ssh-host dsh-ssh-status-row">
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
