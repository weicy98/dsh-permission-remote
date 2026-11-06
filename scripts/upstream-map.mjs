/**
 * One place that answers "a contract probe failed — where do I look?".
 *
 * `check-upstream.mjs --explain` and `upgrade.mjs` print matching rows when a
 * contract probe fails. This table is NOT derived from the probe code: the
 * regression test in `tests/upstream-map.spec.ts` reads `src/upstream-worker.ts`
 * and extracts every `failures.push(...)` literal, so adding or rewording a
 * probe without a row here fails the test instead of silently losing its
 * runbook entry.
 */

/**
 * @typedef {object} Guide
 * @property {string} id stable identifier, also the test fixture key
 * @property {string} match exact probe failure string, or its stable prefix when it embeds a value
 * @property {string} meaning what the probe looked for and why the plugin needs it
 * @property {string} where file and function to change
 * @property {string} next the command to run after the change
 */

/** @type {readonly Guide[]} */
export const PROBE_GUIDES = [
  {
    id: 'entry',
    match: 'process.js entry line changed',
    meaning: 'process.js must still start the worker with runNodeMain(openInheritedControlChannel(), Number(process.argv[2]), process). The shim passes the control socket and the parent pid to exactly that call.',
    where: 'src/upstream-worker.ts probeContract() entry regex, then src/ptc-shim.mjs argument order',
    next: 'npm run upgrade:ptc -- --dry-run',
  },
  {
    id: 'imports',
    match: 'process.js imports a non-Node module',
    meaning: 'The uploaded worker is a single self-contained .mjs file, so it may only import node: built-ins. A third-party import would need uploading that package too.',
    where: 'src/upstream-worker.ts probeContract() importsOnlyNode',
    next: 'npm run upgrade:ptc -- --dry-run',
  },
  {
    id: 'control-fd',
    match: 'fd 7 control descriptor not found',
    meaning: 'The worker expects its control channel on file descriptor 7. The shim builds stdio entries 3..7 and puts the socket last; a different descriptor moves the socket.',
    where: 'src/ptc-shim.mjs spawnWorker() stdio array, then src/remote-world.ts',
    next: 'npm run test:ptc',
  },
  {
    id: 'control-env',
    match: 'DSH_SUBPROCESS_CONTROL marker not found',
    meaning: 'The host tells the worker to use a control pipe through DSH_SUBPROCESS_CONTROL. Without that marker the worker never opens the channel.',
    where: 'src/ptc-shim.mjs spawnWorker() env block',
    next: 'npm run test:ptc',
  },
  {
    id: 'control-env-changed',
    match: 'control environment marker changed to',
    meaning: 'Upstream renamed the control environment variable. The shim injects a fixed name, so it would set a variable nothing reads.',
    where: 'src/upstream-worker.ts PTC_CONTROL_ENV and src/ptc-shim.mjs spawnWorker() env block',
    next: 'npm run test:ptc',
  },
  {
    id: 'bootstrap-args',
    match: 'bootstrapArgs no longer maps process.js through fs.processPathFromHostPath',
    meaning: 'bootstrapArgs must route the host process.js path through fs.processPathFromHostPath. That hook is how the plugin swaps the local path for the uploaded one.',
    where: 'src/remote-world.ts installWorkerPathMap()',
    next: 'npm run test:ptc',
  },
  {
    id: 'spawn-control',
    match: 'subprocess.spawn no longer requests a control pipe',
    meaning: 'The runtime must spawn with stdio.control: "pipe"; that single field is what makes the remote spawn seam take over. Without it the runtime would launch a local process.',
    where: 'src/remote-world.ts installRemoteWorld() subprocess.spawn patch',
    next: 'npm run test:ptc',
  },
]

/** Non-probe failures the upgrade path must also explain. */
export const CHANNEL_GUIDES = [
  {
    id: 'handshake',
    match: 'PTC shim did not print a control-channel handshake',
    meaning: 'The shim never printed __DSH_PTC_READY__ on stderr, or the token did not match.',
    where: 'src/ptc-shim.mjs handshake/auth and src/remote-world.ts consumeStderr()',
    next: 'npm run test:ptc',
  },
  {
    id: 'auth',
    match: 'PTC shim did not acknowledge the TCP authentication token',
    meaning: 'The loopback TCP fallback did not answer __DSH_PTC_AUTH_OK__.',
    where: 'src/ptc-shim.mjs startTcpControl() and src/remote-world.ts auth wait',
    next: 'npm run test:ptc',
  },
  {
    id: 'frame',
    match: 'invalid-output',
    meaning: 'The control channel opened but a frame did not match the runtime. This is the frame-level contract, not the launch contract.',
    where: 'src/ptc-remote.ts dispatch and src/remote-world.ts control bridge',
    next: 'npm run test:ptc',
  },
]

/**
 * Match a failure message against the guide table.
 *
 * Probe failures are plain sentences, but two of them embed a value
 * (`control environment marker changed to X`) or arrive wrapped in a larger
 * error, so matching is by prefix rather than equality.
 *
 * @param {string} message failure text from probeContract() or a thrown error
 * @returns {Guide | undefined}
 */
export function guideFor(message) {
  const text = String(message)
  const all = [...PROBE_GUIDES, ...CHANNEL_GUIDES]
  return all.find(guide => text.includes(guide.match))
}

/**
 * Render one guide as the lines a human or an agent needs.
 * @param {Guide} guide
 * @returns {string[]}
 */
export function renderGuide(guide) {
  return [
    `  [${guide.id}] ${guide.match}`,
    `      meaning: ${guide.meaning}`,
    `      change:  ${guide.where}`,
    `      then:    ${guide.next}`,
  ]
}
