import { shQuote } from './shell-quote.ts'

/**
 * One-shot read of the remote Bash startup files.
 *
 * The interactive bash exists so a bashrc that returns unless `$-` contains `i`
 * still applies its PATH. Each file is sourced with its output discarded, and
 * `.` / `source` ignore a second request for `~/.bashrc` or `/etc/bash.bashrc`,
 * because Ubuntu's `~/.profile` already sources `~/.bashrc`. Only `export -p`
 * comes back. The result is reused for later commands; this command is not
 * part of them. `~/.zshrc` is not read. `PWD`, `OLDPWD`, `SHLVL`, and `_` are
 * session state, so they are unset here and dropped again when the text is
 * stored. The caller bounds this with {@link LOGIN_ENV_CAPTURE_MS}.
 */
export const LOGIN_ENV_CAPTURE_MS = 10_000

export function loginEnvCaptureCommand(): string {
  const capture = [
    'set +e',
    '__dsh_hit_sys=0',
    '__dsh_hit_rc=0',
    '__dsh_canon() {',
    '  local f="${1-}"',
    '  [ -n "$f" ] || return 1',
    '  if [ "$f" = "~/.bashrc" ]; then f="$HOME/.bashrc"; fi',
    '  case "$f" in',
    '    *bashrc|*bash.bashrc) ;;',
    '    *) return 1 ;;',
    '  esac',
    '  case "$f" in',
    '    "$HOME/.bashrc"|/etc/bash.bashrc)',
    '      printf %s "$f"',
    '      return 0',
    '      ;;',
    '  esac',
    '  local dir="${f%/*}" abs',
    '  [ "$dir" = "$f" ] && dir="."',
    '  abs=$(CDPATH= cd -- "$dir" 2>/dev/null && pwd) || return 1',
    '  printf %s "$abs/${f##*/}"',
    '}',
    '__dsh_once() {',
    '  local f',
    '  f=$(__dsh_canon "${1-}") || return 0',
    '  if [ "$f" = "$HOME/.bashrc" ]; then',
    '    if [ "$__dsh_hit_rc" -eq 1 ]; then return 1; fi',
    '    __dsh_hit_rc=1',
    '    return 0',
    '  fi',
    '  if [ "$f" = /etc/bash.bashrc ]; then',
    '    if [ "$__dsh_hit_sys" -eq 1 ]; then return 1; fi',
    '    __dsh_hit_sys=1',
    '    return 0',
    '  fi',
    '  return 0',
    '}',
    'function source { if __dsh_once "${1-}"; then builtin source "$@"; else return 0; fi; }',
    'function . { if __dsh_once "${1-}"; then builtin . "$@"; else return 0; fi; }',
    'if [ -r /etc/profile ]; then . /etc/profile >/dev/null 2>&1; fi',
    'if [ -r "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile" >/dev/null 2>&1',
    'elif [ -r "$HOME/.bash_login" ]; then . "$HOME/.bash_login" >/dev/null 2>&1',
    'elif [ -r "$HOME/.profile" ]; then . "$HOME/.profile" >/dev/null 2>&1',
    'fi',
    'if [ -r /etc/bash.bashrc ]; then . /etc/bash.bashrc >/dev/null 2>&1; fi',
    'if [ -r "$HOME/.bashrc" ]; then . "$HOME/.bashrc" >/dev/null 2>&1; fi',
    'unset -f source . __dsh_once __dsh_canon',
    'unset __dsh_hit_sys __dsh_hit_rc PWD OLDPWD SHLVL _',
    'export -p',
  ].join('\n')
  return `bash --noprofile --norc -ic ${shQuote(capture)} 2>/dev/null || true`
}

/**
 * Bash text that sources a published snapshot, returns to `workdir`, and runs `command`.
 *
 * The snapshot stays in the file. Putting `export -p` on the command line would
 * show bashrc secrets in `ps` and in the executor's command string.
 */
export function loginEnvApply(envFile: string, command: string, workdir: string): string {
  return [
    `. ${shQuote(envFile)} || true`,
    `cd ${shQuote(workdir)} || exit $?`,
    command,
  ].join('\n')
}

export interface LoginEnvRead {
  stdout: string
  timedOut: boolean
  stdoutTruncated: boolean
}

/**
 * Names the command's own bash sets. A cached copy would freeze the capture
 * shell's directory and nesting level into every later command. `PATH` is not
 * one of these: a value from bashrc, including a bad one, is what the user asked
 * to load. `cd` of an absolute workdir already corrects `PWD`; removing it here
 * means the snapshot does not depend on that.
 */
const SESSION_STATE = new Set(['PWD', 'OLDPWD', 'SHLVL', '_'])

/**
 * Keep a capture only when it finished and looks like `export -p`.
 * A timeout or a truncated read must not become the environment for the rest
 * of the connection, and a banner mixed into the output is not evaluated.
 * Session-state assignments are removed even when the capture shell printed
 * them again after `unset`.
 */
export function loginEnvSnapshot(result: LoginEnvRead): string {
  if (result.timedOut || result.stdoutTruncated) return ''
  const text = result.stdout.replace(/^\n+/, '').replace(/\n+$/, '')
  if (!text.startsWith('declare ') && !text.startsWith('export ')) return ''
  const kept = stripSessionState(text)
  return kept.length > 0 ? `${kept}\n` : ''
}

