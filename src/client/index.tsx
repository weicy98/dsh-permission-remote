import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import en from '../../locale/en.json' with { type: 'json' }
import zh from '../../locale/zh.json' with { type: 'json' }
import { callHost, installRipgrep, purgeHost as purgeHostRequest, readHosts, readWorkspaces, writeRgRegistry, writeTagWorkspaceTitles, type ClientFace, type DeletedHostView, type HostView, type RemoteWorkspaceView, type RunnerView } from './api.ts'
import { blankDraft, clampActive, createTarget, draftPortValid, filterEntries, mergeEditedHost, parentDir, stepActive, toDraft, type Draft } from './draft.ts'
import { installStyles } from './styles.ts'

export const inject = ['remote', 'remote.settings', 'connection', 'slots', 'locale']

const NS = 'permission-remote'

type TabId = 'hosts' | 'deleted' | 'settings' | 'help'

/** The page mixes unrelated concerns; each tab owns one. */
const TABS: ReadonlyArray<{ id: TabId, label: string }> = [
  { id: 'hosts', label: 'tabHosts' },
  { id: 'deleted', label: 'tabDeleted' },
  { id: 'settings', label: 'tabSettings' },
  { id: 'help', label: 'tabHelp' },
]

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
  /**
   * Typed filter for the listing, applied while typing. It narrows the names
   * already on screen, so it is local state, not a remote query: each keystroke
   * costs no round trip. A new listing resets it, because the next directory is
   * a different set of names and a stale query would hide all of them.
   */
  const [filter, setFilter] = useState('')
  /**
   * Highlighted row of the listing, as an index into the filtered rows and not
   * into `entries`: the filter can shrink the list while a row is highlighted,
   * so `-1` means nothing is highlighted and the index is clamped at render.
   * It is separate from DOM focus, because the arrow keys must keep focus in
   * the filter box — otherwise a keypress would leave the field you are typing
   * in just to move one row.
   */
  const [active, setActive] = useState(-1)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([])
  /** The open picker's card, scrolled into view when a host is opened. */
  const panelRef = useRef<HTMLDivElement | null>(null)
  const [busy, setBusy] = useState(false)
  const [pendingTrust, setPendingTrust] = useState<{ hostId: string, fingerprint: string } | null>(null)
  const [workspaces, setWorkspaces] = useState<RemoteWorkspaceView[]>([])
  const [deleted, setDeleted] = useState<DeletedHostView[]>([])
  const [openWorkspaces, setOpenWorkspaces] = useState<Record<string, boolean>>({})
  const [tagTitles, setTagTitles] = useState(true)
  const [rgRegistry, setRgRegistry] = useState('')
  const [revision, setRevision] = useState(0)
  /** Which tab is showing. The page holds four unrelated groups of controls. */
  const [tab, setTab] = useState<TabId>('hosts')
  /** Host awaiting the second click on Purge; guards a destructive action. */
  const [purgeTarget, setPurgeTarget] = useState('')

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
   *
   * The call already re-probes, so its `status` is the fresh one; a second
   * `probe` would only repeat that request and drop the login banner.
   */
  async function installRg(hostId: string): Promise<void> {
    setBusy(true)
    setInstallLog(null)
    try {
      const result = await installRipgrep(ctx, hostId)
      setStatus(current => ({ hostId, banner: current?.hostId === hostId ? current.banner : '', runner: result.status }))
      const tag = `${result.platform} ${result.version}`
      if (result.status.ripgrep === 'uploaded') {
        setInstallLog({ hostId, text: `${t('rgInstalled')} ${tag} -> ${result.status.ripgrepPath}` })
        note(t('rgInstalled'))
      } else if (result.status.ripgrep === 'upload-failed') {
        const text = `${t('rgUploadFailed')} (${tag})`
        setInstallLog({ hostId, text })
        fail(text)
      } else {
        const text = `${t('rgStillMissing')} (${tag})`
        setInstallLog({ hostId, text })
        fail(text)
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      setInstallLog({ hostId, text })
      // Without this the failure lived only in the log under the host row.
      fail(text)
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
      if (browsing === hostId) closeBrowser()
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
      // A refresh keeps a query on the same directory useful; walking to another
      // directory — or to another host at the same path — does not, since none of
      // those names are on screen under the query any more.
      if (listed.path !== dir || hostId !== browsing) {
        setFilter('')
        setActive(-1)
      }
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }

  /** Close the picker without touching the host or the remote. */
  function closeBrowser(): void {
    setBrowsing('')
    setEntries([])
    setDir('/')
    setListed(false)
    setFilter('')
    setActive(-1)
  }

  async function createWorkspace(hostId: string, path: string): Promise<void> {
    setBusy(true)
    try {
      const created = await callHost<{ path: string, title?: string }>(ctx, 'createWorkspace', { hostId, path })
      note(`${t('workspaceCreated')} ${created.title ?? created.path}`)
      // The picker's job is done once its directory is a workspace; leaving it
      // open hid the new row and made the click look like it failed.
      closeBrowser()
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

  /**
   * Switch tabs, dropping transient state that belongs to the tab being left:
   * a half-filled dialog and the directory browser are both scoped to a host
   * row that is only on screen in the hosts tab.
   */
  function switchTab(next: TabId): void {
    setTab(next)
    setPurgeTarget('')
    if (next === 'hosts') return
    setFormOpen(false)
    closeBrowser()
  }

  async function purgeHost(hostId: string): Promise<void> {
    setBusy(true)
    try {
      const result = await purgeHostRequest(ctx, hostId)
      setPurgeTarget('')
      await Promise.all([reload(), reloadWorkspaces()])
      note(`${t('purgedHost')} ${result.workspaces}`)
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

  /**
   * Keyboard navigation for the listing, handled on the filter box only.
   *
   * Scoping it to the input matters: the same panel holds Up, Refresh, and
   * "use this directory", and a panel-wide Enter would hijack those buttons and
   * enter a directory instead of pressing them. Rows are real buttons, so Tab
   * plus Enter already works there without help.
   */
  function onSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    const count = visible.length
    if (event.key === 'Escape') {
      // `type=search` clears itself in some browsers but not others, so do it
      // explicitly; only when there is nothing to clear does Esc give up focus.
      if (filter.length > 0) {
        event.preventDefault()
        setFilter('')
        setActive(-1)
        return
      }
      event.preventDefault()
      searchRef.current?.blur()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (count === 0) return
      // The caret cannot move vertically in a single-line input, so the arrow is
      // free to mean "next row" here, which is what a search box in a picker does.
      event.preventDefault()
      setActive(current => stepActive(clampActive(current, count), event.key === 'ArrowDown' ? 1 : -1, count))
      return
    }
    if (event.key === 'Enter') {
      if (highlighted < 0 || busy) return
      event.preventDefault()
      const entry = visible[highlighted]
      if (entry !== undefined) void browse(browsing, entry.path)
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      if (count === 0) return
      event.preventDefault()
      setActive(event.key === 'Home' ? 0 : count - 1)
    }
  }

  const target = createTarget(browsing, listed)
  const crumbs = dir.split('/').filter(Boolean)
  // The listing is filtered locally as the box is typed; `filter` never reaches
  // the remote, so every keystroke is instant even on a slow link.
  const visible = filterEntries(entries, filter)
  // Derived, not stored: the filter can shrink `visible` between keystrokes, and
  // deriving keeps the highlight on a real row without another effect.
  const highlighted = clampActive(active, visible.length)

  /**
   * `/` focuses the filter box, the convention every file picker uses. It is a
   * plain key, so it must stay inert inside any text field or contenteditable
   * and must not fight the browser/OS shortcuts that come with a modifier.
   */
  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      // Bare `/` is reserved by the shell for its command menu, so this only
      // claims the key on the settings page — the command menu is not there —
      // and never with a modifier or after another handler took the event.
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return
      // Only the picker's own box is a target: closing it leaves the empty panel
      // out of the DOM, so the ref check doubles as "is the picker open".
      if (tab !== 'hosts' || searchRef.current === null) return
      const target = event.target
      if (target instanceof HTMLElement) {
        const tag = target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return
      }
      // Take the key only when the picker is on screen, and prevent the default
      // so the browser's quick-find does not also open.
      event.preventDefault()
      searchRef.current.focus()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [tab, browsing])

  // Keep the highlighted row visible when it moves past the list's scroll box.
  useEffect(() => {
    if (highlighted < 0) return
    rowRefs.current[highlighted]?.scrollIntoView({ block: 'nearest' })
  }, [highlighted])

  /**
   * The picker opens inside the host row that was clicked, which may be far
   * below the fold on a long list; without this the click still looks inert.
   * Keyed on the host, not on the directory, so walking into a subdirectory
   * does not re-scroll the page under the user.
   */
  useEffect(() => {
    if (browsing.length === 0) return
    // The card opens under a button that may be near the top edge, so scroll it
    // into view instead of trusting the browser to reveal a collapsed insert.
    panelRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [browsing])

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

  /**
   * The directory picker, rendered inside the host row it belongs to.
   *
   * It used to sit after the whole host list, so opening it on the first host
   * pushed the panel past every other row and off-screen — the click appeared
   * to do nothing. Anchoring it to the row keeps it next to the button that
   * opened it, and matches how the trust and probe panels already behave.
   */
  /**
   * The directory picker, rendered inside the host row it belongs to.
   *
   * It used to sit after the whole host list, so opening it on the first host
   * pushed the panel below every other row and off-screen — the click looked
   * like it did nothing. Anchoring it to the row keeps it under the button that
   * opened it, matching how the trust and probe panels already behave.
   */
  function renderBrowser(host: HostView): JSX.Element {
    return (
      <div className="dsh-ssh-browser" ref={panelRef}>
        <div className="dsh-ssh-browser-head">
          <div className="dsh-ssh-browser-heading">
            <span className="dsh-ssh-legend">{t('directory')}</span>
            <span className="dsh-ssh-browser-host">{host.name || host.host}</span>
          </div>
          <div className="dsh-ssh-browser-tools">
            <div className="dsh-ssh-inline">
              <button type="button" className="dsh-ssh-button" disabled={busy || dir === '/'} onClick={() => void browse(host.id, parentDir(dir))}>{t('up')}</button>
              <button type="button" className="dsh-ssh-button" disabled={busy} onClick={() => void browse(host.id, dir)}>{t('refresh')}</button>
              <button type="button" className="dsh-ssh-button" data-primary="true" disabled={busy || target === null} onClick={() => { if (target !== null) void createWorkspace(target, dir) }}>{t('createWorkspace')}</button>
            </div>
            <button type="button" className="dsh-ssh-close" aria-label={t('closeBrowser')} title={t('closeBrowser')} disabled={busy} onClick={closeBrowser}>×</button>
          </div>
        </div>
        <div className="dsh-ssh-breadcrumb">
          <button type="button" className="dsh-ssh-crumb" disabled={busy} onClick={() => void browse(host.id, '/')}>/</button>
          {crumbs.map((name, index) => (
            <span key={`${name}-${index}`} className="dsh-ssh-crumb-part">
              <span className="dsh-ssh-crumb-sep">/</span>
              <button type="button" className="dsh-ssh-crumb" disabled={busy} onClick={() => void browse(host.id, `/${crumbs.slice(0, index + 1).join('/')}`)}>{name}</button>
            </span>
          ))}
        </div>
        {/* Local filter over the entries already listed. It never disables and
            never calls the remote, so typing stays responsive while a listing
            is in flight; it filters whatever entries are committed. */}
        <div className="dsh-ssh-browser-filter">
          <input
            ref={searchRef}
            className="dsh-ssh-input dsh-ssh-search"
            type="search"
            role="combobox"
            aria-expanded="true"
            aria-controls="dsh-ssh-dirs"
            aria-autocomplete="list"
            aria-activedescendant={highlighted >= 0 ? `dsh-ssh-dir-${highlighted}` : undefined}
            value={filter}
            aria-label={t('filter')}
            placeholder={t('filterPlaceholder')}
            autoComplete="off"
            spellCheck={false}
            onChange={event => {
              setFilter(event.target.value)
              // The old highlight belongs to the previous set of names.
              setActive(-1)
            }}
            onKeyDown={onSearchKeyDown}
          />
          {filter.trim().length > 0 && entries.length > 0
            ? <span className="dsh-ssh-filter-count">{visible.length} / {entries.length}</span>
            : null}
        </div>
        {/* Focus stays in the input (the combobox), so an arrow key moves a
            highlight and not the caret: the input's `aria-activedescendant` is
            what announces the row, and `aria-selected` marks it in the list.
            Rows stay real buttons, so Tab + Enter keeps working without this. */}
        <ul id="dsh-ssh-dirs" className="dsh-ssh-dirs" role="listbox" aria-label={t('directory')}>
          {visible.map((entry, index) => (
            <li key={entry.path} role="none">
              <button
                ref={node => { rowRefs.current[index] = node }}
                id={`dsh-ssh-dir-${index}`}
                type="button"
                role="option"
                aria-selected={index === highlighted}
                className="dsh-ssh-dir"
                data-active={index === highlighted ? 'true' : undefined}
                disabled={busy}
                onClick={() => void browse(host.id, entry.path)}
                onMouseEnter={() => setActive(index)}
              >
                <span className="dsh-ssh-dir-icon" aria-hidden="true">▸</span>
                <span className="dsh-ssh-dir-name">{entry.name}</span>
              </button>
            </li>
          ))}
          {entries.length === 0 ? <li className="dsh-ssh-empty">{t('emptyDir')}</li> : null}
          {entries.length > 0 && visible.length === 0 ? <li className="dsh-ssh-empty">{t('noMatch')}</li> : null}
        </ul>
      </div>
    )
  }

  return (
    <section className="dsh-ssh-page">
      <div className="dsh-ssh-header">
        <h2 className="dsh-ssh-title">{t('title')}</h2>
        {tab === 'hosts'
          ? <button type="button" className="dsh-ssh-button" disabled={busy} onClick={beginAdd}>{t('addHost')}</button>
          : null}
      </div>
      <nav className="dsh-ssh-tabs" role="tablist">
        {TABS.map(item => (
          <button
            key={item.id}
            type="button"
            role="tab"
            className="dsh-ssh-tab"
            aria-selected={tab === item.id}
            data-active={tab === item.id ? 'true' : undefined}
            onClick={() => switchTab(item.id)}
          >
            {t(item.label)}
            {item.id === 'hosts' && hosts.length > 0 ? <span className="dsh-ssh-count">{hosts.length}</span> : null}
            {item.id === 'deleted' && orphans.size > 0 ? <span className="dsh-ssh-count">{orphans.size}</span> : null}
          </button>
        ))}
      </nav>
      {message.length > 0 ? <p className="dsh-ssh-status" data-tone={tone === 'warn' ? 'warn' : undefined}>{message}</p> : null}
      {tab === 'hosts' ? (
        <>
          <p className="dsh-ssh-intro">{t('description')}</p>
          {hosts.length > 0 ? (
        <ul className="dsh-ssh-hosts">
          {hosts.map(host => {
            const owned = byHost.get(host.id) ?? []
            const expanded = openWorkspaces[host.id] ?? true
            return (
              <li key={host.id} className="dsh-ssh-host" data-editing={draft.id === host.id ? 'true' : undefined} data-browsing={browsing === host.id ? 'true' : undefined}>
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
                    <button
                      type="button"
                      className="dsh-ssh-button"
                      aria-expanded={browsing === host.id}
                      disabled={busy}
                      onClick={() => {
                        // Toggle: a second click closes. Another host always
                        // starts at root, so a path that only existed on the
                        // previous machine is never requested.
                        if (browsing === host.id) closeBrowser()
                        else void browse(host.id, '/')
                      }}
                    >{t('browse')}</button>
                    <button type="button" className="dsh-ssh-button" disabled={busy} onClick={() => void removeHost(host.id)}>{t('remove')}</button>
                  </div>
                </div>
                {/* The picker belongs to this row too: at page level it landed
                    below the whole list and off-screen for the first host. */}
                {browsing === host.id ? renderBrowser(host) : null}
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
                        {/* No usable binary yet: either this machine has no build for
                            the remote platform, or the upload was refused. Fetching
                            one on request is the only fix the page can offer, and it
                            stays explicit — nothing downloads without this click. */}
                        {status.runner.ripgrep === 'missing' || status.runner.ripgrep === 'upload-failed'
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
        </>
      ) : null}
      {tab === 'settings' ? (
        <>
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
        </>
      ) : null}
      {tab === 'deleted' ? (
        <div className="dsh-ssh-deleted">
          <p className="dsh-ssh-note">{t('deletedHostsNote')}</p>
          {orphans.size === 0 ? <p className="dsh-ssh-empty">{t('deletedEmpty')}</p> : null}
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
                      {/* Destructive and unrecoverable, so it asks once more. */}
                      {purgeTarget === hostId
                        ? <>
                            <span className="dsh-ssh-note dsh-ssh-danger-note">
                              {t('purgeConfirm')} {rows.length}
                              {rows.some(row => row.sessions > 0)
                                ? ` · ${rows.reduce((sum, row) => sum + row.sessions, 0)} ${t('sessions')}`
                                : ''}
                            </span>
                            <button type="button" className="dsh-ssh-button" disabled={busy} onClick={() => setPurgeTarget('')}>{t('cancel')}</button>
                            <button type="button" className="dsh-ssh-button dsh-ssh-danger" disabled={busy} onClick={() => void purgeHost(hostId)}>{t('purgeConfirmAction')}</button>
                          </>
                        : <button
                            type="button"
                            className="dsh-ssh-button"
                            disabled={busy}
                            onClick={() => setPurgeTarget(hostId)}
                          >{t('purgeHost')}</button>}
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
      {tab === 'help' ? (
        <>
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
        </>
      ) : null}
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
