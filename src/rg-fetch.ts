/**
 * Fetch a ripgrep binary for a remote platform this machine does not have.
 *
 * @vscode/ripgrep ships one platform package per target, and a package manager
 * only installs the one matching the host. A Windows DSH managing a Linux
 * remote therefore has no `ripgrep-linux-x64` to upload, even though the remote
 * is reachable and the upload path is correct. The npm registry serves every
 * platform package to every platform, so the binary can be fetched on demand.
 *
 * Downloads are explicit: nothing here runs during a probe. The operator picks
 * a registry and presses the install button.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { gunzipSync } from 'node:zlib'

/** Default registry; matches what npm itself uses without configuration. */
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org'

/** One npm tarball entry: `package/bin/rg`. */
const RG_ENTRY = 'bin/rg'

export type RgPlatform = 'linux-x64' | 'linux-arm64' | 'darwin-x64' | 'darwin-arm64'

/** The package that carries the binary for a remote platform. */
export function rgPackageName(platform: RgPlatform): string {
  return `@vscode/ripgrep-${platform}`
}

/** Platform key for a remote `uname` result, or `null` when unsupported. */
export function rgPlatformOf(os: string, arch: string): RgPlatform | null {
  if (os !== 'linux' && os !== 'darwin') return null
  if (arch !== 'x64' && arch !== 'arm64') return null
  return `${os === 'darwin' ? 'darwin' : 'linux'}-${arch}` as RgPlatform
}

/**
 * Registry URL without a trailing slash. An empty value means npmjs; a value
 * without a scheme is treated as a hostname so a bare mirror still works. Any
 * other scheme is rejected instead of being folded into a nonsense `https://`
 * prefix that would only fail later with a confusing network error.
 */
export function registryBase(registry: string): string {
  const trimmed = registry.trim().replace(/\/+$/, '')
  if (trimmed.length === 0) return DEFAULT_REGISTRY
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    throw new Error(`download source must be an http(s) URL: ${registry.trim()}`)
  }
  return `https://${trimmed}`
}

/**
 * Tarball URL for one platform package. Unscoped packages live at `/<name>`,
 * scoped ones at `/@scope%2Fname`; both are followed by `/-/<basename>-<version>.tgz`.
 */
export function tarballUrl(registry: string, platform: RgPlatform, version: string): string {
  const name = rgPackageName(platform)
  const base = registryBase(registry)
  const leaf = name.slice(name.indexOf('/') + 1)
  return `${base}/${name}/-/${leaf}-${version}.tgz`
}

/** Metadata URL, used to discover the published version. */
export function metadataUrl(registry: string, platform: RgPlatform): string {
  return `${registryBase(registry)}/${rgPackageName(platform)}`
}

/** Version from an npm package document, preferring `dist-tags.latest`. */
export function publishedVersion(document: unknown): string {
  if (typeof document !== 'object' || document === null) return ''
  const record = document as { 'dist-tags'?: { latest?: unknown }, versions?: Record<string, unknown> }
  const latest = record['dist-tags']?.latest
  if (typeof latest === 'string' && latest.length > 0) return latest
  // The document does not promise key order, so the fallback cannot be "last".
  const keys = Object.keys(record.versions ?? {})
  return keys.sort(compareVersions).at(-1) ?? ''
}

