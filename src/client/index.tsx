import { useEffect, useRef, useState } from 'react'
import en from '../../locale/en.json' with { type: 'json' }
import zh from '../../locale/zh.json' with { type: 'json' }
import { callHost, installRipgrep, readHosts, readWorkspaces, writeRgRegistry, writeTagWorkspaceTitles, type ClientFace, type DeletedHostView, type HostView, type RemoteWorkspaceView, type RunnerView } from './api.ts'
import { blankDraft, createTarget, draftPortValid, mergeEditedHost, parentDir, toDraft, type Draft } from './draft.ts'
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

/** `tagWorkspaces` returns the refreshed rows together with how many changed. */
interface WorkspaceTagResult {
  items?: RemoteWorkspaceView[]
  deleted?: DeletedHostView[]
  changed?: number
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
  const [draft, setDraft] = useState<Draft>(blankDraft())
  /** The add/edit form is a dialog; nothing renders it until opened. */
  const [formOpen, setFormOpen] = useState(false)
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const [secret, setSecret] = useState('')
  const [message, setMessage] = useState('')
  const [tone, setTone] = useState<'ok' | 'warn'>('ok')
  // `browsing` owns the directory panel; status and trust render inside their host row.
  const [browsing, setBrowsing] = useState('')
  const [listed, setListed] = useState(false)
  // Each panel is tagged with its host and rendered inside that host's row, so
  // probing one host never shows another host's probe or fingerprint offer.
  // `banner` is the greeting the remote printed; it belongs beside the probe
  // result it arrived with, not in the page-level message.
  const [status, setStatus] = useState<{ hostId: string, runner: RunnerView, banner: string } | null>(null)
  const [installLog, setInstallLog] = useState<{ hostId: string, text: string } | null>(null)
  const [dir, setDir] = useState('/')
  const [entries, setEntries] = useState<Array<{ name: string, path: string }>>([])
  const [busy, setBusy] = useState(false)
  const [pendingTrust, setPendingTrust] = useState<{ hostId: string, fingerprint: string } | null>(null)
  const [workspaces, setWorkspaces] = useState<RemoteWorkspaceView[]>([])
  const [deleted, setDeleted] = useState<DeletedHostView[]>([])
  const [openWorkspaces, setOpenWorkspaces] = useState<Record<string, boolean>>({})
  const [tagTitles, setTagTitles] = useState(true)
  const [rgRegistry, setRgRegistry] = useState('')
  const [revision, setRevision] = useState(0)

  async function reload(): Promise<HostView[]> {
    const loaded = await readHosts(ctx)
    setHosts(loaded.hosts)
    setTagTitles(loaded.tagWorkspaceTitles)
    setRgRegistry(loaded.rgRegistry)
    setRevision(loaded.revision)
    return loaded.hosts
  }

  async function toggleTagTitles(enabled: boolean): Promise<void> {
    setBusy(true)
    try {
      await writeTagWorkspaceTitles(ctx, enabled, revision)
      setTagTitles(enabled)
      const saved = await readHosts(ctx)
      setRevision(saved.revision)
      // Enabling the switch should label the existing workspaces now, not on
      // the next plugin load.
      if (enabled) {
        const tagged = await callHost<WorkspaceTagResult>(ctx, 'tagWorkspaces', {})
        const changed = tagged.changed ?? 0
        note(changed > 0 ? `${changed} ${t('titlesUpdated')}` : t('tagToggleSaved'))
      } else {
        note(t('tagToggleSaved'))
      }
      await reloadWorkspaces()
    } catch (error) {
      // A stale revision means another tab wrote first; re-read and let the user retry.
      await reload().catch(() => undefined)
      fail(error)
    } finally {
      setBusy(false)
    }
  }

  /** Workspace rows and tombstones always arrive together. */
  function applyTagged(tagged: WorkspaceTagResult): number {
    if (Array.isArray(tagged.items)) setWorkspaces(tagged.items)
    if (Array.isArray(tagged.deleted)) setDeleted(tagged.deleted)
    return tagged.changed ?? 0
  }

  async function reloadWorkspaces(): Promise<void> {
    const listed = await readWorkspaces(ctx)
    setWorkspaces(listed.items)
    setDeleted(listed.deleted)
  }

