import { createRequire } from 'node:module'
import type { Client as SshClient, ConnectConfig } from 'ssh2'

const require = createRequire(import.meta.url)

/**
 * ssh2's published package runs an optional native build on install.
 * pnpm 11 treats that unapproved script as a failed `dsh plugin add`.
 * The copy under vendor/ssh2 has no install script. Keep this require
 * external so `__dirname` inside ssh2 still points at that copy.
 */
const ssh2 = require('../vendor/ssh2/lib/index.js') as typeof import('ssh2')

export type { ConnectConfig }
export type Client = SshClient
export const Client: typeof ssh2.Client = ssh2.Client
