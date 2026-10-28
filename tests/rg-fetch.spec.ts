import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import test from 'node:test'
import {
  DEFAULT_REGISTRY,
  binaryFromTarball,
  binaryMatchesPlatform,
  fetchRgBinary,
  metadataUrl,
  publishedDist,
  publishedVersion,
  registryBase,
  rgPackageName,
  rgPlatformOf,
  tarballUrl,
  tarEntries,
  verifyTarball,
} from '../src/rg-fetch.ts'

/** Bytes good enough for the platform check: a real ELF header and a little more. */
const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0])

/** Metadata document with one published version, its tarball, and its checksum. */
function metadata(version: string, dist: { tarball?: string, integrity?: string, shasum?: string } = {}): string {
  return JSON.stringify({
    'dist-tags': { latest: version },
    versions: { [version]: { dist: { tarball: dist.tarball ?? '', integrity: dist.integrity ?? '', shasum: dist.shasum ?? '' } } },
  })
}

/** SHA-512 SRI string for a body, the way npm publishes it. */
function sri(body: Buffer): string {
  return `sha512-${createHash('sha512').update(body).digest('base64')}`
}

/** A tar archive with the given entries, padded the way tar expects. */
function tar(entries: Array<{ name: string, data: Buffer }>): Buffer {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const header = Buffer.alloc(512)
    header.write(entry.name, 0, 100, 'utf8')
    header.write('0000644\0', 100, 108, 'utf8')
    header.write('0000000\0', 108, 116, 'utf8')
    header.write('0000000\0', 116, 124, 'utf8')
    header.write(`${entry.data.length.toString(8).padStart(11, '0')}\0`, 124, 136, 'utf8')
    blocks.push(header, entry.data)
    const pad = (512 - (entry.data.length % 512)) % 512
    if (pad > 0) blocks.push(Buffer.alloc(pad))
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

test('a remote platform maps to its package', () => {
  assert.equal(rgPlatformOf('linux', 'x64'), 'linux-x64')
  assert.equal(rgPlatformOf('linux', 'arm64'), 'linux-arm64')
  assert.equal(rgPlatformOf('darwin', 'x64'), 'darwin-x64')
  assert.equal(rgPlatformOf('darwin', 'arm64'), 'darwin-arm64')
})

test('an unsupported remote platform has no package', () => {
  assert.equal(rgPlatformOf('other', 'x64'), null)
  assert.equal(rgPlatformOf('linux', 'other'), null)
  assert.equal(rgPlatformOf('freebsd', 'x64'), null)
})

test('package names are scoped per platform', () => {
  assert.equal(rgPackageName('linux-x64'), '@vscode/ripgrep-linux-x64')
  assert.equal(rgPackageName('darwin-arm64'), '@vscode/ripgrep-darwin-arm64')
})

test('an empty registry means npmjs', () => {
  assert.equal(registryBase(''), DEFAULT_REGISTRY)
  assert.equal(registryBase('   '), DEFAULT_REGISTRY)
  assert.equal(registryBase(DEFAULT_REGISTRY), DEFAULT_REGISTRY)
  assert.equal(registryBase('https://registry.npmmirror.com/'), 'https://registry.npmmirror.com')
})

test('a bare mirror hostname gets a scheme', () => {
  assert.equal(registryBase('registry.npmmirror.com'), 'https://registry.npmmirror.com')
})

test('scoped tarball paths keep the scope in the address and drop it in the file name', () => {
  assert.equal(
    tarballUrl('', 'linux-x64', '1.18.0'),
    'https://registry.npmjs.org/@vscode/ripgrep-linux-x64/-/ripgrep-linux-x64-1.18.0.tgz',
  )
  assert.equal(
    tarballUrl('https://registry.npmmirror.com', 'darwin-arm64', '1.2.3'),
    'https://registry.npmmirror.com/@vscode/ripgrep-darwin-arm64/-/ripgrep-darwin-arm64-1.2.3.tgz',
  )
})

test('metadata points at the package document', () => {
  assert.equal(metadataUrl('', 'linux-arm64'), 'https://registry.npmjs.org/@vscode/ripgrep-linux-arm64')
})

test('the latest version comes from dist-tags first', () => {
  assert.equal(publishedVersion({ 'dist-tags': { latest: '1.18.0' }, versions: { '1.17.0': {} } }), '1.18.0')
  assert.equal(publishedVersion({ versions: { '1.16.0': {}, '1.17.0': {} } }), '1.17.0')
  assert.equal(publishedVersion({}), '')
  assert.equal(publishedVersion(null), '')
})

test('tar entries are read by size and offset', () => {
  const entries = tarEntries(tar([
    { name: 'package/package.json', data: Buffer.from('{}') },
    { name: 'package/bin/rg', data: Buffer.from([0x7f, 0x45, 0x4c, 0x46]) },
  ]))
  assert.deepEqual(entries.map(entry => entry.name), ['package/package.json', 'package/bin/rg'])
  assert.deepEqual([...(entries[1]?.data ?? [])], [0x7f, 0x45, 0x4c, 0x46])
})

test('a truncated archive stops instead of reading past the end', () => {
  const full = tar([{ name: 'package/bin/rg', data: Buffer.alloc(2048, 1) }])
  assert.equal(tarEntries(full.subarray(0, 700)).length, 0)
})

test('the binary is taken from package/bin/rg only', () => {
  const gzipped = gzipSync(tar([
    { name: 'package/README.md', data: Buffer.from('readme') },
    { name: 'package/bin/rg', data: Buffer.from([1, 2, 3]) },
  ]))
  assert.deepEqual([...(binaryFromTarball(gzipped) ?? [])], [1, 2, 3])
})

test('an archive without the binary yields null', () => {
  const gzipped = gzipSync(tar([{ name: 'package/README.md', data: Buffer.from('x') }]))
  assert.equal(binaryFromTarball(gzipped), null)
})

test('a body that is not gzip yields null instead of throwing', () => {
  assert.equal(binaryFromTarball(Buffer.from('not gzip')), null)
})

test('a fetch reads the version then the matching tarball', async () => {
  const binary = Buffer.concat([ELF, Buffer.from([9, 9])])
  const tarball = gzipSync(tar([{ name: 'package/bin/rg', data: binary }]))
  const calls: string[] = []
  const fetchImpl = (async (input: string | URL) => {
    const url = String(input)
    calls.push(url)
    if (url.endsWith('/@vscode/ripgrep-linux-x64')) {
      return new Response(metadata('1.18.0'), { status: 200 })
    }
    return new Response(tarball, { status: 200 })
  }) as unknown as typeof fetch

  const result = await fetchRgBinary({ registry: '', platform: 'linux-x64', fetchImpl })
  assert.equal(result.version, '1.18.0')
  assert.deepEqual([...result.binary], [...binary])
  assert.deepEqual(calls, [
    'https://registry.npmjs.org/@vscode/ripgrep-linux-x64',
    'https://registry.npmjs.org/@vscode/ripgrep-linux-x64/-/ripgrep-linux-x64-1.18.0.tgz',
  ])
})

test('a mirror is used for both requests', async () => {
  const calls: string[] = []
  const fetchImpl = (async (input: string | URL) => {
    const url = String(input)
    calls.push(url)
    if (url.endsWith('ripgrep-linux-x64')) {
      return new Response(metadata('2.0.0'), { status: 200 })
    }
    return new Response(gzipSync(tar([{ name: 'package/bin/rg', data: ELF }])), { status: 200 })
  }) as unknown as typeof fetch

  await fetchRgBinary({ registry: 'https://registry.npmmirror.com', platform: 'linux-x64', fetchImpl })
  assert.equal(calls.every(url => url.startsWith('https://registry.npmmirror.com/')), true)
})

test('the tarball address from the package document wins over the derived one', async () => {
  const binary = ELF
  const tarball = gzipSync(tar([{ name: 'package/bin/rg', data: binary }]))
  const calls: string[] = []
  const fetchImpl = (async (input: string | URL) => {
    const url = String(input)
    calls.push(url)
    if (url.endsWith('/@vscode/ripgrep-linux-x64')) {
      return new Response(metadata('1.18.0', { tarball: 'https://cdn.example.test/rg.tgz', integrity: sri(tarball) }), { status: 200 })
    }
    return new Response(tarball, { status: 200 })
  }) as unknown as typeof fetch

  await fetchRgBinary({ registry: 'https://registry.npmmirror.com', platform: 'linux-x64', fetchImpl })
  assert.deepEqual(calls, [
    'https://registry.npmmirror.com/@vscode/ripgrep-linux-x64',
    'https://cdn.example.test/rg.tgz',
  ])
})

test('a tarball that does not match its published integrity is rejected', async () => {
  const tarball = gzipSync(tar([{ name: 'package/bin/rg', data: ELF }]))
  const fetchImpl = (async (input: string | URL) => {
    if (String(input).endsWith('/@vscode/ripgrep-linux-x64')) {
      return new Response(metadata('1.18.0', { tarball: 'https://cdn.example.test/rg.tgz', integrity: sri(Buffer.from('other')) }), { status: 200 })
    }
    return new Response(tarball, { status: 200 })
  }) as unknown as typeof fetch
  await assert.rejects(
    fetchRgBinary({ registry: '', platform: 'linux-x64', fetchImpl }),
    /does not match its published sha512 integrity/,
  )
})

test('a mirror that only publishes a sha1 shasum is still verified', async () => {
  const tarball = gzipSync(tar([{ name: 'package/bin/rg', data: ELF }]))
  const shasum = createHash('sha1').update(tarball).digest('hex')
  const ok = (async (input: string | URL) => {
    if (String(input).endsWith('/@vscode/ripgrep-linux-x64')) {
      return new Response(metadata('1.18.0', { tarball: 'https://cdn.example.test/rg.tgz', shasum }), { status: 200 })
    }
    return new Response(tarball, { status: 200 })
  }) as unknown as typeof fetch
  await fetchRgBinary({ registry: '', platform: 'linux-x64', fetchImpl: ok })

  const wrong = (async (input: string | URL) => {
    if (String(input).endsWith('/@vscode/ripgrep-linux-x64')) {
      return new Response(metadata('1.18.0', { tarball: 'https://cdn.example.test/rg.tgz', shasum: '0'.repeat(40) }), { status: 200 })
    }
    return new Response(tarball, { status: 200 })
  }) as unknown as typeof fetch
  await assert.rejects(
    fetchRgBinary({ registry: '', platform: 'linux-x64', fetchImpl: wrong }),
    /does not match its published sha1 shasum/,
  )
})

test('a body larger than the announced cap is refused before buffering', async () => {
  const fetchImpl = (async (input: string | URL) => {
    if (String(input).endsWith('/@vscode/ripgrep-linux-x64')) return new Response(metadata('1.0.0'), { status: 200 })
    return new Response(Buffer.alloc(8), { status: 200, headers: { 'content-length': String(999 * 1024 * 1024) } })
  }) as unknown as typeof fetch
  await assert.rejects(
    fetchRgBinary({ registry: '', platform: 'linux-x64', fetchImpl }),
    /over the \d+-byte limit/,
  )
})

test('a stream longer than the cap stops instead of buffering it all', async () => {
  // No content-length, so only the streaming check can catch it.
  let pulled = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1
      controller.enqueue(new Uint8Array(1024 * 1024))
      if (pulled > 64) controller.close()
    },
  })
  const fetchImpl = (async (input: string | URL) => {
    if (String(input).endsWith('/@vscode/ripgrep-linux-x64')) return new Response(metadata('1.0.0'), { status: 200 })
    return new Response(stream, { status: 200 })
  }) as unknown as typeof fetch
  await assert.rejects(
    fetchRgBinary({ registry: '', platform: 'linux-x64', fetchImpl }),
    /returned more than the \d+-byte limit/,
  )
  // It stopped early rather than reading the whole (66 MiB) stream.
  assert.ok(pulled < 64, `read ${pulled} MiB before giving up`)
})

