#!/usr/bin/env node
/**
 * Verify the verbatim-vendored fs-patch files still match vendor/fs-patch/SOURCE.md.
 * Run from the package root: `node vendor/fs-patch/verify.mjs`.
 * Exits 1 with a clear message on any missing file / checksum mismatch.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const vendorDir = here
const sourcePath = path.join(vendorDir, 'SOURCE.md')

// The three files copied byte-for-byte with `cp` from @deepseek-ai/dsh-fs-patch@0.2.2-rc.1.
const COPIED_FILES = ['index.js', 'types.d.ts', 'LICENSE']

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

let source
try {
  source = readFileSync(sourcePath, 'utf8')
} catch (err) {
  console.error(`verify-vendor: cannot read ${sourcePath}: ${err.message}`)
  process.exit(1)
}

// Parse "- `name`: `<64 hex>`" checksum lines out of SOURCE.md.
const expected = new Map()
const line = /^\s*-\s*`([^`]+)`:\s*`([a-fA-F0-9]{64})`\s*$/gm
let match
while ((match = line.exec(source)) !== null) {
  expected.set(match[1], match[2].toLowerCase())
}

let failed = false
for (const name of COPIED_FILES) {
  const file = path.join(vendorDir, name)
  let actual
  try {
    actual = sha256(file)
  } catch (err) {
    console.error(`verify-vendor: MISSING/UNREADABLE ${name}: ${err.message}`)
    failed = true
    continue
  }
  const want = expected.get(name)
  if (want === undefined) {
    console.error(`verify-vendor: NO CHECKSUM in SOURCE.md for ${name} (computed ${actual})`)
    failed = true
  } else if (want !== actual) {
    console.error(`verify-vendor: MISMATCH ${name}\n  SOURCE.md: ${want}\n  actual:    ${actual}`)
    failed = true
  } else {
    console.log(`verify-vendor: OK ${name} ${actual}`)
  }
}

if (failed) {
  console.error('verify-vendor: FAIL — vendored files differ from SOURCE.md (verbatim copy required; do not hand-edit).')
  process.exit(1)
}
console.log('verify-vendor: OK — all copied files match SOURCE.md')
