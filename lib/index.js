// src/index.ts
import { mkdir as mkdir3 } from "node:fs/promises";
import { basename } from "node:path";
import { credentialKey } from "@deepseek-ai/dsh-credentials";
import { ESCALATION_TARGETS } from "@deepseek-ai/dsh-sandbox";
import { ToolArgsError, parameterSchemaSpecToJsonSchema, validateArgs } from "@deepseek-ai/dsh-tools";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

// src/rg-fetch.ts
import { createHash, timingSafeEqual } from "node:crypto";
import { gunzipSync } from "node:zlib";
var DEFAULT_REGISTRY = "https://registry.npmjs.org";
var RG_ENTRY = "bin/rg";
function rgPackageName(platform) {
  return `@vscode/ripgrep-${platform}`;
}
function rgPlatformOf(os2, arch) {
  if (os2 !== "linux" && os2 !== "darwin") return null;
  if (arch !== "x64" && arch !== "arm64") return null;
  return `${os2 === "darwin" ? "darwin" : "linux"}-${arch}`;
}
function registryBase(registry) {
  const trimmed = registry.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) return DEFAULT_REGISTRY;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    throw new Error(`download source must be an http(s) URL: ${registry.trim()}`);
  }
  return `https://${trimmed}`;
}
function tarballUrl(registry, platform, version) {
  const name2 = rgPackageName(platform);
  const base = registryBase(registry);
  const leaf = name2.slice(name2.indexOf("/") + 1);
  return `${base}/${name2}/-/${leaf}-${version}.tgz`;
}
function metadataUrl(registry, platform) {
  return `${registryBase(registry)}/${rgPackageName(platform)}`;
}
function publishedVersion(document) {
  if (typeof document !== "object" || document === null) return "";
  const record = document;
  const latest = record["dist-tags"]?.latest;
  if (typeof latest === "string" && latest.length > 0) return latest;
  const keys = Object.keys(record.versions ?? {});
  return keys.sort(compareVersions).at(-1) ?? "";
}
function compareVersions(left, right) {
  const split = (value) => value.split(/[.+-]/).map((part) => /^\d+$/.test(part) ? Number(part) : part);
  const a = split(left);
  const b = split(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const x = a[index];
    const y = b[index];
    if (x === void 0) return -1;
    if (y === void 0) return 1;
    if (typeof x === "number" && typeof y === "number") {
      if (x !== y) return x - y;
    } else if (typeof x === "number") {
      return 1;
    } else if (typeof y === "number") {
      return -1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}
function publishedDist(document, version) {
  if (typeof document !== "object" || document === null) return null;
  const versions = document.versions;
  if (typeof versions !== "object" || versions === null) return null;
  const row = versions[version];
  if (typeof row !== "object" || row === null) return null;
  const dist = row.dist;
  if (typeof dist !== "object" || dist === null) return null;
  const record = dist;
  return {
    tarball: typeof record.tarball === "string" ? record.tarball : "",
    integrity: typeof record.integrity === "string" ? record.integrity : "",
    shasum: typeof record.shasum === "string" ? record.shasum : ""
  };
}
function tarEntries(archive) {
  const entries = [];
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    const name2 = header.toString("utf8", 0, 100).replace(/\0.*$/s, "");
    if (name2.length === 0) break;
    const sizeField = header.toString("utf8", 124, 136).replace(/\0.*$/s, "").trim();
    const size = sizeField.length === 0 ? 0 : Number.parseInt(sizeField, 8);
    if (!Number.isFinite(size) || size < 0) break;
    const dataStart = offset + 512;
    if (dataStart + size > archive.length) break;
    entries.push({ name: name2, data: archive.subarray(dataStart, dataStart + size) });
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}
function binaryFromTarball(gzipped) {
  let archive;
  try {
    archive = gunzipSync(gzipped);
  } catch {
    return null;
  }
  for (const entry of tarEntries(archive)) {
    const name2 = entry.name.replace(/^\.\//, "");
    if (name2 === `package/${RG_ENTRY}`) return entry.data;
  }
  return null;
}
var META_TIMEOUT_MS = 1e4;
var TARBALL_TIMEOUT_MS = 6e4;
var TARBALL_CAP = 32 * 1024 * 1024;
var BINARY_MAGIC = {
  "linux-x64": [Buffer.from([127, 69, 76, 70])],
  "linux-arm64": [Buffer.from([127, 69, 76, 70])],
  "darwin-x64": [
    Buffer.from([254, 237, 250, 206]),
    Buffer.from([206, 250, 237, 254]),
    Buffer.from([202, 254, 186, 190]),
    Buffer.from([190, 186, 254, 202])
  ],
  "darwin-arm64": [
    Buffer.from([207, 250, 237, 254]),
    Buffer.from([254, 237, 250, 207]),
    Buffer.from([202, 254, 186, 190]),
    Buffer.from([190, 186, 254, 202])
  ]
};
function binaryMatchesPlatform(binary, platform) {
  return BINARY_MAGIC[platform].some((magic) => binary.length >= magic.length && binary.subarray(0, magic.length).equals(magic));
}
function verifyTarball(tarball, dist) {
  const matches = (algorithm, expected) => {
    const actual = createHash(algorithm).update(tarball).digest();
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
  const sri = /^(sha256|sha384|sha512)-([A-Za-z0-9+/=]+)$/.exec(dist.integrity.trim());
  if (sri !== null) {
    const algorithm = sri[1];
    if (!matches(algorithm, Buffer.from(sri[2], "base64"))) {
      throw new Error(`tarball ${dist.tarball} does not match its published ${algorithm} integrity`);
    }
    return;
  }
  if (dist.shasum.trim().length > 0) {
    if (!matches("sha1", Buffer.from(dist.shasum.trim(), "hex"))) {
      throw new Error(`tarball ${dist.tarball} does not match its published sha1 shasum`);
    }
  }
}
async function readCapped(response, cap, url) {
  const declared = Number(response.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > cap) {
    throw new Error(`${url} announced ${declared} bytes, over the ${cap}-byte limit`);
  }
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === void 0) continue;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => void 0);
      throw new Error(`${url} returned more than the ${cap}-byte limit`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
function networkError(error, url, timeoutMs) {
  const name2 = error?.name;
  if (name2 === "TimeoutError" || name2 === "AbortError") return new Error(`${url} did not answer within ${timeoutMs / 1e3}s`);
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${url} failed: ${message}`);
}
async function fetchRgBinary(options) {
  const doFetch = options.fetchImpl ?? fetch;
  const metaUrl = metadataUrl(options.registry, options.platform);
  const metaResponse = await doFetch(metaUrl, {
    headers: { accept: "application/json", "user-agent": "dsh-permission-remote" },
    signal: AbortSignal.timeout(META_TIMEOUT_MS)
  }).catch((error) => {
    throw networkError(error, metaUrl, META_TIMEOUT_MS);
  });
  if (!metaResponse.ok) throw new Error(`registry ${metaUrl} answered ${metaResponse.status}`);
  const document = await metaResponse.json();
  const version = publishedVersion(document);
  if (version.length === 0) throw new Error(`registry ${metaUrl} listed no version`);
  const dist = publishedDist(document, version);
  const url = dist !== null && dist.tarball.length > 0 ? dist.tarball : tarballUrl(options.registry, options.platform, version);
  const response = await doFetch(url, { signal: AbortSignal.timeout(TARBALL_TIMEOUT_MS) }).catch((error) => {
    throw networkError(error, url, TARBALL_TIMEOUT_MS);
  });
  if (!response.ok) throw new Error(`tarball ${url} answered ${response.status}`);
  const tarball = await readCapped(response, TARBALL_CAP, url);
  if (dist !== null) verifyTarball(tarball, { ...dist, tarball: url });
  const binary = binaryFromTarball(tarball);
  if (binary === null || binary.length === 0) throw new Error(`tarball ${url} carried no ${RG_ENTRY}`);
  if (!binaryMatchesPlatform(binary, options.platform)) {
    throw new Error(`tarball ${url} carried a binary that is not built for ${options.platform}`);
  }
  return { version, binary };
}

// src/config.ts
import Schema from "@deepseek-ai/schemastery";
import { createVolatile, isVolatile, updateVolatile } from "@deepseek-ai/cosmokit";
var OpsPolicy = Schema.union([
  Schema.const("ask").required(),
  Schema.const("trust").required(),
  Schema.const("deny").required()
]).default("ask");
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
  fingerprint: Schema.string().default(""),
  opsPolicy: OpsPolicy
});
var DeletedHost = Schema.object({
  host: Host,
  deletedAt: Schema.string().default("")
});
var Config = Schema.object({
  // Settings only lists and writes fields marked volatile. Without this, the
  // host row is dropped from describe() and every save is a silent no-op.
  hosts: Schema.array(Host).default([]).volatile(),
  /**
   * Hosts removed from the settings list. Their workspaces stay registered, so
   * the settings page keeps showing them under "deleted hosts" and can restore
   * the host or unregister a single workspace.
   */
  deletedHosts: Schema.array(DeletedHost).default([]).volatile(),
  maxConnections: Schema.natural().min(1).max(32).default(4),
  /**
   * DSH's sidebar has no slot on a workspace row, so the owning server is
   * written into the workspace title. Off keeps the titles untouched.
   */
  tagWorkspaceTitles: Schema.boolean().default(true).volatile(),
  /**
   * npm registry used when fetching a ripgrep binary for a remote platform this
   * machine does not have installed. Empty means the default npmjs registry.
   * A mirror is usually needed where npmjs.org is slow or blocked.
   */
  rgRegistry: Schema.string().default("").volatile()
});
function normalizeOpsPolicy(value) {
  return value === "trust" || value === "deny" ? value : "ask";
}
function connectionKeyChanged(previous, next) {
  return previous.host !== next.host || previous.port !== next.port || previous.username !== next.username || previous.auth !== next.auth || previous.privateKeyPath !== next.privateKeyPath;
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isHostRef(value) {
  return isVolatile(value);
}
function asHostArray(value) {
  if (!Array.isArray(value)) throw new Error("SSH host list is not an array");
  return value;
}
function copyHostRows(value) {
  if (value === void 0 || value === null) return void 0;
  return asHostArray(value).map((item) => ({ ...item }));
}
function copyDeletedRows(value) {
  if (value === void 0 || value === null) return void 0;
  if (!Array.isArray(value)) throw new Error("deleted SSH host list is not an array");
  return value.map((row) => ({ host: { ...row.host }, deletedAt: row.deletedAt ?? "" }));
}
function commitHosts(ref, hosts) {
  updateVolatile(ref, createVolatile(hosts.map((host) => ({ ...host }))));
}
function commitDeleted(ref, rows) {
  updateVolatile(ref, createVolatile(rows.map((row) => ({ host: { ...row.host }, deletedAt: row.deletedAt }))));
}
function readConfig(raw) {
  const record = isRecord(raw) ? raw : {};
  const hostRef = refOf(record.hosts);
  const deletedRef = refOf(record.deletedHosts);
  const tagRef = refOf(record.tagWorkspaceTitles);
  const tagDefault = record.tagWorkspaceTitles !== false;
  const registryRef = refOf(record.rgRegistry);
  const registryDefault = typeof record.rgRegistry === "string" ? record.rgRegistry : "";
  const parsed = Config({
    ...record,
    hosts: copyHostRows(hostRef !== void 0 ? hostRef.get() : record.hosts),
    deletedHosts: copyDeletedRows(deletedRef !== void 0 ? deletedRef.get() : record.deletedHosts),
    // A volatile reference cannot be validated; resolve it to a value first.
    tagWorkspaceTitles: tagRef !== void 0 ? tagRef.get() !== false : tagDefault,
    rgRegistry: registryRef !== void 0 ? String(registryRef.get() ?? "") : registryDefault
  });
  const maxConnections = parsed.maxConnections ?? 4;
  const tag = tagRef === void 0 ? () => tagDefault : () => tagRef.get() !== false;
  const registry = () => String(registryRef === void 0 ? registryDefault : registryRef.get() ?? "").trim();
  const ref = hostRef ?? parsed.hosts;
  const deletedRowRef = deletedRef ?? refOf(parsed.deletedHosts);
  const deletedRows = copyDeletedRows(deletedRowRef !== void 0 ? deletedRowRef.get() : record.deletedHosts) ?? [];
  if (isHostRef(ref)) return viewConfig(ref, maxConnections, tag, registry, deletedRowRef, deletedRows);
  return { hosts: asHostArray(ref), deletedHosts: deletedRows, maxConnections, tagWorkspaceTitles: tagDefault, rgRegistry: registry() };
}
function refOf(value) {
  return isVolatile(value) ? value : void 0;
}
function viewConfig(ref, maxConnections, tagWorkspaceTitles, rgRegistry, deletedRef, deletedRows) {
  return {
    get hosts() {
      return asHostArray(ref.get()).map((host) => ({ ...host }));
    },
    set hosts(value) {
      commitHosts(ref, value);
    },
    get deletedHosts() {
      return deletedRef === void 0 ? deletedRows : copyDeletedRows(deletedRef.get()) ?? [];
    },
    set deletedHosts(value) {
      if (deletedRef === void 0) throw new Error("the deleted SSH host list is not writable in this config");
      commitDeleted(deletedRef, value);
    },
    maxConnections,
    get tagWorkspaceTitles() {
      return tagWorkspaceTitles();
    },
    get rgRegistry() {
      return rgRegistry();
    }
  };
}

// src/execute.ts
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, posix as posix4 } from "node:path";
import { writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { FsError } from "@deepseek-ai/dsh-fs";
import { dshCachePath, resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import {
  SandboxUnavailableError,
  WIDER_MODES,
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
    auto: "sudo -n apt-get update; sudo -n apt-get install -y bubblewrap",
    manual: "sudo apt-get update; sudo apt-get install -y bubblewrap"
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
function atomicWriteScript(directory, tmp, target, mode) {
  const quotedTarget = shJoin([target]);
  const bits = mode === void 0 ? void 0 : mode & 4095;
  const chmod = bits === void 0 ? "" : ` && chmod ${bits.toString(8)} ${quotedTarget}`;
  const write = `if test -d ${quotedTarget}; then echo 'remote path is a directory' >&2; false; else cat > ${shJoin([tmp])} && mv -f ${shJoin([tmp, target])}${chmod}; fi`;
  const cleanup = `{ status=$?; rm -f ${shJoin([tmp])}; exit $status; }`;
  return `mkdir -p ${shJoin([directory])} && ${write} || ${cleanup}`;
}

// src/probe.ts
import { posix as posix2 } from "node:path";
function probeOutcome(exitCode, timedOut, stderr = "") {
  if (timedOut) return { available: false, reason: "timeout" };
  if (exitCode === 0) return { available: true, reason: "ok" };
  if (exitCode === null || exitCode === 127 || /not found|command not found/i.test(stderr)) {
    return { available: false, reason: "missing" };
  }
  return { available: false, reason: "rejected" };
}
var FACT_BEGIN = "__DSH_FACTS_BEGIN__";
var FACT_END = "__DSH_FACTS_END__";
function hostFactsCommand() {
  const line = (body) => `( ${body} ) || printf '\\n'`;
  return [
    `printf '%s\\n' '${FACT_BEGIN}'`,
    "uname -s",
    "uname -m",
    line("cd /tmp && pwd -P"),
    line('cd "${TMPDIR:-/tmp}" && pwd -P'),
    `printf '%s\\n' "$HOME"`,
    `printf '%s\\n' '${FACT_END}'`
  ].join("; ");
}
function parseHostFacts(stdout) {
  const [osLine = "", archLine = "", tmpLine = "", userTmpLine = "", homeLine = ""] = factBody(stdout);
  const tmp = absoluteOr(tmpLine.trim(), "/tmp");
  const userTmp = absoluteOr(userTmpLine.trim(), tmp);
  const home = absoluteOr(homeLine.trim(), "");
  return {
    os: remoteOsOf(osLine),
    arch: remoteArchOf(archLine),
    tmp,
    userTmp,
    home
  };
}
function factBody(stdout) {
  return outputBlock(stdout, FACT_BEGIN, FACT_END, 5);
}
function outputBlock(stdout, begin, end, legacyCount) {
  const lines = stdout.split(/\r?\n/);
  const start = lines.indexOf(begin);
  if (start === -1) return legacyCount === void 0 ? lines : lines.slice(0, legacyCount);
  const stop = lines.indexOf(end, start + 1);
  return lines.slice(start + 1, stop === -1 ? void 0 : stop);
}
var RG_LOOKUP_BEGIN = "__DSH_RG_BEGIN__";
var RG_LOOKUP_END = "__DSH_RG_END__";
function systemRipgrepCommand() {
  return [
    `printf '%s\\n' '${RG_LOOKUP_BEGIN}'`,
    "command -v rg",
    "status=$?",
    `printf '%s\\n' '${RG_LOOKUP_END}'`,
    "exit $status"
  ].join("; ");
}
function systemRipgrepPath(stdout) {
  const lines = outputBlock(stdout, RG_LOOKUP_BEGIN, RG_LOOKUP_END);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] ?? "").trim();
    if (posix2.isAbsolute(line) && !/\s/.test(line)) return line;
  }
  return "";
}
function absoluteOr(value, fallback) {
  return posix2.isAbsolute(value) ? value : fallback;
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
  const platform = rgPlatformOf(os2, arch);
  return platform === null ? null : rgPackageName(platform);
}

// src/router.ts
import os from "node:os";
import path from "node:path";
import { posix as posix3 } from "node:path";
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
  if (!posix3.isAbsolute(remotePath)) return null;
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
  const remoteCwd = extra.length === 0 ? remotePath : posix3.join(remotePath, ...extra);
  return { kind: "remote", hostId, remoteCwd, placeholderCwd: cwd };
}
function resolveRemotePath(requestedPath, remoteCwd, placeholderCwd) {
  if (!posix3.isAbsolute(requestedPath)) {
    const rel2 = path.relative(placeholderCwd, requestedPath);
    if (rel2 !== "" && !rel2.startsWith("..") && !path.isAbsolute(rel2)) {
      return posix3.join(remoteCwd, rel2.split(path.sep).join("/"));
    }
    return posix3.normalize(posix3.resolve(remoteCwd, requestedPath));
  }
  const rel = posix3.relative(placeholderCwd, requestedPath);
  if (rel !== "" && !rel.startsWith("..") && !posix3.isAbsolute(rel)) {
    return posix3.join(remoteCwd, rel);
  }
  return posix3.normalize(requestedPath);
}
function toPlaceholderPath(remotePath, hostId, env = process.env) {
  const normalized = posix3.normalize(remotePath);
  const local = mapRemoteToLocal(hostId, normalized, env);
  if (local === null) return normalized;
  return local;
}
function toModelPath(remotePath, route, env = process.env) {
  const normalized = posix3.normalize(remotePath);
  const rel = posix3.relative(route.remoteCwd, normalized);
  if (rel === "") return route.placeholderCwd;
  if (rel !== "" && !rel.startsWith("..") && !posix3.isAbsolute(rel)) {
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
async function remoteFacts(pool, host, secret) {
  const uname = await pool.exec(host, secret, hostFactsCommand(), 2e4);
  return parseHostFacts(uname.stdout);
}
async function probeHost(pool, host, secret) {
  const uname = await pool.exec(host, secret, hostFactsCommand(), 2e4);
  const facts = parseHostFacts(uname.stdout);
  const { os: os2, arch } = facts;
  const tmp = await existingRemotePath(pool, host, secret, facts.tmp);
  const userTmp = await existingRemotePath(pool, host, secret, facts.userTmp);
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
  const rgRemote = home.length > 0 ? `${home}/.dsh-permission-remote/rg` : "";
  const system = await pool.exec(host, secret, systemRipgrepCommand(), 1e4);
  let ripgrep = "missing";
  let ripgrepPath = "";
  const systemPath = systemRipgrepPath(system.stdout);
  if (!system.timedOut && system.code === 0 && systemPath.length > 0) {
    ripgrep = "system";
    ripgrepPath = systemPath;
  } else if (rgRemote.length > 0) {
    const pkg = ripgrepPackage(os2, arch);
    if (pkg !== null) {
      const local = resolveRgBinary(pkg, rgPlatformOf(os2, arch) ?? void 0);
      if (local !== null) {
        try {
          await pool.sftpUpload(host, secret, local, rgRemote);
          const check = await pool.exec(host, secret, `${shJoin([rgRemote])} --version`, 15e3);
          if (check.code === 0) {
            ripgrep = "uploaded";
            ripgrepPath = rgRemote;
          } else {
            ripgrep = "upload-failed";
          }
        } catch {
          ripgrep = "upload-failed";
        }
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
function resolveRgBinary(pkg, platform, env = process.env) {
  try {
    return require2.resolve(`${pkg}/bin/rg`);
  } catch {
    if (platform === void 0) return null;
    for (const candidate of rgCachePaths(platform, env)) {
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }
}
function rgCachePaths(platform, env = process.env) {
  const home = resolveDshHome(void 0, env);
  return [
    dshCachePath({ dshHome: home }, "ripgrep", platform, "rg"),
    join(home, "remote", "ripgrep", platform, "rg")
  ];
}
function rgCachePath(platform, env = process.env) {
  return rgCachePaths(platform, env)[0];
}
async function cacheRgBinary(platform, binary, env = process.env) {
  const target = rgCachePath(platform, env);
  await writeFileAtomic(target, binary, { mode: 493, dirMode: 448 });
  return target;
}
async function effectiveMode(host, exec, args, toolName, subject) {
  return host.resolveMode(exec, args.sandbox_permissions, args.justification, toolName, subject);
}
var SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"];
function buildResolveMode(ctx) {
  return async (exec, requested, justification, toolName, subject, detail) => {
    const session = exec.agent?.session;
    const standing = ctx.sandboxPolicy.resolve(session === void 0 ? {} : { session }).mode;
    validateEscalationArgs(requested, justification);
    if (requested === void 0 || justification === void 0) return standing;
    if (!SANDBOX_MODES.includes(requested)) {
      throw new Error(`sandbox_permissions "${requested}" is not a sandbox mode`);
    }
    if (requested === standing) return standing;
    if (!(WIDER_MODES[standing] ?? []).includes(requested)) return standing;
    const approved = await approveEscalation({
      requestedMode: requested,
      justification,
      effectiveMode: standing,
      subject
    }, {
      approver: presentOpsDetail(ctx.get("approval"), detail),
      agent: exec.agent,
      callId: exec.callId ?? "",
      toolName,
      signal: exec.signal
    });
    return approved;
  };
}
function presentOpsDetail(approver, detail) {
  if (approver === void 0 || detail === void 0) return approver;
  const en = detail.en.trim();
  const zh = detail.zh.trim();
  if (en.length === 0 && zh.length === 0) return approver;
  return {
    request: (req) => approver.request({
      ...req,
      displayReason: {
        en: appendLine(req.displayReason?.en ?? req.reason, en),
        zh: appendLine(req.displayReason?.zh ?? req.displayReason?.en ?? req.reason, zh.length > 0 ? zh : en)
      }
    })
  };
}
function appendLine(base, line) {
  return line.length === 0 ? base : `${base}
${line}`;
}
async function rootsFor(status, workspace, pool, host, secret) {
  const workspaceRoot = await canonicalRemotePath(pool, host, secret, workspace);
  return { workspaceRoot, tmp: status.roots.tmp, userTmp: status.roots.userTmp };
}
var NOT_FOUND = /no such file|cannot find|not found|does not exist/i;
async function existingRemotePath(pool, host, secret, remotePath) {
  if (remotePath.trim().length === 0) return "";
  try {
    return await pool.sftpRealpath(host, secret, remotePath);
  } catch (error) {
    if (error instanceof Error && NOT_FOUND.test(error.message)) return "";
    return posix4.normalize(remotePath);
  }
}
async function canonicalRemotePath(pool, host, secret, remotePath) {
  try {
    return await pool.sftpRealpath(host, secret, remotePath);
  } catch {
    return posix4.normalize(remotePath);
  }
}
async function runBash(hostApi, route, args, exec) {
  const host = requireHost(hostApi, route.hostId);
  const secret = await hostApi.secretOf(host);
  const status = await hostApi.statusOf(host);
  const mode = await effectiveMode(hostApi, exec, args, "bash", "command");
  const command = String(args.command ?? "");
  const timeoutMs = typeof args.timeoutMs === "number" && args.timeoutMs > 0 ? args.timeoutMs : 6e4;
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
    const profile = bwrapFileProfileArgs(mode, roots) ?? [];
    return shJoin(["bwrap", ...profile, "--chdir", roots.workspaceRoot, "--", "bash", "-c", script]);
  }
  const writable = mode === "workspace-write" ? fileWritableRoots(mode, roots) : [];
  return seatbeltBashCommand(mode, writable, roots.workspaceRoot, script);
}
function finishBackground(result, note, append) {
  if (note.length > 0) append(note);
  return {
    status: result.timedOut || result.signal === "KILL" ? "killed" : "completed",
    detail: result.timedOut ? "timed out" : result.signal === "KILL" ? "cancelled" : `exit code: ${result.code ?? "null"}`
  };
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
      }).then((result) => finishBackground(result, note, (text) => job.append(text))).catch((error) => ({
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
  } catch (error) {
    if (exec.signal?.aborted === true || error instanceof Error && error.name === "AbortError") throw error;
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
  const image = await save(data, posix4.basename(remotePath));
  return { path: toModelPath(remotePath, route), image };
}
async function runGlob(hostApi, route, args, exec) {
  throwIfAborted(exec?.signal);
  const host = requireHost(hostApi, route.hostId);
  const secret = await hostApi.secretOf(host);
  const status = await hostApi.statusOf(host);
  if (status.ripgrepPath.length === 0) throw new Error('ripgrep is not available on this remote host; click "Install ripgrep" on its host row in the SSH settings, or install ripgrep on the remote so rg is on PATH');
  const base = typeof args.path === "string" ? resolveRemotePath(args.path, route.remoteCwd, route.placeholderCwd) : route.remoteCwd;
  const pattern = String(args.pattern ?? "");
  const command = withSearchMarkers(`cd ${shJoin([base])} && ${shJoin(globArgv(status.ripgrepPath, pattern))}`);
  const result = await hostApi.pool.exec(host, secret, command, 3e4, exec?.signal);
  throwIfRgFailed(result, exec?.signal, "glob");
  const paths = searchOutputLines(result.stdout).map((line) => {
    const absolute = posix4.isAbsolute(line) ? line : posix4.join(base, line);
    return toModelPath(absolute, route);
  });
  return { root: toModelPath(base, route), paths };
}
async function runGrep(hostApi, route, args, exec) {
  throwIfAborted(exec?.signal);
  const host = requireHost(hostApi, route.hostId);
  const secret = await hostApi.secretOf(host);
  const status = await hostApi.statusOf(host);
  if (status.ripgrepPath.length === 0) throw new Error('ripgrep is not available on this remote host; click "Install ripgrep" on its host row in the SSH settings, or install ripgrep on the remote so rg is on PATH');
  const base = typeof args.path === "string" ? resolveRemotePath(args.path, route.remoteCwd, route.placeholderCwd) : route.remoteCwd;
  const argv = grepArgv(status.ripgrepPath, String(args.pattern ?? ""), base, typeof args.include === "string" ? args.include : void 0);
  const result = await hostApi.pool.exec(host, secret, shJoin(argv), 3e4, exec?.signal);
  throwIfRgFailed(result, exec?.signal, "grep");
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
  let cursor = posix4.normalize(lexicalPath);
  const missing = [];
  while (true) {
    try {
      const real = await pool.sftpRealpath(host, secret, cursor);
      return composeCreatedPath(real, missing);
    } catch {
      if (cursor === "/") return composeCreatedPath("/", missing);
      missing.unshift(posix4.basename(cursor));
      const parent = posix4.dirname(cursor);
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
  const directory = posix4.dirname(target);
  const tmp = posix4.join(directory, `.dsh-permission-remote-${randomBytes(8).toString("hex")}`);
  const script = atomicWriteScript(directory, tmp, target);
  const wrapped = mode === "danger-full-access" ? script : fileCommand(status, mode, roots, script);
  const result = await hostApi.pool.exec(host, secret, wrapped, 2e4, signal, content);
  if (result.code !== 0) throw new Error(result.stderr || "remote write failed");
}
function throwIfAborted(signal) {
  if (signal?.aborted === true) throw abortError();
}
var SEARCH_BEGIN = "__DSH_SEARCH_BEGIN__";
var SEARCH_END = "__DSH_SEARCH_END__";
function withSearchMarkers(body) {
  return `printf '%s\\n' '${SEARCH_BEGIN}'; ${body}; status=$?; printf '%s\\n' '${SEARCH_END}'; exit $status`;
}
function searchOutputLines(stdout) {
  return outputBlock(stdout, SEARCH_BEGIN, SEARCH_END).map((line) => line.trim()).filter((line) => line.length > 0);
}
function throwIfRgFailed(result, signal, label) {
  if (signal?.aborted === true) throw abortError();
  if (result.code !== 0 && result.code !== 1) throw new Error(result.stderr || `${label} failed`);
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
    const detach = () => signal.removeEventListener("abort", fail);
    work.then(resolve, reject).then(detach, detach);
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

// src/ops.ts
import { randomBytes as randomBytes2 } from "node:crypto";
import { posix as posix5 } from "node:path";
import { sandboxDenialMarker as sandboxDenialMarker2 } from "@deepseek-ai/dsh-sandbox";
var READ_CAP2 = 1024 * 1024;
var NOT_FOUND2 = /no such file|cannot find|not found|does not exist/i;
var HOME_BEGIN = "__DSH_OPS_HOME_BEGIN__";
var HOME_END = "__DSH_OPS_HOME_END__";
function resolveOpsHost(hosts, selector) {
  const query = selector.trim();
  if (query.length === 0) throw new Error("ssh host is required; call ssh_hosts for the configured hosts");
  const byId = hosts.find((item) => item.id === query);
  if (byId !== void 0) return byId;
  const byName = hosts.filter((item) => item.name.trim().length > 0 && item.name.trim().toLowerCase() === query.toLowerCase());
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) throw new Error(`SSH host name "${query}" is ambiguous; use one of: ${byName.map((item) => item.id).join(", ")}`);
  const byAddress = hosts.filter((item) => item.host === query);
  if (byAddress.length === 1) return byAddress[0];
  if (byAddress.length > 1) throw new Error(`SSH address "${query}" matches several hosts; use one of: ${byAddress.map((item) => item.id).join(", ")}`);
  throw new Error(`unknown SSH host "${query}"; call ssh_hosts for the configured hosts`);
}
function hostLabel(host) {
  return host.name.trim().length > 0 ? `${host.name} (${host.host})` : host.host;
}
function hostSubject(host, action) {
  const name2 = host.name.trim().length > 0 ? `"${host.name}"` : "";
  return name2.length > 0 ? `${action} on SSH host ${name2}` : `${action} on SSH host ${host.host}`;
}
function opsHostView(host) {
  return {
    id: host.id,
    name: host.name,
    address: host.host,
    username: host.username,
    opsPolicy: host.opsPolicy,
    trusted: host.fingerprint.trim().length > 0
  };
}
function opsEscalationHint(subject) {
  return `[sandbox: escalation available \u2014 retry this exact ${subject} once with sandbox_permissions "danger-full-access" + justification; the approval prompt asks the user]`;
}
async function requireOps(hostApi, host, exec, args, toolName, subject, detail) {
  if (host.opsPolicy === "deny") throw new Error(`remote ops are disabled for SSH host ${hostLabel(host)}`);
  requireTrusted(host);
  if (host.opsPolicy === "trust") return;
  const requested = args.sandbox_permissions;
  if (requested !== void 0 && requested !== "danger-full-access") {
    const standing = await hostApi.resolveMode(exec, void 0, void 0, toolName, subject);
    if (standing === "danger-full-access") return;
    throw new Error(`${sandboxDenialMarker2(standing)}
${opsEscalationHint(subject)}`);
  }
  const mode = await hostApi.resolveMode(exec, requested, args.justification, toolName, subject, detail);
  if (mode === "danger-full-access") return;
  throw new Error(`${sandboxDenialMarker2(mode)}
${opsEscalationHint(subject)}`);
}
function requireTrusted(host) {
  if (host.fingerprint.trim().length > 0) return;
  throw new Error(`SSH host ${hostLabel(host)} is not trusted yet; open Settings \u2192 SSH hosts, test the connection, and trust its fingerprint first`);
}
function clip(text, max = 160) {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}\u2026`;
}
async function runSshExec(hostApi, host, args, exec) {
  const command = String(args.command ?? "");
  if (command.trim().length === 0) throw new Error("command is required");
  const workdir = typeof args.workdir === "string" ? args.workdir.trim() : "";
  if (workdir.length > 0 && !posix5.isAbsolute(workdir)) throw new Error(`workdir must be an absolute remote path: ${workdir}`);
  const where = workdir.length > 0 ? ` (workdir ${clip(workdir, 80)})` : "";
  await requireOps(
    hostApi,
    host,
    exec,
    args,
    "ssh_exec",
    hostSubject(host, "remote command"),
    {
      en: `command on ${hostLabel(host)}: ${clip(command)}${where}`,
      zh: `\u5728 ${hostLabel(host)} \u4E0A\u6267\u884C\uFF1A${clip(command)}${where}`
    }
  );
  const secret = await hostApi.secretOf(host);
  const timeoutMs = typeof args.timeoutMs === "number" && args.timeoutMs > 0 ? args.timeoutMs : 6e4;
  throwIfAborted(exec.signal);
  const inner = shJoin(["bash", "-lc", command]);
  const wrapped = workdir.length > 0 ? `cd ${shJoin([workdir])} && ${inner}` : inner;
  const result = await hostApi.pool.exec(host, secret, wrapped, timeoutMs, exec.signal);
  return {
    kind: "foreground",
    host: opsHostView(host),
    workdir: workdir.length > 0 ? workdir : null,
    exitCode: result.timedOut ? null : result.code,
    signal: result.signal,
    timedOut: result.timedOut,
    aborted: exec.signal?.aborted === true,
    timeoutMs,
    stdout: { text: capturedText(result.stdout, result.stdoutTruncated), truncated: result.stdoutTruncated },
    stderr: { text: capturedText(result.stderr, result.stderrTruncated), truncated: result.stderrTruncated }
  };
}
function renderOpsExec(value) {
  const host = value.host;
  const label = host === void 0 ? "remote host" : host.name || host.address;
  const stdout = value.stdout?.text ?? "";
  const stderr = value.stderr?.text ?? "";
  const status = value.timedOut === true ? "timed out" : `exit code: ${value.exitCode ?? "null"}`;
  const parts = [];
  if (stdout.length > 0) parts.push(stdout);
  if (stderr.length > 0) parts.push(`[stderr]
${stderr}`);
  const body = parts.join("\n");
  return body.length === 0 ? `[${label}: ${status}]` : `${body}
[${label}: ${status}]`;
}
async function runSshRead(hostApi, host, args, exec) {
  if (host.opsPolicy === "deny") throw new Error(`remote ops are disabled for SSH host ${hostLabel(host)}`);
  requireTrusted(host);
  throwIfAborted(exec?.signal);
  const secret = await hostApi.secretOf(host);
  const remotePath = await resolveOpsPath(hostApi, host, secret, String(args.file_path ?? ""));
  const bytes = await withSignal(hostApi.pool.sftpRead(host, secret, remotePath, READ_CAP2), exec?.signal);
  const text = bytes.toString("utf8");
  const all = text.split(/\n/);
  const offset = typeof args.offset === "number" && args.offset > 0 ? Math.floor(args.offset) : 1;
  const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 2e3;
  const slice = all.slice(offset - 1, offset - 1 + limit);
  return {
    host: opsHostView(host),
    path: remotePath,
    offset,
    lines: slice.map((line, index) => ({ number: offset + index, text: line })),
    totalLines: all.length
  };
}
function renderOpsRead(value) {
  const lines = Array.isArray(value.lines) ? value.lines : [];
  const total = typeof value.totalLines === "number" ? value.totalLines : lines.length;
  const body = lines.map((line) => `${line.number}|${line.text}`).join("\n");
  const first = lines[0]?.number;
  const last = lines[lines.length - 1]?.number;
  const span = first === void 0 || last === void 0 ? "none" : `${first}-${last}`;
  const more = last !== void 0 && last < total;
  const page = `lines ${span} of ${total}${more ? "; more lines follow" : ""}`;
  return body.length === 0 ? page : `${body}
${page}`;
}
async function runSshWrite(hostApi, host, args, exec) {
  const requestedRaw = String(args.file_path ?? "").trim();
  if (requestedRaw.length === 0) throw new Error("file_path is required");
  const content = String(args.content ?? "");
  await requireOps(
    hostApi,
    host,
    exec,
    args,
    "ssh_write",
    hostSubject(host, "remote file write"),
    {
      en: `write ${clip(requestedRaw)} on ${hostLabel(host)}`,
      zh: `\u5728 ${hostLabel(host)} \u4E0A\u5199\u5165 ${clip(requestedRaw)}`
    }
  );
  const secret = await hostApi.secretOf(host);
  const requested = await resolveOpsPath(hostApi, host, secret, requestedRaw);
  const target = await resolveCreatedPath(hostApi.pool, host, secret, requested);
  throwIfAborted(exec.signal);
  let before = null;
  let mode;
  try {
    const info = await withSignal(hostApi.pool.sftpStat(host, secret, target), exec.signal);
    if (info.isDirectory) throw new Error(`remote path is a directory: ${target}`);
    mode = info.mode;
    before = (await withSignal(hostApi.pool.sftpRead(host, secret, target, READ_CAP2), exec.signal)).toString("utf8");
  } catch (error) {
    if (exec.signal?.aborted === true || error instanceof Error && error.name === "AbortError") throw error;
    if (!isRemoteMissing(error)) throw error;
    before = null;
    mode = void 0;
  }
  const directory = posix5.dirname(target);
  const tmp = posix5.join(directory, `.dsh-permission-remote-${randomBytes2(8).toString("hex")}`);
  const result = await hostApi.pool.exec(host, secret, atomicWriteScript(directory, tmp, target, mode), 2e4, exec.signal, content);
  if (result.code !== 0) throw new Error(result.stderr || "remote write failed");
  return {
    host: opsHostView(host),
    path: target,
    operation: before === null ? "create" : "update",
    before,
    after: content
  };
}
function isRemoteMissing(error) {
  return error instanceof Error && NOT_FOUND2.test(error.message);
}
async function resolveOpsPath(hostApi, host, secret, requested) {
  const path2 = requested.trim();
  if (path2.length === 0) throw new Error("file_path is required");
  if (posix5.isAbsolute(path2)) return posix5.normalize(path2);
  if (path2 === "~") return remoteHome(hostApi, host, secret);
  if (path2.startsWith("~/")) {
    const home = await remoteHome(hostApi, host, secret);
    return posix5.normalize(posix5.join(home, path2.slice(2)));
  }
  throw new Error(`file_path must be an absolute remote path or start with "~/": ${requested}`);
}
var homes = /* @__PURE__ */ new Map();
function forgetOpsHost(hostId) {
  homes.delete(hostId);
}
async function remoteHome(hostApi, host, secret) {
  const cached = homes.get(host.id);
  if (cached !== void 0) return cached;
  const pending = (async () => {
    const command = `printf '%s\\n' ${shJoin([HOME_BEGIN])} "$HOME" ${shJoin([HOME_END])}`;
    const result = await hostApi.pool.exec(host, secret, command, 1e4);
    const home = result.code === 0 ? parseRemoteHome(result.stdout) : void 0;
    if (home === void 0) throw new Error('cannot resolve "~": the remote home directory is unknown');
    return home;
  })();
  homes.set(host.id, pending);
  pending.catch(() => {
    if (homes.get(host.id) === pending) homes.delete(host.id);
  });
  return pending;
}
function parseRemoteHome(stdout) {
  const lines = stdout.split(/\r?\n/);
  for (let index = 0; index < lines.length - 2; index += 1) {
    if (lines[index] !== HOME_BEGIN || lines[index + 2] !== HOME_END) continue;
    const home = lines[index + 1] ?? "";
    if (posix5.isAbsolute(home)) return home;
  }
  return void 0;
}

// src/shell-surface.ts
var WINDOWS_SHELLS = ["pwsh", "powershell", "cmd"];
var WINDOWS_SHELL_NAMES = new Set(WINDOWS_SHELLS);
var PWSH_SECTION = "tool:pwsh";
var REMOTE_POSIX_SECTION = "remote-posix-shell";
var WINDOWS_SHELL_DENIED = "pwsh, powershell, and cmd run on the Windows machine where DSH is running, not on this remote workspace. Use bash.";
var REMOTE_POSIX_PROMPT = "This workspace is a POSIX host reached over SSH. The bash tool runs on that host: write commands with Linux paths and Bash syntax. Do not use PowerShell or cmd. File-tool arguments may keep the placeholder paths those tools already return. Skills, MCP tools, and custom tools registered on this computer may still run locally.";
function isWindowsShell(name2) {
  return WINDOWS_SHELL_NAMES.has(name2);
}
function isUnknownRestrictError(error) {
  return error instanceof Error && error.message.includes("unknown global tool");
}
function shellSurfacePlan(route, hasOfficialBash) {
  if (route.kind !== "remote") {
    return { remote: false, deny: [], shadowPwshPrompt: false, bashFallback: false };
  }
  return {
    remote: true,
    deny: WINDOWS_SHELLS,
    shadowPwshPrompt: true,
    bashFallback: !hasOfficialBash
  };
}
function sameShellSurface(left, right) {
  return left.remote === right.remote && left.shadowPwshPrompt === right.shadowPwshPrompt && left.bashFallback === right.bashFallback && left.deny.length === right.deny.length && left.deny.every((name2, index) => name2 === right.deny[index]);
}
function remotePosixPrompt(remote) {
  return remote ? REMOTE_POSIX_PROMPT : "";
}
function windowsShellGuardReason(remote) {
  return remote ? WINDOWS_SHELL_DENIED : void 0;
}
function withoutWindowsShells(tools, remote) {
  if (!remote) return tools;
  return tools.filter((tool) => !isWindowsShell(tool.name));
}

// src/shadow.ts
var ROUTED_TOOLS = ["bash", "read", "write", "edit", "read_image", "glob", "grep", "working_directory", "terminal_open"];
var TERMINAL_OPEN_REFUSED = "terminal_open is not available in a remote workspace: the local PTY backend would open a shell on this computer, not on the SSH host. Use bash for a one-shot command, or open the sidebar terminal (it connects to the remote host) for an interactive shell.";
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

// src/sidebar-terminal.ts
import { mkdir as mkdir2 } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { symbols } from "@deepseek-ai/cordis";
var WINDOWS_SHELLS2 = /* @__PURE__ */ new Set(["cmd", "powershell", "pwsh"]);
var LOGIN_SHELLS = /* @__PURE__ */ new Set(["bash", "zsh", "fish"]);
var nextPid = 1;
function isSidebarTerminal(spec) {
  return spec.terminalType === "xterm-256color" && spec.shellActivity === true;
}
function sidebarCommand(remoteCwd, argv) {
  return `cd ${shQuote(remoteCwd)} && exec ${shJoin(argv)}`;
}
function shellKind(path2) {
  const base = path2.slice(Math.max(path2.lastIndexOf("/"), path2.lastIndexOf("\\")) + 1);
  return base.toLowerCase().replace(/\.exe$/u, "");
}
function shellArgs(kind) {
  if (WINDOWS_SHELLS2.has(kind)) return [];
  if (kind === "sh" || kind === "dash") return ["-i"];
  if (LOGIN_SHELLS.has(kind)) return ["-l", "-i"];
  return ["-i"];
}
function shellProbeCommand(candidates) {
  const checks = candidates.filter((candidate) => !WINDOWS_SHELLS2.has(shellKind(candidate))).map((candidate) => {
    const quoted = shQuote(candidate);
    return `p=$(command -v ${quoted} 2>/dev/null) || true; if [ -n "$p" ]; then printf 'HAVE %s\\n' "$p"; fi`;
  });
  return [`printf 'SHELL %s\\n' "$SHELL"`, ...checks].join("; ");
}
function parseShellProbe(text, label) {
  const shells = [];
  const seen = /* @__PURE__ */ new Set();
  const add = (path2) => {
    if (!path2.startsWith("/")) return;
    const kind = shellKind(path2);
    if (kind.length === 0 || WINDOWS_SHELLS2.has(kind) || seen.has(kind)) return;
    seen.add(kind);
    shells.push({ path: path2, name: `${label} \xB7 ${kind}`, args: shellArgs(kind) });
  };
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("SHELL ")) add(trimmed.slice("SHELL ".length).trim());
    else if (trimmed.startsWith("HAVE ")) add(trimmed.slice("HAVE ".length).trim());
  }
  return shells;
}
function installSidebarBridge(ctx, core) {
  const terminalService = ctx.get("terminalController");
  const subprocessService = ctx.get("subprocess");
  const directoryService = ctx.get("workingDirectory");
  if (terminalService == null || subprocessService == null || directoryService == null) {
    ctx.logger?.warn("[@dsh-permission-remote] sidebar bridge is missing terminalController, subprocess, or workingDirectory");
    return void 0;
  }
  const terminal = unwrap(terminalService);
  const subprocess = unwrap(subprocessService);
  const directories = directoryService;
  if (Object.hasOwn(subprocess, "spawnTerminal") || Object.hasOwn(terminal, "shells") || Object.hasOwn(terminal, "create") || Object.hasOwn(terminal, "spawn")) {
    ctx.logger?.warn("[@dsh-permission-remote] sidebar bridge already installed");
    return void 0;
  }
  const originalSpawn = subprocess.spawnTerminal.bind(subprocess);
  const originalShells = terminal.shells.bind(terminal);
  const originalCreate = terminal.create.bind(terminal);
  const spawnSession = terminal.spawn;
  const originalSessionSpawn = typeof spawnSession === "function" ? spawnSession.bind(terminal) : void 0;
  subprocess.spawnTerminal = async (spec) => {
    if (!isSidebarTerminal(spec)) return originalSpawn(spec);
    const route = routeByCwd(spec.cwd);
    if (route.kind !== "remote") return originalSpawn(spec);
    return openRemoteTerminal(core, route, spec);
  };
  terminal.shells = async (agent, signal) => {
    signal.throwIfAborted();
    const route = sessionRoute(directories, agent);
    if (route === void 0) return originalShells(agent, signal);
    return core.loadShells(route.hostId, shellCandidatesOf(terminal));
  };
  terminal.create = async (agent, request, signal) => {
    const route = sessionRoute(directories, agent);
    if (route !== void 0 && typeof request.shellPath === "string" && request.shellPath.length > 0) {
      const shells = await terminal.shells(agent, signal);
      if (!shells.some((shell) => shell.path === request.shellPath)) {
        const fallback = shells[0];
        if (fallback === void 0) throw new Error("no interactive shell found on the remote host");
        request = { ...request, shellPath: fallback.path };
      }
    }
    return originalCreate(agent, request, signal);
  };
  if (originalSessionSpawn !== void 0) {
    terminal.spawn = async (agent, owner, request, signal) => {
      await materializeRemotePlaceholder(directories, agent);
      return originalSessionSpawn(agent, owner, request, signal);
    };
  }
  return () => {
    Reflect.deleteProperty(subprocess, "spawnTerminal");
    Reflect.deleteProperty(terminal, "shells");
    Reflect.deleteProperty(terminal, "create");
    Reflect.deleteProperty(terminal, "spawn");
  };
}
async function materializeRemotePlaceholder(directories, agent) {
  if (agent.session === void 0) return;
  let cwd;
  try {
    cwd = directories.get(agent.session);
  } catch {
    return;
  }
  if (routeByCwd(cwd).kind !== "remote") return;
  await mkdir2(cwd, { recursive: true }).catch(() => void 0);
}
async function openRemoteTerminal(core, route, spec) {
  if (spec.argv.length === 0) throw new Error("sidebar terminal is missing a shell");
  const host = core.requireHost(route.hostId);
  const opened = await core.pool.openPty(host, await core.secret(host), {
    command: sidebarCommand(route.remoteCwd, spec.argv),
    term: spec.terminalType,
    cols: spec.cols,
    rows: spec.rows,
    signal: spec.signal
  });
  return new SshTerminalHandle(opened.channel, opened.onTransportClosed);
}
function sessionRoute(directories, agent) {
  if (agent.session === void 0) return void 0;
  let cwd;
  try {
    cwd = directories.get(agent.session);
  } catch {
    return void 0;
  }
  const route = routeByCwd(cwd);
  return route.kind === "remote" ? route : void 0;
}
function shellCandidatesOf(terminal) {
  const listed = terminal.config?.shellCandidates;
  if (listed === void 0 || listed.length === 0) return ["zsh", "bash", "fish", "sh"];
  return listed;
}
function unwrap(service) {
  const branded = service;
  return branded[symbols.original] ?? service;
}
var SshTerminalHandle = class {
  constructor(channel, onTransportClosed) {
    this.channel = channel;
    this.pid = nextPid;
    nextPid += 1;
    this.output = new PassThrough();
    this.done = new Promise((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
    this.stopTransport = onTransportClosed((error) => this.finish(error));
    this.output.on("drain", () => this.resume());
    channel.on("data", (chunk) => this.push(chunk));
    channel.stderr?.on("data", (chunk) => this.push(chunk));
    channel.on("close", (code, signal) => {
      this.exitCode = typeof code === "number" ? code : null;
      this.exitSignal = nodeSignal(signal);
      this.finish(null);
    });
  }
  pid;
  output;
  done;
  settled = false;
  exitCode = null;
  exitSignal = null;
  revision = 0;
  pending = /* @__PURE__ */ new Set();
  /** Writes blocked on `drain`. A dead connection must release them or `terminate` never returns. */
  wakeups = [];
  /** The channel is paused because the screen consumer is behind. */
  paused = false;
  stopTransport = () => void 0;
  resolveDone = () => void 0;
  rejectDone = () => void 0;
  write(data) {
    return this.track(new Promise((resolve, reject) => {
      if (this.settled) {
        reject(new Error("terminal is closed"));
        return;
      }
      this.revision += 1;
      let accepted = true;
      try {
        accepted = this.channel.write(data);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (accepted !== false || this.channel.once === void 0) {
        resolve();
        return;
      }
      let finished = false;
      const settle = (error) => {
        if (finished) return;
        finished = true;
        if (error === void 0) resolve();
        else reject(error);
      };
      this.channel.once("drain", () => settle());
      this.wakeups.push(() => settle(new Error("terminal is closed")));
      if (this.settled) settle(new Error("terminal is closed"));
    }));
  }
  resize(cols, rows) {
    return this.track(Promise.resolve().then(() => {
      if (this.settled) throw new Error("terminal is closed");
      this.revision += 1;
      this.channel.setWindow(rows, cols, 0, 0);
    }));
  }
  inspectForeground() {
    return Promise.resolve(void 0);
  }
  inspectActivity() {
    return Promise.resolve({ state: "unknown", revision: this.revision });
  }
  signalForeground(signal) {
    return this.track(Promise.resolve().then(() => {
      if (this.settled) throw new Error("terminal is closed");
      this.channel.signal(signal);
      return this.pid;
    }));
  }
  /**
   * Close the channel first, then wait for in-flight calls.
   *
   * A remote program that never reads stdin (`sleep`, a stopped job, a pager)
   * leaves the channel window full, so `write` parks on `drain` indefinitely.
   * `close()` is the only thing that can release it: it ends the channel, the
   * `close` event runs `finish`, and `finish` wakes every blocked write. Waiting
   * on `pending` first would deadlock against that.
   */
  async terminate() {
    try {
      this.channel.close();
    } catch (error) {
      this.finish(error instanceof Error ? error : new Error(String(error)));
    }
    await Promise.allSettled([...this.pending]);
    await this.done.then(() => void 0, () => void 0);
  }
  /**
   * Forward bytes, pausing the channel while the screen consumer is behind.
   *
   * `output` is read by the controller's headless emulator. A `PassThrough`
   * nobody drains would buffer without bound — one `yes` or `journalctl -f`
   * fills it in seconds — so the channel is paused until `drain`, exactly as the
   * local provider does.
   */
  push(chunk) {
    if (this.settled || this.output.writableEnded) return;
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (!this.output.write(bytes) && !this.paused && !this.settled) {
      this.paused = true;
      this.channel.pause?.();
    }
  }
  resume() {
    if (!this.paused) return;
    this.paused = false;
    if (!this.settled) this.channel.resume?.();
  }
  track(work) {
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work)).catch(() => void 0);
    return work;
  }
  /** End the screen stream first, then settle `done`, exactly once. */
  finish(error) {
    if (this.settled) return;
    this.settled = true;
    this.stopTransport();
    if (!this.output.writableEnded) this.output.end();
    const wakeups = this.wakeups.splice(0);
    for (const wake of wakeups) wake();
    if (error === null) this.resolveDone({ exitCode: this.exitCode, signal: this.exitSignal });
    else this.rejectDone(error);
  }
};
function nodeSignal(signal) {
  if (signal == null || signal.length === 0) return null;
  const name2 = signal.startsWith("SIG") ? signal : `SIG${signal}`;
  if (!/^SIG[A-Z0-9]+$/u.test(name2)) return null;
  return name2;
}

// src/ssh-pool.ts
import { readFile } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

// src/ssh2-client.ts
import { createRequire as createRequire2 } from "node:module";
var require3 = createRequire2(import.meta.url);
var ssh2 = require3("../vendor/ssh2/lib/index.js");
var Client = ssh2.Client;

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
function takeChannelText(decoder, chunk) {
  return decoder.write(chunk);
}
function truncationMarker(noted) {
  if (noted.current) return "";
  noted.current = true;
  return "\n[output truncated]";
}
function settleThen(work, cleanup) {
  const run = () => {
    try {
      cleanup();
    } catch {
    }
  };
  void work.then(run, run);
}
var SSH_KEEPALIVE_INTERVAL_MS = 15e3;
function sshConnectOptions(host) {
  return {
    host: host.host,
    port: host.port,
    username: host.username,
    readyTimeout: 2e4,
    keepaliveInterval: SSH_KEEPALIVE_INTERVAL_MS,
    hostHash: "sha256"
  };
}
var SshFailure = class extends Error {
  constructor(message, stage) {
    super(message);
    this.stage = stage;
    this.name = "SshFailure";
  }
};
function isRetryableOpenFailure(error) {
  if (!(error instanceof SshFailure) || error.stage !== "exec") return false;
  return /no response from server|not connected|connection lost/i.test(error.message);
}
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
    const queued = this.waiters.splice(0);
    for (const next of queued) next();
    for (const item of pending) {
      try {
        const live = await item;
        live.markDead();
        await closeLive(live);
      } catch {
      }
    }
  }
  invalidate(hostId) {
    void this.dropSession(hostId);
  }
  /**
   * Close one cached session and wait until its connection slot is free.
   *
   * `reserve` blocks once `maxConnections` is reached, so a retry that opens a
   * new session before the old one releases would wait on itself forever.
   */
  async dropSession(hostId) {
    const current = this.live.get(hostId);
    this.live.delete(hostId);
    if (current === void 0) return;
    try {
      const live = await current;
      live.markDead();
      await closeLive(live);
    } catch {
    }
  }
  /** Whether a session is cached for this host id. Diagnostics and tests only. */
  hasSession(hostId) {
    return this.live.has(hostId);
  }
  /**
   * Open one PTY channel on the host's pooled connection. The connection stays
   * up when the shell exits; `dispose` and `invalidate` close it.
   */
  async openPty(host, secret, request) {
    if (request.signal?.aborted) throw new SshFailure("pty allocation aborted", "pty");
    const live = await this.acquire(host, secret, true);
    if (request.signal?.aborted) throw new SshFailure("pty allocation aborted", "pty");
    const channel = await execPty(live.client, request);
    if (request.signal?.aborted) {
      try {
        channel.close();
      } catch {
      }
      throw new SshFailure("pty allocation aborted", "pty");
    }
    return {
      channel,
      onTransportClosed(listener) {
        const onError = (error) => listener(error instanceof Error ? error : new SshFailure(String(error), "pty"));
        const onClose = () => listener(new SshFailure("SSH connection closed", "pty"));
        live.client.on("error", onError);
        live.client.on("close", onClose);
        return () => {
          live.client.off("error", onError);
          live.client.off("close", onClose);
        };
      }
    };
  }
  async exec(host, secret, command, timeoutMs, signal, stdin, onOutput) {
    const commandHandle = await this.open(host, secret, command, timeoutMs, signal, stdin, onOutput);
    try {
      return await commandHandle.done;
    } catch (error) {
      if (signal?.aborted === true || !isRetryableOpenFailure(error)) throw error;
      await this.dropSession(host.id);
      const retried = await this.open(host, secret, command, timeoutMs, signal, stdin, onOutput);
      return retried.done;
    }
  }
  /** `timeoutMs` of 0 waits until the command exits, the signal aborts, or `close` kills its channel. */
  async open(host, secret, command, timeoutMs, signal, stdin, onOutput) {
    const live = await this.acquire(host, secret, true);
    const commandHandle = openChannel(live.client, command, timeoutMs, stdin, onOutput);
    if (signal !== void 0) {
      const abort = () => commandHandle.close();
      if (signal.aborted) commandHandle.close();
      else signal.addEventListener("abort", abort, { once: true });
      settleThen(commandHandle.done, () => signal.removeEventListener("abort", abort));
    }
    return commandHandle;
  }
  /** Connect far enough to read the host key. Does not persist trust. */
  async offerFingerprint(host, secret) {
    const stored = host.fingerprint.trim();
    let offered = "";
    let live;
    try {
      live = await connect(host, secret, (key) => {
        offered = formatFingerprint(key);
        return stored.length > 0 && offered === stored;
      });
      const banner = await openChannel(live, "echo ok", 15e3).done;
      return { fingerprint: stored, trusted: true, banner: banner.stdout.trim() };
    } catch (error) {
      if (offered.length > 0 && offered !== stored) {
        return { fingerprint: offered, trusted: false, banner: "" };
      }
      throw error;
    } finally {
      live?.end();
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
        const live = {
          client,
          hostId: host.id,
          markDead: () => drop()
        };
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
    client.on("error", () => void 0);
    const options = {
      ...sshConnectOptions(host),
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
function exitFields(cause, code, signal) {
  if (cause !== "exit") return { code: null, signal: "KILL" };
  return { code: code ?? null, signal: signal ?? null };
}
var SESSION_TABLE_FULL = /channel open failure:\s*open failed/i;
function channelLimitMessage(error) {
  if (!(error instanceof Error) || !SESSION_TABLE_FULL.test(error.message)) return void 0;
  return new SshFailure(
    "this host refused another SSH session. File transfer and remote commands share this connection, so closing a sidebar terminal may not free a slot. Close one of those, or raise MaxSessions in the remote sshd_config.",
    "pty"
  );
}
function execPty(client, request) {
  return new Promise((resolve, reject) => {
    client.exec(request.command, {
      pty: { term: request.term, cols: request.cols, rows: request.rows }
    }, (error, stream) => {
      if (error) {
        reject(channelLimitMessage(error) ?? new SshFailure(error.message, "pty"));
        return;
      }
      resolve(stream);
    });
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
  const decoders = {
    stdout: new StringDecoder("utf8"),
    stderr: new StringDecoder("utf8")
  };
  const decoderEnded = { stdout: false, stderr: false };
  const truncationNoted = { current: false };
  const emit = (which, text) => {
    if (text.length === 0 || onOutput === void 0) return;
    try {
      onOutput({ stream: which, text });
    } catch {
    }
  };
  const flushDecoder = (which) => {
    if (decoderEnded[which]) return;
    decoderEnded[which] = true;
    emit(which, decoders[which].end());
  };
  const markTruncation = (which) => {
    flushDecoder(which);
    emit(which, truncationMarker(truncationNoted));
  };
  const finish = (code, signal) => {
    if (settled) return;
    settled = true;
    flushDecoder("stdout");
    flushDecoder("stderr");
    clearTimeout(timer);
    clearTimeout(fallback);
    resolveDone({
      ...exitFields(cause, code, signal),
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
  try {
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
      const push = (target, chunk, which) => {
        const used = target.reduce((sum, part) => sum + part.length, 0);
        const room = OUTPUT_CAP - used;
        if (room <= 0) {
          if (which === "stdout") stdoutTruncated = true;
          else stderrTruncated = true;
          markTruncation(which);
          stop("truncate");
          return;
        }
        const kept = Buffer.from(chunk.subarray(0, Math.min(chunk.length, room)));
        target.push(kept);
        emit(which, takeChannelText(decoders[which], kept));
        if (kept.length < chunk.length) {
          if (which === "stdout") stdoutTruncated = true;
          else stderrTruncated = true;
          markTruncation(which);
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
  } catch (error) {
    settled = true;
    clearTimeout(timer);
    clearTimeout(fallback);
    rejectDone(error instanceof Error ? new SshFailure(error.message, "exec") : new SshFailure(String(error), "exec"));
  }
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
      api.on("error", () => void 0);
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
      else resolve({ isDirectory: stats.isDirectory(), size: stats.size, mode: typeof stats.mode === "number" ? stats.mode : void 0 });
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

// src/workspaces.ts
import { realpathSync } from "node:fs";
import { posix as posix6 } from "node:path";
function hostTag(host) {
  const name2 = host.name.trim();
  return name2.length > 0 ? name2 : host.host;
}
function titlePrefix(host) {
  return `${hostTag(host)} \xB7 `;
}
function taggedTitle(host, title) {
  const prefix = titlePrefix(host);
  const current = title.trim();
  if (current.startsWith(prefix)) return title;
  if (current.length === 0) return hostTag(host);
  return `${prefix}${current}`;
}
function stripKnownPrefix(title, hosts) {
  const current = title.trim();
  for (const host of hosts) {
    const prefix = titlePrefix(host);
    if (current.startsWith(prefix) && current.length > prefix.length) return current.slice(prefix.length);
  }
  return title;
}
function retaggedTitle(host, previousTag, title) {
  const previousPrefix = `${previousTag} \xB7 `;
  const current = title.trim();
  if (!current.startsWith(previousPrefix)) return title;
  return `${titlePrefix(host)}${current.slice(previousPrefix.length)}`;
}
function autoTaggedTitle(host, remotePath, title) {
  const current = title.trim();
  if (current.length === 0) return taggedTitle(host, title);
  const base = posix6.basename(remotePath.replace(/\/+$/, "")) || remotePath;
  if (current === base) return taggedTitle(host, title);
  return title;
}
function candidateRoots(env) {
  const root = remoteRoot(env);
  const roots = [root];
  try {
    const real = realpathSync(root);
    if (real !== root) roots.push(real);
  } catch {
  }
  return roots;
}
function workspaceRoute(workspacePath, env = process.env) {
  for (const root of candidateRoots(env)) {
    const route = routeByCwd(workspacePath, { ...env, DSH_SSH_REMOTE_ROOT: root });
    if (route.kind === "remote") return { hostId: route.hostId, remotePath: route.remoteCwd };
  }
  return null;
}
function remoteWorkspaces(workspaces, env = process.env) {
  const items = [];
  for (const workspace of workspaces) {
    const route = workspaceRoute(workspace.path, env);
    if (route === null) continue;
    items.push({
      hostId: route.hostId,
      workspaceId: String(workspace.id),
      title: workspace.title,
      remotePath: route.remotePath,
      placeholderPath: workspace.path,
      sessions: workspace.sessionIds.length,
      createdAt: workspace.createdAt
    });
  }
  return items;
}
function createdWorkspaceTitle(host, requested, enabled) {
  return enabled ? taggedTitle(host, requested) : requested;
}
function requestedHostTitle(host, title, known) {
  return taggedTitle(host, stripKnownPrefix(title, known));
}
async function tagRemoteWorkspaces(hosts, workspaces, options = {}, env = process.env) {
  const byId = new Map(hosts.map((host) => [host.id, host]));
  const known = options.knownHosts ?? hosts;
  const onlyHost = textOrUndefined(options.hostId);
  const onlyWorkspace = textOrUndefined(options.workspaceId);
  const previousTag = textOrUndefined(options.previousTag);
  let changed = 0;
  for (const workspace of workspaces) {
    if (onlyWorkspace !== void 0 && String(workspace.id) !== onlyWorkspace) continue;
    const route = workspaceRoute(workspace.path, env);
    if (route === null) continue;
    if (onlyHost !== void 0 && route.hostId !== onlyHost) continue;
    const host = byId.get(route.hostId);
    if (host === void 0) continue;
    const explicit = onlyWorkspace !== void 0 || onlyHost !== void 0 && previousTag === void 0;
    const next = previousTag !== void 0 ? retaggedTitle(host, previousTag, workspace.title) : explicit ? requestedHostTitle(host, workspace.title, known) : autoTaggedTitle(host, route.remotePath, workspace.title);
    if (next === workspace.title) continue;
    await workspace.setTitle(next);
    changed += 1;
  }
  return changed;
}
function textOrUndefined(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : void 0;
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
  /**
   * Install bubblewrap on the remote. `ok` is the command's own exit status;
   * `sandbox.available` is the re-probe, which is what actually matters after
   * an install that reported success.
   */
  async installDeps(input) {
    const host = this.core.requireHost(input.hostId);
    const status = await this.core.probe(input.hostId);
    const result = await installBubblewrap(this.core.pool, host, await this.core.secret(host), status);
    this.core.forgetProbe(input.hostId);
    const next = await this.core.probe(input.hostId);
    return { ok: result.code === 0, code: result.code, stdout: result.stdout, stderr: result.stderr, status: next };
  }
  /**
   * Fetch a ripgrep binary for the remote platform and cache it here, so the
   * upload path works on a machine whose package manager only installed its own
   * platform package. Explicit: nothing downloads until this is called.
   */
  async installRipgrep(input) {
    const result = await this.core.installRipgrep(input.hostId);
    return { ok: true, ...result };
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
    await mkdir3(local, { recursive: true });
    const requested = input.title?.trim() || basename(input.path);
    const title = createdWorkspaceTitle(host, requested, this.core.taggingEnabled);
    const workspace = await this.core.workspaces.create(local, title);
    return { path: local, title: workspace.title };
  }
  async listWorkspaces() {
    return { items: this.core.listWorkspaces(), deleted: this.core.listDeletedHosts() };
  }
  async tagWorkspaces(input) {
    const changed = await this.core.tagWorkspaces(textOrUndefined(input.hostId), textOrUndefined(input.workspaceId));
    return { items: this.core.listWorkspaces(), deleted: this.core.listDeletedHosts(), changed };
  }
  async removeWorkspace(input) {
    return { ok: await this.core.removeWorkspace(input.hostId, input.workspaceId) };
  }
  /** Forget a deleted host completely, unregistering its workspaces. */
  async purgeHost(input) {
    const result = await this.core.purgeHost(input.hostId);
    return { ok: true, workspaces: result.workspaces };
  }
  async restoreHost(input) {
    await this.core.restoreHost(input.hostId);
    return { ok: true };
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
  shellLists = /* @__PURE__ */ new Map();
  listWorkspaces() {
    return remoteWorkspaces(this.workspaces.list());
  }
  /** Whether workspace titles carry the server name. */
  get taggingEnabled() {
    return this.config.tagWorkspaceTitles;
  }
  /** Hosts the operator removed, newest first. */
  listDeletedHosts() {
    return this.config.deletedHosts.map((row) => ({
      id: row.host.id,
      name: row.host.name.trim() || row.host.host,
      address: row.host.host,
      username: row.host.username,
      port: row.host.port,
      deletedAt: row.deletedAt
    }));
  }
  async restoreHost(hostId) {
    assertHostId(hostId);
    if (this.config.hosts.some((item) => item.id === hostId)) throw new Error(`SSH host ${hostId} is already configured`);
    const row = this.config.deletedHosts.find((item) => item.host.id === hostId);
    if (row === void 0) throw new Error(`SSH host ${hostId} cannot be restored; add it again`);
    this.config.hosts = [...this.config.hosts, { ...row.host }];
    this.config.deletedHosts = this.config.deletedHosts.filter((item) => item.host.id !== hostId);
    this.pool.invalidate(hostId);
    this.status.delete(hostId);
    forgetOpsHost(hostId);
    await this.persistHosts();
  }
  /**
   * Drop the tombstone and unregister every workspace left under that host.
   *
   * The workspaces must go too: they resolve through a host id that would no
   * longer exist anywhere, so they could never be opened or deleted again.
   * Remote files are not touched.
   */
  async purgeHost(hostId) {
    assertHostId(hostId);
    if (this.config.hosts.some((item) => item.id === hostId)) {
      throw new Error(`SSH host ${hostId} is still configured; remove it from the list first`);
    }
    const tombstone = this.config.deletedHosts.some((item) => item.host.id === hostId);
    const owned = this.listWorkspaces().filter((item) => item.hostId === hostId);
    if (!tombstone && owned.length === 0) {
      throw new Error(`SSH host ${hostId} is not in the deleted list`);
    }
    let removed = 0;
    for (const workspace of owned) {
      if (await this.workspaces.delete(workspace.workspaceId)) removed += 1;
    }
    if (tombstone) {
      this.config.deletedHosts = this.config.deletedHosts.filter((item) => item.host.id !== hostId);
      await this.persistHosts();
    }
    this.pool.invalidate(hostId);
    this.status.delete(hostId);
    forgetOpsHost(hostId);
    return { workspaces: removed };
  }
  /**
   * Remove one workspace registration. Unknown ids and ids that belong to a
   * different host fail instead of reporting a success that did nothing.
   */
  async removeWorkspace(hostId, workspaceId) {
    const row = this.listWorkspaces().find((item) => item.workspaceId === workspaceId);
    if (row === void 0) return false;
    if (row.hostId !== hostId) throw new Error(`workspace ${workspaceId} does not belong to SSH host ${hostId}`);
    return this.workspaces.delete(workspaceId);
  }
  async tagWorkspaces(hostId, workspaceId, previousTag) {
    const known = [...this.config.hosts, ...this.config.deletedHosts.map((row) => row.host)];
    return tagRemoteWorkspaces(this.config.hosts, this.workspaces.list(), { hostId, workspaceId, previousTag, knownHosts: known });
  }
  /**
   * On every load, prefix a title that is empty or still exactly the remote
   * directory's name. A title the operator changed stays. A title set back to
   * that directory name is prefixed again, because it is indistinguishable
   * from a workspace that was never tagged.
   */
  async autoTagWorkspaces() {
    if (!this.config.tagWorkspaceTitles) return;
    const changed = await this.tagWorkspaces();
    if (changed > 0) this.ctx.logger?.info(`[@dsh-permission-remote] tagged ${changed} workspace title(s) with their SSH host`);
  }
  requireHost(hostId) {
    const host = this.config.hosts.find((item) => item.id === hostId);
    if (host === void 0) throw new Error(`unknown SSH host ${hostId}`);
    return host;
  }
  /** Ops tools let the model name a host by id, name, or address. */
  requireOpsHost(selector) {
    return resolveOpsHost(this.config.hosts, selector);
  }
  listHosts() {
    return this.config.hosts;
  }
  async trust(hostId, fingerprint) {
    this.requireHost(hostId);
    this.config.hosts = this.config.hosts.map((item) => item.id === hostId ? { ...item, fingerprint } : item);
    this.pool.invalidate(hostId);
    this.status.delete(hostId);
    forgetOpsHost(hostId);
    await this.persistHosts();
  }
  /**
   * Drop everything derived from a connection that no longer applies: the
   * cached probe, the pooled session, the cached remote home, and the sidebar
   * shell list. Connecting is interrupted, so an agent command running on that
   * session is killed.
   */
  forgetStatus(hostId) {
    this.status.delete(hostId);
    this.pool.invalidate(hostId);
    forgetOpsHost(hostId);
    this.forgetShells(hostId);
  }
  /** Drop the sidebar shell menu for one host. The label includes the server name. */
  forgetShells(hostId) {
    this.shellLists.delete(hostId);
  }
  /** Seed the sidebar shell list without dialing. Diagnostics and tests only. */
  primeShells(hostId, shells) {
    this.shellLists.set(hostId, Promise.resolve(shells));
  }
  /** Whether a sidebar shell list is cached. Diagnostics and tests only. */
  hasShells(hostId) {
    return this.shellLists.has(hostId);
  }
  loadShells(hostId, candidates) {
    const cached = this.shellLists.get(hostId);
    if (cached !== void 0) return cached;
    const pending = (async () => {
      const host = this.requireHost(hostId);
      const result = await this.pool.exec(host, await this.secret(host), shellProbeCommand(candidates), 2e4);
      const shells = parseShellProbe(result.stdout, hostTag(host));
      if (shells.length === 0) throw new Error(`no interactive shell found on ${hostTag(host)}`);
      return shells;
    })();
    this.shellLists.set(hostId, pending);
    pending.catch(() => {
      if (this.shellLists.get(hostId) === pending) this.shellLists.delete(hostId);
    });
    return pending;
  }
  /**
   * Forget only the cached probe result. Used after a change on the remote that
   * leaves the session valid (a package install, a new uploaded binary), so a
   * running command is not cancelled just to refresh a status line.
   */
  forgetProbe(hostId) {
    this.status.delete(hostId);
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
      return { kind: "grant", payload: grantPayload(material, previous) };
    });
    this.forgetStatus(hostId);
  }
  async saveHost(host) {
    assertHostId(host.id);
    const previous = this.config.hosts.find((item) => item.id === host.id);
    const normalized = { ...host, opsPolicy: normalizeOpsPolicy(host.opsPolicy) };
    this.config.hosts = previous === void 0 ? [...this.config.hosts, normalized] : this.config.hosts.map((item) => item.id === host.id ? normalized : item);
    if (previous !== void 0 && connectionKeyChanged(previous, normalized)) this.forgetStatus(host.id);
    else forgetOpsHost(host.id);
    this.forgetShells(normalized.id);
    await this.persistHosts();
    if (previous === void 0) return;
    const previousTag = hostTag(previous);
    const nextTag = hostTag(normalized);
    if (previousTag === nextTag) return;
    if (!this.config.tagWorkspaceTitles) return;
    await this.tagWorkspaces(normalized.id, void 0, previousTag);
  }
  async deleteHost(hostId) {
    const removed = this.config.hosts.find((item) => item.id === hostId);
    if (removed !== void 0) {
      const rows = [
        { host: removed, deletedAt: (/* @__PURE__ */ new Date()).toISOString() },
        ...this.config.deletedHosts.filter((item) => item.host.id !== hostId)
      ];
      const withWorkspaces = new Set(this.listWorkspaces().map((item) => item.hostId));
      let spare = 0;
      this.config.deletedHosts = rows.filter((row) => {
        if (withWorkspaces.has(row.host.id)) return true;
        spare += 1;
        return spare <= 20;
      });
    }
    this.config.hosts = this.config.hosts.filter((item) => item.id !== hostId);
    this.pool.invalidate(hostId);
    this.status.delete(hostId);
    forgetOpsHost(hostId);
    this.forgetShells(hostId);
    await this.persistHosts();
  }
  async persistHosts() {
    const row = this.ctx.settings.describe().find((item) => String(item.ns) === "permission-remote");
    if (row === void 0) {
      this.ctx.logger?.warn('[@dsh-permission-remote] settings row "permission-remote" is missing; the host list changed in memory but was not persisted');
      return;
    }
    await this.ctx.settings.update(String(row.ns), {
      hosts: this.config.hosts,
      deletedHosts: this.config.deletedHosts
    });
  }
  /** Fetch and cache the ripgrep binary for this host's remote platform. */
  async installRipgrep(hostId) {
    const host = this.requireHost(hostId);
    const facts = await remoteFacts(this.pool, host, await this.secret(host));
    const platform = rgPlatformOf(facts.os, facts.arch);
    if (platform === null) {
      throw new Error(`no ripgrep build for ${facts.os}/${facts.arch}; install ripgrep on the remote so rg is on PATH`);
    }
    if (facts.home.length === 0) {
      throw new Error("the remote did not report an absolute $HOME, so rg cannot be placed there; install ripgrep on the remote so rg is on PATH");
    }
    const fetched = await fetchRgBinary({ registry: this.config.rgRegistry, platform });
    await cacheRgBinary(platform, fetched.binary);
    this.forgetProbe(hostId);
    const next = await this.probe(hostId);
    return { platform, version: fetched.version, status: next };
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
function grantPayload(material, previous) {
  const password = material.password !== void 0 ? material.password : previous.password;
  const passphrase = material.passphrase !== void 0 ? material.passphrase : previous.passphrase;
  const payload = {};
  if (typeof password === "string") payload.password = password;
  if (typeof passphrase === "string") payload.passphrase = passphrase;
  return payload;
}
function markRemote(service) {
  const methods = ["testConnection", "trustFingerprint", "probe", "installDeps", "installRipgrep", "listDir", "createWorkspace", "listWorkspaces", "tagWorkspaces", "removeWorkspace", "restoreHost", "purgeHost", "saveSecret", "saveHost", "deleteHost"];
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
  }),
  // A local PTY backend would open a shell inside the placeholder directory
  // while the sidebar terminal is already on the server. Refuse instead of
  // handing the model a prompt that is not where the Session is.
  terminal_open: async () => {
    throw new Error(TERMINAL_OPEN_REFUSED);
  }
};
function apply(rawCtx, rawConfig) {
  const ctx = rawCtx;
  const core = new Core(ctx, readConfig(rawConfig), ctx.workspaceRegistry);
  const api = new SshApi(rawCtx, core);
  const unregisters = /* @__PURE__ */ new Set();
  ctx.effect(() => ctx.settings.configure({ auto: false }));
  ctx.effect(() => () => {
    const failure = settleDisposers([...unregisters]);
    unregisters.clear();
    if (failure !== void 0) {
      ctx.logger?.warn(`[@dsh-permission-remote] plugin cleanup failed: ${errorText(failure)}`);
    }
    void core.pool.dispose();
  });
  rawCtx.inject(["terminalController", "subprocess", "workingDirectory"], (bridged) => {
    const remove = installSidebarBridge(bridged, core);
    if (remove === void 0) return;
    unregisters.add(remove);
    bridged.effect(() => () => {
      remove();
      unregisters.delete(remove);
    });
  });
  void api;
  const seen = /* @__PURE__ */ new Set();
  const attach = (agent) => {
    if (seen.has(agent)) return;
    seen.add(agent);
    let installed = false;
    try {
      installed = installShadows(ctx, core, agent, unregisters, () => {
        seen.delete(agent);
      });
    } finally {
      if (!installed) seen.delete(agent);
    }
  };
  ctx.on("agent/created", ({ agent }) => attach(agent));
  const agents = ctx.get("agents");
  if (typeof agents?.list === "function") {
    for (const agent of agents.list()) attach(agent);
  }
  void core.autoTagWorkspaces().catch((error) => {
    ctx.logger?.warn(`[@dsh-permission-remote] workspace title tagging failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  ctx.logger?.info("[@dsh-permission-remote] loaded");
}
function installShadows(ctx, core, agent, unregisters, forget) {
  const headerCwd = agent.session?.header?.cwd;
  const opened = routeByCwd(effectiveCwd(ctx, { agent }, headerCwd));
  const disposers = [];
  let disposeDynamic = () => {
  };
  try {
    const plans = planShadows((name2) => agent.ctx.tools.get(name2, agent));
    const hasOfficialBash = plans.some((plan) => plan.name === "bash" && plan.official !== void 0);
    const host = core.toolHost(agent.ctx.get("jobs"));
    for (const plan of plans) {
      if (plan.official === void 0) continue;
      const official = plan.official;
      const runner = RUNNERS[plan.name];
      disposers.push(agent.ctx.tools.register(withRemoteTimeout({
        ...capturedSchema(agent.ctx.tools, plan.name, agent),
        name: plan.name,
        async execute(args, exec) {
          const current = routeByCwd(effectiveCwd(ctx, exec, headerCwd));
          if (current.kind !== "remote") {
            return dispatchShadow(official, false, async () => {
              throw new Error("dsh-permission-remote: local call has no official tool");
            }, args, exec);
          }
          return runner(host, current, args, exec, ctx);
        }
      })));
    }
    const surface = installRemoteShellSurface(ctx, agent, host, headerCwd, hasOfficialBash, disposers);
    disposeDynamic = surface.disposeDynamic;
    surface.sync(opened);
  } catch (error) {
    const cleanup = releaseShadows(disposeDynamic, disposers);
    ctx.logger?.warn(`[@dsh-permission-remote] shadow install failed for agent ${agentLabel(agent)}: ${errorText(error)}`);
    if (cleanup !== void 0) {
      ctx.logger?.warn(`[@dsh-permission-remote] shadow cleanup failed for agent ${agentLabel(agent)}: ${errorText(cleanup)}`);
    }
    if (opened.kind === "remote") throw error;
    return false;
  }
  try {
    for (const tool of opsTools(core)) disposers.push(agent.ctx.tools.register(tool));
  } catch (error) {
    ctx.logger?.warn(`[@dsh-permission-remote] ops tool install failed for agent ${agentLabel(agent)}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let dropped = false;
  const drop = () => {
    if (dropped) return;
    dropped = true;
    const failure = releaseShadows(disposeDynamic, disposers);
    unregisters.delete(drop);
    try {
      forget();
    } catch (error) {
      ctx.logger?.warn(`[@dsh-permission-remote] shadow cleanup failed for agent ${agentLabel(agent)}: ${errorText(error)}`);
    }
    if (failure !== void 0) {
      ctx.logger?.warn(`[@dsh-permission-remote] shadow cleanup failed for agent ${agentLabel(agent)}: ${errorText(failure)}`);
    }
  };
  unregisters.add(drop);
  try {
    agent.ctx.effect(() => drop);
  } catch (error) {
    drop();
    ctx.logger?.warn(`[@dsh-permission-remote] shadow install failed for agent ${agentLabel(agent)}: ${error instanceof Error ? error.message : String(error)}`);
    if (opened.kind === "remote") throw error;
    return false;
  }
  return true;
}
function installRemoteShellSurface(ctx, agent, host, headerCwd, hasOfficialBash, disposers) {
  const dynamic = [];
  let applied = { kind: "local" };
  const remoteNow = () => routeByCwd(effectiveCwd(ctx, { agent }, headerCwd)).kind === "remote";
  const disposeDynamic = () => {
    const current = dynamic.splice(0, dynamic.length);
    let failure;
    for (let index = current.length - 1; index >= 0; index -= 1) {
      try {
        current[index]();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== void 0) throw failure;
  };
  const applyDynamic = (route) => {
    const plan = shellSurfacePlan(route, hasOfficialBash);
    const added = [];
    try {
      for (const name2 of plan.deny) {
        try {
          added.push(agent.ctx.tools.restrict({ deny: [name2] }));
        } catch (error) {
          if (!isUnknownRestrictError(error)) throw error;
        }
      }
      if (plan.shadowPwshPrompt) {
        added.push(agent.ctx.systemPrompt.section({
          name: PWSH_SECTION,
          order: agent.ctx.systemPrompt.getSectionOrder("TOOL_PWSH"),
          text: ""
        }));
      }
      if (plan.bashFallback) {
        added.push(agent.ctx.tools.register(withRemoteTimeout({
          ...fallbackSchema("bash"),
          name: "bash",
          async execute(args, exec) {
            const current = routeByCwd(effectiveCwd(ctx, exec, headerCwd));
            if (current.kind !== "remote") {
              return dispatchShadow(void 0, false, async () => {
                throw new Error("dsh-permission-remote: local call has no official tool");
              }, args, exec);
            }
            return RUNNERS.bash(host, current, args, exec, ctx);
          }
        })));
      }
    } catch (error) {
      for (let index = added.length - 1; index >= 0; index -= 1) {
        try {
          added[index]();
        } catch {
        }
      }
      throw error;
    }
    dynamic.push(...added);
  };
  const sync = (route) => {
    const next = shellSurfacePlan(route, hasOfficialBash);
    if (sameShellSurface(next, shellSurfacePlan(applied, hasOfficialBash))) {
      applied = route;
      return;
    }
    const previous = applied;
    let removed = false;
    try {
      disposeDynamic();
      removed = true;
      applyDynamic(route);
      applied = route;
    } catch (error) {
      if (!removed || route.kind !== "remote") {
        applied = { kind: "local" };
        throw error;
      }
      try {
        disposeDynamic();
        applyDynamic(previous);
        applied = previous;
      } catch {
        applied = { kind: "local" };
      }
      throw error;
    }
  };
  disposers.push(agent.ctx.tools.guard((execution) => {
    if (!isWindowsShell(execution.name)) return void 0;
    return windowsShellGuardReason(routeByCwd(effectiveCwd(ctx, execution, headerCwd)).kind === "remote");
  }));
  disposers.push(agent.ctx.on("system-prompt/assemble", async (_assembly, context, next) => {
    const assembled = await next();
    if (context.scope !== void 0 && context.scope !== agent) return assembled;
    if (!remoteNow()) return assembled;
    return { ...assembled, tools: withoutWindowsShells(assembled.tools, true) };
  }));
  disposers.push(agent.ctx.systemPrompt.section({
    name: REMOTE_POSIX_SECTION,
    order: agent.ctx.systemPrompt.getSectionOrder("TOOL_BASH") + 5,
    text: () => remotePosixPrompt(remoteNow())
  }));
  disposers.push(agent.ctx.on("session/event", (_session, event) => {
    if (event.type !== "working-directory/change") return;
    if (typeof event.data?.cwd !== "string") return;
    const route = routeByCwd(event.data.cwd);
    try {
      sync(route);
    } catch (error) {
      const remoteMounted = shellSurfacePlan(applied, hasOfficialBash).remote;
      if (route.kind === "remote" && !remoteMounted) {
        const bash = hasOfficialBash ? "The preset bash tool is still registered." : "No bash tool was registered.";
        ctx.logger?.warn(`[@dsh-permission-remote] remote shell surface was not mounted for agent ${agentLabel(agent)}: ${errorText(error)}. Windows shells stay off the native tool list and cannot run. ${bash} A later working-directory change retries.`);
        return;
      }
      ctx.logger?.warn(`[@dsh-permission-remote] shell surface sync failed for agent ${agentLabel(agent)}: ${errorText(error)}`);
    }
  }));
  return { sync, disposeDynamic };
}
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}
function settleDisposers(disposers) {
  let failure;
  for (let index = disposers.length - 1; index >= 0; index -= 1) {
    try {
      disposers[index]();
    } catch (error) {
      failure ??= error;
    }
  }
  return failure;
}
function releaseShadows(disposeDynamic, disposers) {
  let failure;
  try {
    disposeDynamic();
  } catch (error) {
    failure = error;
  }
  const permanent = settleDisposers(disposers);
  return failure ?? permanent;
}
function agentLabel(agent) {
  return agent.session?.id ?? agent.session?.header?.cwd ?? "unknown";
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
function capturedSchema(tools, toolName, agent) {
  const official = tools.get(toolName, agent);
  if (official === void 0) return fallbackSchema(toolName);
  const { execute: _execute, ...rest } = official;
  return rest;
}
function fallbackSchema(toolName) {
  if (toolName !== "bash") {
    return {
      description: toolName,
      parameters: { type: "object", properties: {}, additionalProperties: false },
      output: { schema: { type: "object", additionalProperties: true }, render: () => [{ type: "text", text: "" }] }
    };
  }
  return {
    description: "Execute a bash command on the remote workspace.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        description: { type: "string" },
        timeoutMs: { type: "number" },
        workdir: { type: "string" },
        run_in_background: { type: "boolean" },
        sandbox_permissions: { type: "string", enum: [...ESCALATION_TARGETS] },
        justification: { type: "string" }
      },
      required: ["command", "description"]
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
var OPS_ESCALATION = {
  sandbox_permissions: { type: "string", enum: ["danger-full-access"] },
  justification: { type: "string" }
};
var textOutput = (render) => ({
  schema: { type: "object", additionalProperties: true },
  render: (_args, value) => [{ type: "text", text: render(value) }]
});
function publishOpsTool(tool) {
  const parameters = parameterSchemaSpecToJsonSchema(tool.parameters);
  return {
    ...tool,
    parameters,
    async execute(args, exec) {
      const violations = validateArgs(tool.parameters, args);
      if (violations.length > 0) throw new ToolArgsError(violations);
      return tool.execute(args, exec);
    }
  };
}
function opsTools(core) {
  const hostApi = core.toolHost(void 0);
  const pick = (args) => core.requireOpsHost(String(args.host ?? ""));
  return [publishOpsTool({
    name: "ssh_hosts",
    description: 'List the configured SSH hosts for ops on another machine: id, name, address, user, ops policy, and whether the host key is trusted. Call this before ssh_exec, ssh_read, or ssh_write when you do not know the host id or name. Policy "ask" allows reads but needs danger-full-access for commands and writes, so pass sandbox_permissions "danger-full-access" and a justification; "trust" runs without a prompt; "deny" accepts nothing. An untrusted host must be trusted in Settings \u2192 SSH hosts first.',
    parameters: {},
    output: textOutput((value) => {
      const hosts = Array.isArray(value.hosts) ? value.hosts : [];
      if (hosts.length === 0) return "no SSH hosts configured";
      return hosts.map((host) => `${host.name || host.address} [${host.id}] ${host.username}@${host.address} ops=${host.opsPolicy}${host.trusted ? "" : " (untrusted: trust it in Settings first)"}`).join("\n");
    }),
    async execute() {
      return { hosts: core.listHosts().map((host) => opsHostView(host)) };
    }
  }), publishOpsTool({
    name: "ssh_exec",
    description: `Run a command on a configured SSH host as the remote login user. This is for ops on a machine that is not your current workspace. The remote command is not sandboxed locally: on an "ask" host it runs only with danger-full-access, either from this session's mode or a one-shot approval. Retry with sandbox_permissions "danger-full-access" and a one-sentence justification when the call is denied. sudo only works without a password prompt (sudo -n).`,
    parameters: {
      host: { type: "string", required: true, description: "SSH host id, name, or address from ssh_hosts" },
      command: { type: "string", required: true, description: "Command to run with bash -lc on the remote host" },
      workdir: { type: "string", description: "Absolute remote working directory; defaults to the login directory" },
      timeoutMs: { type: "number", description: "Command timeout in milliseconds; defaults to 60000" },
      ...OPS_ESCALATION
    },
    output: textOutput(renderOpsExec),
    execute(args, exec) {
      const record = args;
      const host = pick(record);
      return runSshExec(hostApi, host, record, exec);
    }
  }), publishOpsTool({
    name: "ssh_read",
    description: 'Read a file from a configured SSH host without a shell. Use an absolute remote path or one that starts with "~/" (expanded against the remote home). Reads are allowed on any host whose ops policy is not "deny". The text result includes the line range and whether more lines follow.',
    parameters: {
      host: { type: "string", required: true, description: "SSH host id, name, or address from ssh_hosts" },
      file_path: { type: "string", required: true, description: 'Absolute remote path or a path starting with "~/"' },
      offset: { type: "number", description: "1-based first line to return; defaults to 1" },
      limit: { type: "number", description: "Maximum lines to return; defaults to 2000" }
    },
    output: textOutput(renderOpsRead),
    execute(args, exec) {
      const record = args;
      const host = pick(record);
      return runSshRead(hostApi, host, record, exec);
    }
  }), publishOpsTool({
    name: "ssh_write",
    description: 'Replace a file on a configured SSH host. The new content is written to a temp file in the same directory and renamed with mv -f, so a dropped connection does not truncate the original. An existing directory is rejected. Replacing a file keeps its permission bits; a new file is created with the remote umask. On an "ask" host this needs danger-full-access: pass sandbox_permissions "danger-full-access" and a one-sentence justification when the call is denied.',
    parameters: {
      host: { type: "string", required: true, description: "SSH host id, name, or address from ssh_hosts" },
      file_path: { type: "string", required: true, description: 'Absolute remote path or a path starting with "~/"' },
      content: { type: "string", required: true, description: "Full replacement file content" },
      ...OPS_ESCALATION
    },
    output: textOutput((value) => {
      const host = value.host;
      return `${value.operation === "create" ? "created" : "updated"} ${String(value.path ?? "")} on ${host === void 0 ? "remote host" : host.name || host.address}`;
    }),
    execute(args, exec) {
      const record = args;
      const host = pick(record);
      return runSshWrite(hostApi, host, record, exec);
    }
  })];
}
export {
  Config,
  Core,
  apply,
  inject,
  name
};
