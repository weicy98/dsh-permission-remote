import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import semver from 'semver'

/**
 * DSH blocks installation and activation when `engines.dsh` (else the DSH peer
 * dependencies) is unmet. A pin to one release makes every plugin version stop
 * installing the moment DSH publishes the next rc, which is what 0.8.0 did at
 * rc.5; a range keeps the protection for a real major change without that
 * churn. The bounds below are the ones whose API this plugin was tested
 * against: 0.2.1-rc.3 through 0.2.1-rc.5 share identical type and runtime code
 * for every imported symbol.
 */
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  engines: { node: string, dsh: string }
  peerDependencies: Record<string, string>
  dependencies: Record<string, string>
}

const SUPPORTED = ['0.2.1-rc.3', '0.2.1-rc.4', '0.2.1-rc.5', '0.2.1']
const REJECTED = ['0.2.0', '0.3.0', '0.2.0-rc.5', '1.0.0']

test('engines.dsh accepts the tested DSH line and rejects the next major', () => {
  for (const version of SUPPORTED) {
    assert.equal(semver.satisfies(version, manifest.engines.dsh), true, `engines.dsh rejects ${version}`)
  }
  for (const version of REJECTED) {
    assert.equal(semver.satisfies(version, manifest.engines.dsh), false, `engines.dsh accepts ${version}`)
  }
  // A bare version is a one-release pin, not a requirement. It is what stopped
  // 0.8.0 from installing on rc.5.
  assert.notEqual(semver.valid(manifest.engines.dsh), manifest.engines.dsh)
})

test('every DSH peer dependency is a range, not a one-release pin', () => {
  const peers = Object.entries(manifest.peerDependencies).filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
  // The eight packages this plugin imports at runtime.
  assert.equal(peers.length, 8)
  for (const [name, range] of peers) {
    assert.equal(semver.valid(range), null, `${name} pins one release: ${range}`)
    for (const version of SUPPORTED) {
      assert.equal(semver.satisfies(version, range), true, `${name} rejects ${version}`)
    }
    assert.equal(semver.satisfies('0.3.0', range), false, `${name} accepts 0.3.0`)
  }
})

test('the DSH packages are peers, never a bundled dependency', () => {
  // A dependency would install a second copy of the harness runtime beside the
  // one DSH loaded, and the plugin's `ctx` would not be the shell's.
  for (const name of Object.keys(manifest.dependencies)) {
    assert.equal(name.startsWith('@deepseek-ai/'), false, `${name} is a dependency, not a peer`)
  }
})
