// src/index.ts
import { mkdir as mkdir2 } from "node:fs/promises";
import { basename } from "node:path";
import { credentialKey } from "@deepseek-ai/dsh-credentials";
import { ESCALATION_TARGETS } from "@deepseek-ai/dsh-sandbox";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

// src/config.ts
import Schema from "@deepseek-ai/schemastery";
var Host = Schema.object({
  id: Schema.string().required(),
  name: Schema.string().default(""),
  host: Schema.string().required(),
  port: Schema.natural().min(1).max(65535).default(22),
  username: Schema.string().required(),
  /** `key` reads a local private-key path. `password` reads ctx.credentials. */
  auth: Schema.union([
    Schema.const("key").required(),
    Schema.const("password").required()
  ]).default("key"),
  /** Local path of the private key. The key bytes are never copied into config. */
  privateKeyPath: Schema.string().default(""),
  /** SHA-256 host key accepted by the operator. Empty until the first trust. */
  fingerprint: Schema.string().default("")
});
var Config = Schema.object({
  // Settings only lists and writes fields marked volatile. Without this, the
  // host row is dropped from describe() and every save is a silent no-op.
  hosts: Schema.array(Host).default([]).volatile(),
  maxConnections: Schema.natural().min(1).max(32).default(4)
});
var volatileWrite = Symbol.for("cosmokit.volatile.write");
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isHostRef(value) {
  if (typeof value !== "object" || value === null || !(volatileWrite in value)) return false;
  return typeof value.get === "function";
}
function asHostArray(value) {
  if (!Array.isArray(value)) throw new Error("SSH host list is not an array");
  return value;
}
function copyHostRows(value) {
  if (value === void 0 || value === null) return void 0;
  return asHostArray(value).map((item) => ({ ...item }));
}
function commitHosts(ref, hosts) {
  const frozen = Object.freeze(hosts.map((host) => Object.freeze({ ...host })));
  const writer = ref[volatileWrite];
  writer(frozen);
}
function readConfig(raw) {
  const record = isRecord(raw) ? raw : {};
  const incoming = record.hosts;
  const parsed = Config({
    ...record,
    hosts: copyHostRows(isHostRef(incoming) ? incoming.get() : incoming)
  });
  const normalized = asHostArray(isHostRef(parsed.hosts) ? parsed.hosts.get() : parsed.hosts);
  const maxConnections = parsed.maxConnections ?? 4;
  if (isHostRef(incoming)) return viewConfig(incoming, maxConnections);
  if (isHostRef(parsed.hosts)) return viewConfig(parsed.hosts, maxConnections);
  return { hosts: normalized, maxConnections };
}
function viewConfig(ref, maxConnections) {
  return {
    get hosts() {
      return asHostArray(ref.get()).map((host) => ({ ...host }));
    },
    set hosts(value) {
      commitHosts(ref, value);
    },
    maxConnections
  };
}

// src/execute.ts
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { posix as posix3 } from "node:path";
import { FsError } from "@deepseek-ai/dsh-fs";
import {
  SandboxUnavailableError,
  approveEscalation,
  escalationHintMarker,
  sandboxDenialMarker,
  validateEscalationArgs
} from "@deepseek-ai/dsh-sandbox";

// src/install-commands.ts
var BUBBLEWRAP_INSTALLS = [
  {
    id: "debian",
    title: "Debian/Ubuntu",
    auto: "sudo -n apt-get update && sudo -n apt-get install -y bubblewrap",
    manual: "sudo apt-get update && sudo apt-get install -y bubblewrap"
  },
  {
    id: "fedora",
    title: "Fedora/RHEL",
    auto: "sudo -n dnf install -y bubblewrap",
    manual: "sudo dnf install -y bubblewrap"
  },
  {
    id: "arch",
    title: "Arch",
    auto: "sudo -n pacman -S --noconfirm bubblewrap",
    manual: "sudo pacman -S bubblewrap"
  },
  {
    id: "alpine",
    title: "Alpine",
    auto: "sudo -n apk add bubblewrap",
    manual: "sudo apk add bubblewrap"
  }
];
var DEBIAN = /* @__PURE__ */ new Set(["debian", "ubuntu", "linuxmint", "pop", "raspbian"]);
var FEDORA = /* @__PURE__ */ new Set(["fedora", "rhel", "centos", "rocky", "almalinux", "ol"]);
var ARCH = /* @__PURE__ */ new Set(["arch", "manjaro", "endeavouros"]);
var ALPINE = /* @__PURE__ */ new Set(["alpine"]);
function parseOsRelease(text) {
  const fields = /* @__PURE__ */ new Map();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq);
    let value = trimmed.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    fields.set(key, value);
  }
  const id = (fields.get("ID") ?? "").toLowerCase();
  const idLike = (fields.get("ID_LIKE") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return { id, idLike };
}
function distroInstallFor(release) {
  const names = [release.id, ...release.idLike];
  for (const name2 of names) {
    if (DEBIAN.has(name2)) return BUBBLEWRAP_INSTALLS[0];
    if (FEDORA.has(name2)) return BUBBLEWRAP_INSTALLS[1];
    if (ARCH.has(name2)) return BUBBLEWRAP_INSTALLS[2];
    if (ALPINE.has(name2)) return BUBBLEWRAP_INSTALLS[3];
  }
  return null;
}

// src/contain.ts
import { posix } from "node:path";
function composeCreatedPath(ancestorReal, missingNames) {
  const suffix = missingNames.filter((name2) => name2.length > 0 && name2 !== "." && name2 !== "..");
  if (suffix.length === 0) return posix.normalize(ancestorReal);
  return posix.normalize(posix.join(ancestorReal, ...suffix));
}

// src/shell-quote.ts
function shQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
function shJoin(argv) {
  return argv.map(shQuote).join(" ");
}

