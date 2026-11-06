/**
 * Remote shell adapter for the official `dsh-tool-bash`.
 *
 * The official tool resolves a request into a `ShellExecSpec` and calls
 * `ctx.shell.execute`. The local executor is responsible for env/output; this
 * thin wrapper adds only the two facts the local executor cannot know:
 * the SSH host's captured login environment and the remote working directory.
 * It never reimplements command execution or output handling.
 */
import { symbols } from '@deepseek-ai/cordis'
import type { HostConfig } from './config.ts'
import { loginEnvApply } from './login-env.ts'
import type { RemoteRoute } from './router.ts'

interface MutableService {
  [key: string]: unknown
}

interface ShellSpecLike {
  readonly command: string
  readonly workdir: string
  readonly signal?: AbortSignal
  readonly [key: string]: unknown
}

export interface RemoteShellDeps {
  readonly routeByCwd: (cwd: string | undefined) => RemoteRoute | { kind: 'local' }
  readonly hostOf: (hostId: string) => HostConfig | undefined
  readonly loginEnvOf: (host: HostConfig, signal?: AbortSignal) => Promise<string>
}

function unwrap(service: unknown): MutableService | undefined {
  if (typeof service !== 'object' || service === null) return undefined
  const branded = service as { [symbols.original]?: MutableService }
  return branded[symbols.original] ?? service as MutableService
}

/** Patch one shell service; local calls and hosts without loginEnv pass through. */
export function installRemoteShell(ctx: { get(name: string): unknown }, deps: RemoteShellDeps): (() => void) | undefined {
  const shell = unwrap(ctx.get('shell'))
  if (shell === undefined || typeof shell.execute !== 'function') return undefined
  const own = Object.hasOwn(shell, 'execute')
  const saved = shell.execute as (spec: ShellSpecLike) => Promise<unknown>
  const original = saved.bind(shell)
  shell.execute = async (spec: ShellSpecLike): Promise<unknown> => {
    const route = deps.routeByCwd(spec.workdir)
    if (route.kind !== 'remote') return original(spec)
    const host = deps.hostOf(route.hostId)
    if (host?.loginEnv !== true) return original(spec)
    const snapshot = await deps.loginEnvOf(host, spec.signal)
    if (snapshot.length === 0) return original(spec)
    const remoteWorkdir = route.remoteCwd
    return original({
      ...spec,
      command: loginEnvApply(snapshot, spec.command, remoteWorkdir),
    })
  }
  return () => {
    if (own) shell.execute = saved
    else delete shell.execute
  }
}