interface DeclarationBlock {
  readonly name: string
  readonly block: string
  readonly next: number
}

/**
 * Parse one complete `export -p` declaration starting at `index`.
 *
 * `export -p` prints either `declare -x NAME` (exported but unset) or
 * `declare -x NAME=<quoted value>`. Only literal quoted values and simple
 * literals are accepted; anything after the closing quote is rejected. A
 * bashrc trap that prints `declare -x A=1; touch /tmp/pwn` must never be
 * treated as a declaration.
 */
function parseDeclaration(lines: readonly string[], index: number): DeclarationBlock | null {
  const line = lines[index] ?? ''
  const match = /^(?:declare\s+-x|export)\s+([A-Za-z_][A-Za-z0-9_]*)(.*)$/.exec(line)
  if (match === null) return null
  const name = match[1]!
  const rest = match[2] ?? ''
  if (rest.length === 0) return { name, block: line, next: index + 1 }
  if (!rest.startsWith('=')) return null
  const value = rest.slice(1)
  if (value.length === 0) return { name, block: line, next: index + 1 }

  let block = line
  let current = value
  let end = index
  for (;;) {
    const scanned = scanQuotedValue(current)
    if (scanned === 'invalid') return null
    if (scanned === 'unclosed') {
      end += 1
      if (end >= lines.length) return null
      current += `\n${lines[end] ?? ''}`
      block += `\n${lines[end] ?? ''}`
      continue
    }
    if (scanned.rest.trim().length > 0) return null
    return { name, block, next: end + 1 }
  }
}

/**
 * Scan the value part of a declaration.
 *
 * A complete literal returns the text after its closing quote. A value that
 * continues on the next line is `unclosed`; an unquoted value with shell syntax
 * is `invalid`.
 */
function scanQuotedValue(value: string): { rest: string } | 'unclosed' | 'invalid' {
  const first = value[0]
  if (first === '"' || first === "'") return scanQuote(value, first, first)
  if (first === '$' && value[1] === "'") return scanQuote(value, '$', "'")
  // A bare literal produced by a shell that does not quote simple values is
  // safe when it contains no shell metacharacters or whitespace.
  if (/^[A-Za-z0-9_./:+=,-]*$/.test(value)) return { rest: '' }
  return 'invalid'
}

function scanQuote(value: string, opener: string, closer: string): { rest: string } | 'unclosed' | 'invalid' {
  let index = opener === '$' ? 2 : 1
  while (index < value.length) {
    const char = value[index] ?? ''
    if (char === '\\' && closer !== "'") {
      index += 2
      continue
    }
    if (char === closer) return { rest: value.slice(index + 1) }
    if (closer === '"' && (char === '`' || (char === '$' && value[index + 1] === '('))) return 'invalid'
    if (closer === '"' && char === '$' && value[index + 1] !== '{') {
      // `export -p` escapes literal dollars as `\$`; an unescaped dollar is a
      // command substitution or expansion the capture did not produce.
      return 'invalid'
    }
    index += 1
  }
  return 'unclosed'
}

/**
 * Drop session-state assignments without cutting a quoted value that happens
 * to contain a line looking like one. `export -p` keeps a newline inside
 * quotes.
 *
 * Only complete `declare -x NAME...` / `export NAME...` assignments are
 * trusted. `export -p` prints nothing else, so any other line is stray output
 * (a bashrc `EXIT` trap, a banner) and must never be eval'd on a later command.
 * A stray or malformed line makes the whole capture untrustworthy, so the
 * entire block is dropped — the same outcome as a timeout or a truncated read.
 */
function stripSessionState(text: string): string {
  const lines = text.split('\n')
  const kept: string[] = []
  let index = 0
  while (index < lines.length) {
    const declaration = parseDeclaration(lines, index)
    if (declaration === null) return ''
    if (!SESSION_STATE.has(declaration.name)) kept.push(declaration.block)
    index = declaration.next
  }
  return kept.join('\n').replace(/^\n+/, '').replace(/\n+$/, '')
}

/**
 * One capture in flight per host, then the text is reused.
 * A rejected read is not stored, so the next command can try again.
 * `forget` drops a finished snapshot and an in-flight read.
 */
export class LoginEnvCache {
  private readonly ready = new Map<string, string>()
  private readonly pending = new Map<string, Promise<string>>()

  constructor(private readonly load: (hostId: string, signal?: AbortSignal) => Promise<LoginEnvRead>) {}

  get(hostId: string, signal?: AbortSignal): Promise<string> {
    const cached = this.ready.get(hostId)
    if (cached !== undefined) return Promise.resolve(cached)
    const inflight = this.pending.get(hostId)
    if (inflight !== undefined) return inflight
    const pending = this.load(hostId, signal).then(result => {
      const snapshot = loginEnvSnapshot(result)
      if (this.pending.get(hostId) === pending) this.ready.set(hostId, snapshot)
      return snapshot
    }).finally(() => {
      if (this.pending.get(hostId) === pending) this.pending.delete(hostId)
    })
    this.pending.set(hostId, pending)
    return pending
  }

  forget(hostId: string): void {
    this.ready.delete(hostId)
    this.pending.delete(hostId)
  }
}