/** Numeric comparison of dotted version parts; `prerelease` sorts before its release. */
function compareVersions(left: string, right: string): number {
  const split = (value: string): Array<number | string> => value.split(/[.+-]/).map(part => /^\d+$/.test(part) ? Number(part) : part)
  const a = split(left)
  const b = split(right)
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const x = a[index]
    const y = b[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x - y
    } else if (typeof x === 'number') {
      return 1
    } else if (typeof y === 'number') {
      return -1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

/** One publish's download location and checksum, from the package document. */
export interface PublishedDist {
  readonly tarball: string
  readonly integrity: string
  readonly shasum: string
}

/** `dist` for the given version, when the document carries one. */
export function publishedDist(document: unknown, version: string): PublishedDist | null {
  if (typeof document !== 'object' || document === null) return null
  const versions = (document as { versions?: Record<string, unknown> }).versions
  if (typeof versions !== 'object' || versions === null) return null
  const row = versions[version]
  if (typeof row !== 'object' || row === null) return null
  const dist = (row as { dist?: unknown }).dist
  if (typeof dist !== 'object' || dist === null) return null
  const record = dist as { tarball?: unknown, integrity?: unknown, shasum?: unknown }
  return {
    tarball: typeof record.tarball === 'string' ? record.tarball : '',
    integrity: typeof record.integrity === 'string' ? record.integrity : '',
    shasum: typeof record.shasum === 'string' ? record.shasum : '',
  }
}

interface TarEntry {
  name: string
  data: Buffer
}

/**
 * Entries of an uncompressed tar archive.
 *
 * Only the subset npm produces is handled: plain `ustar` headers with a
 * numeric size and no long-name or pax extensions. The binary sits under a
 * short fixed path, so the size/offset arithmetic is enough and no tar
 * dependency is needed.
 */
export function tarEntries(archive: Buffer): TarEntry[] {
  const entries: TarEntry[] = []
  let offset = 0
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512)
    // Two zero blocks end the archive; a zero name alone also stops it.
    const name = header.toString('utf8', 0, 100).replace(/\0.*$/s, '')
    if (name.length === 0) break
    const sizeField = header.toString('utf8', 124, 136).replace(/\0.*$/s, '').trim()
    const size = sizeField.length === 0 ? 0 : Number.parseInt(sizeField, 8)
    if (!Number.isFinite(size) || size < 0) break
    const dataStart = offset + 512
    if (dataStart + size > archive.length) break
    entries.push({ name, data: archive.subarray(dataStart, dataStart + size) })
    offset = dataStart + Math.ceil(size / 512) * 512
  }
  return entries
}

