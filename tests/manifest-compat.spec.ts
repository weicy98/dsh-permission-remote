import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import semver from 'semver'

/**
 * DSH blocks installation and activation when `engines.dsh` (else the DSH peer
 * dependencies) is unmet. A pin to one release makes every plugin version stop
 * installing the moment DSH publishes the next rc, which is what 0.8.0 did at
 * rc.5; a range keeps the protection for a real major change without that
 * churn.
 *
 * The plugin's baseline moved to DSH 0.2.2 with this release: it now uses the
 * 0.2.2 filesystem surface (`patchText` / `deleteFile` / `moveFile`) and the
 * tool-provider prompt assembly, so 0.2.1 is no longer supported.
 */
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  engines: { node: string, dsh: string }
  peerDependencies: Record<string, string>
  dependencies: Record<string, string>
}

const SUPPORTED = ['0.2.2-rc.1', '0.2.2']
const REJECTED = ['0.2.0', '0.2.1', '0.2.1-rc.3', '0.2.1-rc.5', '0.3.0', '0.2.0-rc.5', '1.0.0']

test('engines.dsh accepts the tested DSH line and rejects the next major', () => {
  for (const version of SUPPORTED) {
    assert.equal(semver.satisfies(version, manifest.engines.dsh, { includePrerelease: true }), true, `engines.dsh rejects ${version}`)
  }
  for (const version of REJECTED) {
    assert.equal(semver.satisfies(version, manifest.engines.dsh, { includePrerelease: true }), false, `engines.dsh accepts ${version}`)
  }
  // A bare version is a one-release pin, not a requirement. It is what stopped
  // 0.8.0 from installing on rc.5.
  assert.notEqual(semver.valid(manifest.engines.dsh), manifest.engines.dsh)
})

test('every DSH peer dependency is a range, not a one-release pin', () => {
  const peers = Object.entries(manifest.peerDependencies).filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
  // The nine packages this plugin imports at runtime.
  assert.equal(peers.length, 9)
  for (const [name, range] of peers) {
    assert.equal(semver.valid(range), null, `${name} pins one release: ${range}`)
    for (const version of SUPPORTED) {
      assert.equal(semver.satisfies(version, range, { includePrerelease: true }), true, `${name} rejects ${version}`)
    }
    assert.equal(semver.satisfies('0.3.0', range, { includePrerelease: true }), false, `${name} accepts 0.3.0`)
  }
})

test('the DSH packages are peers, never a bundled dependency', () => {
  // A dependency would install a second copy of the harness runtime beside the
  // one DSH loaded, and the plugin's `ctx` would not be the shell's.
  for (const name of Object.keys(manifest.dependencies)) {
    assert.equal(name.startsWith('@deepseek-ai/'), false, `${name} is a dependency, not a peer`)
  }
})
