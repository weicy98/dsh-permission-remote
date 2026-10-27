import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { Client } from '../src/ssh2-client.ts'

test('vendored ssh2 loads without an install script', () => {
  assert.equal(typeof Client, 'function')
  const vendored = JSON.parse(readFileSync(new URL('../vendor/ssh2/package.json', import.meta.url), 'utf8'))
  const scripts = vendored.scripts ?? {}
  for (const name of ['preinstall', 'install', 'postinstall', 'prepare']) {
    assert.equal(scripts[name], undefined)
  }
  assert.equal(vendored.optionalDependencies, undefined)
})

test('production lockfile has no dependency install scripts', () => {
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8')) as {
    packages: Record<string, { dev?: boolean, devOptional?: boolean, hasInstallScript?: boolean }>
  }
  const blocked = Object.entries(lock.packages)
    .filter(([path, meta]) => path !== '' && !meta.dev && !meta.devOptional && meta.hasInstallScript === true)
    .map(([path]) => path)
  assert.deepEqual(blocked, [])
})
