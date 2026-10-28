import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import test from 'node:test'
import {
  DEFAULT_REGISTRY,
  binaryFromTarball,
  fetchRgBinary,
  metadataUrl,
  publishedVersion,
  registryBase,
  rgPackageName,
  rgPlatformOf,
  tarballUrl,
  tarEntries,
} from '../src/rg-fetch.ts'

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
  const binary = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 9, 9])
  const calls: string[] = []
  const fetchImpl = (async (input: string | URL) => {
    const url = String(input)
    calls.push(url)
    if (url.endsWith('/@vscode/ripgrep-linux-x64')) {
      return new Response(JSON.stringify({ 'dist-tags': { latest: '1.18.0' } }), { status: 200 })
    }
    return new Response(gzipSync(tar([{ name: 'package/bin/rg', data: binary }])), { status: 200 })
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
      return new Response(JSON.stringify({ 'dist-tags': { latest: '2.0.0' } }), { status: 200 })
    }
    return new Response(gzipSync(tar([{ name: 'package/bin/rg', data: Buffer.from([1]) }])), { status: 200 })
  }) as unknown as typeof fetch

  await fetchRgBinary({ registry: 'https://registry.npmmirror.com', platform: 'linux-x64', fetchImpl })
  assert.equal(calls.every(url => url.startsWith('https://registry.npmmirror.com/')), true)
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