test('a timed-out request names the address and the deadline', async () => {
  const fetchImpl = (async () => {
    const error = new Error('timed out')
    error.name = 'TimeoutError'
    throw error
  }) as unknown as typeof fetch
  await assert.rejects(
    fetchRgBinary({ registry: 'https://registry.example.test', platform: 'linux-x64', fetchImpl }),
    /example\.test\/@vscode\/ripgrep-linux-x64 did not answer within 10s/,
  )
})

test('a binary built for another platform is refused', async () => {
  const tarball = gzipSync(tar([{ name: 'package/bin/rg', data: Buffer.from('#!/bin/sh\n') }]))
  const fetchImpl = (async (input: string | URL) => {
    if (String(input).endsWith('/@vscode/ripgrep-linux-x64')) return new Response(metadata('1.0.0'), { status: 200 })
    return new Response(tarball, { status: 200 })
  }) as unknown as typeof fetch
  await assert.rejects(
    fetchRgBinary({ registry: '', platform: 'linux-x64', fetchImpl }),
    /not built for linux-x64/,
  )
})

test('a failing registry names the address it tried', async () => {
  const fetchImpl = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
  await assert.rejects(
    fetchRgBinary({ registry: 'https://registry.example.test', platform: 'linux-x64', fetchImpl }),
    /example\.test.*500/,
  )
})