// src/profile.ts
function bwrapProfileArgs(mode, workspaceRoot) {
  if (mode === "danger-full-access") return null;
  const args = bwrapBaseArgs();
  if (mode === "workspace-write") {
    args.push("--tmpfs", "/tmp", "--bind", workspaceRoot, workspaceRoot);
  }
  return args;
}
function bwrapFileProfileArgs(mode, roots) {
  if (mode === "danger-full-access") return null;
  const args = bwrapBaseArgs();
  if (mode === "workspace-write") {
    const binds = fileWritableRoots(mode, roots).slice().sort((left, right) => left.length - right.length || left.localeCompare(right));
    for (const root of binds) args.push("--bind", root, root);
  }
  return args;
}
function bwrapBaseArgs() {
  return [
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--unshare-pid",
    "--proc",
    "/proc",
    "--die-with-parent"
  ];
}
function seatbeltBashCommand(mode, writable, workdir, command) {
  const profile = seatbeltProfileArgs(mode, writable) ?? [];
  return `cd ${shJoin([workdir])} && ${shJoin(["sandbox-exec", ...profile, "--", "bash", "-c", command])}`;
}
function bwrapProbeArgv() {
  return ["bwrap", ...bwrapProfileArgs("read-only", "/"), "--", "true"];
}
function seatbeltProfileArgs(mode, roots) {
  if (mode === "danger-full-access") return null;
  const forms = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    '(allow file-write* (literal "/dev/null"))'
  ];
  if (mode === "workspace-write" && roots.length > 0) {
    const grants = roots.map((root) => `(subpath ${sbplString(root)})`).join(" ");
    forms.push(`(allow file-write* ${grants})`);
  }
  return ["-p", forms.join(" ")];
}
function seatbeltProbeArgv() {
  return ["sandbox-exec", ...seatbeltProfileArgs("read-only", []), "--", "true"];
}
function sbplString(value) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
function fileWritableRoots(mode, roots) {
  if (mode !== "workspace-write") return [];
  return [...new Set([roots.workspaceRoot, roots.tmp, roots.userTmp].filter((root) => root.length > 0))];
}
function pathInsideRoot(target, root) {
  const normalizedTarget = target.length > 1 && target.endsWith("/") ? target.slice(0, -1) : target;
  const normalizedRoot = root.length > 1 && root.endsWith("/") ? root.slice(0, -1) : root;
  if (normalizedRoot === "/") return normalizedTarget.startsWith("/");
  if (normalizedTarget === normalizedRoot) return true;
  return normalizedTarget.startsWith(`${normalizedRoot}/`);
}
function fileWriteAllowed(mode, target, roots) {
  if (mode === "danger-full-access") return true;
  if (mode === "read-only") return false;
  return fileWritableRoots(mode, roots).some((root) => pathInsideRoot(target, root));
}
function sandboxDenied(exitCode, stderr) {
  if (exitCode === 0 || exitCode === null) return false;
  return /read-only file system|operation not permitted/i.test(stderr);
}
function grepArgv(rg, pattern, base, include) {
  const argv = [rg, "--no-config", "--json", "-n", "--heading", pattern];
  if (include !== void 0 && include.length > 0) argv.push("--glob", include);
  argv.push(base);
  return argv;
}
function globArgv(rg, pattern) {
  return [rg, "--no-config", "--files", "--hidden", "--iglob", pattern, "--glob", "!.git/**", "--sort", "modified"];
}
function atomicWriteScript(directory, tmp, target) {
  const write = `cat > ${shJoin([tmp])} && mv -f ${shJoin([tmp, target])}`;
  const cleanup = `{ status=$?; rm -f ${shJoin([tmp])}; exit $status; }`;
  return `mkdir -p ${shJoin([directory])} && ${write} || ${cleanup}`;
}

// src/probe.ts
function probeOutcome(exitCode, timedOut, stderr = "") {
  if (timedOut) return { available: false, reason: "timeout" };
  if (exitCode === 0) return { available: true, reason: "ok" };
  if (exitCode === null || exitCode === 127 || /not found|command not found/i.test(stderr)) {
    return { available: false, reason: "missing" };
  }
  return { available: false, reason: "rejected" };
}
function hostFactsCommand() {
  const line = (body) => `{ ${body}; } || printf '\\n'`;
  return [
    "uname -s",
    "uname -m",
    line("cd /tmp && pwd -P"),
    line('cd "${TMPDIR:-/tmp}" && pwd -P'),
    `printf '%s\\n' "$HOME"`
  ].join("; ");
}
function parseHostFacts(stdout) {
  const [osLine = "", archLine = "", tmpLine = "", userTmpLine = "", homeLine = ""] = stdout.split("\n");
  const tmp = tmpLine.trim() || "/tmp";
  const userTmp = userTmpLine.trim() || tmp;
  const home = homeLine.trim() || "/tmp";
  return {
    os: remoteOsOf(osLine),
    arch: remoteArchOf(archLine),
    tmp,
    userTmp,
    home
  };
}
function remoteOsOf(uname) {
  const name2 = uname.trim().toLowerCase();
  if (name2 === "linux") return "linux";
  if (name2 === "darwin") return "darwin";
  return "other";
}
function remoteArchOf(machine) {
  const name2 = machine.trim().toLowerCase();
  if (name2 === "x86_64" || name2 === "amd64") return "x64";
  if (name2 === "aarch64" || name2 === "arm64") return "arm64";
  return "other";
}
function ripgrepPackage(os2, arch) {
  if (arch === "other" || os2 === "other") return null;
  if (os2 === "linux" && arch === "x64") return "@vscode/ripgrep-linux-x64";
  if (os2 === "linux" && arch === "arm64") return "@vscode/ripgrep-linux-arm64";
  if (os2 === "darwin" && arch === "x64") return "@vscode/ripgrep-darwin-x64";
  if (os2 === "darwin" && arch === "arm64") return "@vscode/ripgrep-darwin-arm64";
  return null;
}

