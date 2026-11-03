import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SFTP_STATUS,
  SshFailure,
  isSftpMissing,
  isSftpPermissionDenied,
  sftpStatusOf,
} from '../src/ssh-pool.ts'
import { isRemoteMissing } from '../src/ops.ts'

/** An error shaped like the one ssh2 builds from a STATUS response. */
function statusError(code: number, message: string): Error {
  const error = new Error(message)
  ;(error as { code?: number }).code = code
  return error
}

test('a raw ssh2 STATUS is missing when the numeric code says so', () => {
  // attrsOf classifies this error before failureOf copies the code onto
  // SshFailure. A German sshd still has to resolve as "no entry".
  const error = statusError(SFTP_STATUS.NO_SUCH_FILE, 'Datei nicht gefunden')
  assert.equal(isSftpMissing(error), true)
  assert.equal(isSftpPermissionDenied(statusError(SFTP_STATUS.PERMISSION_DENIED, 'Zugriff verweigert')), true)
})

test('a NO_SUCH_FILE status reads as missing even when the message is localised', () => {
  // A German sshd says "Datei nicht gefunden". The English regex misses it, so
  // only the numeric status can classify the failure.
  const failure = new SshFailure('Datei nicht gefunden', 'sftp-stat', SFTP_STATUS.NO_SUCH_FILE)
  assert.equal(isSftpMissing(failure), true)
  assert.equal(isRemoteMissing(failure), true)
})

test('a PERMISSION_DENIED status is never treated as absence', () => {
  const failure = new SshFailure('Zugriff verweigert', 'sftp-stat', SFTP_STATUS.PERMISSION_DENIED)
  assert.equal(isSftpMissing(failure), false)
  assert.equal(isRemoteMissing(failure), false)
  assert.equal(isSftpPermissionDenied(failure), true)
})

test('a bare FAILURE status still falls back to the message', () => {
  // Servers without a specific code send FAILURE and put the reason in the
  // text. The code alone cannot tell absence from a permission denial.
  const missing = new SshFailure('No such file', 'sftp-stat', SFTP_STATUS.FAILURE)
  assert.equal(isSftpMissing(missing), true)
  const denied = new SshFailure('Permission denied', 'sftp-stat', SFTP_STATUS.FAILURE)
  assert.equal(isSftpPermissionDenied(denied), true)
  assert.equal(isSftpMissing(denied), false)
})

test('a non-failure status wins over a misleading message', () => {
  // Some servers answer with a generic message. A code that is neither
  // NO_SUCH_FILE nor FAILURE must not be re-read as absence from the text.
  const failure = new SshFailure('No such file or directory', 'sftp-read', SFTP_STATUS.NO_CONNECTION)
  assert.equal(isSftpMissing(failure), false)
})

test('isSftpMissing keeps accepting a plain Error for non-SFTP failures', () => {
  assert.equal(isSftpMissing(new Error('no such file')), true)
  assert.equal(isSftpMissing(new Error('connection reset')), false)
})

test('sftpStatusOf reads only a numeric code', () => {
  assert.equal(sftpStatusOf(statusError(SFTP_STATUS.NO_SUCH_FILE, 'x')), SFTP_STATUS.NO_SUCH_FILE)
  assert.equal(sftpStatusOf(new Error('plain')), undefined)
  assert.equal(sftpStatusOf(undefined), undefined)
  assert.equal(sftpStatusOf({ code: '2' }), undefined)
})