/** The `package/bin/rg` bytes from a package tarball, or `null`. */
export function binaryFromTarball(gzipped: Buffer): Buffer | null {
  let archive: Buffer
  try {
    archive = gunzipSync(gzipped)
  } catch {
    return null
  }
  for (const entry of tarEntries(archive)) {
    const name = entry.name.replace(/^\.\//, '')
    if (name === `package/${RG_ENTRY}`) return entry.data
  }
  return null
}

export interface RgFetchOptions {
  readonly registry: string
  readonly platform: RgPlatform
  /** Injected for tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch
}

export interface RgFetchResult {
  readonly version: string
  readonly binary: Buffer
}

/** Package metadata is small; a slow mirror must not hang the settings page. */
const META_TIMEOUT_MS = 10_000
/** The tarball is a few megabytes; give a slow link room but still bound it. */
const TARBALL_TIMEOUT_MS = 60_000
/** Largest tarball accepted. Every platform package today is under 3 MiB. */
const TARBALL_CAP = 32 * 1024 * 1024

/** Leading bytes of a binary built for the target platform. */
const BINARY_MAGIC: Record<RgPlatform, readonly Buffer[]> = {
  'linux-x64': [Buffer.from([0x7f, 0x45, 0x4c, 0x46])],
  'linux-arm64': [Buffer.from([0x7f, 0x45, 0x4c, 0x46])],
  'darwin-x64': [
    Buffer.from([0xfe, 0xed, 0xfa, 0xce]),
    Buffer.from([0xce, 0xfa, 0xed, 0xfe]),
    Buffer.from([0xca, 0xfe, 0xba, 0xbe]),
    Buffer.from([0xbe, 0xba, 0xfe, 0xca]),
  ],
  'darwin-arm64': [
    Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
    Buffer.from([0xfe, 0xed, 0xfa, 0xcf]),
    Buffer.from([0xca, 0xfe, 0xba, 0xbe]),
    Buffer.from([0xbe, 0xba, 0xfe, 0xca]),
  ],
}

/** Whether the bytes look like an executable for this platform. */
export function binaryMatchesPlatform(binary: Buffer, platform: RgPlatform): boolean {
  return BINARY_MAGIC[platform].some(magic => binary.length >= magic.length && binary.subarray(0, magic.length).equals(magic))
}

/**
 * Verify the downloaded tarball against the checksum npm published.
 *
 * `integrity` is an SRI string (`sha512-<base64>`); a bare `shasum` is a hex
 * SHA-1. A mirror that carries neither is accepted, because the tarball is
 * unpacked locally and the binary still has to look like a target executable.
 */
export function verifyTarball(tarball: Buffer, dist: PublishedDist): void {
  const matches = (algorithm: string, expected: Buffer): boolean => {
    const actual = createHash(algorithm).update(tarball).digest()
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }
  const sri = /^(sha256|sha384|sha512)-([A-Za-z0-9+/=]+)$/.exec(dist.integrity.trim())
  if (sri !== null) {
    const algorithm = sri[1]!
    if (!matches(algorithm, Buffer.from(sri[2]!, 'base64'))) {
      throw new Error(`tarball ${dist.tarball} does not match its published ${algorithm} integrity`)
    }
    return
  }
  if (dist.shasum.trim().length > 0) {
    if (!matches('sha1', Buffer.from(dist.shasum.trim(), 'hex'))) {
      throw new Error(`tarball ${dist.tarball} does not match its published sha1 shasum`)
    }
  }
}

/**
 * Read a response body, refusing to buffer more than `cap` bytes.
 *
 * The advertised length is checked first so an obviously oversized response is
 * rejected without reading it. The stream is then read in chunks and stopped
 * the moment the running total passes the cap, because a server is free to
 * understate `content-length` or omit it entirely.
 */
export async function readCapped(response: Response, cap: number, url: string): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? NaN)
  if (Number.isFinite(declared) && declared > cap) {
    throw new Error(`${url} announced ${declared} bytes, over the ${cap}-byte limit`)
  }
  if (response.body === null) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value === undefined) continue
    total += value.byteLength
    if (total > cap) {
      await reader.cancel().catch(() => undefined)
      throw new Error(`${url} returned more than the ${cap}-byte limit`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

/** Translate an abort into a message that names the address and the deadline. */
function networkError(error: unknown, url: string, timeoutMs: number): Error {
  const name = (error as { name?: string } | null)?.name
  if (name === 'TimeoutError' || name === 'AbortError') return new Error(`${url} did not answer within ${timeoutMs / 1000}s`)
  const message = error instanceof Error ? error.message : String(error)
  return new Error(`${url} failed: ${message}`)
}

/**
 * Download and unpack the ripgrep binary for a remote platform.
 *
 * Network failures, a checksum mismatch, and a missing entry all surface as a
 * thrown error with the URL that was tried: the operator chose the registry,
 * so the message has to name what was actually requested. The package document
 * is trusted for the tarball address and checksum, because a mirror is free to
 * serve a different address than the one derived from its name.
 */
export async function fetchRgBinary(options: RgFetchOptions): Promise<RgFetchResult> {
  const doFetch = options.fetchImpl ?? fetch
  const metaUrl = metadataUrl(options.registry, options.platform)
  const metaResponse = await doFetch(metaUrl, {
    headers: { accept: 'application/json', 'user-agent': 'dsh-permission-remote' },
    signal: AbortSignal.timeout(META_TIMEOUT_MS),
  }).catch((error: unknown) => {
    throw networkError(error, metaUrl, META_TIMEOUT_MS)
  })
  if (!metaResponse.ok) throw new Error(`registry ${metaUrl} answered ${metaResponse.status}`)
  const document = await metaResponse.json()
  const version = publishedVersion(document)
  if (version.length === 0) throw new Error(`registry ${metaUrl} listed no version`)

  const dist = publishedDist(document, version)
  const url = dist !== null && dist.tarball.length > 0
    ? dist.tarball
    : tarballUrl(options.registry, options.platform, version)
  const response = await doFetch(url, { signal: AbortSignal.timeout(TARBALL_TIMEOUT_MS) }).catch((error: unknown) => {
    throw networkError(error, url, TARBALL_TIMEOUT_MS)
  })
  if (!response.ok) throw new Error(`tarball ${url} answered ${response.status}`)
  const tarball = await readCapped(response, TARBALL_CAP, url)
  if (dist !== null) verifyTarball(tarball, { ...dist, tarball: url })

  const binary = binaryFromTarball(tarball)
  if (binary === null || binary.length === 0) throw new Error(`tarball ${url} carried no ${RG_ENTRY}`)
  if (!binaryMatchesPlatform(binary, options.platform)) {
    throw new Error(`tarball ${url} carried a binary that is not built for ${options.platform}`)
  }
  return { version, binary }
}