// src/router.ts
import os from "node:os";
import path from "node:path";
import { posix as posix2 } from "node:path";
function remoteRoot(env = process.env) {
  if (env.DSH_SSH_REMOTE_ROOT) return path.resolve(String(env.DSH_SSH_REMOTE_ROOT));
  const home = env.DSH_HOME ? String(env.DSH_HOME) : path.join(os.homedir(), ".dsh");
  return path.join(home, "remote");
}
function isValidHostId(hostId) {
  return /^[a-z][a-z0-9-]*$/.test(hostId);
}
function encodeRemotePath(remotePath) {
  return Buffer.from(remotePath, "utf8").toString("base64url");
}
function decodeRemotePath(encoded) {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  let text;
  try {
    text = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (encodeRemotePath(text) !== encoded) return null;
  return text;
}
function mapRemoteToLocal(hostId, remotePath, env = process.env) {
  if (!isValidHostId(hostId)) return null;
  if (!posix2.isAbsolute(remotePath)) return null;
  return path.join(remoteRoot(env), hostId, encodeRemotePath(remotePath));
}
function routeByCwd(cwd, env = process.env) {
  if (!cwd) return { kind: "local" };
  const root = remoteRoot(env);
  const rel = path.relative(root, cwd);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return { kind: "local" };
  const segments = rel.split(path.sep).filter((segment) => segment.length > 0);
  if (segments.length < 2) return { kind: "local" };
  const hostId = segments[0];
  const encoded = segments[1];
  if (!isValidHostId(hostId)) return { kind: "local" };
  const remotePath = decodeRemotePath(encoded);
  if (remotePath === null || !remotePath.startsWith("/")) return { kind: "local" };
  const extra = segments.slice(2);
  const remoteCwd = extra.length === 0 ? remotePath : posix2.join(remotePath, ...extra);
  return { kind: "remote", hostId, remoteCwd, placeholderCwd: cwd };
}
function resolveRemotePath(requestedPath, remoteCwd, placeholderCwd) {
  if (!posix2.isAbsolute(requestedPath)) {
    const rel2 = path.relative(placeholderCwd, requestedPath);
    if (rel2 !== "" && !rel2.startsWith("..") && !path.isAbsolute(rel2)) {
      return posix2.join(remoteCwd, rel2.split(path.sep).join("/"));
    }
    return posix2.normalize(posix2.resolve(remoteCwd, requestedPath));
  }
  const rel = posix2.relative(placeholderCwd, requestedPath);
  if (rel !== "" && !rel.startsWith("..") && !posix2.isAbsolute(rel)) {
    return posix2.join(remoteCwd, rel);
  }
  return posix2.normalize(requestedPath);
}
function toPlaceholderPath(remotePath, hostId, env = process.env) {
  const normalized = posix2.normalize(remotePath);
  const local = mapRemoteToLocal(hostId, normalized, env);
  if (local === null) return normalized;
  return local;
}
function toModelPath(remotePath, route, env = process.env) {
  const normalized = posix2.normalize(remotePath);
  const rel = posix2.relative(route.remoteCwd, normalized);
  if (rel === "") return route.placeholderCwd;
  if (rel !== "" && !rel.startsWith("..") && !posix2.isAbsolute(rel)) {
    return path.join(route.placeholderCwd, ...rel.split("/"));
  }
  return toPlaceholderPath(normalized, route.hostId, env);
}

// src/execute.ts
var require2 = createRequire(import.meta.url);
var READ_CAP = 1024 * 1024;
var IMAGE_CAP = 8 * 1024 * 1024;
var denialMarker = sandboxDenialMarker;
var hintMarker = escalationHintMarker;
async function probeHost(pool, host, secret) {
  const uname = await pool.exec(host, secret, hostFactsCommand(), 2e4);
  const facts = parseHostFacts(uname.stdout);
  const { os: os2, arch } = facts;
  const tmp = await canonicalRemotePath(pool, host, secret, facts.tmp);
  const userTmp = await canonicalRemotePath(pool, host, secret, facts.userTmp);
  const home = facts.home;
  const roots = { workspaceRoot: "/", tmp, userTmp };
  let sandbox = { available: false, reason: "missing" };
  let sandboxTool = "none";
  if (os2 === "linux") {
    sandboxTool = "bwrap";
    const probe = await pool.exec(host, secret, shJoin(bwrapProbeArgv()), 2e4);
    sandbox = probeOutcome(probe.timedOut ? null : probe.code, probe.timedOut, probe.stderr);
  } else if (os2 === "darwin") {
    sandboxTool = "sandbox-exec";
    const probe = await pool.exec(host, secret, shJoin(seatbeltProbeArgv()), 2e4);
    sandbox = probeOutcome(probe.timedOut ? null : probe.code, probe.timedOut, probe.stderr);
  }
  const rgRemote = `${home}/.dsh-permission-remote/rg`;
  const system = await pool.exec(host, secret, "command -v rg", 1e4);
  let ripgrep = "missing";
  let ripgrepPath = "";
  if (!system.timedOut && system.code === 0 && system.stdout.trim().length > 0) {
    ripgrep = "system";
    ripgrepPath = system.stdout.trim().split("\n")[0] ?? "rg";
  } else {
    const pkg = ripgrepPackage(os2, arch);
    const local = pkg === null ? null : resolveRgBinary(pkg);
    if (local !== null) {
      await pool.sftpUpload(host, secret, local, rgRemote);
      const check = await pool.exec(host, secret, `${shJoin([rgRemote])} --version`, 15e3);
      if (check.code === 0) {
        ripgrep = "uploaded";
        ripgrepPath = rgRemote;
      }
    }
  }
  let install = null;
  if (os2 === "linux") {
    const release = await pool.exec(host, secret, "cat /etc/os-release", 1e4);
    install = distroInstallFor(parseOsRelease(release.stdout));
  }
  return { os: os2, sandbox, sandboxTool, ripgrep, ripgrepPath, roots, install };
}
async function installBubblewrap(pool, host, secret, status) {
  if (status.install === null) {
    throw new Error("this remote has no supported package manager; use the manual command for your distro");
  }
  return pool.exec(host, secret, status.install.auto, 18e4);
}
function resolveRgBinary(pkg) {
  try {
    return require2.resolve(`${pkg}/bin/rg`);
  } catch {
    return null;
  }
}
async function effectiveMode(host, exec, args, toolName, subject) {
  return host.resolveMode(exec, args.sandbox_permissions, args.justification, toolName, subject);
}
function buildResolveMode(ctx) {
  return async (exec, requested, justification, toolName, subject) => {
    const session = exec.agent?.session;
    const standing = ctx.sandboxPolicy.resolve(session === void 0 ? {} : { session }).mode;
    validateEscalationArgs(requested, justification);
    if (requested === void 0 || justification === void 0) return standing;
    const approved = await approveEscalation({
      requestedMode: requested,
      justification,
      effectiveMode: standing,
      subject
    }, {
      approver: ctx.get("approval"),
      agent: exec.agent,
      callId: exec.callId ?? "",
      toolName,
      signal: exec.signal
    });
    return approved;
  };
}
async function rootsFor(status, workspace, pool, host, secret) {
  const workspaceRoot = await canonicalRemotePath(pool, host, secret, workspace);
  const tmp = await existingRemotePath(pool, host, secret, status.roots.tmp);
  const userTmp = await existingRemotePath(pool, host, secret, status.roots.userTmp);
  return { workspaceRoot, tmp, userTmp };
}
async function existingRemotePath(pool, host, secret, remotePath) {
  if (remotePath.trim().length === 0) return "";
  try {
    return await pool.sftpRealpath(host, secret, remotePath);
  } catch {
    return "";
  }
}
async function canonicalRemotePath(pool, host, secret, remotePath) {
  try {
    return await pool.sftpRealpath(host, secret, remotePath);
  } catch {
    return posix3.normalize(remotePath);
  }
}
async function runBash(hostApi, route, args, exec) {
  const host = requireHost(hostApi, route.hostId);
  const secret = await hostApi.secretOf(host);
  const status = await hostApi.statusOf(host);
  const mode = await effectiveMode(hostApi, exec, args, "bash", "command");
  const command = String(args.command ?? "");
  const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : 6e4;
  const workdir = typeof args.workdir === "string" ? resolveRemotePath(args.workdir, route.remoteCwd, route.placeholderCwd) : route.remoteCwd;
  const cwd = toModelPath(workdir, route);
  if (args.run_in_background === true) {
    return startBackground(hostApi, host, secret, status, route, command, workdir, cwd, mode, exec);
  }
  if (mode !== "danger-full-access" && !status.sandbox.available) {
    throw new SandboxUnavailableError(mode, "remote sandbox probe failed");
  }
  throwIfAborted(exec.signal);
  const roots = await rootsFor(status, route.remoteCwd, hostApi.pool, host, secret);
  const argv = commandArgv(status, mode, roots, workdir, command);
  const result = await hostApi.pool.exec(host, secret, argv, timeoutMs, exec.signal);
  const denied = mode !== "danger-full-access" && sandboxDenied(result.code, result.stderr);
  return {
    kind: "foreground",
    cwd,
    exitCode: result.timedOut ? null : result.code,
    signal: result.signal,
    timedOut: result.timedOut,
    aborted: exec.signal?.aborted === true,
    timeoutMs,
    stdout: { text: capturedText(result.stdout, result.stdoutTruncated), truncated: result.stdoutTruncated },
    stderr: { text: capturedText(result.stderr, result.stderrTruncated), truncated: result.stderrTruncated },
    ...mode === "danger-full-access" && !status.sandbox.available ? { sandbox: { mode, denied: false, enforcement: "partial" } } : { sandbox: { mode, denied, enforcement: status.sandbox.available ? "full" : "partial" } }
  };
}
function commandArgv(status, mode, roots, workdir, command) {
  const inner = ["bash", "-c", command];
  if (mode === "danger-full-access" || !status.sandbox.available) {
    return `cd ${shJoin([workdir])} && ${shJoin(inner)}`;
  }
  if (status.sandboxTool === "bwrap") {
    const profile = bwrapProfileArgs(mode, roots.workspaceRoot) ?? [];
    return shJoin(["bwrap", ...profile, "--chdir", workdir, "--", ...inner]);
  }
  const writable = mode === "workspace-write" ? fileWritableRoots(mode, roots) : [];
  return seatbeltBashCommand(mode, writable, workdir, command);
}
function fileCommand(status, mode, roots, script) {
  if (status.sandboxTool === "bwrap") {
    const profile2 = bwrapFileProfileArgs(mode, roots) ?? [];
    return shJoin(["bwrap", ...profile2, "--chdir", roots.workspaceRoot, "--", "bash", "-c", script]);
  }
  const writable = mode === "workspace-write" ? fileWritableRoots(mode, roots) : [];
  const profile = seatbeltProfileArgs(mode, writable) ?? [];
  return shJoin(["sandbox-exec", ...profile, "--", "bash", "-c", script]);
}
async function startBackground(hostApi, host, secret, status, route, command, workdir, cwd, mode, exec) {
  const jobs = hostApi.jobs;
  if (jobs === void 0 || typeof jobs.start !== "function") {
    throw new Error("background jobs unavailable: load the jobs service");
  }
  if (mode !== "danger-full-access" && !status.sandbox.available) {
    throw new SandboxUnavailableError(mode, "remote sandbox probe failed");
  }
  const roots = await rootsFor(status, route.remoteCwd, hostApi.pool, host, secret);
  const argv = commandArgv(status, mode, roots, workdir, command);
  const reaped = status.sandbox.available && status.sandboxTool === "bwrap" && mode !== "danger-full-access";
  const note = reaped ? "" : "\n[dsh-permission-remote] stopping this job closes its SSH channel; descendant processes may survive when no sandbox runner is wrapping the command";
  const id = jobs.start({
    kind: "bash",
    label: command,
    owner: exec.agent?.session?.id,
    toolCall: exec.callId === void 0 ? void 0 : {
      callId: exec.callId,
      rootCallId: exec.rootCallId ?? exec.callId
    },
    run: (job) => {
      let opened;
      let cancelled = false;
      const done = hostApi.pool.open(host, secret, argv, 0, exec.signal, void 0, (chunk) => {
        job.append(chunk.text, { channel: chunk.stream });
      }).then((commandHandle) => {
        opened = commandHandle;
        if (cancelled || exec.signal?.aborted === true) commandHandle.close();
        return commandHandle.done;
      }).then((result) => {
        if (note.length > 0) job.append(note);
        const text = `${capturedText(result.stdout, result.stdoutTruncated)}${capturedText(result.stderr, result.stderrTruncated)}${note}`;
        return {
          status: result.timedOut || result.signal === "KILL" ? "killed" : "completed",
          detail: result.timedOut ? "timed out" : result.signal === "KILL" ? "cancelled" : `exit code: ${result.code ?? "null"}`,
          result: text
        };
      }).catch((error) => ({
        status: "failed",
        detail: error instanceof Error ? error.message : String(error)
      }));
      return {
        cancel: () => {
          cancelled = true;
          opened?.close();
        },
        done
      };
    }
  });
  return { kind: "background", jobId: id, cwd };
}
async function runRead(hostApi, route, args, exec) {
  throwIfAborted(exec?.signal);
  const host = requireHost(hostApi, route.hostId);
  const secret = await hostApi.secretOf(host);
  const remotePath = resolveRemotePath(String(args.file_path ?? ""), route.remoteCwd, route.placeholderCwd);
  const bytes = await withSignal(hostApi.pool.sftpRead(host, secret, remotePath, READ_CAP), exec?.signal);
  const text = bytes.toString("utf8");
  const all = text.split(/\n/);
  const offset = typeof args.offset === "number" && args.offset > 0 ? Math.floor(args.offset) : 1;
  const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 2e3;
  const slice = all.slice(offset - 1, offset - 1 + limit);
  return {
    path: toModelPath(remotePath, route),
    offset,
    lines: slice.map((line, index) => ({ number: offset + index, text: line })),
    totalLines: all.length
  };
}
async function runWrite(hostApi, route, args, exec) {
  const host = requireHost(hostApi, route.hostId);
  const secret = await hostApi.secretOf(host);
  const status = await hostApi.statusOf(host);
  const mode = await effectiveMode(hostApi, exec, args, "write", "operation");
  const remotePath = resolveRemotePath(String(args.file_path ?? ""), route.remoteCwd, route.placeholderCwd);
  const roots = await rootsFor(status, route.remoteCwd, hostApi.pool, host, secret);
  const target = await resolveCreatedPath(hostApi.pool, host, secret, remotePath);
  if (!fileWriteAllowed(mode, target, roots)) {
    throw new FsError(`${denialMarker(mode)}
${hintMarker("operation")}`, "FS_SANDBOX_DENIED");
  }
  let before = null;
  try {
    before = (await withSignal(hostApi.pool.sftpRead(host, secret, target, READ_CAP), exec.signal)).toString("utf8");
  } catch {
    before = null;
  }
  const content = String(args.content ?? "");
  await commitFile(hostApi, host, secret, status, mode, roots, target, content, exec.signal);
  return {
    path: toModelPath(target, route),
    operation: before === null ? "create" : "update",
    before,
    after: content
  };
}
async function runEdit(hostApi, route, args, exec) {
  const host = requireHost(hostApi, route.hostId);
  const secret = await hostApi.secretOf(host);
  const status = await hostApi.statusOf(host);
  const mode = await effectiveMode(hostApi, exec, args, "edit", "operation");
  const remotePath = resolveRemotePath(String(args.file_path ?? ""), route.remoteCwd, route.placeholderCwd);
  const roots = await rootsFor(status, route.remoteCwd, hostApi.pool, host, secret);
  const real = await resolveCreatedPath(hostApi.pool, host, secret, remotePath);
  if (!fileWriteAllowed(mode, real, roots)) {
    throw new FsError(`${denialMarker(mode)}
${hintMarker("operation")}`, "FS_SANDBOX_DENIED");
  }
  const before = (await withSignal(hostApi.pool.sftpRead(host, secret, real, READ_CAP), exec.signal)).toString("utf8");
  const oldString = String(args.old_string ?? "");
  const newString = String(args.new_string ?? "");
  const replaceAll = args.replace_all === true;
  const count = before.split(oldString).length - 1;
  if (count === 0) throw new Error(`old_string was not found in ${toModelPath(real, route)}`);
  if (!replaceAll && count !== 1) throw new Error(`old_string matched ${count} times; pass replace_all or include more context`);
  const after = replaceAll ? before.replaceAll(oldString, newString) : before.replace(oldString, newString);
  await commitFile(hostApi, host, secret, status, mode, roots, real, after, exec.signal);
  return { path: toModelPath(real, route), before, after };
}
async function runReadImage(hostApi, route, args, save, exec) {
  throwIfAborted(exec?.signal);
  const host = requireHost(hostApi, route.hostId);
  const secret = await hostApi.secretOf(host);
  const remotePath = resolveRemotePath(String(args.file_path ?? ""), route.remoteCwd, route.placeholderCwd);
  const data = await withSignal(hostApi.pool.sftpRead(host, secret, remotePath, IMAGE_CAP), exec?.signal);
  const image = await save(data, posix3.basename(remotePath));
  return { path: toModelPath(remotePath, route), image };
}
async function runGlob(hostApi, route, args, exec) {
  throwIfAborted(exec?.signal);
  const host = requireHost(hostApi, route.hostId);
  const secret = await hostApi.secretOf(host);
  const status = await hostApi.statusOf(host);
  if (status.ripgrepPath.length === 0) throw new Error("ripgrep is not available on this remote host");
  const base = typeof args.path === "string" ? resolveRemotePath(args.path, route.remoteCwd, route.placeholderCwd) : route.remoteCwd;
  const pattern = String(args.pattern ?? "");
  const command = `cd ${shJoin([base])} && ${shJoin(globArgv(status.ripgrepPath, pattern))}`;
  const result = await hostApi.pool.exec(host, secret, command, 3e4, exec?.signal);
  if (result.code !== 0 && result.code !== 1) throw new Error(result.stderr || "glob failed");
  const paths = result.stdout.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const absolute = posix3.isAbsolute(line) ? line : posix3.join(base, line);
    return toModelPath(absolute, route);
  });
  return { root: toModelPath(base, route), paths };
}
async function runGrep(hostApi, route, args, exec) {
  throwIfAborted(exec?.signal);
  const host = requireHost(hostApi, route.hostId);
  const secret = await hostApi.secretOf(host);
  const status = await hostApi.statusOf(host);
  if (status.ripgrepPath.length === 0) throw new Error("ripgrep is not available on this remote host");
  const base = typeof args.path === "string" ? resolveRemotePath(args.path, route.remoteCwd, route.placeholderCwd) : route.remoteCwd;
  const argv = grepArgv(status.ripgrepPath, String(args.pattern ?? ""), base, typeof args.include === "string" ? args.include : void 0);
  const result = await hostApi.pool.exec(host, secret, shJoin(argv), 3e4, exec?.signal);
  if (result.code !== 0 && result.code !== 1) throw new Error(result.stderr || "grep failed");
  const matches = [];
  for (const row of result.stdout.split("\n")) {
    if (row.trim().length === 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(row);
    } catch {
      continue;
    }
    if (parsed.type !== "match") continue;
    const absolute = parsed.data?.path?.text ?? "";
    matches.push({
      path: toModelPath(absolute, route),
      lineNumber: parsed.data?.line_number ?? 0,
      line: (parsed.data?.lines?.text ?? "").replace(/\n$/, "")
    });
  }
  return { matches };
}
async function runWorkingDirectory(hostApi, route, args, exec, setDirectory) {
  if (args.cd === void 0 || args.cd === "") return { cwd: route.placeholderCwd };
  const requested = resolveRemotePath(String(args.cd), route.remoteCwd, route.placeholderCwd);
  const host = requireHost(hostApi, route.hostId);
  const secret = await hostApi.secretOf(host);
  let remote;
  try {
    remote = await hostApi.pool.sftpRealpath(host, secret, requested);
  } catch {
    throw new Error(`directory does not exist on the remote host: ${requested}`);
  }
  const local = mapRemoteToLocal(route.hostId, remote);
  if (local === null) throw new Error("remote directory cannot be mapped to a workspace path");
  await mkdir(local, { recursive: true });
  if (exec.agent === void 0) throw new Error("working_directory requires an agent Session");
  const cwd = await setDirectory(local);
  return { cwd };
}
async function resolveCreatedPath(pool, host, secret, lexicalPath) {
  let cursor = posix3.normalize(lexicalPath);
  const missing = [];
  while (true) {
    try {
      const real = await pool.sftpRealpath(host, secret, cursor);
      return composeCreatedPath(real, missing);
    } catch {
      if (cursor === "/") return composeCreatedPath("/", missing);
      missing.unshift(posix3.basename(cursor));
      const parent = posix3.dirname(cursor);
      if (parent === cursor) return composeCreatedPath(cursor, missing);
      cursor = parent;
    }
  }
}
async function commitFile(hostApi, host, secret, status, mode, roots, target, content, signal) {
  throwIfAborted(signal);
  if (mode !== "danger-full-access" && !status.sandbox.available) {
    throw new SandboxUnavailableError(mode, "remote sandbox probe failed");
  }
  const directory = posix3.dirname(target);
  const tmp = posix3.join(directory, `.dsh-permission-remote-${randomBytes(8).toString("hex")}`);
  const script = atomicWriteScript(directory, tmp, target);
  const wrapped = mode === "danger-full-access" ? script : fileCommand(status, mode, roots, script);
  const result = await hostApi.pool.exec(host, secret, wrapped, 2e4, signal, content);
  if (result.code !== 0) throw new Error(result.stderr || "remote write failed");
}
function throwIfAborted(signal) {
  if (signal?.aborted === true) throw abortError();
}
function abortError() {
  const error = new Error("tool call aborted");
  error.name = "AbortError";
  return error;
}
function withSignal(work, signal) {
  throwIfAborted(signal);
  if (signal === void 0) return work;
  return new Promise((resolve, reject) => {
    const fail = () => reject(abortError());
    signal.addEventListener("abort", fail, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", fail));
  });
}
function capturedText(text, truncated) {
  if (!truncated) return text;
  return `${text}
[output truncated]`;
}
function requireHost(hostApi, hostId) {
  const host = hostApi.hostOf(hostId);
  if (host === void 0) throw new Error(`SSH host ${hostId} is not configured`);
  return host;
}

// src/image.ts
function sniffImage(data) {
  if (data.length >= 8 && data[0] === 137 && data[1] === 80 && data[2] === 78 && data[3] === 71) return "image/png";
  if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return "image/jpeg";
  if (data.length >= 12 && data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  const gif = data.length >= 6 ? data.toString("ascii", 0, 6) : "";
  if (gif === "GIF87a" || gif === "GIF89a") return "image/gif";
  return void 0;
}

// src/shadow.ts
var ROUTED_TOOLS = ["bash", "read", "write", "edit", "read_image", "glob", "grep", "working_directory"];
function planShadows(visible) {
  const plans = [];
  for (const name2 of ROUTED_TOOLS) {
    const official = visible(name2);
    if (official === void 0 && name2 !== "bash") continue;
    plans.push({
      name: name2,
      official: official?.execute,
      required: name2 === "bash"
    });
  }
  return plans;
}
function dispatchShadow(official, remote, remoteExecute, args, exec) {
  if (!remote) {
    if (official === void 0) {
      throw new Error("dsh-permission-remote: this call left the remote workspace and no local tool is mounted");
    }
    return official(args, exec);
  }
  return remoteExecute(args, exec);
}

// src/ssh-pool.ts
import { readFile } from "node:fs/promises";
import { Client } from "ssh2";

// src/pool-claim.ts
function claimPending(map, key, create) {
  const existing = map.get(key);
  if (existing !== void 0) return existing;
  const pending = create().catch((error) => {
    if (map.get(key) === pending) map.delete(key);
    throw error;
  });
  map.set(key, pending);
  return pending;
}

// src/ssh-pool.ts
var OUTPUT_CAP = 1024 * 1024;
var SshFailure = class extends Error {
  constructor(message, stage) {
    super(message);
    this.stage = stage;
    this.name = "SshFailure";
  }
};
var FINGERPRINT_PREFIX = "SHA256:";
function formatFingerprint(hashedKey) {
  return `${FINGERPRINT_PREFIX}${hashedKey.toString("base64")}`;
}
var SshPool = class {
  constructor(maxConnections) {
    this.maxConnections = maxConnections;
  }
  live = /* @__PURE__ */ new Map();
  waiters = [];
  active = 0;
  async dispose() {
    const pending = [...this.live.values()];
    this.live.clear();
    for (const item of pending) {
      try {
        const live = await item;
        await closeLive(live);
      } catch {
      }
    }
  }
  invalidate(hostId) {
    const current = this.live.get(hostId);
    this.live.delete(hostId);
    if (current === void 0) return;
    void current.then((live) => closeLive(live)).catch(() => void 0);
  }
  async exec(host, secret, command, timeoutMs, signal, stdin, onOutput) {
    const commandHandle = await this.open(host, secret, command, timeoutMs, signal, stdin, onOutput);
    return commandHandle.done;
  }
  /** `timeoutMs` of 0 waits until the command exits, the signal aborts, or `close` kills its channel. */
  async open(host, secret, command, timeoutMs, signal, stdin, onOutput) {
    const live = await this.acquire(host, secret, true);
    const commandHandle = openChannel(live.client, command, timeoutMs, stdin, onOutput);
    if (signal !== void 0) {
      const abort = () => commandHandle.close();
      if (signal.aborted) commandHandle.close();
      else signal.addEventListener("abort", abort, { once: true });
      void commandHandle.done.finally(() => signal.removeEventListener("abort", abort));
    }
    return commandHandle;
  }
  /** Connect far enough to read the host key. Does not persist trust. */
  async offerFingerprint(host, secret) {
    const stored = host.fingerprint.trim();
    let offered = "";
    try {
      const live = await connect(host, secret, (key) => {
        offered = formatFingerprint(key);
        return stored.length > 0 && offered === stored;
      });
      const banner = await openChannel(live, "echo ok", 15e3).done;
      live.end();
      return { fingerprint: stored, trusted: true, banner: banner.stdout.trim() };
    } catch (error) {
      if (offered.length > 0 && offered !== stored) {
        return { fingerprint: offered, trusted: false, banner: "" };
      }
      throw error;
    }
  }
  async sftpRead(host, secret, remotePath, maxBytes) {
    const session = await this.sftp(host, secret);
    if (maxBytes !== void 0) {
      const size = await statSize(session, remotePath);
      if (size > maxBytes) throw new SshFailure(`file is ${size} bytes, over the ${maxBytes} byte limit`, "sftp-read");
    }
    return readAll(session, remotePath);
  }
  async sftpWrite(host, secret, remotePath, body) {
    const session = await this.sftp(host, secret);
    await writeAll(session, remotePath, body);
  }
  async sftpRealpath(host, secret, remotePath) {
    const session = await this.sftp(host, secret);
    return realpathOf(session, remotePath);
  }
  async sftpStat(host, secret, remotePath) {
    const session = await this.sftp(host, secret);
    return statInfo(session, remotePath);
  }
  async sftpList(host, secret, remotePath) {
    const session = await this.sftp(host, secret);
    const rows = await readdir(session, remotePath);
    return rows.filter((row) => row.attrs.isDirectory()).map((row) => ({
      name: row.filename,
      path: remotePath === "/" ? `/${row.filename}` : `${remotePath.replace(/\/$/, "")}/${row.filename}`
    })).sort((a, b) => a.name.localeCompare(b.name));
  }
  async sftp(host, secret) {
    const live = await this.acquire(host, secret, true);
    live.sftp ??= openSftp(live.client).catch((error) => {
      live.sftp = void 0;
      throw error;
    });
    const session = await live.sftp;
    return session.api;
  }
  async sftpUpload(host, secret, localPath, remotePath) {
    const body = await readFile(localPath);
    const dir = remotePath.slice(0, remotePath.lastIndexOf("/"));
    if (dir.length > 0) {
      await this.exec(host, secret, `mkdir -p ${shJoin([dir])} && chmod 700 ${shJoin([dir])}`, 2e4);
    }
    await this.sftpWrite(host, secret, remotePath, body);
    await this.exec(host, secret, `chmod 755 ${shJoin([remotePath])}`, 15e3);
  }
  acquire(host, secret, requireTrust) {
    return claimPending(this.live, host.id, async () => {
      await this.reserve();
      try {
        const client = await connect(host, secret, (key) => {
          const fingerprint = formatFingerprint(key);
          if (!requireTrust) return true;
          return host.fingerprint.trim().length > 0 && host.fingerprint.trim() === fingerprint;
        });
        const live = { client, hostId: host.id };
        let released = false;
        const drop = () => {
          if (released) return;
          released = true;
          const current = this.live.get(host.id);
          void current?.then((value) => {
            if (value === live) this.live.delete(host.id);
          }).catch(() => void 0);
          void live.sftp?.then((session) => session.end()).catch(() => void 0);
          this.release();
        };
        client.on("close", drop);
        client.on("end", drop);
        return live;
      } catch (error) {
        this.release();
        throw error;
      }
    });
  }
  reserve() {
    if (this.active < this.maxConnections) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }
  release() {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next !== void 0) next();
  }
};
function connect(host, secret, accept) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    const fail = (error) => {
      client.end();
      reject(error instanceof Error ? error : new SshFailure(String(error), "connect"));
    };
    client.once("ready", () => resolve(client));
    client.once("error", fail);
    const options = {
      host: host.host,
      port: host.port,
      username: host.username,
      readyTimeout: 2e4,
      hostHash: "sha256",
      hostVerifier: (key) => accept(key)
    };
    if (host.auth === "password") {
      if (!secret.password) {
        fail(new SshFailure("password is not stored for this host", "auth"));
        return;
      }
      options.password = secret.password;
    } else if (host.privateKeyPath.trim().length > 0) {
      void readFile(host.privateKeyPath).then((key) => {
        options.privateKey = key;
        if (secret.passphrase) options.passphrase = secret.passphrase;
        client.connect(options);
      }).catch(fail);
      return;
    }
    client.connect(options);
  });
}
function openChannel(client, command, timeoutMs, stdin, onOutput) {
  let settled = false;
  let cause = "exit";
  let stream;
  let resolveDone = () => void 0;
  let rejectDone = () => void 0;
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const stdout = [];
  const stderr = [];
  let stdoutTruncated = false;
  let stderrTruncated = false;
  const finish = (code, signal) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearTimeout(fallback);
    resolveDone({
      code: cause === "exit" ? code : null,
      signal: cause === "exit" ? signal : "KILL",
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
      timedOut: cause === "timeout",
      stdoutTruncated,
      stderrTruncated
    });
  };
  let fallback;
  const stop = (next) => {
    if (settled || cause !== "exit") return;
    cause = next;
    if (stream === void 0) {
      finish(null, null);
      return;
    }
    try {
      stream.signal?.("KILL", () => void 0);
    } catch {
    }
    try {
      stream.close();
    } catch {
    }
    fallback = setTimeout(() => finish(null, "KILL"), 2e3);
  };
  const timer = timeoutMs > 0 ? setTimeout(() => stop("timeout"), timeoutMs) : void 0;
  client.exec(command, (error, opened) => {
    if (error) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        rejectDone(new SshFailure(error.message, "exec"));
      }
      return;
    }
    stream = opened;
    const emit = (stream2, text) => {
      if (text.length === 0 || onOutput === void 0) return;
      try {
        onOutput({ stream: stream2, text });
      } catch {
      }
    };
    const push = (target, chunk, which) => {
      const used = target.reduce((sum, part) => sum + part.length, 0);
      const room = OUTPUT_CAP - used;
      if (room <= 0) {
        if (which === "stdout") stdoutTruncated = true;
        else stderrTruncated = true;
        stop("truncate");
        return;
      }
      const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
      target.push(kept);
      emit(which, kept.toString("utf8"));
      if (kept.length < chunk.length) {
        if (which === "stdout") stdoutTruncated = true;
        else stderrTruncated = true;
        emit(which, "\n[output truncated]");
        stop("truncate");
      }
    };
    stream.on("data", (chunk) => push(stdout, chunk, "stdout"));
    stream.stderr.on("data", (chunk) => push(stderr, chunk, "stderr"));
    stream.on("close", (code, signal) => finish(code, signal));
    if (stdin !== void 0 && cause === "exit") {
      stream.write(typeof stdin === "string" ? Buffer.from(stdin) : stdin);
      stream.end();
    }
    if (cause !== "exit") {
      try {
        stream.signal?.("KILL", () => void 0);
      } catch {
      }
      try {
        stream.close();
      } catch {
      }
    }
  });
  return { done, close: () => stop("cancel") };
}
function openSftp(client) {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error) {
        reject(new SshFailure(error.message, "sftp"));
        return;
      }
      const api = sftp;
      resolve({
        api,
        end: () => {
          try {
            api.end();
          } catch {
          }
        }
      });
    });
  });
}
async function closeLive(live) {
  try {
    const session = await live.sftp;
    session?.end();
  } catch {
  }
  live.client.end();
}
function statInfo(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.stat(remotePath, (error, stats) => {
      if (error) reject(new SshFailure(error.message, "sftp-stat"));
      else resolve({ isDirectory: stats.isDirectory(), size: stats.size });
    });
  });
}
function statSize(sftp, remotePath) {
  return statInfo(sftp, remotePath).then((info) => info.size);
}
function readAll(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.readFile(remotePath, (error, data) => {
      if (error) reject(new SshFailure(error.message, "sftp-read"));
      else resolve(data);
    });
  });
}
function writeAll(sftp, remotePath, body) {
  return new Promise((resolve, reject) => {
    sftp.writeFile(remotePath, body, (error) => {
      if (error) reject(new SshFailure(error.message, "sftp-write"));
      else resolve();
    });
  });
}
function realpathOf(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.realpath(remotePath, (error, resolved) => {
      if (error) reject(new SshFailure(error.message, "sftp-realpath"));
      else resolve(resolved);
    });
  });
}
function readdir(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.readdir(remotePath, (error, list) => {
      if (error) reject(new SshFailure(error.message, "sftp-list"));
      else resolve(list);
    });
  });
}

