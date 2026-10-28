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
 * without a scheme is treated as a hostname so a bare mirror still works.
 */
export function registryBase(registry: string): string {
  const trimmed = registry.trim().replace(/\/+$/, '')
  if (trimmed.length === 0) return DEFAULT_REGISTRY
  if (/^https?:\/\//i.test(trimmed)) return trimmed
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
  const keys = Object.keys(record.versions ?? {})
  return keys.length > 0 ? keys[keys.length - 1] ?? '' : ''
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
  readonly source: string
}

/**
 * Download and unpack the ripgrep binary for a remote platform.
 *
 * Network failures and a missing entry both surface as a thrown error with the
 * URL that was tried: the operator chose the registry, so the message has to
 * name what was actually requested.
 */
export async function fetchRgBinary(options: RgFetchOptions): Promise<RgFetchResult> {
  const doFetch = options.fetchImpl ?? fetch
  const metaUrl = metadataUrl(options.registry, options.platform)
  const metaResponse = await doFetch(metaUrl, { headers: { accept: 'application/json' } })
  if (!metaResponse.ok) throw new Error(`registry ${metaUrl} answered ${metaResponse.status}`)
  const version = publishedVersion(await metaResponse.json())
  if (version.length === 0) throw new Error(`registry ${metaUrl} listed no version`)

  const url = tarballUrl(options.registry, options.platform, version)
  const response = await doFetch(url)
  if (!response.ok) throw new Error(`tarball ${url} answered ${response.status}`)
  const binary = binaryFromTarball(Buffer.from(await response.arrayBuffer()))
  if (binary === null || binary.length === 0) throw new Error(`tarball ${url} carried no ${RG_ENTRY}`)
  return { version, binary, source: url }
}