test('a tarball without the binary reports the URL', async () => {
  const fetchImpl = (async (input: string | URL) => {
    if (String(input).endsWith('ripgrep-linux-x64')) {
      return new Response(JSON.stringify({ 'dist-tags': { latest: '1.0.0' } }), { status: 200 })
    }
    return new Response(gzipSync(tar([{ name: 'package/README.md', data: Buffer.from('x') }])), { status: 200 })
  }) as unknown as typeof fetch
  await assert.rejects(
    fetchRgBinary({ registry: '', platform: 'linux-x64', fetchImpl }),
    /carried no bin\/rg/,
  )
})

test('a scheme other than http or https is rejected instead of being misspelled', () => {
  assert.throws(() => registryBase('ftp://mirror.test'), /download source must be an http\(s\) URL/)
  assert.throws(() => registryBase('file:///tmp/mirror'), /download source must be an http\(s\) URL/)
})

test('the published version fallback is numeric, not document order', () => {
  // npm does not promise key order, so "1.9.0" must not beat "1.10.0".
  assert.equal(publishedVersion({ versions: { '1.9.0': {}, '1.10.0': {}, '1.2.0': {} } }), '1.10.0')
})

test('publishedDist reads the tarball and checksums of one version', () => {
  assert.deepEqual(
    publishedDist({ versions: { '1.0.0': { dist: { tarball: 'https://x/a.tgz', integrity: 'sha512-abc', shasum: 'def' } } } }, '1.0.0'),
    { tarball: 'https://x/a.tgz', integrity: 'sha512-abc', shasum: 'def' },
  )
  // No `dist` at all means the document cannot point at a tarball; the caller
  // then derives the URL from the registry name.
  assert.equal(publishedDist({ versions: { '1.0.0': {} } }, '1.0.0'), null)
  assert.deepEqual(publishedDist({ versions: { '1.0.0': { dist: {} } } }, '1.0.0'), { tarball: '', integrity: '', shasum: '' })
  assert.equal(publishedDist({ versions: {} }, '1.0.0'), null)
  assert.equal(publishedDist({ versions: { '1.0.0': {} } }, '2.0.0'), null)
  assert.equal(publishedDist(null, '1.0.0'), null)
})

test('the platform check accepts only the target executable magic', () => {
  assert.equal(binaryMatchesPlatform(ELF, 'linux-x64'), true)
  assert.equal(binaryMatchesPlatform(ELF, 'darwin-arm64'), false)
  assert.equal(binaryMatchesPlatform(Buffer.from('not a binary'), 'linux-x64'), false)
  // A thin 64-bit little-endian Mach-O is what arm64 macOS ships.
  assert.equal(binaryMatchesPlatform(Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), 'darwin-arm64'), true)
  // A universal binary carries both slices and is valid for either.
  assert.equal(binaryMatchesPlatform(Buffer.from([0xca, 0xfe, 0xba, 0xbe]), 'darwin-x64'), true)
  // A short body must not read past its end.
  assert.equal(binaryMatchesPlatform(Buffer.from([0x7f]), 'linux-x64'), false)
})

test('a document without checksums still unpacks the binary', () => {
  const tarball = gzipSync(tar([{ name: 'package/bin/rg', data: ELF }]))
  assert.doesNotThrow(() => verifyTarball(tarball, { tarball: 'https://x/a.tgz', integrity: '', shasum: '' }))
})