// src/index.ts
var name = "dsh-permission-remote";
var inject = ["sandboxPolicy", "tools", "settings", "credentials", "workspaceRegistry"];
var REMOTE_METHODS = "@deepseek-ai/dsh-typert-protocol/remote-methods";
var SshApi = class extends TypertRemoteService {
  constructor(ctx, core) {
    super(ctx, "sshPermission");
    this.core = core;
    markRemote(this);
  }
  async testConnection(input) {
    const host = this.core.requireHost(input.hostId);
    return this.core.pool.offerFingerprint(host, await this.core.secret(host));
  }
  async trustFingerprint(input) {
    await this.core.trust(input.hostId, input.fingerprint);
    return { ok: true };
  }
  async probe(input) {
    return this.core.probe(input.hostId, input.refresh === true);
  }
  async installDeps(input) {
    const host = this.core.requireHost(input.hostId);
    const status = await this.core.probe(input.hostId);
    const result = await installBubblewrap(this.core.pool, host, await this.core.secret(host), status);
    this.core.forgetStatus(input.hostId);
    const next = await this.core.probe(input.hostId);
    return { code: result.code, stdout: result.stdout, stderr: result.stderr, status: next };
  }
  async listDir(input) {
    const host = this.core.requireHost(input.hostId);
    const entries = await this.core.pool.sftpList(host, await this.core.secret(host), input.path || "/");
    return { path: input.path || "/", entries };
  }
  async createWorkspace(input) {
    const host = this.core.requireHost(input.hostId);
    const info = await this.core.pool.sftpStat(host, await this.core.secret(host), input.path);
    if (!info.isDirectory) throw new Error(`remote path is not a directory: ${input.path}`);
    const local = mapRemoteToLocal(input.hostId, input.path);
    if (local === null) throw new Error("remote path must be absolute");
    await mkdir2(local, { recursive: true });
    const title = input.title?.trim() || basename(input.path);
    await this.core.workspaces.create(local, title);
    return { path: local };
  }
  async saveHost(input) {
    await this.core.saveHost(input);
    return { ok: true };
  }
  async deleteHost(input) {
    await this.core.deleteHost(input.hostId);
    return { ok: true };
  }
  async saveSecret(input) {
    await this.core.saveSecret(input.hostId, { password: input.password, passphrase: input.passphrase });
    return { ok: true };
  }
};
var Core = class {
  constructor(ctx, config, workspaces) {
    this.ctx = ctx;
    this.workspaces = workspaces;
    this.config = config;
    this.pool = new SshPool(config.maxConnections);
  }
  pool;
  config;
  status = /* @__PURE__ */ new Map();
  requireHost(hostId) {
    const host = this.config.hosts.find((item) => item.id === hostId);
    if (host === void 0) throw new Error(`unknown SSH host ${hostId}`);
    return host;
  }
  async trust(hostId, fingerprint) {
    this.requireHost(hostId);
    this.config.hosts = this.config.hosts.map((item) => item.id === hostId ? { ...item, fingerprint } : item);
    this.pool.invalidate(hostId);
    this.status.delete(hostId);
    await this.persistHosts();
  }
  forgetStatus(hostId) {
    this.status.delete(hostId);
    this.pool.invalidate(hostId);
  }
  async secret(host) {
    const record = await this.ctx.credentials.readRecord(credentialKey("dsh-permission-remote", host.id));
    if (record === void 0 || record.kind !== "grant" || !isPayload(record.payload)) return {};
    return { password: record.payload.password, passphrase: record.payload.passphrase };
  }
  async saveSecret(hostId, material) {
    assertHostId(hostId);
    this.requireHost(hostId);
    const key = credentialKey("dsh-permission-remote", hostId);
    await this.ctx.credentials.modifyRecord(key, async (current) => {
      const previous = current?.kind === "grant" && isPayload(current.payload) ? current.payload : {};
      return {
        kind: "grant",
        payload: {
          password: material.password !== void 0 ? material.password : previous.password,
          passphrase: material.passphrase !== void 0 ? material.passphrase : previous.passphrase
        }
      };
    });
  }
  async saveHost(host) {
    assertHostId(host.id);
    const hosts = this.config.hosts.filter((item) => item.id !== host.id);
    this.config.hosts = [...hosts, host];
    await this.persistHosts();
  }
  async deleteHost(hostId) {
    this.config.hosts = this.config.hosts.filter((item) => item.id !== hostId);
    this.pool.invalidate(hostId);
    this.status.delete(hostId);
    await this.persistHosts();
  }
  async persistHosts() {
    const row = this.ctx.settings.describe().find((item) => String(item.ns) === "permission-remote");
    if (row === void 0) return;
    await this.ctx.settings.update(String(row.ns), { hosts: this.config.hosts });
  }
  probe(hostId, refresh = false) {
    if (refresh) this.status.delete(hostId);
    const cached = this.status.get(hostId);
    if (cached !== void 0) return cached;
    const pending = (async () => {
      const host = this.requireHost(hostId);
      return probeHost(this.pool, host, await this.secret(host));
    })();
    this.status.set(hostId, pending);
    pending.catch(() => {
      if (this.status.get(hostId) === pending) this.status.delete(hostId);
    });
    return pending;
  }
  toolHost(jobs) {
    return {
      pool: this.pool,
      hostOf: (id) => this.config.hosts.find((item) => item.id === id),
      secretOf: (host) => this.secret(host),
      statusOf: (host) => this.probe(host.id),
      resolveMode: buildResolveMode(this.ctx),
      jobs
    };
  }
};
function assertHostId(hostId) {
  if (!isValidHostId(hostId)) throw new Error("host id must be a lowercase credential key: it starts with a letter and contains only letters, digits, and hyphens");
}
function isPayload(value) {
  return typeof value === "object" && value !== null;
}
function markRemote(service) {
  const methods = ["testConnection", "trustFingerprint", "probe", "installDeps", "listDir", "createWorkspace", "saveSecret", "saveHost", "deleteHost"];
  Object.defineProperty(Object.getPrototypeOf(service), REMOTE_METHODS, {
    configurable: true,
    value: Object.freeze({
      version: 1,
      methods: Object.freeze(methods.map((method) => Object.freeze({
        method,
        invocation: Object.freeze({ kind: "direct" })
      })))
    })
  });
}
var RUNNERS = {
  bash: (host, route, args, exec) => runBash(host, route, args, exec),
  read: (host, route, args, exec) => runRead(host, route, args, exec),
  write: (host, route, args, exec) => runWrite(host, route, args, exec),
  edit: (host, route, args, exec) => runEdit(host, route, args, exec),
  read_image: (host, route, args, exec, ctx) => runReadImage(host, route, args, async (data, fileName) => {
    const attachments = ctx.get("attachments");
    if (attachments === void 0) throw new Error("no attachment service is mounted");
    const mediaType = sniffImage(data);
    if (mediaType === void 0) throw new Error(`cannot read "${fileName}": the file content is not a PNG, JPEG, WebP, or GIF`);
    return attachments.saveImage({ data, mediaType, name: fileName });
  }, exec),
  glob: (host, route, args, exec) => runGlob(host, route, args, exec),
  grep: (host, route, args, exec) => runGrep(host, route, args, exec),
  working_directory: (host, route, args, exec, ctx) => runWorkingDirectory(host, route, args, exec, async (directory) => {
    const directories = ctx.get("workingDirectory");
    if (directories === void 0 || exec.agent === void 0) throw new Error("working_directory requires an agent Session");
    return directories.set(exec.agent, directory, exec.signal);
  })
};
function apply(rawCtx, rawConfig) {
  const ctx = rawCtx;
  const core = new Core(ctx, readConfig(rawConfig), ctx.workspaceRegistry);
  const api = new SshApi(rawCtx, core);
  const unregisters = /* @__PURE__ */ new Set();
  ctx.effect(() => ctx.settings.configure({ auto: false }));
  ctx.effect(() => () => {
    for (const unregister of unregisters) unregister();
    unregisters.clear();
    void core.pool.dispose();
  });
  void api;
  const seen = /* @__PURE__ */ new Set();
  const attach = (agent) => {
    if (seen.has(agent)) return;
    seen.add(agent);
    if (!installShadows(ctx, core, agent, unregisters)) seen.delete(agent);
  };
  ctx.on("agent/created", ({ agent }) => attach(agent));
  const agents = ctx.get("agents");
  if (typeof agents?.list === "function") {
    for (const agent of agents.list()) attach(agent);
  }
  ctx.logger?.info("[@dsh-permission-remote] loaded");
}
function installShadows(ctx, core, agent, unregisters) {
  const cwd = agent.session?.header?.cwd;
  const initial = routeByCwd(cwd);
  const disposers = [];
  try {
    const plans = planShadows((name2) => agent.ctx.tools.get(name2, agent));
    const host = core.toolHost(agent.ctx.get("jobs"));
    for (const plan of plans) {
      if (plan.official === void 0 && !(plan.name === "bash" && initial.kind === "remote")) continue;
      const official = plan.official;
      const runner = RUNNERS[plan.name];
      disposers.push(agent.ctx.tools.register(withRemoteTimeout({
        ...capturedSchema(agent.ctx, plan.name, agent),
        name: plan.name,
        async execute(args, exec) {
          const current = routeByCwd(effectiveCwd(ctx, exec, cwd));
          if (current.kind !== "remote") {
            return dispatchShadow(official, false, async () => {
              throw new Error("dsh-permission-remote: local call has no official tool");
            }, args, exec);
          }
          return runner(host, current, args, exec, ctx);
        }
      })));
    }
  } catch (error) {
    for (const unregister of disposers) unregister();
    ctx.logger?.warn(`[@dsh-permission-remote] shadow install failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  let dropped = false;
  const drop = () => {
    if (dropped) return;
    dropped = true;
    for (const unregister of disposers) unregister();
    unregisters.delete(drop);
  };
  unregisters.add(drop);
  try {
    agent.ctx.effect(() => drop);
  } catch (error) {
    drop();
    ctx.logger?.warn(`[@dsh-permission-remote] shadow install failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  return true;
}
function withRemoteTimeout(definition) {
  const parameters = definition.parameters;
  if (parameters?.timeoutMs === void 0) return definition;
  return {
    ...definition,
    parameters: {
      ...parameters,
      timeoutMs: {
        ...parameters.timeoutMs,
        description: "Timeout in milliseconds. When it expires this remote command is killed. Without a sandbox runner, child processes of the command may keep running on the remote host."
      }
    }
  };
}
function effectiveCwd(ctx, exec, fallback) {
  const directories = ctx.get("workingDirectory");
  const session = exec.agent?.session;
  if (directories !== void 0 && session !== void 0) {
    try {
      return directories.get(session);
    } catch {
    }
  }
  return session?.header?.cwd ?? fallback;
}
function capturedSchema(ctx, toolName, agent) {
  const official = ctx.tools.get(toolName, agent);
  if (official === void 0) return fallbackSchema(toolName);
  const { execute: _execute, ...rest } = official;
  return rest;
}
function fallbackSchema(toolName) {
  if (toolName !== "bash") return { description: toolName, parameters: {}, output: { schema: { type: "object" }, render: () => [{ type: "text", text: "" }] } };
  return {
    description: "Execute a bash command on the remote workspace.",
    parameters: {
      command: { type: "string", required: true },
      description: { type: "string", required: true },
      timeoutMs: { type: "number" },
      workdir: { type: "string" },
      run_in_background: { type: "boolean" },
      sandbox_permissions: { type: "string", enum: [...ESCALATION_TARGETS] },
      justification: { type: "string" }
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [{
        type: "text",
        text: value.kind === "background" ? "started background job" : `${value.stdout?.text ?? ""}${value.stderr?.text ?? ""}
[exit code: ${value.exitCode ?? "null"}]`
      }]
    }
  };
}
export {
  Config,
  apply,
  inject,
  name
};