  useEffect(() => {
    // A host without the newer workspace RPC still has to list and save hosts.
    void reload().catch(error => fail(error))
    void reloadWorkspaces().catch(() => setWorkspaces([]))
  }, [])

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog === null) return
    // `open` alone is a static element: no backdrop, no focus trap, no Esc.
    if (formOpen && !dialog.open) dialog.showModal()
    if (!formOpen && dialog.open) dialog.close()
  }, [formOpen])

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
      const latest = hosts.find(item => item.id === id)
      const next = mergeEditedHost(latest, { ...draft, id })
      const moved = latest !== undefined && (latest.host !== next.host || latest.port !== next.port)
      await callHost(ctx, 'saveHost', next)
      // Remember the generated id before the credential call: a failure there
      // would make the retry mint a second host row for the same server.
      setDraft(current => ({ ...current, id }))
      if (next.auth === 'password' || secret.trim().length > 0) {
        await callHost(ctx, 'saveSecret', {
          hostId: id,
          password: next.auth === 'password' && secret.trim().length > 0 ? secret : undefined,
          passphrase: next.auth === 'key' && secret.trim().length > 0 ? secret : undefined,
        })
      }
      setSecret('')
      setDraft(blankDraft())
      setFormOpen(false)
      if (moved && status?.hostId === id) setStatus(null)
      await Promise.all([reload(), reloadWorkspaces()])
      note(moved ? `${t('saved')} ${t('retrust')}` : t('saved'))
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }

  function beginAdd(): void {
    setDraft(blankDraft())
    setSecret('')
    setPendingTrust(null)
    setMessage('')
    setTone('ok')
    setFormOpen(true)
  }

  function beginEdit(host: HostView): void {
    setDraft(toDraft(host))
    setSecret('')
    setPendingTrust(null)
    setMessage('')
    setTone('ok')
    setFormOpen(true)
  }

  function cancelEdit(): void {
    setDraft(blankDraft())
    setSecret('')
    setFormOpen(false)
  }

  async function test(host: HostView): Promise<void> {
    setBusy(true)
    setMessage('')
    // Nothing from the previous host may stay on screen while this one is probed.
    setStatus(null)
    setPendingTrust(null)
    setInstallLog(null)
    try {
      const offered = await callHost<{ fingerprint: string, trusted: boolean, banner: string }>(ctx, 'testConnection', { hostId: host.id })
      if (!offered.trusted) {
        // The row shows the offer and the fingerprint; the page message would
        // repeat both. A stale probe from the previous host must go too.
        setPendingTrust({ hostId: host.id, fingerprint: offered.fingerprint })
        setMessage('')
        return
      }
      // One result block: the row's own status panel. Writing the same outcome
      // to the page message showed it twice.
      setMessage('')
      setStatus({
        hostId: host.id,
        banner: offered.banner,
        runner: await callHost<RunnerView>(ctx, 'probe', { hostId: host.id, refresh: true }),
      })
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }

  async function trust(host: HostView): Promise<void> {
    // The offered fingerprint belongs to the host it was issued for.
    if (pendingTrust === null || pendingTrust.hostId !== host.id) return
    setBusy(true)
    try {
      await callHost(ctx, 'trustFingerprint', { hostId: host.id, fingerprint: pendingTrust.fingerprint })
      setPendingTrust(null)
      await reload()
      note(t('trusted'))
      setStatus({ hostId: host.id, banner: '', runner: await callHost<RunnerView>(ctx, 'probe', { hostId: host.id, refresh: true }) })
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }

  /** Save the npm registry; empty restores npmjs. */
  async function saveRegistry(): Promise<void> {
    setBusy(true)
    try {
      await writeRgRegistry(ctx, rgRegistry.trim(), revision)
      const saved = await readHosts(ctx)
      setRgRegistry(saved.rgRegistry)
      setRevision(saved.revision)
      note(t('registrySaved'))
    } catch (error) {
      await reload().catch(() => undefined)
      fail(error)
    } finally {
      setBusy(false)
    }
  }

  /**
   * Download the ripgrep binary for this host's remote platform. Explicit: the
   * plugin never reaches the network on its own.
   */
  async function installRg(hostId: string): Promise<void> {
    setBusy(true)
    setInstallLog(null)
    try {
      const result = await installRipgrep(ctx, hostId)
      setStatus({ hostId, banner: '', runner: await callHost<RunnerView>(ctx, 'probe', { hostId, refresh: false }) })
      setInstallLog({
        hostId,
        text: result.status.ripgrep === 'missing'
          ? `${t('rgStillMissing')} (${result.platform} ${result.version})`
          : `${t('rgInstalled')} ${result.platform} ${result.version} -> ${result.status.ripgrepPath}`,
      })
    } catch (error) {
      setInstallLog({ hostId, text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  async function install(hostId: string): Promise<void> {
    setBusy(true)
    setInstallLog(null)
    try {
      const result = await callHost<{ ok: boolean, code: number | null, stdout: string, stderr: string, status: RunnerView }>(ctx, 'installDeps', { hostId })
      setStatus({ hostId, banner: '', runner: result.status })
      // The outcome is the re-probe, not the exit status: a package manager can
      // report success on an already-installed package, and a non-zero status
      // can still leave a usable bwrap behind.
      const ready = result.status.sandbox.available
      const verdict = ready
        ? t('installOk')
        : result.ok ? t('installNoEffect') : t('installFailed')
      const exit = `exit ${result.code ?? 'null'}`
      const body = [result.stdout, result.stderr].filter(Boolean).join('\n')
      setInstallLog({ hostId, text: `${verdict} (${exit})\n${body.length > 0 ? body : t('installNoOutput')}` })
      // The banner has to say the same thing the log does.
      if (ready) note(t('installOk'))
      else if (result.ok) fail(t('installNoEffect'))
      else fail(t('installFailed'))
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      setInstallLog({ hostId, text: `${t('installFailed')}\n${text}` })
      fail(text)
    } finally {
      setBusy(false)
    }
  }

  async function savePolicy(host: HostView, opsPolicy: HostView['opsPolicy']): Promise<void> {
    setBusy(true)
    try {
      await callHost(ctx, 'saveHost', { ...host, opsPolicy })
      await reload()
      // Keep an open edit form in step with the policy just saved on the card.
      setDraft(current => current.id === host.id ? { ...current, opsPolicy } : current)
      note(t('policySaved'))
    } catch (error) {
      // The select is controlled by the loaded host. Reload shows the saved
      // policy, or the previous one when the save did not land.
      await reload().catch(() => undefined)
      fail(error)
    } finally {
      setBusy(false)
    }
  }

  async function removeHost(hostId: string): Promise<void> {
    setBusy(true)
    try {
      await callHost(ctx, 'deleteHost', { hostId })
      if (browsing === hostId) {
        setBrowsing('')
        setEntries([])
        setDir('/')
        setListed(false)
      }
      if (status?.hostId === hostId) setStatus(null)
      if (pendingTrust?.hostId === hostId) setPendingTrust(null)
      if (installLog?.hostId === hostId) setInstallLog(null)
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
    try {
      const listed = await callHost<{ path: string, entries: Array<{ name: string, path: string }> }>(ctx, 'listDir', { hostId, path })
      // Only commit once the listing succeeded: a failure keeps the previous host.
      setBrowsing(hostId)
      setDir(listed.path)
      setEntries(listed.entries)
      setListed(true)
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
      const changed = applyTagged(await callHost<WorkspaceTagResult>(ctx, 'tagWorkspaces', { hostId, workspaceId }))
      note(changed > 0 ? `${changed} ${t('titlesUpdated')}` : t('titlesUnchanged'))
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }

  async function removeWorkspace(hostId: string, workspaceId: string): Promise<void> {
    setBusy(true)
    try {
      const removed = await callHost<{ ok?: boolean }>(ctx, 'removeWorkspace', { hostId, workspaceId })
      await reloadWorkspaces()
      note(removed.ok === false ? t('workspaceGone') : t('workspaceRemoved'))
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }

  async function restoreHost(hostId: string): Promise<void> {
    setBusy(true)
    try {
      await callHost(ctx, 'restoreHost', { hostId })
      await Promise.all([reload(), reloadWorkspaces()])
      note(t('restoredHost'))
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }

  const browsingHost = hosts.find(item => item.id === browsing)
  const target = createTarget(browsing, listed)
  const crumbs = dir.split('/').filter(Boolean)
  const byHost = new Map<string, RemoteWorkspaceView[]>()
  for (const workspace of workspaces) {
    const rows = byHost.get(workspace.hostId)
    if (rows === undefined) byHost.set(workspace.hostId, [workspace])
    else rows.push(workspace)
  }
  // Workspaces whose host is no longer configured stay registered in DSH, and a
  // removed host may own none at all. Both belong under "deleted hosts", or the
  // host could never be restored from the settings page.
  const orphans = new Map<string, RemoteWorkspaceView[]>()
  for (const [hostId, rows] of byHost) {
    if (hosts.every(host => host.id !== hostId)) orphans.set(hostId, rows)
  }
  for (const row of deleted) {
    if (hosts.every(host => host.id !== row.id) && !orphans.has(row.id)) orphans.set(row.id, [])
  }

  const workspaceRow = (workspace: RemoteWorkspaceView): JSX.Element => (
    <li key={workspace.workspaceId} className="dsh-ssh-workspace">
      <div className="dsh-ssh-workspace-text">
        <span className="dsh-ssh-workspace-title" title={workspace.title}>{workspace.title}</span>
        <span className="dsh-ssh-workspace-path" title={workspace.remotePath}>{workspace.remotePath}</span>
      </div>
      <div className="dsh-ssh-inline">
        <span className="dsh-ssh-workspace-meta">{workspace.sessions} {t('sessions')}</span>
        <button type="button" className="dsh-ssh-button" disabled={busy} onClick={() => void removeWorkspace(workspace.hostId, workspace.workspaceId)}>{t('unregister')}</button>
      </div>
    </li>
  )

  return (
    <section className="dsh-ssh-page">
      <div className="dsh-ssh-header">
        <h2 className="dsh-ssh-title">{t('title')}</h2>
        <button type="button" className="dsh-ssh-button" data-primary="true" disabled={busy} onClick={beginAdd}>{t('addHost')}</button>
      </div>
      <p className="dsh-ssh-intro">{t('description')}</p>
      {message.length > 0 ? <p className="dsh-ssh-status" data-tone={tone === 'warn' ? 'warn' : undefined}>{message}</p> : null}
      {hosts.length > 0 ? (
        <ul className="dsh-ssh-hosts">
          {hosts.map(host => {
            const owned = byHost.get(host.id) ?? []
            const expanded = openWorkspaces[host.id] ?? true
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
                {/* Trust and probe output belong to the row they describe: the
                    add/edit form sits between the list and the page bottom, so a
                    panel down there was off-screen while operating a host. */}
                {pendingTrust !== null && pendingTrust.hostId === host.id
                  ? <div className="dsh-ssh-trust">
                      <span className="dsh-ssh-note">{t('untrusted')}</span>
                      <code className="dsh-ssh-fingerprint">{pendingTrust.fingerprint}</code>
                      <button type="button" className="dsh-ssh-button" data-primary="true" disabled={busy} onClick={() => void trust(host)}>{t('trust')}</button>
                    </div>
                  : null}
                {status !== null && status.hostId === host.id ? (
                  <div className="dsh-ssh-status-row">
                    <div>
                      {status.banner.length > 0
                        ? <div className="dsh-ssh-host-meta dsh-ssh-banner" title={status.banner}>{status.banner}</div>
                        : null}
                      <div className="dsh-ssh-host-name">{t('sandbox')}: {status.runner.sandboxTool} {status.runner.sandbox.available ? t('available') : `${t('unavailable')} (${status.runner.sandbox.reason})`}</div>
                      <div className="dsh-ssh-host-meta">
                        {t('ripgrep')}: {status.runner.ripgrep}
                        {/* Missing on a remote this machine has no build for: fetch
                            the matching binary on request instead of failing silently. */}
                        {status.runner.ripgrep === 'missing'
                          ? <button type="button" className="dsh-ssh-link" disabled={busy} onClick={() => void installRg(host.id)}>{t('installRipgrep')}</button>
                          : null}
                      </div>
                    </div>
                    {status.runner.os === 'linux' && !status.runner.sandbox.available
                      ? <button type="button" className="dsh-ssh-button" disabled={busy || status.runner.install === null} onClick={() => void install(host.id)}>{t('install')}</button>
                      : null}
                  </div>
                ) : null}
                {installLog !== null && installLog.hostId === host.id
                  ? <pre className="dsh-ssh-log">{installLog.text}</pre>
                  : null}
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
                        {owned.map(workspaceRow)}
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
      <label className="dsh-ssh-toggle">
        <input
          type="checkbox"
          checked={tagTitles}
          disabled={busy}
          onChange={event => void toggleTagTitles(event.target.checked)}
        />
        <span>{t('tagTitles')}</span>
        <span className="dsh-ssh-note">{t('tagTitlesHint')}</span>
      </label>
      {/* Only used by the explicit ripgrep install; empty means npmjs. */}
      <div className="dsh-ssh-registry">
        <label className="dsh-ssh-field" htmlFor="dsh-ssh-registry">
          <span className="dsh-ssh-label">{t('rgRegistry')}</span>
          <input
            id="dsh-ssh-registry"
            className="dsh-ssh-input"
            type="text"
            value={rgRegistry}
            placeholder="https://registry.npmjs.org"
            disabled={busy}
            onChange={event => setRgRegistry(event.target.value)}
          />
        </label>
        <button type="button" className="dsh-ssh-button" disabled={busy} onClick={() => void saveRegistry()}>{t('save')}</button>
        <span className="dsh-ssh-note">{t('rgRegistryHint')}</span>
      </div>
      {orphans.size > 0 ? (
        <div className="dsh-ssh-deleted">
          <h3 className="dsh-ssh-section-title">{t('deletedHosts')}</h3>
          <p className="dsh-ssh-note">{t('deletedHostsNote')}</p>
          <ul className="dsh-ssh-hosts">
            {[...orphans.entries()].map(([hostId, rows]) => {
              const tombstone = deleted.find(item => item.id === hostId)
              return (
                <li key={hostId} className="dsh-ssh-host">
                  <div className="dsh-ssh-host-head">
                    <div className="dsh-ssh-host-identity">
                      <div className="dsh-ssh-host-name">{tombstone?.name ?? hostId}</div>
                      <div className="dsh-ssh-host-meta">
                        {tombstone === undefined ? hostId : `${tombstone.username}@${tombstone.address}:${tombstone.port} · ${t('hostRemoved')}`}
                      </div>
                    </div>
                    <div className="dsh-ssh-row-actions">
                      <button
                        type="button"
                        className="dsh-ssh-button"
                        disabled={busy || tombstone === undefined}
                        title={tombstone === undefined ? t('restoreUnavailable') : undefined}
                        onClick={() => void restoreHost(hostId)}
                      >{t('restoreHost')}</button>
                    </div>
                  </div>
                  {rows.length > 0 ? (
                    <ul className="dsh-ssh-workspace-list">
                      {rows.map(workspaceRow)}
                    </ul>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}
      {browsingHost !== undefined ? (
        <div className="dsh-ssh-browser">
          <div className="dsh-ssh-browser-head">
            <div className="dsh-ssh-browser-heading">
              <span className="dsh-ssh-legend">{t('directory')}</span>
              <span className="dsh-ssh-browser-host">{browsingHost.name || browsingHost.host}</span>
            </div>
            <div className="dsh-ssh-inline">
              <button type="button" className="dsh-ssh-button" disabled={busy || dir === '/'} onClick={() => void browse(browsing, parentDir(dir))}>{t('up')}</button>
              <button type="button" className="dsh-ssh-button" disabled={busy} onClick={() => void browse(browsing, dir)}>{t('refresh')}</button>
              <button type="button" className="dsh-ssh-button" data-primary="true" disabled={busy || target === null} onClick={() => { if (target !== null) void createWorkspace(target, dir) }}>{t('createWorkspace')}</button>
            </div>
          </div>
          <div className="dsh-ssh-breadcrumb">
            <button type="button" className="dsh-ssh-crumb" disabled={busy} onClick={() => void browse(browsing, '/')}>/</button>
            {crumbs.map((name, index) => (
              <span key={`${name}-${index}`} className="dsh-ssh-crumb-part">
                <span className="dsh-ssh-crumb-sep">/</span>
                <button type="button" className="dsh-ssh-crumb" disabled={busy} onClick={() => void browse(browsing, `/${crumbs.slice(0, index + 1).join('/')}`)}>{name}</button>
              </span>
            ))}
          </div>
          <ul className="dsh-ssh-dirs">
            {entries.map(entry => (
              <li key={entry.path}>
                <button type="button" className="dsh-ssh-dir" disabled={busy} onClick={() => void browse(browsing, entry.path)}>
                  <span className="dsh-ssh-dir-icon" aria-hidden="true">▸</span>
                  <span className="dsh-ssh-dir-name">{entry.name}</span>
                </button>
              </li>
            ))}
            {entries.length === 0 ? <li className="dsh-ssh-empty">{t('emptyDir')}</li> : null}
          </ul>
        </div>
      ) : null}
      <dialog ref={dialogRef} className="dsh-ssh-dialog" aria-label={draft.id.length > 0 ? t('editHost') : t('addHost')} onCancel={event => { event.preventDefault(); if (!busy) cancelEdit() }}>
        {/* The list stays in view behind the dialog, so a host card is still
            reachable while the form is open. */}
        <form id="dsh-ssh-form" className="dsh-ssh-card" data-editing={draft.id.length > 0 ? 'true' : undefined} onSubmit={event => { event.preventDefault(); void saveDraft() }}>
          <div className="dsh-ssh-dialog-head">
            <div className="dsh-ssh-legend">{draft.id.length > 0 ? t('editHost') : t('addHost')}</div>
            <button type="button" className="dsh-ssh-close" aria-label={t('cancel')} title={t('cancel')} disabled={busy} onClick={cancelEdit}>×</button>
          </div>
          <div className="dsh-ssh-grid">
            <Field id="dsh-ssh-name" label={t('name')} value={draft.name} onChange={value => setDraft({ ...draft, name: value })} />
            <Field id="dsh-ssh-host" label={t('address')} value={draft.host} onChange={value => setDraft({ ...draft, host: value })} />
          </div>
          <div className="dsh-ssh-grid">
            <Field id="dsh-ssh-port" label={t('port')} value={draft.port} onChange={value => setDraft({ ...draft, port: value.replace(/[^0-9]/g, '') })} />
            <Field id="dsh-ssh-user" label={t('user')} value={draft.username} onChange={value => setDraft({ ...draft, username: value })} />
          </div>
          <label className="dsh-ssh-field" htmlFor="dsh-ssh-auth">
            <span className="dsh-ssh-label">{t('auth')}</span>
            <select id="dsh-ssh-auth" className="dsh-ssh-select" value={draft.auth} onChange={event => setDraft({ ...draft, auth: event.target.value === 'password' ? 'password' : 'key' })}>
              <option value="key">{t('authKey')}</option>
              <option value="password">{t('authPassword')}</option>
            </select>
          </label>
          {draft.auth === 'key'
            ? <Field id="dsh-ssh-key" label={t('keyPath')} value={draft.privateKeyPath} onChange={value => setDraft({ ...draft, privateKeyPath: value })} />
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
          <Field id="dsh-ssh-secret" label={draft.auth === 'password' ? t('password') : t('passphrase')} value={secret} secret onChange={setSecret} />
          {draft.id.length > 0 ? <p className="dsh-ssh-note">{t('secretKeep')}</p> : null}
          <div className="dsh-ssh-actions">
            <button type="button" className="dsh-ssh-button" disabled={busy} onClick={cancelEdit}>{t('cancel')}</button>
            <button type="submit" className="dsh-ssh-button" data-primary="true" disabled={busy || draft.host.trim().length === 0 || draft.username.trim().length === 0 || !draftPortValid(draft)}>{t('save')}</button>
          </div>
        </form>
      </dialog>
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

function Field(props: { id: string, label: string, value: string, secret?: boolean, onChange: (value: string) => void }): JSX.Element {
  return (
    <label className="dsh-ssh-field" htmlFor={props.id}>
      <span className="dsh-ssh-label">{props.label}</span>
      <input id={props.id} className="dsh-ssh-input" type={props.secret ? 'password' : 'text'} value={props.value} onChange={event => props.onChange(event.target.value)} />
    </label>
  )
}

function newId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(8))
  return `h${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`
}
