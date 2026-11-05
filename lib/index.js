// src/index.ts
import { existsSync as existsSync2, realpathSync as realpathSync3 } from "node:fs";
import { mkdir as mkdir5 } from "node:fs/promises";
import { join as joinPath2, posix as posix11, resolve as resolveLocalPath, sep as sep2 } from "node:path";
import { credentialKey } from "@deepseek-ai/dsh-credentials";
import { FsError as FsError4 } from "@deepseek-ai/dsh-fs";
import { resolveDshHome as resolveDshHome4 } from "@deepseek-ai/dsh-home-paths";
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

// src/router.ts
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { posix } from "node:path";
function defaultRemoteRoot(env = process.env) {
  if (env.DSH_SSH_REMOTE_ROOT) return path.resolve(String(env.DSH_SSH_REMOTE_ROOT));
  const home = env.DSH_HOME ? String(env.DSH_HOME) : path.join(os.homedir(), ".dsh");
  return path.join(home, "remote");
}
var remoteRootOverride = null;
var supersededRoots = [];
function setRemoteRootOverride(root) {
  const text2 = root === null ? "" : String(root).trim();
  remoteRootOverride = text2.length === 0 ? null : path.resolve(text2);
}
function addSupersededRoot(root) {
  const text2 = String(root ?? "").trim();
  if (text2.length === 0) return;
  const resolved = path.resolve(text2);
  if (resolved === remoteRoot()) return;
  if (!supersededRoots.includes(resolved)) supersededRoots.push(resolved);
}
function clearSupersededRoots() {
  supersededRoots.length = 0;
}
function routingRoots(env = process.env) {
  const roots = [remoteRoot(env)];
  for (const root of supersededRoots) {
    if (!roots.includes(root)) roots.push(root);
  }
  return roots;
}
function pathSpellings(target) {
  const out = [target];
  try {
    const real = realpathSync(target);
    if (real !== target) out.push(real);
  } catch {
  }
  return out;
}
function canonicalRoutingRoots(env = process.env) {
  const roots = [];
  for (const root of routingRoots(env)) {
    for (const spelling of pathSpellings(root)) {
      if (!roots.includes(spelling)) roots.push(spelling);
    }
  }
  return roots;
}
function remoteRoot(env = process.env) {
  if (remoteRootOverride !== null) return remoteRootOverride;
  return defaultRemoteRoot(env);
}
function expandRemoteRoot(input, env = process.env) {
  const text2 = String(input ?? "").trim();
  if (text2.length === 0) return null;
  const home = env.HOME && String(env.HOME).length > 0 ? String(env.HOME) : os.homedir();
  let expanded = text2;
  if (text2 === "~") expanded = home;
  else if (text2.startsWith("~/")) expanded = path.join(home, text2.slice(2));
  if (!path.isAbsolute(expanded)) return null;
  return path.resolve(expanded);
}
function isValidHostId(hostId) {
  return /^[a-z][a-z0-9-]*$/.test(hostId);
}
function encodeRemotePath(remotePath) {
  return Buffer.from(remotePath, "utf8").toString("base64url");
}
function decodeRemotePath(encoded) {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  let text2;
  try {
    text2 = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (encodeRemotePath(text2) !== encoded) return null;
  return text2;
}
function mapRemoteToLocal(hostId, remotePath, env = process.env) {
  if (!isValidHostId(hostId)) return null;
  if (!posix.isAbsolute(remotePath)) return null;
  return path.join(remoteRoot(env), hostId, encodeRemotePath(remotePath));
}
function routeUnderRoot(root, cwd) {
  if (!cwd) return { kind: "local" };
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
  const remoteCwd = extra.length === 0 ? remotePath : posix.join(remotePath, ...extra);
  return { kind: "remote", hostId, remoteCwd, placeholderCwd: cwd };
}
function routeByCwd(cwd, env = process.env) {
  if (!cwd) return { kind: "local" };
  for (const spelling of pathSpellings(cwd)) {
    for (const root of canonicalRoutingRoots(env)) {
      const route = routeUnderRoot(root, spelling);
      if (route.kind === "remote") {
        return spelling === cwd ? route : { ...route, placeholderCwd: cwd };
      }
    }
  }
  return { kind: "local" };
}
function workspaceBinding(cwd, env = process.env) {
  if (!cwd) return null;
  for (const spelling of pathSpellings(cwd)) {
    for (const root of canonicalRoutingRoots(env)) {
      const rel = path.relative(root, spelling);
      if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) continue;
      const segments = rel.split(path.sep).filter((segment) => segment.length > 0);
      if (segments.length < 2) continue;
      const hostId = segments[0];
      if (!isValidHostId(hostId)) continue;
      const remotePath = decodeRemotePath(segments[1]);
      if (remotePath === null || !remotePath.startsWith("/")) continue;
      const normalized = normalizeRemoteDirectory(remotePath);
      if (normalized === null) continue;
      return { hostId, remotePath: normalized };
    }
  }
  return null;
}
function resolveRemotePath(requestedPath, remoteCwd, placeholderCwd) {
  if (!posix.isAbsolute(requestedPath)) {
    const rel2 = path.relative(placeholderCwd, requestedPath);
    if (rel2 !== "" && !rel2.startsWith("..") && !path.isAbsolute(rel2)) {
      return posix.join(remoteCwd, rel2.split(path.sep).join("/"));
    }
    return posix.normalize(posix.resolve(remoteCwd, requestedPath));
  }
  const rel = posix.relative(placeholderCwd, requestedPath);
  if (rel !== "" && !rel.startsWith("..") && !posix.isAbsolute(rel)) {
    return posix.join(remoteCwd, rel);
  }
  return posix.normalize(requestedPath);
}
function normalizeRemoteDirectory(remotePath) {
  const text2 = remotePath.trim();
  if (!posix.isAbsolute(text2)) return null;
  return posix.normalize(text2).replace(/\/+$/, "") || "/";
}
function listingPath(requested, home) {
  const text2 = requested.trim();
  if (text2.length === 0) return "/";
  if (text2 === "~") return home;
  if (text2.startsWith("~/")) return posix.join(home, text2.slice(2)).replace(/\/+$/, "") || "/";
  return text2;
}
function childDirectoryPath(parent, rawName) {
  const name2 = rawName.trim();
  if (name2.length === 0) return { error: "empty" };
  if (name2 === "." || name2 === "..") return { error: "dot" };
  if (name2.includes("/") || name2.includes("\0")) return { error: "separator" };
  const root = parent.length === 0 ? "/" : parent;
  return { path: root === "/" ? `/${name2}` : `${root.replace(/\/$/, "")}/${name2}` };
}
function toPlaceholderPath(remotePath, hostId, env = process.env) {
  const normalized = posix.normalize(remotePath);
  const local = mapRemoteToLocal(hostId, normalized, env);
  if (local === null) return normalized;
  return local;
}
function toModelPath(remotePath, route, env = process.env) {
  const normalized = posix.normalize(remotePath);
  const rel = posix.relative(route.remoteCwd, normalized);
  if (rel === "") return route.placeholderCwd;
  if (rel !== "" && !rel.startsWith("..") && !posix.isAbsolute(rel)) {
    return path.join(route.placeholderCwd, ...rel.split("/"));
  }
  return toPlaceholderPath(normalized, route.hostId, env);
}

// src/config.ts
var TRANSFER_MAX_BYTES_DEFAULT = 32 * 1024 * 1024;
var TRANSFER_TIMEOUT_MS_DEFAULT = 12e4;
var TRANSFER_TIMEOUT_MS_MAX = 2 ** 31 - 1;
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
  opsPolicy: OpsPolicy,
  /**
   * When true, workspace bash loads Bash login scripts and bashrc before the
   * command and discards their output. Off keeps the sshd session environment.
   */
  loginEnv: Schema.boolean().default(false)
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
  rgRegistry: Schema.string().default("").volatile(),
  /**
   * Local directory the remote-workspace placeholder tree lives under. Empty
   * keeps the built-in default (`<DSH_HOME>/remote`, or `DSH_SSH_REMOTE_ROOT`).
   * The Settings action changes it and migrates the old tree there.
   */
  remoteRoot: Schema.string().default("").volatile(),
  /**
   * Byte ceiling for one `ssh_upload` / `ssh_download`. `0` means no ceiling:
   * the whole file is held in memory, so the operator opts in explicitly.
   * Volatile so the settings page can write it; a non-volatile field would be
   * read once at load and every save would be a silent no-op.
   */
  transferMaxBytes: Schema.natural().default(TRANSFER_MAX_BYTES_DEFAULT).volatile(),
  /**
   * Abort deadline for one transfer, in milliseconds. `0` means no deadline.
   * Applied to the remote write and the remote read; the pre-transfer `stat`
   * cannot be cancelled mid-flight and only rejects the caller's promise.
   */
  transferTimeoutMs: Schema.natural().default(TRANSFER_TIMEOUT_MS_DEFAULT).max(TRANSFER_TIMEOUT_MS_MAX).volatile()
});
function normalizeOpsPolicy(value) {
  return value === "trust" || value === "deny" ? value : "ask";
}
function normalizeLoginEnv(value) {
  return value === true;
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
  const rootRef = refOf(record.remoteRoot);
  const rootDefault = typeof record.remoteRoot === "string" ? record.remoteRoot : "";
  const bytesRef = refOf(record.transferMaxBytes);
  const bytesDefault = typeof record.transferMaxBytes === "number" ? record.transferMaxBytes : TRANSFER_MAX_BYTES_DEFAULT;
  const timeoutRef = refOf(record.transferTimeoutMs);
  const timeoutDefault = typeof record.transferTimeoutMs === "number" ? record.transferTimeoutMs : TRANSFER_TIMEOUT_MS_DEFAULT;
  const parsed = Config({
    ...record,
    hosts: copyHostRows(hostRef !== void 0 ? hostRef.get() : record.hosts),
    deletedHosts: copyDeletedRows(deletedRef !== void 0 ? deletedRef.get() : record.deletedHosts),
    // A volatile reference cannot be validated; resolve it to a value first.
    tagWorkspaceTitles: tagRef !== void 0 ? tagRef.get() !== false : tagDefault,
    rgRegistry: registryRef !== void 0 ? String(registryRef.get() ?? "") : registryDefault,
    remoteRoot: rootRef !== void 0 ? String(rootRef.get() ?? "") : rootDefault,
    transferMaxBytes: bytesRef !== void 0 ? Number(bytesRef.get() ?? 0) : bytesDefault,
    transferTimeoutMs: timeoutRef !== void 0 ? Number(timeoutRef.get() ?? 0) : timeoutDefault
  });
  const maxConnections = parsed.maxConnections ?? 4;
  const tag = tagRef === void 0 ? () => tagDefault : () => tagRef.get() !== false;
  const registry = () => String(registryRef === void 0 ? registryDefault : registryRef.get() ?? "").trim();
  const root = () => String(rootRef === void 0 ? rootDefault : rootRef.get() ?? "").trim();
  const transferMaxBytes = () => normalizeTransferLimit(
    bytesRef === void 0 ? bytesDefault : bytesRef.get(),
    TRANSFER_MAX_BYTES_DEFAULT
  );
  const transferTimeoutMs = () => Math.min(
    TRANSFER_TIMEOUT_MS_MAX,
    normalizeTransferLimit(timeoutRef === void 0 ? timeoutDefault : timeoutRef.get(), TRANSFER_TIMEOUT_MS_DEFAULT)
  );
  const ref = hostRef ?? parsed.hosts;
  const deletedRowRef = deletedRef ?? refOf(parsed.deletedHosts);
  const deletedRows = copyDeletedRows(deletedRowRef !== void 0 ? deletedRowRef.get() : record.deletedHosts) ?? [];
  if (isHostRef(ref)) return viewConfig(ref, maxConnections, tag, registry, root, rootRef, deletedRowRef, deletedRows, transferMaxBytes, transferTimeoutMs);
  return { hosts: asHostArray(ref), deletedHosts: deletedRows, maxConnections, tagWorkspaceTitles: tagDefault, rgRegistry: registry(), remoteRoot: root(), transferMaxBytes: transferMaxBytes(), transferTimeoutMs: transferTimeoutMs() };
}
function normalizeTransferLimit(value, fallback = 0) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}
function refOf(value) {
  return isVolatile(value) ? value : void 0;
}
function viewConfig(ref, maxConnections, tagWorkspaceTitles, rgRegistry, remoteRoot2, rootRef, deletedRef, deletedRows, transferMaxBytes, transferTimeoutMs) {
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
    },
    get remoteRoot() {
      return remoteRoot2();
    },
    get transferMaxBytes() {
      return transferMaxBytes();
    },
    get transferTimeoutMs() {
      return transferTimeoutMs();
    },
    set remoteRoot(value) {
      if (rootRef === void 0) throw new Error("the remote root setting is not writable in this config");
      updateVolatile(rootRef, createVolatile(String(value ?? "")));
    }
  };
}
function normalizeHostRow(raw) {
  if (!isRecord(raw)) throw new Error("each imported host must be an object");
  const text2 = (value) => typeof value === "string" ? value : "";
  const id = text2(raw.id).trim();
  if (!isValidHostId(id)) throw new Error(`imported host has an invalid id: ${JSON.stringify(raw.id)}`);
  const host = text2(raw.host).trim();
  if (host.length === 0) throw new Error(`imported host ${id} is missing its address`);
  const username = text2(raw.username).trim();
  if (username.length === 0) throw new Error(`imported host ${id} is missing its username`);
  const port = raw.port === void 0 ? 22 : raw.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`imported host ${id} has an invalid port: ${JSON.stringify(raw.port)}`);
  }
  if (raw.auth !== void 0 && raw.auth !== "key" && raw.auth !== "password") {
    throw new Error(`imported host ${id} has an unknown auth mode: ${JSON.stringify(raw.auth)}`);
  }
  if (raw.opsPolicy !== void 0 && raw.opsPolicy !== "ask" && raw.opsPolicy !== "trust" && raw.opsPolicy !== "deny") {
    throw new Error(`imported host ${id} has an unknown ops policy: ${JSON.stringify(raw.opsPolicy)}`);
  }
  const parsed = Host({
    ...raw,
    id,
    host,
    username,
    port,
    privateKeyPath: text2(raw.privateKeyPath).trim(),
    fingerprint: text2(raw.fingerprint).trim()
  });
  return {
    id: parsed.id,
    name: text2(parsed.name).trim(),
    host: parsed.host,
    port: parsed.port,
    username: parsed.username,
    auth: parsed.auth,
    privateKeyPath: parsed.privateKeyPath,
    fingerprint: parsed.fingerprint,
    opsPolicy: parsed.opsPolicy,
    loginEnv: parsed.loginEnv
  };
}
function exportHostConfig(hosts, deletedHosts) {
  return {
    version: 1,
    exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
    hosts: hosts.map((host) => ({ ...host })),
    deletedHosts: deletedHosts.map((row) => ({ host: { ...row.host }, deletedAt: row.deletedAt ?? "" }))
  };
}
var HOST_PATCH_FIELDS = ["name", "host", "port", "username", "auth", "privateKeyPath", "fingerprint", "opsPolicy", "loginEnv"];
function presentHostFields(raw) {
  if (!isRecord(raw)) return /* @__PURE__ */ new Set();
  return new Set(HOST_PATCH_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(raw, field)));
}
function overlayHost(current, incoming, present) {
  const next = { ...current };
  if (present.has("name")) next.name = incoming.name;
  if (present.has("host")) next.host = incoming.host;
  if (present.has("port")) next.port = incoming.port;
  if (present.has("username")) next.username = incoming.username;
  if (present.has("auth")) next.auth = incoming.auth;
  if (present.has("privateKeyPath")) next.privateKeyPath = incoming.privateKeyPath;
  if (present.has("fingerprint")) next.fingerprint = incoming.fingerprint;
  if (present.has("opsPolicy")) next.opsPolicy = incoming.opsPolicy;
  if (present.has("loginEnv")) next.loginEnv = incoming.loginEnv;
  if (present.has("host") && incoming.host !== current.host && !present.has("fingerprint")) next.fingerprint = "";
  return next;
}
function parseHostImport(payload) {
  let hostsRaw;
  let deletedRaw;
  if (Array.isArray(payload)) hostsRaw = payload;
  else if (isRecord(payload)) {
    hostsRaw = payload.hosts;
    deletedRaw = payload.deletedHosts;
  } else {
    throw new Error("imported file is not a host configuration export");
  }
  if (!Array.isArray(hostsRaw)) throw new Error('imported file has no "hosts" array');
  const hosts = [];
  const present = [];
  for (const raw of hostsRaw) {
    hosts.push(normalizeHostRow(raw));
    present.push(presentHostFields(raw));
  }
  const seen = /* @__PURE__ */ new Set();
  for (const host of hosts) {
    if (seen.has(host.id)) throw new Error(`imported file lists host ${host.id} more than once`);
    seen.add(host.id);
  }
  const deletedHosts = [];
  if (Array.isArray(deletedRaw)) {
    for (const row of deletedRaw) {
      if (!isRecord(row)) continue;
      const host = normalizeHostRow(row.host);
      if (seen.has(host.id)) continue;
      seen.add(host.id);
      deletedHosts.push({ host, deletedAt: typeof row.deletedAt === "string" ? row.deletedAt : "" });
    }
  }
  return { hosts, deletedHosts, present };
}
function mergeImportedHosts(current, currentDeleted, incoming, mode) {
  const importedIds = new Set(incoming.hosts.map((host) => host.id));
  const known = /* @__PURE__ */ new Map();
  for (const host of current) known.set(host.id, host);
  for (const row of currentDeleted) if (!known.has(row.host.id)) known.set(row.host.id, row.host);
  const placed = incoming.hosts.map((host, index) => {
    const previous = known.get(host.id);
    const fields = incoming.present[index] ?? /* @__PURE__ */ new Set();
    return previous === void 0 ? { ...host } : overlayHost(previous, host, fields);
  });
  let hosts;
  let added = 0;
  let updated = 0;
  let removed = 0;
  let dropped = [];
  if (mode === "replace") {
    const currentIds = new Set(current.map((host) => host.id));
    hosts = placed;
    added = incoming.hosts.filter((host) => !currentIds.has(host.id)).length;
    updated = incoming.hosts.length - added;
    const droppedHosts = current.filter((host) => !importedIds.has(host.id));
    removed = droppedHosts.length;
    const now = (/* @__PURE__ */ new Date()).toISOString();
    dropped = droppedHosts.map((host) => ({ host: { ...host }, deletedAt: now }));
  } else {
    hosts = current.map((host) => ({ ...host }));
    const byId = new Map(hosts.map((host) => [host.id, host]));
    for (let index = 0; index < placed.length; index += 1) {
      const next = placed[index];
      if (byId.has(next.id)) {
        byId.set(next.id, next);
        updated += 1;
      } else {
        byId.set(next.id, next);
        added += 1;
      }
    }
    hosts = [...byId.values()];
  }
  const baseDeleted = mode === "replace" ? [...dropped, ...incoming.deletedHosts] : currentDeleted;
  const seenDeleted = /* @__PURE__ */ new Set();
  const deletedHosts = baseDeleted.filter((row) => !importedIds.has(row.host.id)).filter((row) => {
    if (seenDeleted.has(row.host.id)) return false;
    seenDeleted.add(row.host.id);
    return true;
  }).map((row) => ({ host: { ...row.host }, deletedAt: row.deletedAt ?? "" }));
  return { hosts, deletedHosts, added, updated, removed };
}

// src/shell-quote.ts
function shQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
function shJoin(argv) {
  return argv.map(shQuote).join(" ");
}

// src/login-env.ts
var LOGIN_ENV_CAPTURE_MS = 1e4;
function loginEnvCaptureCommand() {
  const capture = [
    "set +e",
    "__dsh_hit_sys=0",
    "__dsh_hit_rc=0",
    "__dsh_canon() {",
    '  local f="${1-}"',
    '  [ -n "$f" ] || return 1',
    '  if [ "$f" = "~/.bashrc" ]; then f="$HOME/.bashrc"; fi',
    '  case "$f" in',
    "    *bashrc|*bash.bashrc) ;;",
    "    *) return 1 ;;",
    "  esac",
    '  case "$f" in',
    '    "$HOME/.bashrc"|/etc/bash.bashrc)',
    '      printf %s "$f"',
    "      return 0",
    "      ;;",
    "  esac",
    '  local dir="${f%/*}" abs',
    '  [ "$dir" = "$f" ] && dir="."',
    '  abs=$(CDPATH= cd -- "$dir" 2>/dev/null && pwd) || return 1',
    '  printf %s "$abs/${f##*/}"',
    "}",
    "__dsh_once() {",
    "  local f",
    '  f=$(__dsh_canon "${1-}") || return 0',
    '  if [ "$f" = "$HOME/.bashrc" ]; then',
    '    if [ "$__dsh_hit_rc" -eq 1 ]; then return 1; fi',
    "    __dsh_hit_rc=1",
    "    return 0",
    "  fi",
    '  if [ "$f" = /etc/bash.bashrc ]; then',
    '    if [ "$__dsh_hit_sys" -eq 1 ]; then return 1; fi',
    "    __dsh_hit_sys=1",
    "    return 0",
    "  fi",
    "  return 0",
    "}",
    'function source { if __dsh_once "${1-}"; then builtin source "$@"; else return 0; fi; }',
    'function . { if __dsh_once "${1-}"; then builtin . "$@"; else return 0; fi; }',
    "if [ -r /etc/profile ]; then . /etc/profile >/dev/null 2>&1; fi",
    'if [ -r "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile" >/dev/null 2>&1',
    'elif [ -r "$HOME/.bash_login" ]; then . "$HOME/.bash_login" >/dev/null 2>&1',
    'elif [ -r "$HOME/.profile" ]; then . "$HOME/.profile" >/dev/null 2>&1',
    "fi",
    "if [ -r /etc/bash.bashrc ]; then . /etc/bash.bashrc >/dev/null 2>&1; fi",
    'if [ -r "$HOME/.bashrc" ]; then . "$HOME/.bashrc" >/dev/null 2>&1; fi',
    "unset -f source . __dsh_once __dsh_canon",
    "unset __dsh_hit_sys __dsh_hit_rc PWD OLDPWD SHLVL _",
    "export -p"
  ].join("\n");
  return `bash --noprofile --norc -ic ${shQuote(capture)} 2>/dev/null || true`;
}
function loginEnvApply(snapshot, command, workdir) {
  return [
    `eval ${shQuote(snapshot)} || true`,
    `cd ${shQuote(workdir)} || exit $?`,
    command
  ].join("\n");
}
var SESSION_STATE = /* @__PURE__ */ new Set(["PWD", "OLDPWD", "SHLVL", "_"]);
function loginEnvSnapshot(result) {
  if (result.timedOut || result.stdoutTruncated) return "";
  const text2 = result.stdout.replace(/^\n+/, "").replace(/\n+$/, "");
  if (!text2.startsWith("declare ") && !text2.startsWith("export ")) return "";
  const kept = stripSessionState(text2);
  return kept.length > 0 ? `${kept}
` : "";
}
function parseDeclaration(lines, index) {
  const line = lines[index] ?? "";
  const match = /^(?:declare\s+-x|export)\s+([A-Za-z_][A-Za-z0-9_]*)(.*)$/.exec(line);
  if (match === null) return null;
  const name2 = match[1];
  const rest = match[2] ?? "";
  if (rest.length === 0) return { name: name2, block: line, next: index + 1 };
  if (!rest.startsWith("=")) return null;
  const value = rest.slice(1);
  if (value.length === 0) return { name: name2, block: line, next: index + 1 };
  let block = line;
  let current = value;
  let end = index;
  for (; ; ) {
    const scanned = scanQuotedValue(current);
    if (scanned === "invalid") return null;
    if (scanned === "unclosed") {
      end += 1;
      if (end >= lines.length) return null;
      current += `
${lines[end] ?? ""}`;
      block += `
${lines[end] ?? ""}`;
      continue;
    }
    if (scanned.rest.trim().length > 0) return null;
    return { name: name2, block, next: end + 1 };
  }
}
function scanQuotedValue(value) {
  const first = value[0];
  if (first === '"' || first === "'") return scanQuote(value, first, first);
  if (first === "$" && value[1] === "'") return scanQuote(value, "$", "'");
  if (/^[A-Za-z0-9_./:+=,-]*$/.test(value)) return { rest: "" };
  return "invalid";
}
function scanQuote(value, opener, closer) {
  let index = opener === "$" ? 2 : 1;
  while (index < value.length) {
    const char = value[index] ?? "";
    if (char === "\\" && closer !== "'") {
      index += 2;
      continue;
    }
    if (char === closer) return { rest: value.slice(index + 1) };
    if (closer === '"' && (char === "`" || char === "$" && value[index + 1] === "(")) return "invalid";
    if (closer === '"' && char === "$" && value[index + 1] !== "{") {
      return "invalid";
    }
    index += 1;
  }
  return "unclosed";
}
function stripSessionState(text2) {
  const lines = text2.split("\n");
  const kept = [];
  let index = 0;
  while (index < lines.length) {
    const declaration = parseDeclaration(lines, index);
    if (declaration === null) return "";
    if (!SESSION_STATE.has(declaration.name)) kept.push(declaration.block);
    index = declaration.next;
  }
  return kept.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
}
var LoginEnvCache = class {
  constructor(load) {
    this.load = load;
  }
  ready = /* @__PURE__ */ new Map();
  pending = /* @__PURE__ */ new Map();
  get(hostId, signal) {
    const cached = this.ready.get(hostId);
    if (cached !== void 0) return Promise.resolve(cached);
    const inflight = this.pending.get(hostId);
    if (inflight !== void 0) return inflight;
    const pending = this.load(hostId, signal).then((result) => {
      const snapshot = loginEnvSnapshot(result);
      if (this.pending.get(hostId) === pending) this.ready.set(hostId, snapshot);
      return snapshot;
    }).finally(() => {
      if (this.pending.get(hostId) === pending) this.pending.delete(hostId);
    });
    this.pending.set(hostId, pending);
    return pending;
  }
  forget(hostId) {
    this.ready.delete(hostId);
    this.pending.delete(hostId);
  }
};

// src/execute.ts
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { createRequire as createRequire2 } from "node:module";
import { join as join2, posix as posix6 } from "node:path";
import { writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { FsError as FsError2 } from "@deepseek-ai/dsh-fs";
import { dshCachePath, resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import {
  SandboxUnavailableError as SandboxUnavailableError2,
  WIDER_MODES,
  approveEscalation,
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
function parseOsRelease(text2) {
  const fields = /* @__PURE__ */ new Map();
  for (const line of text2.split("\n")) {
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

// src/remote-write.ts
import { createHash as createHash2, randomBytes } from "node:crypto";
import { posix as posix4 } from "node:path";
import { FsError } from "@deepseek-ai/dsh-fs";
import { SandboxUnavailableError } from "@deepseek-ai/dsh-sandbox";

// src/contain.ts
import { posix as posix2 } from "node:path";
function composeCreatedPath(ancestorReal, missingNames) {
  const suffix = missingNames.filter((name2) => name2.length > 0 && name2 !== "." && name2 !== "..");
  if (suffix.length === 0) return posix2.normalize(ancestorReal);
  return posix2.normalize(posix2.join(ancestorReal, ...suffix));
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
  const argv = [rg, "--no-config", "--json", "-n", "--heading", "-e", pattern];
  if (include !== void 0 && include.length > 0) argv.push("--glob", include);
  argv.push("--", base);
  return argv;
}
function globArgv(rg, pattern) {
  return [rg, "--no-config", "--files", "--hidden", "--iglob", pattern, "--glob", "!.git/**", "--sort", "modified"];
}
function atomicWriteScript(directory, tmp, target, mode, options = {}) {
  const quotedTarget = shJoin([target]);
  const quotedTmp = shJoin([tmp]);
  const bits = mode === void 0 ? void 0 : mode & 4095;
  const chmod2 = bits === void 0 ? "" : ` && chmod ${bits.toString(8)} ${quotedTarget}`;
  const rename2 = options.noClobber === true ? `mv -n ${quotedTmp} ${quotedTarget} || true; if [ -e ${quotedTmp} ]; then if [ -e ${quotedTarget} ] || [ -L ${quotedTarget} ]; then echo 'remote target already exists' >&2; fi; false; fi` : `mv -f ${quotedTmp} ${quotedTarget}`;
  const write = `if test -d ${quotedTarget}; then echo 'remote path is a directory' >&2; false; else cat > ${quotedTmp} && ${rename2}${chmod2}; fi`;
  const cleanup = `{ status=$?; rm -f ${quotedTmp}; exit $status; }`;
  return `mkdir -p ${shJoin([directory])} && ${write} || ${cleanup}`;
}

// src/ssh-pool.ts
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix as posix3 } from "node:path";
import { StringDecoder } from "node:string_decoder";

// src/ssh2-client.ts
import { createRequire } from "node:module";
var require2 = createRequire(import.meta.url);
var ssh2 = require2("../vendor/ssh2/lib/index.js");
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
var SFTP_STATUS = {
  OK: 0,
  EOF: 1,
  NO_SUCH_FILE: 2,
  PERMISSION_DENIED: 3,
  FAILURE: 4,
  BAD_MESSAGE: 5,
  NO_CONNECTION: 6,
  CONNECTION_LOST: 7,
  OP_UNSUPPORTED: 8
};
var SshFailure = class extends Error {
  constructor(message, stage, status) {
    super(message);
    this.stage = stage;
    this.status = status;
    this.name = "SshFailure";
  }
};
function sftpStatusOf(error) {
  if (typeof error !== "object" || error === null) return void 0;
  const code = error.code;
  return typeof code === "number" ? code : void 0;
}
function failureOf(error, stage) {
  return new SshFailure(error.message, stage, sftpStatusOf(error));
}
function sftpFailureStatus(error) {
  if (error instanceof SshFailure && typeof error.status === "number") return error.status;
  return sftpStatusOf(error);
}
function isSftpMissing(error) {
  const status = sftpFailureStatus(error);
  if (status === SFTP_STATUS.NO_SUCH_FILE) return true;
  if (status !== void 0 && status !== SFTP_STATUS.FAILURE) return false;
  return error instanceof Error && /no such file|cannot find|not found|does not exist/i.test(error.message);
}
function isSftpPermissionDenied(error) {
  const status = sftpFailureStatus(error);
  if (status === SFTP_STATUS.PERMISSION_DENIED) return true;
  if (status !== void 0 && status !== SFTP_STATUS.FAILURE) return false;
  return error instanceof Error && /permission denied/i.test(error.message);
}
function isRetryableOpenFailure(error) {
  if (!(error instanceof SshFailure) || error.stage !== "exec") return false;
  return /no response from server|not connected|connection lost/i.test(error.message);
}
var FINGERPRINT_PREFIX = "SHA256:";
function formatFingerprint(hashedKey) {
  const digest = typeof hashedKey === "string" ? Buffer.from(hashedKey, "hex") : hashedKey;
  return `${FINGERPRINT_PREFIX}${digest.toString("base64").replace(/=+$/, "")}`;
}
function legacyFingerprint(hashedKey) {
  const hex = typeof hashedKey === "string" ? hashedKey : hashedKey.toString("hex");
  return `${FINGERPRINT_PREFIX}${hex}`;
}
function fingerprintMatches(stored, hashedKey) {
  const value = stored.trim();
  if (value.length === 0) return false;
  return value === formatFingerprint(hashedKey) || value === legacyFingerprint(hashedKey);
}
function expandTildePath(input) {
  const text2 = input.trim();
  if (text2 === "~") return homedir();
  if (text2.startsWith("~/") || text2.startsWith("~\\")) return join(homedir(), text2.slice(2));
  return input;
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
        return fingerprintMatches(stored, key);
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
  async sftpRead(host, secret, remotePath, maxBytes, signal) {
    if (signal?.aborted) throw new SshFailure("sftp read aborted", "sftp-read");
    const session = await this.sftp(host, secret);
    if (maxBytes !== void 0) {
      const size = await statSize(session, remotePath);
      if (size > maxBytes) throw new SshFailure(`file is ${size} bytes, over the ${maxBytes} byte limit`, "sftp-read");
      return readAllCapped(session, remotePath, maxBytes, signal);
    }
    if (signal !== void 0) return readAllCapped(session, remotePath, Number.MAX_SAFE_INTEGER, signal);
    return readAll(session, remotePath);
  }
  async sftpWrite(host, secret, remotePath, body) {
    const session = await this.sftp(host, secret);
    await writeAll(session, remotePath, body);
  }
  async sftpRename(host, secret, fromPath, toPath) {
    const session = await this.sftp(host, secret);
    await renameRemote(session, fromPath, toPath);
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
    return rows.filter((row) => row.filename.length > 0 && row.filename !== "." && row.filename !== ".." && !row.filename.includes("/") && !row.filename.includes("\\") && attrsFrom(row.attrs, row.longname).type === "directory").map((row) => ({
      name: row.filename,
      path: remotePath === "/" ? `/${row.filename}` : `${remotePath.replace(/\/$/, "")}/${row.filename}`
    })).sort((a, b) => a.name.localeCompare(b.name));
  }
  /**
   * Create one directory. `recursive` is off by default on purpose: a picker
   * creates a child of a directory it just listed, so a missing parent means
   * the listing went stale and creating a deep tree would hide that.
   */
  async sftpMkdir(host, secret, remotePath) {
    const session = await this.sftp(host, secret);
    await makeDirectory(session, remotePath);
  }
  async sftp(host, secret) {
    const live = await this.acquire(host, secret, true);
    if (live.sftp === void 0) {
      let opening;
      opening = openSftp(live.client, () => {
        if (live.sftp === opening) live.sftp = void 0;
      }).catch((error) => {
        if (live.sftp === opening) live.sftp = void 0;
        throw error;
      });
      live.sftp = opening;
    }
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
  /**
   * Place a data file. The parent directory is private. The file itself keeps
   * the remote umask: `sftpUpload` marks a binary executable, and a document
   * must not become one.
   */
  async sftpPutFile(host, secret, localPath, remotePath, allowedRoot) {
    const body = await readFile(localPath);
    const dir = remotePath.slice(0, remotePath.lastIndexOf("/"));
    if (dir.length > 0) {
      await this.exec(host, secret, `mkdir -p ${shJoin([dir])} && chmod 700 ${shJoin([dir])}`, 2e4);
      if (allowedRoot !== void 0) {
        const realDir = await this.sftpRealpath(host, secret, dir);
        if (!remotePathWithin(allowedRoot, realDir)) {
          throw new Error(`upload directory ${dir} escapes ${allowedRoot}`);
        }
      }
    }
    const previous = await this.sftpAttrs(host, secret, remotePath, false).catch(() => void 0);
    const temporary = `${remotePath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await this.sftpWrite(host, secret, temporary, body);
      try {
        await this.sftpRename(host, secret, temporary, remotePath);
      } catch {
        const moved = await this.exec(host, secret, `mv -f ${shJoin([temporary, remotePath])}`, 2e4);
        if (moved.code !== 0) throw new Error(moved.stderr || "remote upload rename failed");
      }
      if (previous?.mode !== void 0) {
        await this.exec(host, secret, `chmod ${previous.mode.toString(8)} ${shJoin([remotePath])}`, 15e3).catch(() => void 0);
      }
    } catch (error) {
      await this.exec(host, secret, `rm -f ${shJoin([temporary])}`, 15e3).catch(() => void 0);
      throw error;
    }
  }
  async sftpAttrs(host, secret, remotePath, follow) {
    const session = await this.sftp(host, secret);
    const info = await attrsOf(session, remotePath, follow);
    if (info === void 0 || info.mode !== void 0 || info.type !== "other") return info;
    return { ...info, type: await this.classifyRemoteType(host, secret, remotePath, follow) };
  }
  async classifyRemoteType(host, secret, remotePath, follow) {
    const path4 = shJoin([remotePath]);
    const command = follow ? `if [ -d ${path4} ]; then echo directory; elif [ -f ${path4} ]; then echo file; else echo other; fi` : `if [ -L ${path4} ]; then echo symlink; elif [ -d ${path4} ]; then echo directory; elif [ -f ${path4} ]; then echo file; else echo other; fi`;
    try {
      const result = await this.exec(host, secret, command, 15e3);
      const kind = result.stdout.trim();
      if (result.code === 0 && (kind === "file" || kind === "directory" || kind === "symlink" || kind === "other")) return kind;
    } catch {
    }
    return "other";
  }
  /** The symlink target. A non-link rejects; the caller decides which errors mean that. */
  async sftpReadLink(host, secret, remotePath) {
    const session = await this.sftp(host, secret);
    return readLinkOf(session, remotePath);
  }
  /**
   * Whether `remotePath` can be opened as a directory. The names are not read:
   * a mode-less `stat` only needs the open to succeed.
   */
  async sftpProbeDir(host, secret, remotePath) {
    const session = await this.sftp(host, secret);
    await probeOpenDir(session, remotePath);
  }
  /** Files and directories. The settings picker uses {@link sftpList}, which drops files. */
  async sftpReadDir(host, secret, remotePath) {
    const session = await this.sftp(host, secret);
    const rows = await readdir(session, remotePath);
    const entries = [];
    for (const row of rows) {
      if (row.filename === "." || row.filename === ".." || row.filename.includes("/") || row.filename.includes("\\")) continue;
      const attrs = attrsFrom(row.attrs, row.longname);
      entries.push({ name: row.filename, type: attrs.type, size: attrs.size, mtime: attrs.mtime });
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    return entries;
  }
  /** One byte window. A short reply is read again until the window is full or a read returns nothing. */
  async sftpReadAt(host, secret, remotePath, offset, length) {
    const session = await this.sftp(host, secret);
    return readOpenRange(session, remotePath, offset, length);
  }
  /** Chunks from one open handle. Stopping the generator closes the handle. */
  async *sftpReadChunks(host, secret, remotePath, signal) {
    if (signal?.aborted) throw new SshFailure("sftp read aborted", "sftp-read");
    const session = await this.sftp(host, secret);
    yield* readOpenChunks(session, remotePath, signal);
  }
  acquire(host, secret, requireTrust) {
    return claimPending(this.live, host.id, async () => {
      await this.reserve();
      try {
        const client = await connect(host, secret, (key) => {
          if (!requireTrust) return true;
          return fingerprintMatches(host.fingerprint, key);
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
    return new Promise((resolve2) => {
      this.waiters.push(() => {
        this.active += 1;
        resolve2();
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
  return new Promise((resolve2, reject) => {
    const client = new Client();
    const fail2 = (error) => {
      client.end();
      reject(error instanceof Error ? error : new SshFailure(String(error), "connect"));
    };
    client.once("ready", () => resolve2(client));
    client.once("error", fail2);
    client.on("error", () => void 0);
    const options = {
      ...sshConnectOptions(host),
      hostVerifier: (key) => accept(key)
    };
    if (host.auth === "password") {
      if (!secret.password) {
        fail2(new SshFailure("password is not stored for this host", "auth"));
        return;
      }
      options.password = secret.password;
    } else if (host.privateKeyPath.trim().length > 0) {
      void readFile(expandTildePath(host.privateKeyPath)).then((key) => {
        options.privateKey = key;
        if (secret.passphrase) options.passphrase = secret.passphrase;
        client.connect(options);
      }).catch(fail2);
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
  return new Promise((resolve2, reject) => {
    client.exec(request.command, {
      pty: { term: request.term, cols: request.cols, rows: request.rows }
    }, (error, stream) => {
      if (error) {
        reject(channelLimitMessage(error) ?? new SshFailure(error.message, "pty"));
        return;
      }
      resolve2(stream);
    });
  });
}
function openChannel(client, command, timeoutMs, stdin, onOutput) {
  let settled = false;
  let cause = "exit";
  let stream;
  let resolveDone = () => void 0;
  let rejectDone = () => void 0;
  const done = new Promise((resolve2, reject) => {
    resolveDone = resolve2;
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
  const emit = (which, text2) => {
    if (text2.length === 0 || onOutput === void 0) return;
    try {
      onOutput({ stream: which, text: text2 });
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
  const timer = timeoutMs > 0 ? setTimeout(() => stop("timeout"), Math.min(timeoutMs, 2 ** 31 - 1)) : void 0;
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
function openSftp(client, onFatal) {
  return new Promise((resolve2, reject) => {
    client.sftp((error, sftp) => {
      if (error) {
        reject(new SshFailure(error.message, "sftp"));
        return;
      }
      const api = sftp;
      api.on("error", () => {
        onFatal?.();
      });
      resolve2({
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
  return new Promise((resolve2, reject) => {
    sftp.stat(remotePath, (error, stats) => {
      if (error) reject(failureOf(error, "sftp-stat"));
      else resolve2({
        isDirectory: stats.isDirectory(),
        size: stats.size,
        mode: typeof stats.mode === "number" ? stats.mode : void 0,
        // Do not turn an absent permission field into `'other'`: callers must
        // know that the server did not answer the type question.
        type: typeof stats.mode === "number" ? listingType(stats) : void 0
      });
    });
  });
}
function statSize(sftp, remotePath) {
  return statInfo(sftp, remotePath).then((info) => info.size);
}
function readAll(sftp, remotePath) {
  return new Promise((resolve2, reject) => {
    sftp.readFile(remotePath, (error, data) => {
      if (error) reject(failureOf(error, "sftp-read"));
      else resolve2(data);
    });
  });
}
async function readAllCapped(sftp, remotePath, maxBytes, signal) {
  let total = 0;
  const parts = [];
  for await (const chunk of readOpenChunks(sftp, remotePath, signal)) {
    total += chunk.length;
    if (total > maxBytes) throw new SshFailure(`file is over the ${maxBytes} byte limit`, "sftp-read");
    parts.push(chunk);
  }
  return parts.length === 0 ? Buffer.alloc(0) : Buffer.concat(parts, total);
}
function writeAll(sftp, remotePath, body) {
  return new Promise((resolve2, reject) => {
    sftp.writeFile(remotePath, body, (error) => {
      if (error) reject(failureOf(error, "sftp-write"));
      else resolve2();
    });
  });
}
function makeDirectory(sftp, remotePath) {
  return new Promise((resolve2, reject) => {
    sftp.mkdir(remotePath, (error) => {
      if (error) reject(failureOf(error, "sftp-mkdir"));
      else resolve2();
    });
  });
}
function realpathOf(sftp, remotePath) {
  return new Promise((resolve2, reject) => {
    sftp.realpath(remotePath, (error, resolved) => {
      if (error) reject(failureOf(error, "sftp-realpath"));
      else resolve2(resolved);
    });
  });
}
async function probeOpenDir(sftp, remotePath) {
  const handle = await new Promise((resolve2, reject) => {
    sftp.opendir(remotePath, (error, opened) => {
      if (error || opened === void 0) reject(error === void 0 ? new SshFailure("sftp opendir failed", "sftp-list") : failureOf(error, "sftp-list"));
      else resolve2(opened);
    });
  });
  await new Promise((resolve2) => {
    sftp.close(handle, () => resolve2());
  });
}
function readdir(sftp, remotePath) {
  return new Promise((resolve2, reject) => {
    sftp.readdir(remotePath, (error, list) => {
      if (error) reject(failureOf(error, "sftp-list"));
      else resolve2(list);
    });
  });
}
var READ_CHUNK = 64 * 1024;
var LONGNAME_KIND = /^([dlbcps-])[r-][w-][xsStT-]/;
function listingType(stats, longname) {
  const link = typeof stats.isSymbolicLink === "function" && stats.isSymbolicLink();
  const file = typeof stats.isFile === "function" && stats.isFile();
  const fromMode = link ? "symlink" : stats.isDirectory() ? "directory" : file ? "file" : "other";
  if (typeof stats.mode === "number") return fromMode;
  const mark = LONGNAME_KIND.exec(longname ?? "")?.[1];
  if (mark === "d") return "directory";
  if (mark === "l") return "symlink";
  if (mark === "-") return "file";
  return fromMode;
}
function attrsFrom(stats, longname) {
  return {
    type: listingType(stats, longname),
    size: stats.size,
    mtime: typeof stats.mtime === "number" ? stats.mtime : 0,
    ...typeof stats.mode === "number" ? { mode: stats.mode } : {}
  };
}
function readLinkOf(sftp, remotePath) {
  return new Promise((resolve2, reject) => {
    sftp.readlink(remotePath, (error, target) => {
      if (error) reject(failureOf(error, "sftp-readlink"));
      else if (target === void 0) reject(new SshFailure("Response missing link info", "sftp-readlink"));
      else resolve2(target);
    });
  });
}
function remotePathWithin(root, candidate) {
  const rel = posix3.relative(posix3.normalize(root), posix3.normalize(candidate));
  return rel === "" || !rel.startsWith("..") && !posix3.isAbsolute(rel);
}
async function renameRemote(sftp, fromPath, toPath) {
  const call = (method) => new Promise((resolve2, reject) => {
    const done = (error) => {
      if (error) reject(failureOf(error, "sftp-rename"));
      else resolve2();
    };
    if (method === "ext" && sftp.ext_openssh_rename !== void 0) sftp.ext_openssh_rename(fromPath, toPath, done);
    else sftp.rename(fromPath, toPath, done);
  });
  if (sftp.ext_openssh_rename === void 0) {
    await call("standard");
    return;
  }
  try {
    await call("ext");
  } catch {
    await call("standard");
  }
}
async function attrsOf(sftp, remotePath, follow) {
  let stats;
  try {
    stats = await new Promise((resolve2, reject) => {
      const finish = (error, value) => {
        if (error) reject(error);
        else if (value === void 0) reject(new SshFailure("stat returned no attributes", follow ? "sftp-stat" : "sftp-lstat"));
        else resolve2(value);
      };
      if (follow) sftp.stat(remotePath, finish);
      else sftp.lstat(remotePath, finish);
    });
  } catch (error) {
    if (isSftpMissing(error)) return void 0;
    throw failureOf(error instanceof Error ? error : new Error(String(error)), follow ? "sftp-stat" : "sftp-lstat");
  }
  const info = attrsFrom(stats);
  if (info.mode !== void 0 || info.type !== "other") return info;
  if (!follow) {
    try {
      await readLinkOf(sftp, remotePath);
      return { ...info, type: "symlink" };
    } catch (error) {
      if (isSftpMissing(error) || isSftpPermissionDenied(error)) return info;
    }
  }
  try {
    await probeOpenDir(sftp, remotePath);
    return { ...info, type: "directory" };
  } catch (error) {
    if (isSftpMissing(error) || isSftpPermissionDenied(error)) return info;
    return info;
  }
}
function openRead(sftp, remotePath) {
  return new Promise((resolve2, reject) => {
    sftp.open(remotePath, "r", (error, handle) => {
      if (error || handle === void 0) reject(error === void 0 ? new SshFailure("sftp open failed", "sftp-read") : failureOf(error, "sftp-read"));
      else resolve2(handle);
    });
  });
}
function readAt(sftp, handle, position, length) {
  const buf = Buffer.alloc(length);
  return new Promise((resolve2, reject) => {
    sftp.read(handle, buf, 0, length, position, (error, bytesRead) => {
      if (error) reject(failureOf(error, "sftp-read"));
      else resolve2(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead));
    });
  });
}
function closeHandle(sftp, handle) {
  return new Promise((resolve2) => {
    sftp.close(handle, () => resolve2());
  });
}
async function readOpenRange(sftp, remotePath, offset, length) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
    throw new SshFailure("read range is not a non-negative safe integer", "sftp-read");
  }
  if (length === 0) return Buffer.alloc(0);
  const handle = await openRead(sftp, remotePath);
  try {
    const parts = [];
    let got = 0;
    while (got < length) {
      const chunk = await readAt(sftp, handle, offset + got, length - got);
      if (chunk.length === 0) break;
      parts.push(chunk);
      got += chunk.length;
    }
    if (parts.length === 0) return Buffer.alloc(0);
    const only = parts[0];
    if (parts.length === 1 && only !== void 0) return only;
    return Buffer.concat(parts, got);
  } finally {
    await closeHandle(sftp, handle);
  }
}
async function* readOpenChunks(sftp, remotePath, signal) {
  const handle = await openRead(sftp, remotePath);
  try {
    let position = 0;
    while (true) {
      if (signal?.aborted) throw new SshFailure("sftp read aborted", "sftp-read");
      const chunk = await readAt(sftp, handle, position, READ_CHUNK);
      if (chunk.length === 0) return;
      position += chunk.length;
      yield chunk;
    }
  } finally {
    await closeHandle(sftp, handle);
  }
}

// src/remote-write.ts
async function resolveCreatedPath(pool, host, secret, lexicalPath2) {
  let cursor = posix4.normalize(lexicalPath2);
  const missing = [];
  while (true) {
    try {
      const real = await pool.sftpRealpath(host, secret, cursor);
      return composeCreatedPath(real, missing);
    } catch (error) {
      if (!isSftpMissing(error)) {
        throw error;
      }
      if (cursor === "/") return composeCreatedPath("/", missing);
      missing.unshift(posix4.basename(cursor));
      const parent = posix4.dirname(cursor);
      if (parent === cursor) return composeCreatedPath(cursor, missing);
      cursor = parent;
    }
  }
}
function remoteVersionToken(version) {
  return `v1|${version.base}|${version.strong ?? ""}|${version.hash ?? ""}|${version.generation ?? ""}`;
}
function parseRemoteVersion(value) {
  const parts = String(value).split("|");
  if (parts.length !== 5 || parts[0] !== "v1") return void 0;
  const base = parts[1] ?? "";
  if (base.length === 0) return void 0;
  const generation = parts[4] === "" ? void 0 : Number(parts[4]);
  return {
    base,
    ...parts[2] === "" ? {} : { strong: parts[2] },
    ...parts[3] === "" ? {} : { hash: parts[3] },
    ...generation !== void 0 && Number.isSafeInteger(generation) ? { generation } : {}
  };
}
var VERSION_HASH_MAX_BYTES = 32 * 1024 * 1024;
async function remoteVersionEvidence(pool, host, secret, remotePath, signal, options = {}) {
  if (typeof pool.exec === "function") {
    const quoted = shJoin([remotePath]);
    const command = `stat -c '%d:%i:%s:%y' -- ${quoted} 2>/dev/null || stat -f '%d:%i:%z:%m' ${quoted} 2>/dev/null`;
    try {
      const result = await pool.exec(host, secret, command, 1e4, signal);
      if (result.code === 0) {
        const line = result.stdout.trim().split("\n")[0]?.trim() ?? "";
        if (line.length > 0 && /\d+\.\d+/.test(line)) return { strong: line };
      }
    } catch (error) {
      if (signal?.aborted === true) throw error;
    }
  }
  if (options.hash !== true) return {};
  const limit = options.maxHashBytes ?? VERSION_HASH_MAX_BYTES;
  const digest = createHash2("sha256");
  let total = 0;
  try {
    for await (const chunk of pool.sftpReadChunks(host, secret, remotePath, signal)) {
      if (signal?.aborted === true) throw new Error("aborted");
      total += chunk.length;
      if (total > limit) return {};
      digest.update(chunk);
    }
    return { hash: digest.digest("hex") };
  } catch (error) {
    if (signal?.aborted === true) throw error;
    return {};
  }
}
async function remoteRoots(status, workspace, pool, host, secret, strict = false) {
  let workspaceRoot = posix4.normalize(workspace);
  try {
    workspaceRoot = await pool.sftpRealpath(host, secret, workspace);
  } catch (error) {
    if (strict && !isSftpMissing(error)) throw error;
  }
  return { workspaceRoot, tmp: status.roots.tmp, userTmp: status.roots.userTmp };
}
function fileCommand(status, mode, roots, script) {
  if (status.sandboxTool === "bwrap") {
    const profile = bwrapFileProfileArgs(mode, roots) ?? [];
    return shJoin(["bwrap", ...profile, "--chdir", roots.workspaceRoot, "--", "bash", "-c", script]);
  }
  const writable = mode === "workspace-write" ? fileWritableRoots(mode, roots) : [];
  return seatbeltBashCommand(mode, writable, roots.workspaceRoot, script);
}
function writeGuardScript(target, intent) {
  if (intent === void 0) return "";
  const quoted = shJoin([target]);
  if (intent.kind === "createIfAbsent") {
    return `if [ -e ${quoted} ] || [ -L ${quoted} ]; then echo 'remote target already exists' >&2; exit 23; fi`;
  }
  const version = parseRemoteVersion(intent.version);
  if (version?.strong !== void 0) {
    const expected = shJoin([version.strong]);
    return `actual=$(stat -c '%d:%i:%s:%y' -- ${quoted} 2>/dev/null || stat -f '%d:%i:%z:%m' ${quoted} 2>/dev/null || true); if [ "$actual" != ${expected} ]; then echo 'remote file version changed' >&2; exit 24; fi`;
  }
  if (version?.hash !== void 0) {
    const expected = shJoin([version.hash]);
    return `actual=$( (sha256sum ${quoted} 2>/dev/null || shasum -a 256 ${quoted} 2>/dev/null) | awk '{print $1}' ); if [ "$actual" != ${expected} ]; then echo 'remote file version changed' >&2; exit 24; fi`;
  }
  return `echo 'remote write requires strong or hash version evidence' >&2; exit 25`;
}
function lockScript(target, lockRoot) {
  const digest = createHash2("sha256").update(target).digest("hex").slice(0, 32);
  const lock = posix4.join(lockRoot, `.dsh-permission-remote-${digest}.lock`);
  const lockQuoted = shJoin([lock]);
  const lockDirQuoted = shJoin([`${lock}.d`]);
  return `if command -v flock >/dev/null 2>&1; then exec 9>${lockQuoted}; flock -x 9; else count=0; while ! mkdir ${lockDirQuoted} 2>/dev/null; do count=$((count + 1)); if [ "$count" -gt 200 ]; then echo 'remote write lock timeout' >&2; exit 75; fi; sleep 0.05; done; trap 'rmdir ${lockDirQuoted} 2>/dev/null || true' EXIT; fi`;
}
async function commitRemoteText(pool, host, secret, status, mode, roots, target, content, signal, fileMode, intent) {
  if (signal?.aborted === true) throw new FsError("aborted", "FS_ABORTED");
  if (mode !== "danger-full-access" && !status.sandbox.available) {
    throw new SandboxUnavailableError(mode, "remote sandbox probe failed");
  }
  const directory = posix4.dirname(target);
  const temp = posix4.join(directory, `.dsh-permission-remote-${randomBytes(8).toString("hex")}`);
  const atomic = atomicWriteScript(directory, temp, target, fileMode, { noClobber: intent?.kind === "createIfAbsent" });
  const lockRoot = status.roots.userTmp || status.roots.tmp || directory;
  const script = `set -e
mkdir -p ${shJoin([directory])}
${lockScript(target, lockRoot)}
${writeGuardScript(target, intent)}
${atomic}`;
  const wrapped = mode === "danger-full-access" ? script : fileCommand(status, mode, roots, script);
  const result = await pool.exec(host, secret, wrapped, 2e4, signal, content);
  if (result.code !== 0) {
    const stderr = result.stderr.trim();
    if (sandboxDenied(result.code, result.stderr)) {
      throw new FsError(`[sandbox: ${mode}] remote write denied: ${stderr || "sandbox denied"}`, "FS_SANDBOX_DENIED");
    }
    if (result.code === 23 || /remote target already exists/i.test(stderr)) {
      throw new FsError(stderr || "remote target already exists", "FS_NOT_OBSERVED");
    }
    if (result.code === 24 || /remote file version changed/i.test(stderr)) {
      throw new FsError(stderr || "remote file version changed", "FS_STALE_VERSION");
    }
    if (result.code === 25 || /requires strong or hash version evidence/i.test(stderr)) {
      throw new FsError(stderr || "remote write requires strong or hash version evidence", "FS_IO_ERROR");
    }
    if (/permission denied/i.test(stderr)) {
      throw new FsError(stderr || "remote write permission denied", "FS_PERMISSION_DENIED");
    }
    throw new Error(stderr || "remote write failed");
  }
}

// src/probe.ts
import { posix as posix5 } from "node:path";
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
function outputBlock(stdout, begin2, end, legacyCount) {
  const lines = stdout.split(/\r?\n/);
  const start = lines.indexOf(begin2);
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
    if (posix5.isAbsolute(line) && !/\s/.test(line)) return line;
  }
  return "";
}
function absoluteOr(value, fallback) {
  return posix5.isAbsolute(value) ? value : fallback;
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

// src/execute.ts
var require3 = createRequire2(import.meta.url);
var READ_CAP = 1024 * 1024;
var IMAGE_CAP = 8 * 1024 * 1024;
async function remoteFacts(pool, host, secret) {
  const uname = await pool.exec(host, secret, hostFactsCommand(), 2e4);
  return parseHostFacts(uname.stdout);
}
async function probeHost(pool, host, secret, resolveBinary = (pkg, platform) => resolveRgBinary(pkg, platform)) {
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
    const local = pkg === null ? null : resolveBinary(pkg, rgPlatformOf(os2, arch) ?? void 0);
    if (local !== null) {
      try {
        await pool.sftpUpload(host, secret, local, rgRemote);
        const check = await pool.exec(host, secret, `${shJoin([rgRemote])} --version`, 15e3);
        if (!check.timedOut && check.code === 0) {
          ripgrep = "uploaded";
          ripgrepPath = rgRemote;
        } else {
          ripgrep = "upload-failed";
        }
      } catch {
        ripgrep = "upload-failed";
      }
    } else {
      try {
        const check = await pool.exec(host, secret, `${shJoin([rgRemote])} --version`, 15e3);
        if (!check.timedOut && check.code === 0) {
          ripgrep = "uploaded";
          ripgrepPath = rgRemote;
        }
      } catch {
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
    return require3.resolve(`${pkg}/bin/rg`);
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
    join2(home, "remote", "ripgrep", platform, "rg")
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
async function effectiveMode(host, exec, args, toolName, subject, detail) {
  return host.resolveMode(exec, args.sandbox_permissions, args.justification, toolName, subject, detail);
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
function rootsFor(status, workspace, pool, host, secret) {
  return remoteRoots(status, workspace, pool, host, secret);
}
function sandboxWorkspaceRoot(route, exec) {
  const opened = workspaceBinding(exec.agent?.session?.header?.cwd);
  if (opened !== null && opened.hostId === route.hostId) return opened.remotePath;
  return route.remoteCwd;
}
function sandboxRoots(hostApi, route, exec, status, host, secret) {
  return rootsFor(status, sandboxWorkspaceRoot(route, exec), hostApi.pool, host, secret);
}
async function existingRemotePath(pool, host, secret, remotePath) {
  if (remotePath.trim().length === 0) return "";
  try {
    return await pool.sftpRealpath(host, secret, remotePath);
  } catch (error) {
    if (isSftpMissing(error)) return "";
    return posix6.normalize(remotePath);
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
    throw new SandboxUnavailableError2(mode, "remote sandbox probe failed");
  }
  throwIfAborted(exec.signal);
  const roots = await sandboxRoots(hostApi, route, exec, status, host, secret);
  const argv = commandArgv(status, mode, roots, workdir, command, await bashSnapshot(hostApi, host, exec.signal));
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
async function bashSnapshot(hostApi, host, signal) {
  if (host.loginEnv !== true || hostApi.loginEnvOf === void 0) return "";
  return hostApi.loginEnvOf(host, signal);
}
function commandArgv(status, mode, roots, workdir, command, snapshot) {
  const body = snapshot.length > 0 ? loginEnvApply(snapshot, command, workdir) : command;
  const inner = ["bash", "-c", body];
  if (mode === "danger-full-access" || !status.sandbox.available) {
    return `cd ${shJoin([workdir])} && ${shJoin(inner)}`;
  }
  if (status.sandboxTool === "bwrap") {
    const profile = bwrapProfileArgs(mode, roots.workspaceRoot) ?? [];
    return shJoin(["bwrap", ...profile, "--chdir", workdir, "--", ...inner]);
  }
  const writable = mode === "workspace-write" ? fileWritableRoots(mode, roots) : [];
  return seatbeltBashCommand(mode, writable, workdir, body);
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
    throw new SandboxUnavailableError2(mode, "remote sandbox probe failed");
  }
  const roots = await sandboxRoots(hostApi, route, exec, status, host, secret);
  const argv = commandArgv(status, mode, roots, workdir, command, await bashSnapshot(hostApi, host, exec.signal));
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
      }).then((result) => finishBackground(result, note, (text2) => job.append(text2))).catch((error) => ({
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
async function runReadImage(hostApi, route, args, save, exec) {
  throwIfAborted(exec?.signal);
  const host = requireHost(hostApi, route.hostId);
  const secret = await hostApi.secretOf(host);
  const remotePath = resolveRemotePath(String(args.file_path ?? ""), route.remoteCwd, route.placeholderCwd);
  const data = await withSignal(hostApi.pool.sftpRead(host, secret, remotePath, IMAGE_CAP, exec?.signal), exec?.signal);
  const image = await save(data, posix6.basename(remotePath));
  return { path: toModelPath(remotePath, route), image };
}
var PRESENT_CAP = 32 * 1024 * 1024;
var stagedPlaceholders = /* @__PURE__ */ new Set();
var stagedEpoch = 0;
async function removeStagedCopies(paths) {
  await Promise.all(paths.map(async (target) => {
    try {
      await rm(target, { force: true });
    } catch {
    }
  }));
}
async function clearStagedPresentFiles(only) {
  if (only !== void 0) {
    const paths = only.filter((target) => stagedPlaceholders.delete(target));
    await removeStagedCopies(paths);
    return;
  }
  stagedEpoch += 1;
  while (stagedPlaceholders.size > 0) {
    const paths = [...stagedPlaceholders];
    for (const target of paths) stagedPlaceholders.delete(target);
    await removeStagedCopies(paths);
  }
}
async function stagePresentFiles(hostApi, route, files, exec) {
  throwIfAborted(exec?.signal);
  const host = requireHost(hostApi, route.hostId);
  const secret = await hostApi.secretOf(host);
  const staged = [];
  for (const file of files) {
    const requested = String(file.path ?? "").trim();
    if (requested.length === 0) throw new FsError2("Cannot present a file: the path is empty", "FS_NOT_FOUND");
    const remotePath = resolveRemotePath(requested, route.remoteCwd, route.placeholderCwd);
    const ticket = stagedEpoch;
    let info;
    try {
      if (typeof hostApi.pool.sftpAttrs === "function") {
        const attrs = await withSignal(hostApi.pool.sftpAttrs(host, secret, remotePath, false), exec?.signal);
        if (attrs === void 0) throw new FsError2(`no file at the remote path ${remotePath}`, "FS_NOT_FOUND");
        info = { isDirectory: attrs.type === "directory", size: attrs.size, type: attrs.type };
      } else {
        info = await withSignal(hostApi.pool.sftpStat(host, secret, remotePath), exec?.signal);
      }
    } catch (error) {
      if (exec?.signal?.aborted === true) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (isSftpMissing(error)) throw new FsError2(`Cannot present ${requested}: no file at the remote path ${remotePath}`, "FS_NOT_FOUND");
      if (error instanceof FsError2) throw error;
      throw new Error(`Cannot present ${requested}: the remote host could not stat ${remotePath}: ${message}`);
    }
    if (info.isDirectory) {
      throw new FsError2(`Cannot present ${requested}: the remote path ${remotePath} is a directory, not a file`, "FS_NOT_REGULAR_FILE");
    }
    if (info.type !== void 0 && info.type !== "file") {
      throw new FsError2(`Cannot present ${requested}: the remote path ${remotePath} is not a regular file`, "FS_NOT_REGULAR_FILE");
    }
    if (info.size > PRESENT_CAP) {
      throw new FsError2(`Cannot present ${requested}: the remote file is ${info.size} bytes, over the ${PRESENT_CAP} byte delivery limit`, "FS_TOO_LARGE");
    }
    let data;
    try {
      data = await withSignal(hostApi.pool.sftpRead(host, secret, remotePath, PRESENT_CAP, exec?.signal), exec?.signal);
    } catch (error) {
      if (exec?.signal?.aborted === true) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (/over the .*byte limit/i.test(message)) {
        throw new FsError2(`Cannot present ${requested}: the remote file is over the ${PRESENT_CAP} byte delivery limit`, "FS_TOO_LARGE");
      }
      throw error;
    }
    const placeholder = toModelPath(remotePath, route);
    await withSignal(writeFileAtomic(placeholder, data, { mode: 384, dirMode: 448 }), exec?.signal);
    if (ticket !== stagedEpoch) {
      await rm(placeholder, { force: true });
      throw new Error(`Cannot present ${requested}: the plugin is unloading`);
    }
    stagedPlaceholders.add(placeholder);
    staged.push({ path: placeholder, bytes: data.length });
  }
  return staged;
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
    const absolute = posix6.isAbsolute(line) ? line : posix6.join(base, line);
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
async function runWorkingDirectory(hostApi, route, args, exec, setDirectory, allow) {
  if (args.cd === void 0 || args.cd === "") return { cwd: route.placeholderCwd, remote: route.remoteCwd };
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
  allow?.(remote, local);
  await mkdir(local, { recursive: true });
  if (exec.agent === void 0) throw new Error("working_directory requires an agent Session");
  const cwd = await setDirectory(local);
  return { cwd, remote };
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
  return new Promise((resolve2, reject) => {
    const fail2 = () => reject(abortError());
    signal.addEventListener("abort", fail2, { once: true });
    const detach = () => signal.removeEventListener("abort", fail2);
    work.then(resolve2, reject).then(detach, detach);
  });
}
function capturedText(text2, truncated) {
  if (!truncated) return text2;
  return `${text2}
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
import { constants as fsConstants } from "node:fs";
import { lstat, open, stat } from "node:fs/promises";
import { dirname as dirnameLocal, isAbsolute, posix as posix7 } from "node:path";
import { writeFileAtomic as writeFileAtomic2 } from "@deepseek-ai/dsh-atomic-write";
import { sandboxDenialMarker } from "@deepseek-ai/dsh-sandbox";
var READ_CAP2 = 1024 * 1024;
var HOME_BEGIN = "__DSH_OPS_HOME_BEGIN__";
var HOME_END = "__DSH_OPS_HOME_END__";
var LOCAL_READ_CHUNK = 64 * 1024;
var NO_TRANSFER_LIMITS = { maxBytes: 0, timeoutMs: 0 };
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
    throw new Error(`${sandboxDenialMarker(standing)}
${opsEscalationHint(subject)}`);
  }
  const mode = await hostApi.resolveMode(exec, requested, args.justification, toolName, subject, detail);
  if (mode === "danger-full-access") return;
  throw new Error(`${sandboxDenialMarker(mode)}
${opsEscalationHint(subject)}`);
}
function requireTrusted(host) {
  if (host.fingerprint.trim().length > 0) return;
  throw new Error(`SSH host ${hostLabel(host)} is not trusted yet; open Settings \u2192 SSH hosts, test the connection, and trust its fingerprint first`);
}
function clip(text2, max = 160) {
  const flat = text2.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}\u2026`;
}
async function runSshExec(hostApi, host, args, exec) {
  const command = String(args.command ?? "");
  if (command.trim().length === 0) throw new Error("command is required");
  const workdir = typeof args.workdir === "string" ? args.workdir.trim() : "";
  if (workdir.length > 0 && !posix7.isAbsolute(workdir)) throw new Error(`workdir must be an absolute remote path: ${workdir}`);
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
  const bytes = await withSignal(hostApi.pool.sftpRead(host, secret, remotePath, READ_CAP2, exec?.signal), exec?.signal);
  const text2 = bytes.toString("utf8");
  const all = text2.split(/\n/);
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
async function runSshWorkspace(hostApi, host, args, exec) {
  throwIfAborted(exec?.signal);
  const requested = String(args.directory ?? "").trim();
  if (requested.length === 0) throw new Error("directory is required");
  if (!posix7.isAbsolute(requested) && requested !== "~" && !requested.startsWith("~/")) {
    throw new Error(`directory must be an absolute remote path or start with "~/": ${requested}`);
  }
  if (posix7.isAbsolute(requested)) refuseFilesystemRoot(requested, host);
  const create = hostApi.createWorkspace;
  if (create === void 0) throw new Error("this build cannot register a workspace for an SSH host");
  await requireOps(
    hostApi,
    host,
    exec ?? {},
    args,
    "ssh_workspace",
    hostSubject(host, "remote workspace registration"),
    {
      en: `register workspace ${clip(requested)} on ${hostLabel(host)}. This adds a sidebar workspace the user can open onto that machine. This session does not enter it`,
      zh: `\u5728 ${hostLabel(host)} \u4E0A\u6CE8\u518C\u5DE5\u4F5C\u533A ${clip(requested)}\u3002\u4FA7\u680F\u4F1A\u591A\u51FA\u4E00\u4E2A\u53EF\u6253\u5F00\u7684\u8FDC\u7AEF\u5DE5\u4F5C\u533A\uFF0C\u6253\u5F00\u540E\u7684\u4F1A\u8BDD\u5728\u90A3\u53F0\u673A\u5668\u4E0A\u3002\u8FD9\u4E2A\u4F1A\u8BDD\u4E0D\u4F1A\u8FDB\u5165`
    }
  );
  throwIfAborted(exec?.signal);
  const secret = await hostApi.secretOf(host);
  const remotePath = await resolveOpsPath(hostApi, host, secret, requested, "directory");
  refuseFilesystemRoot(remotePath, host);
  const title = typeof args.title === "string" ? args.title : void 0;
  const created = await create(host, remotePath, title, exec?.signal);
  return {
    host: opsHostView(host),
    remotePath: created.remotePath,
    title: created.title,
    // The registry reuses an existing row and keeps its title, so a caller that
    // passed one cannot assume it was applied.
    created: created.created
  };
}
function renderSshWorkspace(value) {
  const host = value.host;
  const label = host === void 0 ? "remote host" : host.name || host.address;
  const title = String(value.title ?? "");
  const path4 = String(value.remotePath ?? "");
  if (value.created === false) {
    return `workspace already registered: "${title}" for ${path4} on ${label}; nothing changed, and the existing title was kept`;
  }
  return `workspace added: "${title}" for ${path4} on ${label}. This session stays here. Open the workspace from the list to start a session on that machine`;
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
    before = (await withSignal(hostApi.pool.sftpRead(host, secret, target, READ_CAP2, exec.signal), exec.signal)).toString("utf8");
  } catch (error) {
    if (exec.signal?.aborted === true || error instanceof Error && error.name === "AbortError") throw error;
    if (!isRemoteMissing(error)) throw error;
    before = null;
    mode = void 0;
  }
  const directory = posix7.dirname(target);
  const tmp = posix7.join(directory, `.dsh-permission-remote-${randomBytes2(8).toString("hex")}`);
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
  return isSftpMissing(error);
}
function refuseFilesystemRoot(remotePath, host) {
  if (normalizeRemoteDirectory(remotePath) !== "/") return;
  throw new Error(`refusing to register "/": a workspace rooted at the remote filesystem root covers every path on ${hostLabel(host)}`);
}
async function resolveOpsPath(hostApi, host, secret, requested, field = "file_path") {
  const path4 = requested.trim();
  if (path4.length === 0) throw new Error(`${field} is required`);
  if (posix7.isAbsolute(path4)) return posix7.normalize(path4);
  if (path4 === "~") return remoteHome(hostApi, host, secret);
  if (path4.startsWith("~/")) {
    const home = await remoteHome(hostApi, host, secret);
    return posix7.normalize(posix7.join(home, path4.slice(2)));
  }
  throw new Error(`${field} must be an absolute remote path or start with "~/": ${requested}`);
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
    if (posix7.isAbsolute(home)) return home;
  }
  return void 0;
}
function transferCap(limits) {
  return limits.maxBytes > 0 ? limits.maxBytes : Number.MAX_SAFE_INTEGER;
}
function transferDeadline(exec, limits) {
  if (limits.timeoutMs <= 0) return exec.signal;
  const timeout = AbortSignal.timeout(limits.timeoutMs);
  return exec.signal === void 0 ? timeout : AbortSignal.any([exec.signal, timeout]);
}
function transferAbortError(cancelSignal, limits, error) {
  if (limits.timeoutMs <= 0) return error;
  if (!(error instanceof Error) || error.name !== "AbortError") return error;
  if (cancelSignal?.aborted === true) return error;
  const timedOut = new Error(`transfer timed out after ${limits.timeoutMs} ms (the deadline is the "Transfer timeout" setting; 0 means unlimited)`);
  timedOut.name = "TimeoutError";
  return timedOut;
}
function requireLocalPath(value, field = "local_path") {
  const requested = String(value ?? "").trim();
  if (requested.length === 0) throw new Error(`${field} is required`);
  if (!isAbsolute(requested)) {
    throw new Error(`${field} must be an absolute path on the machine running DSH: ${requested}`);
  }
  return requested;
}
async function readLocalCapped(path4, maxBytes, signal) {
  let info;
  try {
    info = await lstat(path4);
  } catch (error) {
    if (signal?.aborted === true) throw error;
    if (error?.code === "ENOENT") {
      throw new Error(`no such local file: ${path4}`);
    }
    throw new Error(`cannot read local file ${path4}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (info.isSymbolicLink()) throw new Error(`refusing to transfer a symbolic link: ${path4}`);
  if (info.isDirectory()) throw new Error(`local path is a directory: ${path4}`);
  if (!info.isFile()) throw new Error(`local path is not a regular file: ${path4}`);
  let handle;
  try {
    const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
    handle = await open(path4, fsConstants.O_RDONLY | noFollow);
  } catch (error) {
    if (error?.code === "ELOOP") {
      throw new Error(`refusing to transfer a symbolic link: ${path4}`);
    }
    throw error;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error(`local path is not a regular file: ${path4}`);
    if (maxBytes > 0 && opened.size > maxBytes) {
      throw new Error(`local file is ${opened.size} bytes, over the ${maxBytes} byte transfer ceiling`);
    }
    const parts = [];
    let total = 0;
    while (true) {
      throwIfAborted(signal);
      const room = maxBytes > 0 ? Math.min(LOCAL_READ_CHUNK, maxBytes + 1 - total) : LOCAL_READ_CHUNK;
      const chunk = Buffer.allocUnsafe(room);
      const { bytesRead } = await handle.read(chunk, 0, room, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (maxBytes > 0 && total > maxBytes) {
        throw new Error(`local file is over the ${maxBytes} byte transfer ceiling`);
      }
      parts.push(chunk.subarray(0, bytesRead));
    }
    return parts.length === 0 ? Buffer.alloc(0) : Buffer.concat(parts, total);
  } finally {
    await handle.close().catch(() => void 0);
  }
}
async function remoteTargetOf(hostApi, host, secret, remotePath, follow, signal) {
  try {
    return await withSignal(hostApi.pool.sftpAttrs(host, secret, remotePath, follow), signal);
  } catch (error) {
    if (signal?.aborted === true) throw error;
    if (isSftpMissing(error)) return void 0;
    throw error;
  }
}
async function withTransferDeadline(work, deadline, cancelSignal, limits) {
  if (deadline === void 0 || limits.timeoutMs <= 0) {
    try {
      return await work;
    } catch (error) {
      throw transferAbortError(cancelSignal, limits, error);
    }
  }
  let onAbort;
  const aborted = new Promise((_resolve, reject) => {
    onAbort = () => reject(abortError());
    if (deadline.aborted) onAbort();
    else deadline.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } catch (error) {
    throw transferAbortError(cancelSignal, limits, error);
  } finally {
    if (onAbort !== void 0) deadline.removeEventListener("abort", onAbort);
    work.catch(() => void 0);
  }
}
function throwIfTransferAborted(signal, cancelSignal, limits) {
  if (signal?.aborted !== true) return;
  throw transferAbortError(cancelSignal, limits, abortError());
}
async function runSshUpload(hostApi, host, args, exec, limits = NO_TRANSFER_LIMITS) {
  const localPath = requireLocalPath(args.local_path);
  const remoteRequest = String(args.remote_path ?? "").trim();
  if (remoteRequest.length === 0) throw new Error("remote_path is required");
  await requireOps(
    hostApi,
    host,
    exec,
    args,
    "ssh_upload",
    hostSubject(host, "remote file upload"),
    {
      en: `upload ${clip(localPath, 120)} to ${clip(remoteRequest, 120)} on ${hostLabel(host)}`,
      zh: `\u628A ${clip(localPath, 120)} \u4E0A\u4F20\u5230 ${hostLabel(host)} \u7684 ${clip(remoteRequest, 120)}`
    }
  );
  throwIfAborted(exec.signal);
  const signal = transferDeadline(exec, limits);
  const secret = await withTransferDeadline(hostApi.secretOf(host), signal, exec.signal, limits);
  const body = await withTransferDeadline(readLocalCapped(localPath, limits.maxBytes, signal), signal, exec.signal, limits);
  throwIfTransferAborted(signal, exec.signal, limits);
  const remotePath = await withTransferDeadline(
    resolveOpsPath(hostApi, host, secret, remoteRequest, "remote_path"),
    signal,
    exec.signal,
    limits
  );
  if (posix7.normalize(remotePath) === "/") throw new Error("remote_path must name a file, not the filesystem root");
  const existing = await withTransferDeadline(
    remoteTargetOf(hostApi, host, secret, remotePath, false, signal),
    signal,
    exec.signal,
    limits
  );
  if (existing !== void 0 && existing.type !== "file") {
    throw new Error(`remote path is not a regular file (${existing.type}): ${remotePath}`);
  }
  const directory = posix7.dirname(remotePath);
  const tmp = posix7.join(directory, `.dsh-permission-remote-${randomBytes2(8).toString("hex")}`);
  const script = atomicWriteScript(directory, tmp, remotePath, existing?.mode);
  const result = await withTransferDeadline(hostApi.pool.exec(host, secret, script, limits.timeoutMs, signal, body), signal, exec.signal, limits);
  if (result.code !== 0) throw new Error(result.stderr || "remote upload failed");
  return {
    host: opsHostView(host),
    localPath,
    remotePath,
    bytes: body.length,
    operation: existing === void 0 ? "create" : "update",
    maxBytes: limits.maxBytes,
    timeoutMs: limits.timeoutMs
  };
}
function renderOpsUpload(value) {
  const host = value.host;
  const label = host === void 0 ? "remote host" : host.name || host.address;
  const bytes = typeof value.bytes === "number" ? value.bytes : 0;
  const action = value.operation === "update" ? "updated" : "created";
  const limits = transferLimitText(value);
  return `uploaded ${String(value.localPath ?? "")} \u2192 ${String(value.remotePath ?? "")} on ${label} (${bytes} bytes, ${action}${limits})`;
}
async function runSshDownload(hostApi, host, args, exec, limits = NO_TRANSFER_LIMITS) {
  const localPath = requireLocalPath(args.local_path);
  const remoteRequest = String(args.remote_path ?? "").trim();
  if (remoteRequest.length === 0) throw new Error("remote_path is required");
  await requireOps(
    hostApi,
    host,
    exec,
    args,
    "ssh_download",
    hostSubject(host, "remote file download"),
    {
      en: `download ${clip(remoteRequest, 120)} from ${hostLabel(host)} to ${clip(localPath, 120)}`,
      zh: `\u628A ${hostLabel(host)} \u7684 ${clip(remoteRequest, 120)} \u4E0B\u8F7D\u5230 ${clip(localPath, 120)}`
    }
  );
  throwIfAborted(exec.signal);
  const signal = transferDeadline(exec, limits);
  const secret = await withTransferDeadline(hostApi.secretOf(host), signal, exec.signal, limits);
  const remotePath = await withTransferDeadline(
    resolveOpsPath(hostApi, host, secret, remoteRequest, "remote_path"),
    signal,
    exec.signal,
    limits
  );
  if (posix7.normalize(remotePath) === "/") throw new Error("remote_path must name a file, not the filesystem root");
  await assertLocalTarget(localPath);
  const info = await withTransferDeadline(
    remoteTargetOf(hostApi, host, secret, remotePath, false, signal),
    signal,
    exec.signal,
    limits
  );
  if (info === void 0) throw new Error(`no file at remote path: ${remotePath}`);
  if (info.type !== "file") {
    throw new Error(`remote path is not a regular file (${info.type}): ${remotePath}`);
  }
  if (limits.maxBytes > 0 && info.size > limits.maxBytes) {
    throw new Error(`remote file is ${info.size} bytes, over the ${limits.maxBytes} byte transfer ceiling`);
  }
  throwIfTransferAborted(signal, exec.signal, limits);
  const data = await withTransferDeadline(
    withSignal(hostApi.pool.sftpRead(host, secret, remotePath, transferCap(limits), signal), signal),
    signal,
    exec.signal,
    limits
  );
  throwIfTransferAborted(signal, exec.signal, limits);
  await withTransferDeadline(
    withSignal(writeFileAtomic2(localPath, data, { mode: 384, dirMode: 448 }), signal),
    signal,
    exec.signal,
    limits
  );
  return {
    host: opsHostView(host),
    remotePath,
    localPath,
    bytes: data.length,
    maxBytes: limits.maxBytes,
    timeoutMs: limits.timeoutMs
  };
}
async function assertLocalTarget(localPath) {
  const parent = dirnameLocal(localPath);
  if (parent.length > 0 && parent !== localPath) {
    const parentInfo = await stat(parent).catch(() => void 0);
    if (parentInfo === void 0) throw new Error(`local parent directory does not exist: ${parent}`);
    if (!parentInfo.isDirectory()) throw new Error(`local parent is not a directory: ${parent}`);
  }
  const existing = await lstat(localPath).catch(() => void 0);
  if (existing === void 0) return;
  if (existing.isDirectory()) throw new Error(`local path is a directory: ${localPath}`);
  if (existing.isSymbolicLink()) throw new Error(`refusing to write through a symbolic link: ${localPath}`);
}
function renderOpsDownload(value) {
  const host = value.host;
  const label = host === void 0 ? "remote host" : host.name || host.address;
  const bytes = typeof value.bytes === "number" ? value.bytes : 0;
  const limits = transferLimitText(value);
  return `downloaded ${String(value.remotePath ?? "")} from ${label} \u2192 ${String(value.localPath ?? "")} (${bytes} bytes${limits})`;
}
function transferLimitText(value) {
  const maxBytes = typeof value.maxBytes === "number" ? value.maxBytes : 0;
  const timeoutMs = typeof value.timeoutMs === "number" ? value.timeoutMs : 0;
  const ceiling = maxBytes > 0 ? `${maxBytes} byte ceiling` : "no byte ceiling";
  const deadline = timeoutMs > 0 ? `${timeoutMs} ms timeout` : "no timeout";
  return `; ${ceiling}, ${deadline}`;
}

// src/session-relocate.ts
import { realpathSync as realpathSync2 } from "node:fs";
import { chmod, mkdir as mkdir2, open as open2, readFile as readFile2, readdir as readdir2, rename, rm as rm2, stat as stat2, writeFile } from "node:fs/promises";
import { basename, dirname, join as joinPath, relative as relativePath, resolve as resolvePath, sep } from "node:path";
import { constants as zconst, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { resolveDshHome as resolveDshHome2 } from "@deepseek-ai/dsh-home-paths";
var ZSTD_MAGIC = 4247762216;
var SESSION_FORMAT_VERSION = 4;
var CHECKSUM_OPTIONS = { params: { [zconst.ZSTD_c_checksumFlag]: 1 } };
var LOG_NAME = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/;
var MAX_REWRITE_BYTES = 64 * 1024 * 1024;
var HEADER_PROBE_BYTES = 4 * 1024;
function zstdAvailable() {
  return typeof zstdCompressSync === "function" && typeof zstdDecompressSync === "function";
}
function encodeSegment(raw) {
  if (raw.length === 0) throw new Error("cannot encode an empty path segment");
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  let out = "";
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return out;
}
function projectKey(cwd) {
  if (cwd.length === 0) throw new Error("cannot encode an empty project path");
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i += 1) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}
function isEscapingRelative(rel) {
  return rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith("../");
}
function sitsUnderRoot(cwd, root) {
  const rel = relativePath(root, cwd);
  if (rel === "") return true;
  if (isEscapingRelative(rel)) return false;
  return !(rel.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(rel));
}
function rootCandidateSpellings(root) {
  const trimmed = root.replace(/[\\/]+$/, "");
  const out = [trimmed];
  try {
    const real = realpathSync2(trimmed).replace(/[\\/]+$/, "");
    if (real !== trimmed) out.push(real);
  } catch {
  }
  return out;
}
function sitsUnder(cwd, roots) {
  return roots.some((root) => sitsUnderRoot(cwd, root));
}
function mapPlaceholderCwd(cwd, olds, newRoot) {
  const trimmedNew = newRoot.replace(/[\\/]+$/, "");
  for (const old of olds) {
    const trimmedOld2 = old.replace(/[\\/]+$/, "");
    const rest = relativePath(trimmedOld2, cwd);
    if (rest === "") return trimmedNew;
    if (isEscapingRelative(rest) || rest.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(rest)) continue;
    return joinPath(trimmedNew, rest);
  }
  const trimmedOld = olds[0].replace(/[\\/]+$/, "");
  const lexical = cwd.slice(trimmedOld.length).replace(/^[\\/]+/, "");
  return lexical.length === 0 ? trimmedNew : joinPath(trimmedNew, lexical);
}
function scanLogFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at byte ${offset}`);
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? singleSegment ? 1 : 0 : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (; ; ) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = blockHeader >>> 1 & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`);
      offset += blockType === 1 ? 1 : blockSize;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    if (offset > buffer.length) return { frames, tornStart: start };
    frames.push({ start, end: offset });
  }
  return { frames };
}
function decodeHeader(bytes, compression) {
  if (compression) {
    const scan = scanLogFrames(bytes);
    if (scan.frames.length === 0) throw new Error("the log holds no complete header frame");
    const text3 = zstdDecompressSync(bytes.subarray(scan.frames[0].start, scan.frames[0].end));
    if (text3.length === 0 || text3.indexOf(10) !== text3.length - 1) throw new Error("first frame is not exactly one header line");
    return { header: JSON.parse(text3.subarray(0, -1).toString("utf8")), headerEnd: scan.frames[0].end };
  }
  const cut = bytes.indexOf(10);
  const text2 = cut < 0 ? bytes : bytes.subarray(0, cut);
  return { header: JSON.parse(text2.toString("utf8")), headerEnd: cut < 0 ? bytes.length : cut + 1 };
}
async function readLogHeader(path4, size) {
  if (size === 0) throw new Error("the log is empty");
  const handle = await open2(path4, "r");
  try {
    let want = Math.min(size, HEADER_PROBE_BYTES);
    for (; ; ) {
      const chunk = Buffer.alloc(want);
      const { bytesRead } = await handle.read(chunk, 0, want, 0);
      const view = chunk.subarray(0, bytesRead);
      const compression = view.length >= 4 && view.readUInt32LE(0) === ZSTD_MAGIC;
      try {
        const decoded = decodeHeader(view, compression);
        return { ...decoded, compression };
      } catch (error) {
        const torn = compression && scanLogFrames(view).frames.length === 0;
        if (!torn || bytesRead >= size || bytesRead < want) throw error;
        want = Math.min(size, want * 4);
      }
    }
  } finally {
    await handle.close();
  }
}
function rewriteHeader(buffer, expectedId, to, oldRoots, newRoot, compression) {
  if (!compression) return rewritePlainHeader(buffer, expectedId, to, oldRoots, newRoot);
  const scan = scanLogFrames(buffer);
  if (scan.frames.length === 0) throw new Error("the log holds no complete header frame");
  const first = scan.frames[0];
  const decoded = decodeHeader(buffer.subarray(first.start, first.end), true);
  const header = decoded.header;
  if (header.type !== "session") throw new Error(`first record is not a Session header (type ${String(header.type)})`);
  if (header.id !== expectedId) throw new Error(`header id ${String(header.id)} does not match directory ${expectedId}`);
  if (typeof header.cwd !== "string" || header.cwd.length === 0) throw new Error("header carries no cwd");
  const rewritten = { ...header, version: header.version ?? SESSION_FORMAT_VERSION, cwd: to };
  const plaintext = Buffer.from(`${JSON.stringify(rewritten)}
`, "utf8");
  const head = zstdCompressSync(plaintext, CHECKSUM_OPTIONS);
  const parts = [head];
  const expected = [void 0];
  let retainedOldRoot = false;
  for (let i = 1; i < scan.frames.length; i += 1) {
    const frame = buffer.subarray(scan.frames[i].start, scan.frames[i].end);
    const event = decodeEventFrame(frame);
    const next = event === void 0 ? void 0 : retargetChangeEvent(event, oldRoots, newRoot);
    if (next !== void 0) {
      parts.push(zstdCompressSync(Buffer.from(`${JSON.stringify(next)}
`, "utf8"), CHECKSUM_OPTIONS));
      expected.push(next);
    } else {
      if (event === void 0) retainedOldRoot = true;
      parts.push(frame);
      expected.push(void 0);
    }
  }
  if (scan.tornStart !== void 0) parts.push(buffer.subarray(scan.tornStart));
  const bytes = Buffer.concat(parts);
  const check = scanLogFrames(bytes);
  if (check.frames.length !== scan.frames.length) {
    throw new Error(`complete frame count changed: ${scan.frames.length} \u2192 ${check.frames.length}`);
  }
  const back = decodeHeader(bytes.subarray(check.frames[0].start, check.frames[0].end), true).header;
  if (back.cwd !== to) throw new Error("rewritten header does not read back with the new cwd");
  if (back.id !== expectedId) throw new Error("rewritten header does not read back with the same id");
  for (let i = 1; i < check.frames.length; i += 1) {
    const before = buffer.subarray(scan.frames[i].start, scan.frames[i].end);
    const after = bytes.subarray(check.frames[i].start, check.frames[i].end);
    const want = expected[i];
    if (want === void 0) {
      if (before.length !== after.length || !before.equals(after)) throw new Error(`frame ${i} changed`);
    } else {
      const got = decodeEventFrame(after);
      if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`frame ${i} did not rewrite as expected`);
    }
  }
  if (scan.tornStart !== void 0) {
    if (check.tornStart === void 0) throw new Error("the rewritten log lost its torn tail");
    if (!bytes.subarray(check.tornStart).equals(buffer.subarray(scan.tornStart))) throw new Error("the torn tail changed");
  }
  return { bytes, retainedOldRoot };
}
function decodeEventFrame(frame) {
  try {
    const text2 = zstdDecompressSync(frame).toString("utf8");
    const line = text2.endsWith("\n") ? text2.slice(0, -1) : text2;
    const value = JSON.parse(line);
    return typeof value === "object" && value !== null ? value : void 0;
  } catch {
    return void 0;
  }
}
function isWorkingDirectoryChange(event) {
  if (event === void 0 || event.type !== "working-directory/change") return false;
  const data = event.data;
  return typeof data === "object" && data !== null && typeof data.cwd === "string";
}
function retargetChangeEvent(event, oldRoots, newRoot) {
  if (!isWorkingDirectoryChange(event)) return void 0;
  if (!sitsUnder(event.data.cwd, oldRoots)) return void 0;
  return { ...event, data: { ...event.data, cwd: mapPlaceholderCwd(event.data.cwd, oldRoots, newRoot) } };
}
function rewritePlainHeader(buffer, expectedId, to, oldRoots, newRoot) {
  const cut = buffer.indexOf(10);
  const headerText = cut < 0 ? buffer : buffer.subarray(0, cut);
  const header = JSON.parse(headerText.toString("utf8"));
  if (header.type !== "session") throw new Error(`first record is not a Session header (type ${String(header.type)})`);
  if (header.id !== expectedId) throw new Error(`header id ${String(header.id)} does not match directory ${expectedId}`);
  if (typeof header.cwd !== "string" || header.cwd.length === 0) throw new Error("header carries no cwd");
  const rewritten = { ...header, version: header.version ?? SESSION_FORMAT_VERSION, cwd: to };
  const headerBytes = Buffer.from(`${JSON.stringify(rewritten)}
`, "utf8");
  if (cut < 0) return { bytes: headerBytes, retainedOldRoot: false };
  const body = buffer.subarray(cut + 1).toString("utf8");
  if (body.length === 0) return { bytes: headerBytes, retainedOldRoot: false };
  const trailingNewline = body.endsWith("\n");
  const lines = body.split("\n");
  if (trailingNewline) lines.pop();
  let retainedOldRoot = false;
  const out = [];
  for (const line of lines) {
    if (line.length === 0) {
      out.push(line);
      continue;
    }
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      event = void 0;
    }
    if (event === void 0) {
      retainedOldRoot = true;
      out.push(line);
      continue;
    }
    const next = retargetChangeEvent(event, oldRoots, newRoot);
    out.push(next === void 0 ? line : JSON.stringify(next));
  }
  const bodyText = out.join("\n") + (trailingNewline ? "\n" : "");
  return { bytes: Buffer.concat([headerBytes, Buffer.from(bodyText, "utf8")]), retainedOldRoot };
}
function logVersion(name2) {
  const match = LOG_NAME.exec(name2);
  if (match === null) return void 0;
  if (match[1] === void 0) return 0;
  const version = Number(match[1]);
  return version === 0 ? void 0 : version;
}
function newestLog(names) {
  let best;
  for (const name2 of names) {
    const match = LOG_NAME.exec(name2);
    if (match === null) continue;
    if (match[1] !== void 0 && Number(match[1]) === 0) continue;
    const version = match[1] === void 0 ? 0 : Number(match[1]);
    if (best === void 0 || version > best.version) best = { name: name2, version };
  }
  return best;
}
async function relocateSessions(options) {
  const summary = { relocated: [], skippedLive: [], failed: [] };
  if (!zstdAvailable()) {
    summary.failed.push({ id: "*", reason: "this Node build has no zlib Zstandard API, so session headers cannot be rewritten" });
    return summary;
  }
  const sessionsRoot = joinPath(options.dshHome ?? resolveDshHome2(), "sessions");
  let projects;
  try {
    projects = await readdir2(sessionsRoot);
  } catch (error) {
    if (error.code === "ENOENT") return summary;
    throw error;
  }
  const supplied = options.liveSessionIds;
  const liveOf = typeof supplied === "function" ? supplied : () => supplied ?? /* @__PURE__ */ new Set();
  const oldRoots = rootCandidateSpellings(options.oldRoot);
  const touchedProjects = /* @__PURE__ */ new Set();
  for (const project of projects) {
    const projectDir = joinPath(sessionsRoot, project);
    let entries;
    try {
      entries = await readdir2(projectDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const dir = joinPath(projectDir, entry);
      let names;
      try {
        names = await readdir2(dir);
      } catch {
        continue;
      }
      const temps = names.filter((name2) => /\.relocate-\d+\.tmp$/.test(name2));
      for (const name2 of temps) {
        const pid = Number(/\.relocate-(\d+)\.tmp$/.exec(name2)[1]);
        if (pid === process.pid || !isProcessAlive(pid)) await rm2(joinPath(dir, name2), { force: true }).catch(() => void 0);
      }
      names = names.filter((name2) => !/\.relocate-\d+\.tmp$/.test(name2));
      const log = newestLog(names);
      if (log === void 0) continue;
      const moved = await relocateSession(
        { sessionsRoot, projectDir, dir, entry, logName: log.name, options, oldRoots, liveOf, summary }
      );
      if (moved) touchedProjects.add(projectDir);
    }
  }
  for (const projectDir of touchedProjects) {
    try {
      if ((await readdir2(projectDir)).length === 0) await rm2(projectDir, { recursive: true, force: false });
    } catch {
    }
  }
  return summary;
}
async function relocateSession(context) {
  const { sessionsRoot, projectDir, dir, entry, logName, options, oldRoots, liveOf, summary } = context;
  const fail2 = (id2, reason) => {
    summary.failed.push({ id: id2, reason });
    return false;
  };
  const logPath = joinPath(dir, logName);
  let size;
  try {
    size = (await stat2(logPath)).size;
  } catch (error) {
    return fail2(entry, `unreadable log: ${text(error)}`);
  }
  let head;
  try {
    head = await readLogHeader(logPath, size);
  } catch (error) {
    return fail2(entry, `unreadable header: ${text(error)}`);
  }
  const header = head.header;
  const cwd = header.cwd;
  if (header.type !== "session" || typeof cwd !== "string" || cwd.length === 0) return false;
  const id = typeof header.id === "string" ? header.id : "";
  if (!sitsUnder(cwd, oldRoots)) {
    if (options.repairBodies === true && sitsUnder(cwd, rootCandidateSpellings(options.newRoot))) {
      if (id.length === 0 || encodeSegment(id) !== entry) return false;
      return rewriteLogAt(dir, logName, id, cwd, oldRoots, options.newRoot, head.compression, summary, liveOf);
    }
    return false;
  }
  if (id.length === 0) return fail2(entry, "header carries no id");
  if (encodeSegment(id) !== entry) return fail2(id, `directory name ${entry} does not match encodeSegment(id) ${encodeSegment(id)}`);
  const to = mapPlaceholderCwd(cwd, oldRoots, options.newRoot);
  const destDir = joinPath(sessionsRoot, projectKey(to), encodeSegment(id));
  const here = basename(projectDir);
  const expectedProject = projectKey(cwd);
  if (here !== expectedProject && here !== projectKey(to)) {
    return fail2(id, `project directory ${here} matches neither projectKey(cwd) ${expectedProject} nor projectKey(newCwd): the layout encoder drifted`);
  }
  if (liveOf().has(id)) {
    summary.skippedLive.push(id);
    return false;
  }
  if (resolvePath(dir) === resolvePath(destDir)) {
    if (!await rewriteLogAt(destDir, logName, id, to, oldRoots, options.newRoot, head.compression, summary, liveOf)) return false;
    summary.relocated.push({ id, from: cwd, to });
    return true;
  }
  let destExists = false;
  try {
    destExists = (await stat2(destDir)).isDirectory();
  } catch (error) {
    if (error.code !== "ENOENT") return fail2(id, text(error));
  }
  if (destExists) {
    return reconcileExistingDestination({ ...context, destDir, id, from: cwd, to });
  }
  return moveAndRewrite({ ...context, destDir, id, from: cwd, to, compression: head.compression });
}
async function moveAndRewrite(context) {
  const { destDir, dir, id, to, from, logName, summary, compression, oldRoots, options, liveOf } = context;
  const fail2 = (reason) => {
    summary.failed.push({ id, reason });
    return false;
  };
  const sourceLog = joinPath(dir, logName);
  let rewritten;
  let srcMode;
  let initialSize = 0;
  let initialMtime = 0;
  try {
    const info = await stat2(sourceLog);
    if (info.size > MAX_REWRITE_BYTES) throw new Error(`the log is ${info.size} bytes, above the ${MAX_REWRITE_BYTES}-byte rewrite ceiling`);
    srcMode = info.mode & 511;
    initialSize = info.size;
    initialMtime = info.mtimeMs;
    const bytes = await readFile2(sourceLog);
    const result = rewriteHeader(bytes, id, to, oldRoots, options.newRoot, compression);
    rewritten = result.bytes;
    if (result.retainedOldRoot) {
      summary.retainedRoots ??= [];
      if (!summary.retainedRoots.includes(options.oldRoot)) summary.retainedRoots.push(options.oldRoot);
    }
  } catch (error) {
    return fail2(`refusing to move the session: ${text(error)}`);
  }
  const staged = `${logName}.relocate-${process.pid}.tmp`;
  try {
    await writeFile(joinPath(dir, staged), rewritten, { mode: 384 });
    if (srcMode !== void 0) await chmod(joinPath(dir, staged), srcMode);
  } catch (error) {
    await rm2(joinPath(dir, staged)).catch(() => void 0);
    return fail2(`could not stage the rewritten log: ${text(error)}`);
  }
  if (liveOf().has(id)) {
    await rm2(joinPath(dir, staged)).catch(() => void 0);
    summary.skippedLive.push(id);
    return false;
  }
  try {
    const now = await stat2(sourceLog);
    if (now.size !== initialSize || now.mtimeMs !== initialMtime) {
      await rm2(joinPath(dir, staged)).catch(() => void 0);
      return fail2("the log changed while it was being relocated; leaving it in place");
    }
  } catch (error) {
    await rm2(joinPath(dir, staged)).catch(() => void 0);
    return fail2(`could not re-check the log before moving it: ${text(error)}`);
  }
  try {
    await mkdir2(dirname(destDir), { recursive: true });
    await rename(dir, destDir);
  } catch (error) {
    await rm2(joinPath(dir, staged)).catch(() => void 0);
    return fail2(`could not move the session directory: ${text(error)}`);
  }
  try {
    await rename(joinPath(destDir, staged), joinPath(destDir, logName));
  } catch (error) {
    let rolledBack = true;
    try {
      await rename(destDir, dir);
      await rm2(joinPath(dir, staged)).catch(() => void 0);
    } catch {
      rolledBack = false;
    }
    return fail2(`could not publish the rewritten log${rolledBack ? " (the move was rolled back)" : ` (ROLLBACK FAILED \u2014 the session directory is left at ${destDir} with its header still naming the old root)`}: ${text(error)}`);
  }
  summary.relocated.push({ id, from, to });
  return true;
}
async function reconcileExistingDestination(context) {
  const { destDir, dir, id, from, to, summary, oldRoots, liveOf } = context;
  const fail2 = (reason) => {
    summary.failed.push({ id, reason });
    return false;
  };
  let names;
  try {
    names = await readdir2(destDir);
  } catch (error) {
    return fail2(`unreadable destination: ${text(error)}`);
  }
  const destLog = newestLog(names);
  if (destLog === void 0) return fail2("the destination holds no committed generation to reconcile with");
  const sourceVersion = logVersion(context.logName);
  if (sourceVersion === void 0 || destLog.version !== sourceVersion) {
    return fail2(`the destination holds generation v${destLog.version}, the source v${String(sourceVersion)}; refusing an automatic reconcile across generations`);
  }
  const destPath = joinPath(destDir, destLog.name);
  let destHeader;
  let size;
  try {
    size = (await stat2(destPath)).size;
    destHeader = (await readLogHeader(destPath, size)).header;
  } catch (error) {
    return fail2(`unreadable destination header: ${text(error)}`);
  }
  if (destHeader.id !== id) {
    return fail2(`the destination already holds session ${String(destHeader.id)}; refusing to overwrite it`);
  }
  if (destHeader.cwd === to) {
    const compression = destLog.name.endsWith(".zstd");
    if (!await rewriteLogAt(destDir, destLog.name, id, to, oldRoots, context.options.newRoot, compression, summary, liveOf)) return false;
    try {
      await rm2(dir, { recursive: true, force: false });
      return true;
    } catch (error) {
      return fail2(`the destination is already correct, but the stale source could not be removed: ${text(error)}`);
    }
  }
  if (destHeader.cwd === from) {
    const compression = destLog.name.endsWith(".zstd");
    if (!await rewriteLogAt(destDir, destLog.name, id, to, oldRoots, context.options.newRoot, compression, summary, liveOf)) return false;
    try {
      await rm2(dir, { recursive: true, force: false });
    } catch (error) {
      summary.failed.push({ id, reason: `the session was repaired at its destination, but the stale source could not be removed: ${text(error)}` });
    }
    summary.relocated.push({ id, from, to });
    return true;
  }
  return fail2(`the destination header names ${String(destHeader.cwd)}, which is neither the old nor the new root; refusing to touch it`);
}
async function rewriteLogAt(dir, logName, expectedId, to, oldRoots, newRoot, compression, summary, liveOf) {
  const path4 = joinPath(dir, logName);
  try {
    const beforeStat = await stat2(path4);
    const size = beforeStat.size;
    if (size > MAX_REWRITE_BYTES) throw new Error(`the log is ${size} bytes, above the ${MAX_REWRITE_BYTES}-byte rewrite ceiling`);
    if (liveOf?.().has(expectedId) === true) {
      summary.skippedLive.push(expectedId);
      return false;
    }
    const bytes = await readFile2(path4);
    const result = rewriteHeader(bytes, expectedId, to, oldRoots, newRoot, compression);
    if (result.retainedOldRoot) {
      const retained = oldRoots[0] ?? "";
      if (retained.length > 0) {
        summary.retainedRoots ??= [];
        if (!summary.retainedRoots.includes(retained)) summary.retainedRoots.push(retained);
      }
    }
    if (liveOf?.().has(expectedId) === true) {
      summary.skippedLive.push(expectedId);
      return false;
    }
    const afterStat = await stat2(path4);
    if (afterStat.size !== beforeStat.size || afterStat.mtimeMs !== beforeStat.mtimeMs) {
      throw new Error("the log changed while it was being rewritten");
    }
    await publish(path4, result.bytes);
    const published = await readFile2(path4);
    const back = (await readLogHeader(path4, published.length)).header;
    if (back.id !== expectedId) throw new Error(`the published log reads back with id ${String(back.id)}`);
    if (back.cwd !== to) throw new Error(`the published log reads back with cwd ${String(back.cwd)}`);
    if (compression) {
      const before = scanLogFrames(bytes);
      const after = scanLogFrames(published);
      if (after.frames.length !== before.frames.length) throw new Error("the published log lost complete frames");
      if (after.tornStart === void 0 !== (before.tornStart === void 0)) throw new Error("the published log changed the torn tail state");
    } else {
      const beforeCut = bytes.indexOf(10);
      const afterCut = published.indexOf(10);
      const beforeLines = beforeCut < 0 ? 0 : bytes.subarray(beforeCut + 1).toString("utf8").split("\n").length;
      const afterLines = afterCut < 0 ? 0 : published.subarray(afterCut + 1).toString("utf8").split("\n").length;
      if (beforeCut < 0 || afterCut < 0 || beforeLines !== afterLines) {
        throw new Error("the published plaintext log changed its event count");
      }
    }
    return true;
  } catch (error) {
    summary.failed.push({ id: expectedId, reason: `could not rewrite the header at ${path4}: ${text(error)}` });
    return false;
  }
}
async function publish(path4, bytes) {
  await mkdir2(dirname(path4), { recursive: true });
  let mode;
  try {
    mode = (await stat2(path4)).mode & 511;
  } catch {
    mode = void 0;
  }
  const temp = `${path4}.relocate-${process.pid}.tmp`;
  await writeFile(temp, bytes, { mode: 384 });
  if (mode !== void 0) await chmod(temp, mode);
  await rename(temp, path4);
}
async function sessionLogExists(dshHome, cwd, id) {
  const segment = encodeSegment(id);
  const sessionsRoot = joinPath(dshHome, "sessions");
  try {
    if (newestLog(await readdir2(joinPath(sessionsRoot, projectKey(cwd), segment))) !== void 0) return true;
  } catch {
  }
  let projects;
  try {
    projects = await readdir2(sessionsRoot);
  } catch {
    return false;
  }
  for (const project of projects) {
    try {
      if (newestLog(await readdir2(joinPath(sessionsRoot, project, segment))) !== void 0) return true;
    } catch {
    }
  }
  return false;
}
function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
function text(error) {
  return error instanceof Error ? error.message : String(error);
}

// src/migration-state.ts
import { readFile as readFile3 } from "node:fs/promises";
import { join as join3 } from "node:path";
import { writeFileAtomic as writeFileAtomic3 } from "@deepseek-ai/dsh-atomic-write";
import { resolveDshHome as resolveDshHome3 } from "@deepseek-ai/dsh-home-paths";
var STATE_FILE_NAME = "dsh-permission-remote.migration.json";
var STATE_VERSION = 1;
var STATE_MODE = 384;
function emptyMigrationState() {
  return { supersededRemoteRoots: [], pendingSessionGrouping: [] };
}
function migrationStatePath(env = process.env) {
  return join3(resolveDshHome3(env.DSH_HOME || void 0, env), "data", "dsh-permission-remote", STATE_FILE_NAME);
}
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function normalizeRootList(value) {
  if (!Array.isArray(value)) return [];
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const root = item.trim();
    if (root.length === 0) continue;
    if (!(root.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(root) || root.startsWith("\\\\"))) continue;
    if (seen.has(root)) continue;
    seen.add(root);
    out.push(root);
  }
  return out;
}
function normalizePendingList(value) {
  if (!Array.isArray(value)) return [];
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const item of value) {
    if (!isRecord2(item)) continue;
    const path4 = typeof item.path === "string" ? item.path.trim() : "";
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (path4.length === 0 || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    out.push({ path: path4, id });
  }
  return out;
}
function parseMigrationState(raw) {
  if (!isRecord2(raw)) return emptyMigrationState();
  return {
    supersededRemoteRoots: normalizeRootList(raw.supersededRemoteRoots),
    pendingSessionGrouping: normalizePendingList(raw.pendingSessionGrouping)
  };
}
function serialize(state) {
  return `${JSON.stringify({
    version: STATE_VERSION,
    supersededRemoteRoots: state.supersededRemoteRoots,
    pendingSessionGrouping: state.pendingSessionGrouping
  }, null, 2)}
`;
}
async function readMigrationState(env = process.env) {
  let text2;
  try {
    text2 = await readFile3(migrationStatePath(env), "utf8");
  } catch (error) {
    const code = error.code;
    if (code === "ENOENT") return { state: emptyMigrationState() };
    return { state: emptyMigrationState(), problem: `the migration bookkeeping could not be read: ${code ?? String(error)}`, readError: true };
  }
  let raw;
  try {
    raw = JSON.parse(text2);
  } catch {
    return { state: emptyMigrationState(), problem: "the migration bookkeeping file is not valid JSON" };
  }
  const state = parseMigrationState(raw);
  if (isRecord2(raw) && raw.version !== void 0 && raw.version !== STATE_VERSION) {
    return { state, problem: `the migration bookkeeping was written by a different version (${String(raw.version)}); reading what it can` };
  }
  return { state };
}
async function writeMigrationState(state, env = process.env) {
  await writeFileAtomic3(migrationStatePath(env), serialize(state), { mode: STATE_MODE, dirMode: 448 });
}

// src/migrate.ts
import { constants } from "node:fs";
import { copyFile, lstat as lstat2, mkdir as mkdir3, open as open3, readdir as readdir3, readlink, realpath, rmdir, stat as stat3, symlink } from "node:fs/promises";
import { basename as basename2, dirname as dirname2, isAbsolute as isAbsolute2, join as join4, relative, resolve } from "node:path";
var COMPARE_CHUNK = 64 * 1024;
var NOFOLLOW = constants.O_NOFOLLOW;
async function pathKind(target, follow = false) {
  try {
    const info = follow ? await stat3(target) : await lstat2(target);
    if (info.isSymbolicLink()) return "symlink";
    if (info.isDirectory()) return "dir";
    if (info.isFile()) return "file";
    return "other";
  } catch {
    return "missing";
  }
}
async function isEmptyDir(target) {
  return (await readdir3(target)).length === 0;
}
async function countTree(root) {
  let count = 0;
  for (const entry of await readdir3(root, { withFileTypes: true })) {
    count += entry.isDirectory() ? await countTree(join4(root, entry.name)) : 1;
  }
  return count;
}
function within(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || !rel.startsWith("..") && !isAbsolute2(rel);
}
async function physicalPath(target) {
  const resolved = resolve(target);
  try {
    return await realpath(resolved);
  } catch {
    const tail = [];
    let cursor = resolved;
    for (; ; ) {
      const parent = dirname2(cursor);
      if (parent === cursor) return resolved;
      tail.push(basename2(cursor));
      cursor = parent;
      let ancestor;
      try {
        ancestor = await realpath(cursor);
      } catch {
        continue;
      }
      tail.reverse();
      return join4(ancestor, ...tail);
    }
  }
}
async function resolvesInside(rootReal, target) {
  return within(rootReal, await physicalPath(target));
}
async function sameContent(a, b) {
  const [left, right] = await Promise.all([stat3(a), stat3(b)]);
  if (!left.isFile() || !right.isFile()) return false;
  if (left.size !== right.size) return false;
  const [leftHandle, rightHandle] = await Promise.all([open3(a, "r"), open3(b, "r")]);
  try {
    const leftBytes = Buffer.alloc(COMPARE_CHUNK);
    const rightBytes = Buffer.alloc(COMPARE_CHUNK);
    for (; ; ) {
      const [leftRead, rightRead] = await Promise.all([
        leftHandle.read(leftBytes, 0, COMPARE_CHUNK, null),
        rightHandle.read(rightBytes, 0, COMPARE_CHUNK, null)
      ]);
      if (leftRead.bytesRead !== rightRead.bytesRead) return false;
      if (leftRead.bytesRead === 0) return true;
      const leftChunk = leftBytes.subarray(0, leftRead.bytesRead);
      const rightChunk = rightBytes.subarray(0, rightRead.bytesRead);
      if (!leftChunk.equals(rightChunk)) return false;
    }
  } finally {
    await Promise.all([leftHandle.close(), rightHandle.close()]);
  }
}
async function planMerge(oldRoot, newRoot, strategy, plan, rel = "") {
  const sourceDir = rel.length === 0 ? oldRoot : join4(oldRoot, rel);
  for (const entry of await readdir3(sourceDir, { withFileTypes: true })) {
    const childRel = rel.length === 0 ? entry.name : `${rel}/${entry.name}`;
    const source = join4(oldRoot, childRel);
    const target = join4(newRoot, childRel);
    const kind = await pathKind(target);
    if (entry.isSymbolicLink() || kind === "symlink" || kind === "other") {
      if (entry.isSymbolicLink() && kind === "missing") plan.links.push({ source, target, rel: childRel });
      else plan.conflicts.push(childRel);
      continue;
    }
    if (entry.isDirectory()) {
      if (kind === "file") {
        plan.conflicts.push(childRel);
        continue;
      }
      plan.directories.push(target);
      await planMerge(oldRoot, newRoot, strategy, plan, childRel);
      continue;
    }
    if (kind === "missing") {
      plan.copies.push({ source, target, rel: childRel });
      continue;
    }
    if (kind === "dir") {
      plan.conflicts.push(childRel);
      continue;
    }
    if (await sameContent(source, target)) {
      plan.skipped += 1;
      continue;
    }
    plan.conflicts.push(childRel);
    if (strategy === "overwrite") plan.overwrites.push({ source, target, rel: childRel });
  }
}
async function planRemoteRoot(oldRoot, newRoot, strategy = "auto") {
  const from = resolve(oldRoot);
  const to = resolve(newRoot);
  const plan = {
    oldRoot: from,
    newRoot: to,
    action: "unchanged",
    targetWasEmpty: false,
    copyTree: false,
    directories: [],
    copies: [],
    links: [],
    overwrites: [],
    conflicts: [],
    skipped: 0
  };
  if (from === to) return plan;
  if (within(from, to) || within(to, from)) {
    throw new Error("the new remote root must not be inside the old one, or the old one inside it");
  }
  const [fromReal, toReal] = await Promise.all([physicalPath(from), physicalPath(to)]);
  if (within(fromReal, toReal) || within(toReal, fromReal)) {
    throw new Error("the new remote root must not be inside the old one, or the old one inside it");
  }
  const oldKind = await pathKind(from, true);
  if (oldKind !== "dir" && oldKind !== "missing") throw new Error(`the current remote root ${from} is not a directory`);
  if (await pathKind(to, true) === "file") throw new Error(`the target ${to} exists and is not a directory`);
  if (oldKind === "missing") return { ...plan, action: "copied", targetWasEmpty: true };
  const targetWasEmpty = await pathKind(to, true) === "missing" || await isEmptyDir(to);
  if (targetWasEmpty) {
    return { ...plan, action: "copied", targetWasEmpty: true, copyTree: true };
  }
  const merged = { ...plan, action: "merged", targetWasEmpty: false };
  await planMerge(from, to, strategy, merged);
  return merged;
}
function plannedReport(plan) {
  return {
    oldRoot: plan.oldRoot,
    newRoot: plan.newRoot,
    action: plan.action,
    targetWasEmpty: plan.targetWasEmpty,
    // A whole-tree copy learns its count while copying; see the callers.
    copied: plan.copyTree ? 0 : plan.copies.length + plan.links.length,
    skipped: plan.skipped,
    overwritten: plan.overwrites.length,
    conflicts: [...plan.conflicts]
  };
}
async function overwriteRegularFile(source, target) {
  const info = await lstat2(target);
  if (!info.isFile()) {
    const error = new Error(`refusing to replace ${target}`);
    error.code = "EEXIST";
    throw error;
  }
  if (typeof NOFOLLOW !== "number") {
    await copyFile(source, target);
    return;
  }
  const src = await open3(source, constants.O_RDONLY);
  try {
    const dest = await open3(target, constants.O_WRONLY | constants.O_TRUNC | NOFOLLOW);
    try {
      const bytes = Buffer.alloc(COMPARE_CHUNK);
      for (; ; ) {
        const read = await src.read(bytes, 0, COMPARE_CHUNK, null);
        if (read.bytesRead === 0) break;
        let offset = 0;
        while (offset < read.bytesRead) {
          const wrote = await dest.write(bytes, offset, read.bytesRead - offset);
          if (wrote.bytesWritten === 0) throw new Error(`could not write ${target}`);
          offset += wrote.bytesWritten;
        }
      }
    } finally {
      await dest.close();
    }
  } finally {
    await src.close();
  }
}
async function copyEntry(source, target, rootReal) {
  if (!await resolvesInside(rootReal, target)) {
    throw new Error(`refusing to write ${target}: it resolves outside the new remote root`);
  }
  const info = await lstat2(source);
  if (info.isSymbolicLink()) {
    await symlink(await readlink(source), target);
    return;
  }
  if (info.isDirectory()) {
    await mkdir3(target);
    for (const name2 of await readdir3(source)) await copyEntry(join4(source, name2), join4(target, name2), rootReal);
    return;
  }
  if (info.isFile()) {
    await copyFile(source, target, constants.COPYFILE_EXCL);
  }
}
async function assertDistinctRoots(plan, rootReal) {
  const oldReal = await physicalPath(plan.oldRoot);
  if (within(oldReal, rootReal) || within(rootReal, oldReal)) {
    throw new Error("the new remote root must not be inside the old one, or the old one inside it");
  }
}
async function openNewRoot(plan) {
  await assertDistinctRoots(plan, await physicalPath(plan.newRoot));
  const before = await pathKind(plan.newRoot);
  await mkdir3(plan.newRoot, { recursive: true });
  const rootReal = await realpath(plan.newRoot);
  try {
    await assertDistinctRoots(plan, rootReal);
  } catch (error) {
    if (before === "missing") await rmdir(plan.newRoot).catch(() => void 0);
    throw error;
  }
  return rootReal;
}
async function runMigration(plan) {
  if (plan.action === "unchanged") return plannedReport(plan);
  if (plan.copyTree) {
    const kind = await pathKind(plan.newRoot, true);
    if (kind === "file") throw new Error(`the target ${plan.newRoot} is no longer a directory`);
    if (kind === "dir" && !await isEmptyDir(plan.newRoot)) {
      throw new Error(`the target ${plan.newRoot} is no longer empty; nothing was copied and nothing was overwritten`);
    }
    const copied2 = await countTree(plan.oldRoot);
    const rootReal2 = await openNewRoot(plan);
    for (const name2 of await readdir3(plan.oldRoot)) {
      await copyEntry(join4(plan.oldRoot, name2), join4(plan.newRoot, name2), rootReal2);
    }
    return { ...plannedReport(plan), copied: copied2 };
  }
  const rootReal = await openNewRoot(plan);
  let copied = 0;
  let overwritten = 0;
  const conflicts = [...plan.conflicts];
  for (const dir of plan.directories) {
    if (!await resolvesInside(rootReal, dir)) {
      throw new Error(`refusing to create ${dir}: it resolves outside the new remote root`);
    }
    const kind = await pathKind(dir);
    if (kind === "symlink" || kind === "file" || kind === "other") {
      conflicts.push(relative(plan.newRoot, dir).split("\\").join("/"));
      continue;
    }
    await mkdir3(dir, { recursive: true });
  }
  for (const step of plan.copies) {
    if (!await resolvesInside(rootReal, step.target)) {
      throw new Error(`refusing to write ${step.target}: it resolves outside the new remote root`);
    }
    try {
      await copyFile(step.source, step.target, constants.COPYFILE_EXCL);
      copied += 1;
    } catch (error) {
      if (error.code === "EEXIST") {
        conflicts.push(step.rel);
        continue;
      }
      throw error;
    }
  }
  for (const step of plan.links) {
    if (!await resolvesInside(rootReal, step.target)) {
      throw new Error(`refusing to write ${step.target}: it resolves outside the new remote root`);
    }
    try {
      await symlink(await readlink(step.source), step.target);
      copied += 1;
    } catch (error) {
      if (error.code === "EEXIST") {
        conflicts.push(step.rel);
        continue;
      }
      throw error;
    }
  }
  for (const step of plan.overwrites) {
    if (!await resolvesInside(rootReal, step.target)) {
      throw new Error(`refusing to write ${step.target}: it resolves outside the new remote root`);
    }
    try {
      await overwriteRegularFile(step.source, step.target);
      overwritten += 1;
    } catch (error) {
      const code = error.code;
      if (code === "EEXIST" || code === "ELOOP") {
        conflicts.push(step.rel);
        continue;
      }
      throw error;
    }
  }
  return {
    ...plannedReport(plan),
    copied,
    overwritten,
    conflicts
  };
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
var REMOTE_WORKSPACE_CONTEXT = "remote-workspace:directory";
function remoteWorkspaceContextText(route) {
  if (route.kind !== "remote") return "";
  return `This workspace is a remote directory on an SSH host. The session's working directory is a local placeholder that maps to the real remote directory ${JSON.stringify(route.remoteCwd)}. File tools keep returning placeholder paths \u2014 pass those back unchanged. bash runs on that SSH host, so in commands use that quoted remote directory for absolute paths, never the local placeholder.`;
}
function windowsShellGuardReason(remote) {
  return remote ? WINDOWS_SHELL_DENIED : void 0;
}
function withoutWindowsShells(tools, remote) {
  if (!remote) return tools;
  return tools.filter((tool) => !isWindowsShell(tool.name));
}

// src/shadow.ts
var ROUTED_TOOLS = ["bash", "read_image", "glob", "grep", "working_directory", "terminal_open", "present"];
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
import { mkdir as mkdir4 } from "node:fs/promises";
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
function shellKind(path4) {
  const base = path4.slice(Math.max(path4.lastIndexOf("/"), path4.lastIndexOf("\\")) + 1);
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
function parseShellProbe(text2, label) {
  const shells = [];
  const seen = /* @__PURE__ */ new Set();
  const add = (path4) => {
    if (!path4.startsWith("/")) return;
    const kind = shellKind(path4);
    if (kind.length === 0 || WINDOWS_SHELLS2.has(kind) || seen.has(kind)) return;
    seen.add(kind);
    shells.push({ path: path4, name: `${label} \xB7 ${kind}`, args: shellArgs(kind) });
  };
  for (const line of text2.split("\n")) {
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
  await mkdir4(cwd, { recursive: true }).catch(() => void 0);
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
    this.done = new Promise((resolve2, reject) => {
      this.resolveDone = resolve2;
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
    return this.track(new Promise((resolve2, reject) => {
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
        resolve2();
        return;
      }
      let finished = false;
      const settle = (error) => {
        if (finished) return;
        finished = true;
        if (error === void 0) resolve2();
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

// src/remote-fs.ts
import path2 from "node:path";
import { posix as posix9 } from "node:path";
import { symbols as symbols2 } from "@deepseek-ai/cordis";
import {
  FsError as FsError3,
  FsTargetKey
} from "@deepseek-ai/dsh-fs";
import { SandboxUnavailableError as SandboxUnavailableError3 } from "@deepseek-ai/dsh-sandbox";

// src/workspaces.ts
import { posix as posix8 } from "node:path";
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
  const base = posix8.basename(remotePath.replace(/\/+$/, "")) || remotePath;
  if (current === base) return taggedTitle(host, title);
  return title;
}
function candidateRoots(env) {
  return canonicalRoutingRoots(env);
}
function workspaceRoute(workspacePath, env = process.env) {
  for (const root of candidateRoots(env)) {
    const route = routeUnderRoot(root, workspacePath);
    if (route.kind === "remote") return { hostId: route.hostId, remotePath: route.remoteCwd };
  }
  return null;
}
function remotePathInside(root, remoteCwd) {
  const rel = posix8.relative(root, remoteCwd);
  const leaves = rel === ".." || rel.startsWith("../") || posix8.isAbsolute(rel);
  return rel === "" || !leaves;
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

// src/remote-fs.ts
var TEXT_CAP = 32 * 1024 * 1024;
var REALPATH_TTL_MS = 3e3;
var ATTR_TTL_MS = 5e3;
var META_CAP = 512;
var MARKER = Symbol("dsh-permission-remote.remote-fs");
var REQUIRED = [
  "resolve",
  "lstat",
  "stat",
  "listDir",
  "readText",
  "streamText",
  "readBytes",
  "readByteRange",
  "writeText",
  "editText",
  "contains",
  "watch"
];
function remoteFsInstalled(ctx) {
  try {
    const service = ctx.get("fs");
    return typeof service === "object" && service !== null && marked(unwrap2(service));
  } catch {
    return false;
  }
}
function installRemoteFs(ctx, access, options) {
  let service;
  try {
    service = ctx.get("fs");
  } catch (error) {
    ctx.logger?.warn(`[@dsh-permission-remote] remote file tree skipped: filesystem service is unavailable (${errorText(error)})`);
    return void 0;
  }
  if (typeof service !== "object" || service === null) {
    ctx.logger?.warn("[@dsh-permission-remote] remote file tree skipped: filesystem service is unavailable");
    return void 0;
  }
  const fs = unwrap2(service);
  if (marked(fs)) {
    ctx.logger?.warn("[@dsh-permission-remote] remote file tree already installed");
    return void 0;
  }
  const missing = REQUIRED.filter((name2) => typeof fs[name2] !== "function");
  if (missing.length > 0) {
    ctx.logger?.warn(`[@dsh-permission-remote] remote file tree skipped: filesystem is missing ${missing.join(", ")}`);
    return void 0;
  }
  const surface = fs;
  const identity = /* @__PURE__ */ new Map();
  const originals = bindOptionalMutations(surface, bindOriginals(surface));
  const now = options?.now ?? Date.now;
  const meta = new MetaCache(
    now,
    options?.metaTtlMs ?? REALPATH_TTL_MS,
    options?.attrTtlMs ?? ATTR_TTL_MS
  );
  const versions = /* @__PURE__ */ new Map();
  const descriptors = /* @__PURE__ */ new Map();
  const locks = /* @__PURE__ */ new Map();
  const runtime = { access, identity, originals, meta, now, versions, descriptors, locks };
  const restorers = [];
  try {
    restorers.push(replaceMethod(surface, "resolve", (requested, opts) => resolveRemote(runtime, requested, opts)));
    restorers.push(replaceMethod(surface, "lstat", (requested, opts, signal) => lstatRemote(runtime, requested, opts, signal)));
    restorers.push(replaceMethod(surface, "stat", (target, signal) => statRemote(runtime, target, signal)));
    restorers.push(replaceMethod(surface, "listDir", (target, signal) => listRemote(runtime, target, signal)));
    restorers.push(replaceMethod(surface, "readText", (target, signal) => readRemoteText(runtime, target, signal)));
    restorers.push(replaceMethod(surface, "streamText", (target, signal) => streamRemoteText(runtime, target, signal)));
    restorers.push(replaceMethod(surface, "readBytes", (target, signal, maxBytes) => readRemoteBytes(runtime, target, signal, maxBytes)));
    restorers.push(replaceMethod(surface, "readByteRange", (target, range, signal) => readRemoteRange(runtime, target, range, signal)));
    restorers.push(replaceMethod(surface, "contains", (parent, child) => containsRemote(runtime, parent, child)));
    restorers.push(replaceMethod(surface, "watch", (target, changed, signal) => watchRemote(runtime, target, changed, signal)));
    restorers.push(replaceMethod(surface, "writeText", (target, content, expected, signal, policy) => writeRemoteText(runtime, target, content, expected, signal, policy)));
    restorers.push(replaceMethod(surface, "editText", (target, edit, expected, signal, policy) => editRemoteText(runtime, target, edit, expected, signal, policy)));
    guardRemoteMutation(surface, originals, restorers, "patchText");
    guardRemoteMutation(surface, originals, restorers, "deleteFile");
    guardRemoteMutation(surface, originals, restorers, "moveFile");
    Object.defineProperty(fs, MARKER, { value: true, configurable: true, enumerable: false });
  } catch (error) {
    for (const restore of restorers) restore();
    ctx.logger?.warn(`[@dsh-permission-remote] remote file tree skipped: ${errorText(error)}`);
    return void 0;
  }
  const remove = (() => {
    for (const restore of restorers) restore();
    Reflect.deleteProperty(fs, MARKER);
  });
  remove.invalidateHost = (hostId) => {
    meta.invalidateHost(hostId);
    for (const [key, record] of identity) {
      if (record.hostId === hostId) identity.delete(key);
    }
    for (const key of versions.keys()) {
      if (key.startsWith(`${hostId}\0`)) versions.delete(key);
    }
    for (const key of descriptors.keys()) {
      if (key.startsWith(`${hostId}\0`)) descriptors.delete(key);
    }
    for (const key of locks.keys()) {
      if (key.startsWith(`${hostId}\0`)) locks.delete(key);
    }
  };
  return remove;
}
async function resolveRemote(runtime, requested, opts) {
  throwIfFsAborted(opts?.signal);
  if (requested.trim().length === 0) throw new FsError3("file_path must be a non-empty string", "FS_NOT_FOUND");
  const lexical = lexicalPath(requested, opts?.cwd);
  if (lexical === void 0) return runtime.originals.resolve(requested, opts);
  const route = routeByCwd(lexical);
  if (route.kind !== "remote") return runtime.originals.resolve(requested, opts);
  const host = hostOf(runtime, route.hostId);
  try {
    const secret = await runtime.access.secret(host);
    throwIfFsAborted(opts?.signal);
    const remoteReal = await realRemote(runtime, host, secret, route.remoteCwd, opts?.signal);
    runtime.identity.set(lexical, { hostId: route.hostId, remoteReal, at: runtime.now() });
    return { targetKey: FsTargetKey(lexical), displayPath: lexical };
  } catch (error) {
    throwIfFsAborted(opts?.signal);
    if (!isSoftFailure(error)) throw asFs(error, opts?.signal);
    const stale = runtime.meta.realpath(host.id, route.remoteCwd, true);
    if (stale !== void 0) {
      runtime.identity.set(lexical, { hostId: route.hostId, remoteReal: stale, at: runtime.now() });
    }
    return { targetKey: FsTargetKey(lexical), displayPath: lexical };
  }
}
async function lstatRemote(runtime, requested, opts, signal) {
  throwIfFsAborted(signal);
  if (requested.trim().length === 0) throw new FsError3("file_path must be a non-empty string", "FS_NOT_FOUND");
  const lexical = lexicalPath(requested, opts?.cwd);
  if (lexical === void 0) return runtime.originals.lstat(requested, opts, signal);
  const route = routeByCwd(lexical);
  if (route.kind !== "remote") return runtime.originals.lstat(requested, opts, signal);
  const host = hostOf(runtime, route.hostId);
  try {
    const secret = await runtime.access.secret(host);
    throwIfFsAborted(signal);
    const info = await uncachedAttrs(runtime, host, secret, route.remoteCwd, false, signal);
    throwIfFsAborted(signal);
    if (info?.type === "symlink") {
      runtime.identity.delete(lexical);
      runtime.meta.forgetRealpath(host.id, route.remoteCwd);
      runtime.meta.forgetAttrs(host.id, route.remoteCwd, true);
      runtime.meta.forgetAttrs(host.id, route.remoteCwd, false);
    }
    runtime.meta.rememberAttrs(host.id, route.remoteCwd, false, info);
    if (info === void 0) return void 0;
    return pathInfo(info, versionFor(runtime, host.id, route.remoteCwd, info));
  } catch (error) {
    return softenAttrs(error, signal, runtime.meta.attrs(host.id, route.remoteCwd, false, true), (info) => pathInfo(info, versionFor(runtime, host.id, route.remoteCwd, info)), () => runtime.originals.lstat(requested, opts, signal));
  }
}
async function statRemote(runtime, target, signal) {
  const key = String(target.targetKey);
  const recorded = runtime.identity.get(key);
  if (recorded === void 0 || !runtime.meta.isRealpathFresh(recorded.at)) {
    try {
      const verified = await verifiedPlace(runtime, target, "any", signal);
      if (verified === void 0) return runtime.originals.stat(target, signal);
    } catch (error) {
      if (error instanceof FsError3 && error.code === "FS_NOT_FOUND") return void 0;
      const fallback = placeOf(runtime, target);
      if (fallback === void 0) return runtime.originals.stat(target, signal);
      return softenAttrs(error, signal, runtime.meta.attrs(fallback.host.id, fallback.remote, true, true), (info) => infoOf(info, versionFor(runtime, fallback.host.id, fallback.remote, info)), () => runtime.originals.stat(target, signal));
    }
  }
  const place = placeOf(runtime, target);
  if (place === void 0) return runtime.originals.stat(target, signal);
  throwIfFsAborted(signal);
  const fresh = runtime.meta.attrs(place.host.id, place.remote, true, false);
  if (fresh.hit) {
    if (fresh.value === void 0) return void 0;
    if (fresh.value.type !== "file") return infoOf(fresh.value, versionFor(runtime, place.host.id, place.remote, fresh.value));
    const key2 = versionKey(place.host.id, place.remote);
    const known = cachedEvidence(runtime, key2, baseVersion(fresh.value));
    if (known !== void 0) return infoOf(fresh.value, versionFor(runtime, place.host.id, place.remote, fresh.value, known));
    const secret = await runtime.access.secret(place.host);
    const evidence = await remoteVersionEvidence(runtime.access.pool, place.host, secret, place.remote, signal, { hash: true });
    rememberDescriptor(runtime, key2, baseVersion(fresh.value), evidence);
    return infoOf(fresh.value, versionFor(runtime, place.host.id, place.remote, fresh.value, evidence));
  }
  try {
    const secret = await runtime.access.secret(place.host);
    const info = await attrsFor(runtime, place.host, secret, place.remote, true, signal);
    throwIfFsAborted(signal);
    runtime.meta.rememberAttrs(place.host.id, place.remote, true, info);
    const evidence = info === void 0 || info.type !== "file" ? {} : await remoteVersionEvidence(runtime.access.pool, place.host, secret, place.remote, signal, { hash: true });
    if (info !== void 0) rememberDescriptor(runtime, versionKey(place.host.id, place.remote), baseVersion(info), evidence);
    return info === void 0 ? void 0 : infoOf(info, versionFor(runtime, place.host.id, place.remote, info, evidence));
  } catch (error) {
    return softenAttrs(error, signal, runtime.meta.attrs(place.host.id, place.remote, true, true), (info) => infoOf(info, versionFor(runtime, place.host.id, place.remote, info)), () => runtime.originals.stat(target, signal));
  }
}
async function listRemote(runtime, target, signal) {
  const parentKey = String(target.targetKey);
  try {
    const place = await verifiedPlace(runtime, target, "directory", signal);
    if (place === void 0) return runtime.originals.listDir(target, signal);
    throwIfFsAborted(signal);
    const secret = await runtime.access.secret(place.host);
    const info = await attrsFor(runtime, place.host, secret, place.remote, true, signal);
    throwIfFsAborted(signal);
    if (info === void 0) throw new FsError3(`no entry at "${target.displayPath}"`, "FS_NOT_FOUND");
    if (info.type !== "directory") throw new FsError3(`"${target.displayPath}" is not a directory`, "FS_NOT_DIRECTORY");
    const rows = await runtime.access.pool.sftpReadDir(place.host, secret, place.remote);
    throwIfFsAborted(signal);
    const entries = [];
    for (const row of rows) {
      if (row.name === "." || row.name === ".." || row.name.length === 0 || row.name.includes("/") || row.name.includes("\\")) continue;
      const childRemote = posix9.join(place.remote, row.name);
      const child = await childEntry(runtime, place.host, secret, childRemote, row, signal);
      const childKey = path2.join(parentKey, row.name);
      if (row.type === "symlink") {
        runtime.identity.delete(String(childKey));
        runtime.meta.forgetRealpath(place.host.id, childRemote);
      }
      const childBase = `${child.mtime}:${child.size ?? 0}`;
      const childGeneration = generationFor(runtime, versionKey(place.host.id, childRemote));
      entries.push({
        name: row.name,
        type: child.type,
        target: { targetKey: FsTargetKey(childKey), displayPath: childKey },
        // Keep the same descriptor grammar as stat/write versions. A listing
        // token is weak by design; a consumer that needs a guard will get
        // `unavailable` instead of a misleading stale answer.
        version: remoteVersionToken({ base: childBase, ...childGeneration !== void 0 ? { generation: childGeneration } : {} }),
        ...child.size === void 0 ? {} : { size: child.size }
      });
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    return entries;
  } catch (error) {
    throw asFs(error, signal);
  }
}
async function childEntry(runtime, host, secret, remotePath, row, signal) {
  if (row.type !== "symlink") {
    const type = row.type === "file" || row.type === "directory" ? row.type : "other";
    return { type, mtime: row.mtime, ...type === "file" ? { size: row.size } : {} };
  }
  const followed = await attrsFor(runtime, host, secret, remotePath, true, signal);
  throwIfFsAborted(signal);
  if (followed?.type === "directory") return { type: "directory", mtime: followed.mtime };
  return { type: "other", mtime: row.mtime };
}
async function readRemoteText(runtime, target, signal) {
  const place = await verifiedPlace(runtime, target, "file", signal);
  if (place === void 0) return runtime.originals.readText(target, signal);
  let total = 0;
  let text2 = "";
  for await (const chunk of decodeRemoteText(runtime, place, target.displayPath, signal)) {
    total += Buffer.byteLength(chunk);
    if (total > TEXT_CAP) throw new FsError3(`file is ${total} bytes, over the ${TEXT_CAP} byte limit`, "FS_TOO_LARGE");
    text2 += chunk;
  }
  return text2;
}
async function streamRemoteText(runtime, target, signal) {
  const place = await verifiedPlace(runtime, target, "file", signal);
  if (place === void 0) return runtime.originals.streamText(target, signal);
  return decodeRemoteText(runtime, place, target.displayPath, signal);
}
async function* decodeRemoteText(runtime, place, display, signal) {
  throwIfFsAborted(signal);
  let chunks;
  try {
    const secret = await runtime.access.secret(place.host);
    chunks = runtime.access.pool.sftpReadChunks(place.host, secret, place.remote, signal);
  } catch (error) {
    throw asFs(error, signal);
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    for await (const chunk of chunks) {
      throwIfFsAborted(signal);
      if (chunk.includes(0)) throw new FsError3(`"${display}" is not UTF-8 text`, "FS_NOT_TEXT");
      const text2 = decodeChunk(decoder, chunk, true, display);
      if (text2.length > 0) yield text2;
    }
    const tail = decodeChunk(decoder, void 0, false, display);
    if (tail.length > 0) yield tail;
  } catch (error) {
    if (error instanceof FsError3) throw error;
    throw asFs(error, signal);
  }
}
function decodeChunk(decoder, chunk, stream, display) {
  try {
    return chunk === void 0 ? decoder.decode() : decoder.decode(chunk, { stream });
  } catch (error) {
    if (error instanceof TypeError) throw new FsError3(`"${display}" is not UTF-8 text`, "FS_NOT_TEXT");
    throw error;
  }
}
async function readRemoteBytes(runtime, target, signal, maxBytes) {
  try {
    const place = await verifiedPlace(runtime, target, "file", signal);
    if (place === void 0) return runtime.originals.readBytes(target, signal, maxBytes);
    throwIfFsAborted(signal);
    const secret = await runtime.access.secret(place.host);
    const data = await runtime.access.pool.sftpRead(place.host, secret, place.remote, maxBytes, signal);
    throwIfFsAborted(signal);
    return data;
  } catch (error) {
    throw asFs(error, signal);
  }
}
async function readRemoteRange(runtime, target, range, signal) {
  if (!Number.isSafeInteger(range.offset) || range.offset < 0 || !Number.isSafeInteger(range.length) || range.length < 0) {
    throw new FsError3("read range is not a non-negative safe integer", "FS_IO_ERROR");
  }
  try {
    const place = await verifiedPlace(runtime, target, "file", signal);
    if (place === void 0) return runtime.originals.readByteRange(target, range, signal);
    throwIfFsAborted(signal);
    if (range.length === 0) return new Uint8Array();
    const secret = await runtime.access.secret(place.host);
    const data = await runtime.access.pool.sftpReadAt(place.host, secret, place.remote, range.offset, range.length);
    throwIfFsAborted(signal);
    return data;
  } catch (error) {
    throw asFs(error, signal);
  }
}
var DIFF_BASIS_MAX_BYTES = 10 * 1024 * 1024;
async function mutationContext(runtime, target, policy, signal) {
  const key = String(target.targetKey);
  const route = routeByCwd(key);
  if (route.kind !== "remote") return void 0;
  throwIfFsAborted(signal);
  if (policy === void 0) throw new FsError3("remote write requires a sandbox policy", "FS_SANDBOX_DENIED");
  if (policy.mode === "read-only") throw new FsError3("remote write is not allowed by the current sandbox mode", "FS_SANDBOX_DENIED");
  const binding = workspaceBinding(policy.workspaceRoot);
  if (binding === null || binding.hostId !== route.hostId) {
    throw new FsError3(`"${target.displayPath}" is outside the session's remote host`, "FS_SANDBOX_DENIED");
  }
  if (runtime.access.allowsRemoteSession === void 0) {
    throw new FsError3("this session cannot prove its remote workspace boundary", "FS_SANDBOX_DENIED");
  }
  if (policy.sessionId === void 0 || !runtime.access.allowsRemoteSession(String(policy.sessionId), route.hostId)) {
    throw new FsError3("this session was not opened on that host", "FS_SANDBOX_DENIED");
  }
  if (runtime.access.statusOf === void 0 || runtime.access.pool.exec === void 0) {
    throw new FsError3("remote writes are unavailable without a probe and exec pool", "FS_IO_ERROR");
  }
  const host = hostOf(runtime, route.hostId);
  const secret = await runtime.access.secret(host);
  const pool = runtime.access.pool;
  const status = await runtime.access.statusOf(host);
  const targetPath = await resolveCreatedPath(pool, host, secret, route.remoteCwd);
  throwIfFsAborted(signal);
  const roots = await remoteRoots(status, binding.remotePath, pool, host, secret, true);
  throwIfFsAborted(signal);
  const mode = policy.mode;
  if (!fileWriteAllowed(mode, targetPath, roots)) {
    throw new FsError3("remote write is not allowed by the current sandbox mode", "FS_SANDBOX_DENIED");
  }
  return { host, secret, pool, status, mode, roots, targetPath };
}
async function withTargetLock(runtime, key, action) {
  const previous = runtime.locks.get(key) ?? Promise.resolve();
  let release;
  const gate = new Promise((resolve2) => {
    release = resolve2;
  });
  const tail = previous.then(() => gate);
  runtime.locks.set(key, tail);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (runtime.locks.get(key) === tail) runtime.locks.delete(key);
  }
}
async function currentRemoteAttrs(runtime, context, signal) {
  const info = await runtime.access.pool.sftpAttrs(context.host, context.secret, context.targetPath, true);
  throwIfFsAborted(signal);
  if (info === void 0) return { info, version: void 0 };
  const evidence = info.type === "file" ? await remoteVersionEvidence(context.pool, context.host, context.secret, context.targetPath, signal, { hash: true }) : {};
  rememberDescriptor(runtime, versionKey(context.host.id, context.targetPath), baseVersion(info), evidence);
  return { info, version: versionFor(runtime, context.host.id, context.targetPath, info, evidence) };
}
async function writeRemoteText(runtime, target, content, expected, signal, policy) {
  const route = routeByCwd(String(target.targetKey));
  if (route.kind !== "remote") return runtime.originals.writeText(target, content, expected, signal, policy);
  return withTargetLock(runtime, `${route.hostId}\0${String(target.targetKey)}`, () => writeRemoteTextUnlocked(runtime, target, content, expected, signal, policy));
}
async function writeRemoteTextUnlocked(runtime, target, content, expected, signal, policy) {
  let context;
  try {
    context = await mutationContext(runtime, target, policy, signal);
  } catch (error) {
    throw asFs(error, signal);
  }
  if (context === void 0) return runtime.originals.writeText(target, content, expected, signal, policy);
  throwIfFsAborted(signal);
  let existing;
  let existingVersion;
  try {
    const current = await currentRemoteAttrs(runtime, context, signal);
    existing = current.info;
    existingVersion = current.version;
  } catch (error) {
    throw asFs(error, signal);
  }
  if (existing !== void 0 && existing.type !== "file") {
    throw new FsError3(`cannot write "${target.displayPath}": not a regular file`, "FS_NOT_REGULAR_FILE");
  }
  if (expected?.kind === "replaceIfVersion") {
    if (existing === void 0 || existingVersion === void 0) {
      throw new FsError3(`cannot write "${target.displayPath}": file changed since it was read`, "FS_STALE_VERSION");
    }
    const comparison = compareRemoteVersion(expected.version, existingVersion);
    if (comparison === "unavailable") {
      throw new FsError3(`cannot verify "${target.displayPath}" before writing: remote version evidence is unavailable`, "FS_IO_ERROR");
    }
    if (comparison !== "match") {
      throw new FsError3(`cannot write "${target.displayPath}": file changed since it was read`, "FS_STALE_VERSION");
    }
  } else if (expected?.kind === "createIfAbsent" && existing !== void 0) {
    throw new FsError3(`cannot overwrite existing "${target.displayPath}" without reading it first`, "FS_NOT_OBSERVED");
  }
  let before = null;
  if (existing !== void 0 && Buffer.byteLength(content, "utf8") < DIFF_BASIS_MAX_BYTES) {
    try {
      const raw = await runtime.access.pool.sftpRead(context.host, context.secret, context.targetPath, DIFF_BASIS_MAX_BYTES, signal);
      throwIfFsAborted(signal);
      if (!raw.includes(0)) before = normalizeLineEndings(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    } catch (error) {
      if (error instanceof FsError3) throw error;
      before = null;
    }
  }
  try {
    await commitRemoteText(context.pool, context.host, context.secret, context.status, context.mode, context.roots, context.targetPath, content, signal, existing?.mode, expected);
  } catch (error) {
    throw asFs(error, signal);
  }
  runtime.meta.forgetAttrs(context.host.id, context.targetPath, true);
  runtime.meta.forgetRealpath(context.host.id, context.targetPath);
  let afterInfo;
  try {
    afterInfo = await runtime.access.pool.sftpAttrs(context.host, context.secret, context.targetPath, true);
  } catch (error) {
    throw asFs(error, signal);
  }
  if (afterInfo === void 0) {
    throw new FsError3(`"${target.displayPath}" disappeared while its write was being verified`, "FS_IO_ERROR");
  }
  const evidence = await remoteVersionEvidence(context.pool, context.host, context.secret, context.targetPath, signal, { hash: true });
  const version = bumpVersion(runtime, context.host.id, context.targetPath, afterInfo, evidence);
  return {
    operation: existing === void 0 ? "create" : "update",
    version,
    before,
    after: normalizeLineEndings(content)
  };
}
function normalizeLineEndings(content) {
  return content.replaceAll("\r\n", "\n");
}
function detectLineEndings(raw) {
  const sample = raw.slice(0, 4096);
  const crlf = sample.split("\r\n").length - 1;
  return crlf > sample.split("\n").length - 1 - crlf ? "CRLF" : "LF";
}
function restoreLineEndings(content, lineEndings) {
  return lineEndings === "LF" ? content : normalizeLineEndings(content).split("\n").join("\r\n");
}
function countOccurrences(content, needle) {
  let count = 0;
  let index = 0;
  while (true) {
    const found = content.indexOf(needle, index);
    if (found === -1) return count;
    count += 1;
    index = found + needle.length;
  }
}
function applyLiteralEdit(content, oldString, newString, replaceAll, displayPath) {
  const oldNorm = normalizeLineEndings(oldString);
  if (oldNorm.length === 0) throw new FsError3("old_string must be a non-empty string", "FS_EDIT_NOT_FOUND");
  const newNorm = normalizeLineEndings(newString);
  const replacements = countOccurrences(content, oldNorm);
  if (replacements === 0) throw new FsError3(`old_string was not found in "${displayPath}"`, "FS_EDIT_NOT_FOUND");
  if (!replaceAll && replacements > 1) {
    throw new FsError3(`old_string matched ${replacements} times in "${displayPath}"; provide a more specific old_string or set replace_all to true`, "FS_AMBIGUOUS_EDIT");
  }
  return { content: content.split(oldNorm).join(newNorm), replacements };
}
async function editRemoteText(runtime, target, edit, expected, signal, policy) {
  const route = routeByCwd(String(target.targetKey));
  if (route.kind !== "remote") return runtime.originals.editText(target, edit, expected, signal, policy);
  return withTargetLock(runtime, `${route.hostId}\0${String(target.targetKey)}`, () => editRemoteTextUnlocked(runtime, target, edit, expected, signal, policy));
}
async function editRemoteTextUnlocked(runtime, target, edit, expected, signal, policy) {
  let context;
  try {
    context = await mutationContext(runtime, target, policy, signal);
  } catch (error) {
    throw asFs(error, signal);
  }
  if (context === void 0) return runtime.originals.editText(target, edit, expected, signal, policy);
  throwIfFsAborted(signal);
  let existing;
  let currentVersion;
  try {
    const current = await currentRemoteAttrs(runtime, context, signal);
    existing = current.info;
    currentVersion = current.version;
  } catch (error) {
    throw asFs(error, signal);
  }
  if (existing === void 0) {
    throw new FsError3(`cannot edit "${target.displayPath}": file changed since it was read`, "FS_STALE_VERSION");
  }
  if (existing.type !== "file") {
    throw new FsError3(`cannot edit "${target.displayPath}": not a regular file`, "FS_NOT_REGULAR_FILE");
  }
  if (expected !== void 0) {
    if (currentVersion === void 0) {
      throw new FsError3(`cannot edit "${target.displayPath}": file changed since it was read`, "FS_STALE_VERSION");
    }
    const comparison = compareRemoteVersion(expected.version, currentVersion);
    if (comparison === "unavailable") {
      throw new FsError3(`cannot verify "${target.displayPath}" before editing: remote version evidence is unavailable`, "FS_IO_ERROR");
    }
    if (comparison !== "match") {
      throw new FsError3(`cannot edit "${target.displayPath}": file changed since it was read`, "FS_STALE_VERSION");
    }
  }
  let raw;
  try {
    raw = await runtime.access.pool.sftpRead(context.host, context.secret, context.targetPath, TEXT_CAP, signal);
  } catch (error) {
    throw asFs(error, signal);
  }
  throwIfFsAborted(signal);
  if (raw.includes(0)) throw new FsError3(`cannot edit "${target.displayPath}": binary file`, "FS_NOT_TEXT");
  let decoded;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw new FsError3(`cannot edit "${target.displayPath}": not UTF-8 text`, "FS_NOT_TEXT");
  }
  const before = normalizeLineEndings(decoded);
  const edited = applyLiteralEdit(before, edit.oldString, edit.newString, edit.replaceAll, target.displayPath);
  const content = restoreLineEndings(edited.content, detectLineEndings(decoded));
  try {
    await commitRemoteText(context.pool, context.host, context.secret, context.status, context.mode, context.roots, context.targetPath, content, signal, existing.mode, expected === void 0 ? void 0 : { kind: "replaceIfVersion", version: expected.version });
  } catch (error) {
    throw asFs(error, signal);
  }
  runtime.meta.forgetAttrs(context.host.id, context.targetPath, true);
  runtime.meta.forgetRealpath(context.host.id, context.targetPath);
  let afterInfo;
  try {
    afterInfo = await runtime.access.pool.sftpAttrs(context.host, context.secret, context.targetPath, true);
  } catch (error) {
    throw asFs(error, signal);
  }
  if (afterInfo === void 0) {
    throw new FsError3(`"${target.displayPath}" disappeared while its edit was being verified`, "FS_IO_ERROR");
  }
  const evidence = await remoteVersionEvidence(context.pool, context.host, context.secret, context.targetPath, signal, { hash: true });
  const afterVersion = bumpVersion(runtime, context.host.id, context.targetPath, afterInfo, evidence);
  return { version: afterVersion, before, after: edited.content };
}
function containsRemote(runtime, parent, child) {
  const rawLeft = runtime.identity.get(String(parent.targetKey));
  const rawRight = runtime.identity.get(String(child.targetKey));
  const left = rawLeft !== void 0 && runtime.meta.isRealpathFresh(rawLeft.at) ? rawLeft : void 0;
  const right = rawRight !== void 0 && runtime.meta.isRealpathFresh(rawRight.at) ? rawRight : void 0;
  if (left !== void 0 && right !== void 0) {
    if (left.hostId !== right.hostId) return false;
    return remotePathInside(left.remoteReal, right.remoteReal);
  }
  if (left !== void 0 || right !== void 0) return false;
  if (routeByCwd(String(parent.targetKey)).kind === "remote" || routeByCwd(String(child.targetKey)).kind === "remote") return false;
  return runtime.originals.contains(parent, child);
}
var NOT_A_LINK = /not a symbolic link|not a symlink|^failure$|^invalid argument$/i;
function isNotALink(error) {
  if (!(error instanceof SshFailure)) return false;
  if (error.status !== void 0 && error.status !== SFTP_STATUS.FAILURE) return false;
  return NOT_A_LINK.test(error.message.trim());
}
async function attrsFor(runtime, host, secret, remotePath, follow, signal) {
  const fresh = runtime.meta.attrs(host.id, remotePath, follow, false);
  if (fresh.hit) return fresh.value;
  const info = await uncachedAttrs(runtime, host, secret, remotePath, follow, signal);
  runtime.meta.rememberAttrs(host.id, remotePath, follow, info);
  return info;
}
async function uncachedAttrs(runtime, host, secret, remotePath, follow, signal) {
  const info = await runtime.access.pool.sftpAttrs(host, secret, remotePath, follow);
  throwIfFsAborted(signal);
  if (info === void 0 || info.mode !== void 0 || info.type !== "other") return info;
  if (!follow) {
    const kind = await linkKind(runtime, host, secret, remotePath, signal);
    if (kind === "symlink") return { ...info, type: "symlink" };
    if (kind === "unknown") return info;
  }
  try {
    await runtime.access.pool.sftpProbeDir(host, secret, remotePath);
    throwIfFsAborted(signal);
    return { ...info, type: "directory" };
  } catch (error) {
    throwIfFsAborted(signal);
    if (error instanceof FsError3) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (isRemoteMissing(error) || isSftpPermissionDenied(error)) return info;
    return { ...info, type: "file" };
  }
}
async function linkKind(runtime, host, secret, remotePath, signal) {
  try {
    await runtime.access.pool.sftpReadLink(host, secret, remotePath);
    throwIfFsAborted(signal);
    return "symlink";
  } catch (error) {
    throwIfFsAborted(signal);
    if (error instanceof FsError3) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (isNotALink(error)) return "not-link";
    if (isRemoteMissing(error)) return "not-link";
    return "unknown";
  }
}
function watchRemote(runtime, target, changed, signal) {
  if (signal.aborted) return Promise.reject(new FsError3("aborted", "FS_ABORTED"));
  if (routeByCwd(String(target.targetKey)).kind === "remote") {
    return Promise.reject(new FsError3("SFTP has no directory watch", "FS_IO_ERROR"));
  }
  return runtime.originals.watch(target, changed, signal);
}
async function realRemote(runtime, host, secret, lexical, signal) {
  const normalized = posix9.normalize(lexical);
  const cached = runtime.meta.realpath(host.id, normalized, false);
  if (cached !== void 0) return cached;
  const value = await walkReal(runtime, host, secret, normalized, signal);
  runtime.meta.rememberRealpath(host.id, normalized, value);
  return value;
}
async function walkReal(runtime, host, secret, lexical, signal) {
  let cursor = lexical;
  const missing = [];
  while (true) {
    throwIfFsAborted(signal);
    const known = runtime.meta.realpath(host.id, cursor, false);
    if (known !== void 0) {
      const composed = normalizeRemoteDirectory(composeCreatedPath(known, missing));
      if (composed === null) throw new FsError3(`remote path is not absolute: ${cursor}`, "FS_IO_ERROR");
      return composed;
    }
    try {
      const real = normalizeRemoteDirectory(await runtime.access.pool.sftpRealpath(host, secret, cursor));
      if (real === null) throw new FsError3(`remote path is not absolute: ${cursor}`, "FS_IO_ERROR");
      runtime.meta.rememberRealpath(host.id, cursor, real);
      const composed = normalizeRemoteDirectory(composeCreatedPath(real, missing));
      if (composed === null) throw new FsError3(`remote path is not absolute: ${cursor}`, "FS_IO_ERROR");
      return composed;
    } catch (error) {
      if (error instanceof FsError3) throw error;
      if (!isRemoteMissing(error)) throw error;
      if (cursor === "/") {
        const composed = normalizeRemoteDirectory(composeCreatedPath("/", missing));
        if (composed === null) throw new FsError3("remote path is not absolute: /", "FS_IO_ERROR");
        return composed;
      }
      missing.unshift(posix9.basename(cursor));
      const parent = posix9.dirname(cursor);
      if (parent === cursor) throw new FsError3(`remote path is not absolute: ${lexical}`, "FS_IO_ERROR");
      cursor = parent;
    }
  }
}
function placeOf(runtime, target) {
  const key = String(target.targetKey);
  const recorded = runtime.identity.get(key);
  if (recorded !== void 0 && runtime.meta.isRealpathFresh(recorded.at)) {
    return { host: hostOf(runtime, recorded.hostId), remote: recorded.remoteReal };
  }
  const route = routeByCwd(key);
  if (route.kind !== "remote") return void 0;
  return { host: hostOf(runtime, route.hostId), remote: route.remoteCwd };
}
async function verifiedPlace(runtime, target, expected, signal) {
  const key = String(target.targetKey);
  const route = routeByCwd(key);
  if (route.kind !== "remote") return void 0;
  const host = hostOf(runtime, route.hostId);
  const secret = await runtime.access.secret(host);
  throwIfFsAborted(signal);
  const lexical = route.remoteCwd;
  let info = await uncachedAttrs(runtime, host, secret, lexical, false, signal);
  throwIfFsAborted(signal);
  if (info === void 0) throw new FsError3(`no entry at "${target.displayPath}"`, "FS_NOT_FOUND");
  let effective = lexical;
  if (info.type === "symlink") {
    const real = normalizeRemoteDirectory(await runtime.access.pool.sftpRealpath(host, secret, lexical));
    throwIfFsAborted(signal);
    if (real === null) throw new FsError3(`remote path is not absolute: ${lexical}`, "FS_IO_ERROR");
    if (!remotePathInsideAnyWorkspace(runtime, route.hostId, real)) {
      throw new FsError3(`"${target.displayPath}" points outside its workspace`, "FS_PERMISSION_DENIED");
    }
    effective = real;
    runtime.identity.set(key, { hostId: route.hostId, remoteReal: real, at: runtime.now() });
    runtime.meta.rememberRealpath(host.id, lexical, real);
    runtime.meta.forgetAttrs(host.id, lexical, true);
    info = await uncachedAttrs(runtime, host, secret, real, true, signal);
    throwIfFsAborted(signal);
    if (info === void 0) throw new FsError3(`no entry at "${target.displayPath}"`, "FS_NOT_FOUND");
  }
  const type = info.type;
  if (expected === "directory" && type !== "directory") {
    throw new FsError3(`"${target.displayPath}" is not a directory`, "FS_NOT_DIRECTORY");
  }
  if (expected === "file" && type !== "file") {
    throw new FsError3(`"${target.displayPath}" is not a regular file`, "FS_NOT_REGULAR_FILE");
  }
  runtime.meta.rememberAttrs(host.id, lexical, true, info);
  return { host, remote: effective };
}
function remotePathInsideAnyWorkspace(runtime, hostId, remotePath) {
  const roots = runtime.access.workspaceRootsOf?.(hostId);
  if (roots === void 0 || roots.length === 0) return false;
  return roots.some((root) => remotePathInside(root, remotePath));
}
function hostOf(runtime, hostId) {
  try {
    return runtime.access.requireHost(hostId);
  } catch (error) {
    throw asFs(error);
  }
}
function lexicalPath(requested, cwd) {
  if (cwd !== void 0) {
    const opened = routeByCwd(cwd);
    if (opened.kind === "remote") {
      const direct = path2.resolve(cwd, requested);
      const directRoute = routeByCwd(direct);
      if (directRoute.kind === "remote" && directRoute.hostId === opened.hostId) return direct;
      const remote = normalizeRemoteDirectory(resolveRemotePath(requested, opened.remoteCwd, opened.placeholderCwd));
      const local = remote === null ? null : mapRemoteToLocal(opened.hostId, remote);
      if (local !== null) return local;
    }
    return path2.resolve(cwd, requested);
  }
  if (path2.isAbsolute(requested)) return path2.resolve(requested);
  return void 0;
}
function versionKey(hostId, remotePath) {
  return `${hostId}\0${remotePath}`;
}
function baseVersion(info) {
  return `${info.mtime}:${info.size}`;
}
function rememberDescriptor(runtime, key, base, evidence) {
  if (evidence.strong === void 0 && evidence.hash === void 0) runtime.descriptors.delete(key);
  else runtime.descriptors.set(key, { base, ...evidence });
  if (runtime.descriptors.size > META_CAP) {
    const oldest = runtime.descriptors.keys().next().value;
    if (oldest !== void 0) runtime.descriptors.delete(oldest);
  }
}
function cachedEvidence(runtime, key, base) {
  const descriptor = runtime.descriptors.get(key);
  if (descriptor === void 0 || descriptor.base !== base) return void 0;
  return { ...descriptor.strong !== void 0 ? { strong: descriptor.strong } : {}, ...descriptor.hash !== void 0 ? { hash: descriptor.hash } : {} };
}
function rememberGeneration(runtime, key, generation) {
  runtime.versions.set(key, generation);
  if (runtime.versions.size > META_CAP) {
    const oldest = runtime.versions.keys().next().value;
    if (oldest !== void 0) runtime.versions.delete(oldest);
  }
}
function generationFor(runtime, key) {
  return runtime.versions.get(key);
}
function versionFor(runtime, hostId, remotePath, info, evidence) {
  const key = versionKey(hostId, remotePath);
  const base = baseVersion(info);
  const effective = evidence !== void 0 && (evidence.strong !== void 0 || evidence.hash !== void 0) ? evidence : cachedEvidence(runtime, key, base);
  const generation = generationFor(runtime, key);
  return remoteVersionToken({
    base,
    ...effective?.strong !== void 0 ? { strong: effective.strong } : {},
    ...effective?.hash !== void 0 ? { hash: effective.hash } : {},
    ...generation !== void 0 ? { generation } : {}
  });
}
function bumpVersion(runtime, hostId, remotePath, info, evidence) {
  const key = versionKey(hostId, remotePath);
  const base = baseVersion(info);
  rememberDescriptor(runtime, key, base, evidence);
  const generation = (runtime.versions.get(key) ?? 0) + 1;
  rememberGeneration(runtime, key, generation);
  return remoteVersionToken({
    base,
    ...evidence.strong !== void 0 ? { strong: evidence.strong } : {},
    ...evidence.hash !== void 0 ? { hash: evidence.hash } : {},
    generation
  });
}
function compareRemoteVersion(expected, current) {
  const left = parseRemoteVersion(expected);
  const right = parseRemoteVersion(current);
  if (left === void 0 || right === void 0) return String(expected) === String(current) ? "match" : "stale";
  if (left.base !== right.base) return "stale";
  if (left.generation !== void 0 && right.generation !== void 0 && left.generation !== right.generation) {
    return "stale";
  }
  if (left.strong !== void 0 && right.strong !== void 0) return left.strong === right.strong ? "match" : "stale";
  if (left.hash !== void 0 && right.hash !== void 0) return left.hash === right.hash ? "match" : "stale";
  if (left.strong !== void 0 || left.hash !== void 0 || right.strong !== void 0 || right.hash !== void 0) return "unavailable";
  return "unavailable";
}
function infoOf(info, version) {
  const type = info.type === "file" || info.type === "directory" ? info.type : "other";
  return { version, type, size: info.size };
}
function pathInfo(info, version) {
  return { version, type: info.type, size: info.size };
}
function throwIfFsAborted(signal) {
  if (signal?.aborted === true) throw new FsError3("aborted", "FS_ABORTED");
}
var MetaCache = class {
  constructor(now, realTtl, attrTtl) {
    this.now = now;
    this.realTtl = realTtl;
    this.attrTtl = attrTtl;
  }
  realPaths = /* @__PURE__ */ new Map();
  attrEntries = /* @__PURE__ */ new Map();
  realpath(hostId, remotePath, stale) {
    const hit = this.read(this.realPaths, `${hostId}\0${remotePath}`, stale, this.realTtl);
    return hit.hit ? hit.value : void 0;
  }
  rememberRealpath(hostId, remotePath, value) {
    this.write(this.realPaths, `${hostId}\0${remotePath}`, value);
  }
  /** Drop one path's cached realpath after it was observed as a symlink. */
  forgetRealpath(hostId, remotePath) {
    this.realPaths.delete(`${hostId}\0${remotePath}`);
  }
  /** Drop one path's cached attributes after its type changed. */
  forgetAttrs(hostId, remotePath, follow) {
    this.attrEntries.delete(`${hostId}\0${follow ? "s" : "l"}\0${remotePath}`);
  }
  /** Whether an identity captured at `at` is still inside the realpath window. */
  isRealpathFresh(at) {
    return this.now() - at < this.realTtl;
  }
  attrs(hostId, remotePath, follow, stale) {
    return this.read(this.attrEntries, `${hostId}\0${follow ? "s" : "l"}\0${remotePath}`, stale, this.attrTtl);
  }
  rememberAttrs(hostId, remotePath, follow, value) {
    this.write(this.attrEntries, `${hostId}\0${follow ? "s" : "l"}\0${remotePath}`, value);
  }
  invalidateHost(hostId) {
    const prefix = `${hostId}\0`;
    for (const key of this.realPaths.keys()) if (key.startsWith(prefix)) this.realPaths.delete(key);
    for (const key of this.attrEntries.keys()) if (key.startsWith(prefix)) this.attrEntries.delete(key);
  }
  read(map, key, stale, ttl) {
    const entry = map.get(key);
    if (entry === void 0) return { hit: false };
    if (!stale && this.now() - entry.at >= ttl) return { hit: false };
    return { hit: true, value: entry.value };
  }
  write(map, key, value) {
    if (map.has(key)) map.delete(key);
    map.set(key, { at: this.now(), value });
    while (map.size > META_CAP) {
      const oldest = map.keys().next().value;
      if (oldest === void 0) break;
      map.delete(oldest);
    }
  }
};
function isSoftFailure(error) {
  if (!(error instanceof SshFailure)) return false;
  if (error.status === SFTP_STATUS.OP_UNSUPPORTED) return false;
  if (isRemoteMissing(error)) return false;
  return !isSftpPermissionDenied(error);
}
async function softenAttrs(error, signal, stale, present, local) {
  throwIfFsAborted(signal);
  if (!isSoftFailure(error)) throw asFs(error, signal);
  if (stale.hit) return stale.value === void 0 ? void 0 : present(stale.value);
  try {
    return await local();
  } catch (localError) {
    throwIfFsAborted(signal);
    if (localError instanceof FsError3 && localError.code === "FS_ABORTED") throw localError;
    return void 0;
  }
}
function asFs(error, signal) {
  if (signal?.aborted === true) return new FsError3("aborted", "FS_ABORTED");
  if (error instanceof FsError3) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof SandboxUnavailableError3) return new FsError3(message, "FS_SANDBOX_DENIED");
  if (isRemoteMissing(error)) return new FsError3(message, "FS_NOT_FOUND");
  if (isSftpPermissionDenied(error)) return new FsError3(message, "FS_PERMISSION_DENIED");
  if (/over the /i.test(message) && /byte limit/i.test(message)) return new FsError3(message, "FS_TOO_LARGE");
  return new FsError3(message, "FS_IO_ERROR");
}
function bindOriginals(fs) {
  return {
    resolve: fs.resolve.bind(fs),
    lstat: fs.lstat.bind(fs),
    stat: fs.stat.bind(fs),
    listDir: fs.listDir.bind(fs),
    readText: fs.readText.bind(fs),
    streamText: fs.streamText.bind(fs),
    readBytes: fs.readBytes.bind(fs),
    readByteRange: fs.readByteRange.bind(fs),
    writeText: fs.writeText.bind(fs),
    editText: fs.editText.bind(fs),
    contains: fs.contains.bind(fs),
    watch: fs.watch.bind(fs)
  };
}
function bindOptionalMutations(fs, originals) {
  const patch = fs;
  if (typeof patch.patchText === "function") originals.patchText = patch.patchText.bind(fs);
  if (typeof patch.deleteFile === "function") originals.deleteFile = patch.deleteFile.bind(fs);
  if (typeof patch.moveFile === "function") originals.moveFile = patch.moveFile.bind(fs);
  return originals;
}
function guardRemoteMutation(surface, originals, restorers, key) {
  const saved = originals[key];
  if (typeof saved !== "function") return;
  const own = Object.hasOwn(surface, key);
  const targetOf = (value) => {
    const record = typeof value === "object" && value !== null ? value : void 0;
    return String(record?.targetKey ?? "");
  };
  const refuse = (displayPath) => Promise.reject(new FsError3(
    `remote workspace: ${displayPath} cannot be changed by this operation; use write or edit instead`,
    "FS_SANDBOX_DENIED"
  ));
  const replacement = key === "moveFile" ? (source, destination, ...rest) => {
    if (routeByCwd(targetOf(source)).kind === "remote") return refuse(String(source?.displayPath ?? "the source"));
    if (routeByCwd(targetOf(destination)).kind === "remote") return refuse(String(destination?.displayPath ?? "the destination"));
    return saved.call(surface, source, destination, ...rest);
  } : (target, ...rest) => {
    if (routeByCwd(targetOf(target)).kind === "remote") return refuse(String(target?.displayPath ?? "the target"));
    return saved.call(surface, target, ...rest);
  };
  surface[key] = replacement;
  restorers.push(() => {
    if (own) surface[key] = saved;
    else Reflect.deleteProperty(surface, key);
  });
}
function replaceMethod(fs, key, next) {
  const own = Object.hasOwn(fs, key);
  const saved = fs[key];
  fs[key] = next;
  return () => {
    if (own) fs[key] = saved;
    else Reflect.deleteProperty(fs, key);
  };
}
function marked(fs) {
  return fs[MARKER] === true;
}
function unwrap2(service) {
  const branded = service;
  const inner = branded[symbols2.original];
  return typeof inner === "object" && inner !== null ? inner : service;
}
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

// src/uploads.ts
import path3 from "node:path";
import { posix as posix10 } from "node:path";
import { symbols as symbols3 } from "@deepseek-ai/cordis";
var UPLOAD_CAP = 32 * 1024 * 1024;
var LEAF_MAX = 120;
var MARKER2 = Symbol("dsh-permission-remote.uploads");
function uploadLeaf(name2) {
  const stripped = posix10.basename(name2).replace(/^\.+/, "");
  const safe = stripped.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, LEAF_MAX);
  return safe.length === 0 ? "file" : safe;
}
var SHA256_PREFIX = "sha256:";
function uploadDigest(attachmentId) {
  if (attachmentId.includes("/") || attachmentId.includes("\\") || attachmentId.includes("\0")) {
    throw new Error("attachment id is not a safe digest");
  }
  const hex = attachmentId.startsWith(SHA256_PREFIX) ? attachmentId.slice(SHA256_PREFIX.length) : attachmentId;
  if (!/^[0-9a-fA-F]{16,}$/.test(hex)) throw new Error("attachment id is not a safe digest");
  return hex.slice(0, 16).toLowerCase();
}
function remoteUploadPath(home, attachmentId, name2) {
  const digest = uploadDigest(attachmentId);
  const root = normalizeRemoteDirectory(home);
  if (root === null) throw new Error("remote home is not an absolute path");
  return posix10.join(root, ".dsh-permission-remote", "uploads", digest, uploadLeaf(name2));
}
function installRemoteUploads(ctx, access) {
  let service;
  try {
    service = ctx.get("fs");
  } catch (error) {
    ctx.logger?.warn(`[@dsh-permission-remote] remote uploads skipped: filesystem service is unavailable (${errorText2(error)})`);
    return void 0;
  }
  if (typeof service !== "object" || service === null) {
    ctx.logger?.warn("[@dsh-permission-remote] remote uploads skipped: filesystem service is unavailable");
    return void 0;
  }
  const fs = unwrap3(service);
  if (marked2(fs)) {
    ctx.logger?.warn("[@dsh-permission-remote] remote uploads already installed");
    return void 0;
  }
  if (typeof fs.processPathFromHostPath !== "function") {
    ctx.logger?.warn("[@dsh-permission-remote] remote uploads skipped: filesystem has no processPathFromHostPath");
    return void 0;
  }
  const surface = fs;
  const records = /* @__PURE__ */ new Map();
  const flights = /* @__PURE__ */ new Map();
  const homes2 = /* @__PURE__ */ new Map();
  const epochs = /* @__PURE__ */ new Map();
  const own = Object.hasOwn(surface, "processPathFromHostPath");
  const saved = surface.processPathFromHostPath;
  const original = saved.bind(surface);
  surface.processPathFromHostPath = (hostPath) => mappedPath(ctx, records, original, hostPath);
  let removeListener;
  try {
    removeListener = ctx.on("llm/stream", (options, next) => {
      if (typeof options.sessionId !== "string" || options.sessionId.length === 0) return next();
      const route = sessionRoute2(ctx, options.sessionId);
      if (route === void 0) return next();
      return (async function* () {
        if (isAborted(options.signal)) throw abortError2();
        await stageAll(ctx, access, records, flights, homes2, epochs, route, options);
        if (isAborted(options.signal)) throw abortError2();
        yield* next();
      })();
    });
    Object.defineProperty(fs, MARKER2, { value: true, configurable: true, enumerable: false });
  } catch (error) {
    if (own) surface.processPathFromHostPath = saved;
    else Reflect.deleteProperty(surface, "processPathFromHostPath");
    ctx.logger?.warn(`[@dsh-permission-remote] remote uploads skipped: ${errorText2(error)}`);
    return void 0;
  }
  const remove = (() => {
    removeListener?.();
    if (own) surface.processPathFromHostPath = saved;
    else Reflect.deleteProperty(surface, "processPathFromHostPath");
    Reflect.deleteProperty(fs, MARKER2);
    records.clear();
    flights.clear();
    homes2.clear();
    epochs.clear();
  });
  remove.invalidateHost = (hostId) => {
    homes2.delete(hostId);
    epochs.set(hostId, (epochs.get(hostId) ?? 0) + 1);
    const prefix = `${hostId}\0`;
    for (const key of records.keys()) if (key.startsWith(prefix)) records.delete(key);
    for (const key of flights.keys()) if (key.startsWith(prefix)) flights.delete(key);
  };
  return remove;
}
function mappedPath(ctx, records, original, hostPath) {
  const hostId = initiatorHost(ctx);
  if (hostId === void 0) return original(hostPath);
  const record = records.get(recordKey(hostId, hostPath));
  if (record === void 0) return original(hostPath);
  if (record.kind === "failed") return void 0;
  return record.remotePath;
}
async function stageAll(ctx, access, records, flights, homes2, epochs, route, options) {
  const refs = fileRefs(ctx, options.messages);
  if (refs.length === 0) return;
  let host;
  try {
    host = access.requireHost(route.hostId);
  } catch (error) {
    if (isAborted(options.signal) || isAbort(error)) throw abortError2();
    ctx.logger?.warn(`[@dsh-permission-remote] remote upload skipped: ${errorText2(error)}`);
    for (const ref of refs) fail(records, route.hostId, ref.hostPath);
    return;
  }
  await Promise.all(refs.map((ref) => begin(ctx, access, records, flights, homes2, epochs, host, ref, options.signal)));
}
function begin(ctx, access, records, flights, homes2, epochs, host, ref, signal) {
  if (isAborted(signal)) return Promise.reject(abortError2());
  if (!acceptable(ref)) {
    fail(records, host.id, ref.hostPath);
    ctx.logger?.warn(`[@dsh-permission-remote] remote upload skipped for ${uploadLeaf(ref.name)}: file is not a readable upload under ${UPLOAD_CAP} bytes`);
    return Promise.resolve();
  }
  const flightKey = `${host.id}\0${flightIdentity(ref.attachmentId)}\0${uploadLeaf(ref.name)}`;
  const existing = flights.get(flightKey);
  if (existing !== void 0) return applyOutcome(records, host.id, ref.hostPath, existing);
  const epoch = epochs.get(host.id) ?? 0;
  let start;
  const flight = new Promise((resolve2, reject) => {
    start = () => {
      uploadOne(ctx, access, homes2, host, ref, signal).then((outcome) => {
        resolve2((epochs.get(host.id) ?? 0) === epoch ? outcome : { kind: "failed" });
      }, reject);
    };
  });
  flights.set(flightKey, flight);
  settleThen(flight, () => {
    if (flights.get(flightKey) === flight) flights.delete(flightKey);
  });
  start();
  return applyOutcome(records, host.id, ref.hostPath, flight);
}
function flightIdentity(attachmentId) {
  try {
    return uploadDigest(attachmentId);
  } catch {
    return attachmentId;
  }
}
function applyOutcome(records, hostId, hostPath, flight) {
  return flight.then((outcome) => {
    if (outcome.kind === "failed") {
      fail(records, hostId, hostPath);
      return;
    }
    ready(records, hostId, hostPath, outcome.remotePath);
    if (outcome.aborted === true) throw abortError2();
  });
}
async function uploadOne(ctx, access, homes2, host, ref, signal) {
  if (isAborted(signal)) throw abortError2();
  let home;
  let remotePath;
  try {
    home = await homeOf(access, homes2, host);
    remotePath = remoteUploadPath(home, ref.attachmentId, ref.name);
  } catch (error) {
    if (isAborted(signal) || isAbort(error)) throw abortError2();
    ctx.logger?.warn(`[@dsh-permission-remote] remote upload failed for ${uploadLeaf(ref.name)}: ${errorText2(error)}`);
    return { kind: "failed" };
  }
  try {
    const secret = await access.secret(host);
    if (isAborted(signal)) throw abortError2();
    if (access.pool.sftpAttrs !== void 0) {
      await assertUploadParent(access, host, secret, home, remotePath);
    }
    if (access.pool.sftpAttrs !== void 0) {
      let attrs;
      try {
        attrs = await access.pool.sftpAttrs(host, secret, remotePath, false);
      } catch (error) {
        if (!isRemoteMissing(error)) {
          ctx.logger?.warn(`[@dsh-permission-remote] remote upload failed for ${uploadLeaf(ref.name)}: ${errorText2(error)}`);
          return { kind: "failed" };
        }
      }
      if (attrs !== void 0 && attrs.type !== "file" && attrs.type !== "directory") {
        ctx.logger?.warn(`[@dsh-permission-remote] remote upload failed for ${uploadLeaf(ref.name)}: the upload path is a ${attrs.type === "symlink" ? "symbolic link" : "non-regular file"}`);
        return { kind: "failed" };
      }
    }
    let info;
    try {
      info = await access.pool.sftpStat(host, secret, remotePath);
    } catch (error) {
      if (isAborted(signal) || isAbort(error)) throw abortError2();
      if (!isRemoteMissing(error)) {
        ctx.logger?.warn(`[@dsh-permission-remote] remote upload failed for ${uploadLeaf(ref.name)}: ${errorText2(error)}`);
        return { kind: "failed" };
      }
    }
    if (info?.isDirectory === true) {
      ctx.logger?.warn(`[@dsh-permission-remote] remote upload failed for ${uploadLeaf(ref.name)}: a directory is already at the upload path`);
      return { kind: "failed" };
    }
    if (info !== void 0 && info.size === ref.bytes) return { kind: "ready", remotePath };
    await access.pool.sftpPutFile(host, secret, ref.hostPath, remotePath, home);
    if (isAborted(signal)) return { kind: "ready", remotePath, aborted: true };
    return { kind: "ready", remotePath };
  } catch (error) {
    if (isAborted(signal) || isAbort(error)) throw abortError2();
    ctx.logger?.warn(`[@dsh-permission-remote] remote upload failed for ${uploadLeaf(ref.name)}: ${errorText2(error)}`);
    return { kind: "failed" };
  }
}
function homeOf(access, homes2, host) {
  const cached = homes2.get(host.id);
  if (cached !== void 0) return cached;
  const pending = resolveHome(access, host);
  homes2.set(host.id, pending);
  void pending.catch(() => {
    if (homes2.get(host.id) === pending) homes2.delete(host.id);
  });
  return pending;
}
async function resolveHome(access, host) {
  const secret = await access.secret(host);
  const home = normalizeRemoteDirectory(await access.pool.sftpRealpath(host, secret, "."));
  if (home === null) throw new Error("remote home is not an absolute path");
  return home;
}
async function assertUploadParent(access, host, secret, home, remotePath) {
  const attrsOf2 = access.pool.sftpAttrs;
  if (attrsOf2 === void 0) return;
  const parent = posix10.dirname(remotePath);
  const rel = posix10.relative(home, parent);
  if (rel === "" || rel.startsWith("..") || posix10.isAbsolute(rel)) {
    if (rel !== "") throw new Error("upload path escapes the remote home");
    return;
  }
  let cursor = home;
  for (const part of rel.split("/").filter((part2) => part2.length > 0)) {
    cursor = posix10.join(cursor, part);
    const attrs = await attrsOf2(host, secret, cursor, false);
    if (attrs === void 0) return;
    if (attrs.type === "symlink" || attrs.type !== "directory") {
      throw new Error(`upload directory ${cursor} is not a real directory`);
    }
    const real = normalizeRemoteDirectory(await access.pool.sftpRealpath(host, secret, cursor));
    if (real === null || !remotePathInside(home, real)) {
      throw new Error(`upload directory ${cursor} escapes the remote home`);
    }
  }
}
function acceptable(ref) {
  return Number.isSafeInteger(ref.bytes) && ref.bytes >= 0 && ref.bytes <= UPLOAD_CAP && path3.isAbsolute(ref.hostPath);
}
function ready(records, hostId, hostPath, remotePath) {
  records.set(recordKey(hostId, hostPath), { kind: "ready", remotePath });
}
function fail(records, hostId, hostPath) {
  records.set(recordKey(hostId, hostPath), { kind: "failed" });
}
function recordKey(hostId, hostPath) {
  return `${hostId}\0${hostPath}`;
}
function fileRefs(ctx, messages) {
  if (!Array.isArray(messages)) return [];
  const attachments = attachmentsOf(ctx);
  const refs = [];
  for (const message of messages) {
    const content = typeof message === "object" && message !== null ? message.content : void 0;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const record = block;
      if (record.type !== "file" || typeof record.attachment !== "object" || record.attachment === null) continue;
      const attachment = record.attachment;
      if (typeof attachment.attachmentId !== "string" || typeof attachment.name !== "string" || typeof attachment.bytes !== "number") continue;
      const ref = { attachmentId: attachment.attachmentId, name: attachment.name, bytes: attachment.bytes };
      let hostPath;
      try {
        hostPath = attachments?.fileHostPath(ref);
      } catch {
        continue;
      }
      if (hostPath === void 0) continue;
      refs.push({ ...ref, hostPath });
    }
  }
  return refs;
}
function attachmentsOf(ctx) {
  try {
    const service = ctx.get("attachments");
    if (typeof service?.fileHostPath !== "function") return void 0;
    return service;
  } catch {
    return void 0;
  }
}
function sessionRoute2(ctx, sessionId) {
  const cwd = liveCwd(ctx, sessionId);
  const route = routeByCwd(cwd);
  return route.kind === "remote" ? route : void 0;
}
function liveCwd(ctx, sessionId) {
  try {
    const sessions = ctx.get("sessions");
    const session = sessions?.get?.(sessionId);
    if (session === void 0) return void 0;
    try {
      const directories = ctx.get("workingDirectory");
      const cwd = directories?.get?.(session);
      if (typeof cwd === "string" && cwd.length > 0) return cwd;
    } catch {
    }
    const header = session.header;
    return header?.cwd;
  } catch {
    return void 0;
  }
}
function initiatorHost(ctx) {
  try {
    const agents = ctx.get("agents");
    const agent = agents?.currentInitiator?.();
    if (agent?.session === void 0) return void 0;
    let cwd;
    try {
      const directories = ctx.get("workingDirectory");
      cwd = directories?.get?.(agent.session);
    } catch {
      cwd = void 0;
    }
    if (cwd === void 0 || cwd.length === 0) cwd = agent.session.header?.cwd;
    const route = routeByCwd(cwd);
    return route.kind === "remote" ? route.hostId : void 0;
  } catch {
    return void 0;
  }
}
function isAborted(signal) {
  return signal?.aborted === true;
}
function abortError2() {
  const error = new Error("remote upload aborted");
  error.name = "AbortError";
  return error;
}
function isAbort(error) {
  return error instanceof Error && error.name === "AbortError";
}
function marked2(fs) {
  return fs[MARKER2] === true;
}
function unwrap3(service) {
  const branded = service;
  const inner = branded[symbols3.original];
  return typeof inner === "object" && inner !== null ? inner : service;
}
function errorText2(error) {
  return error instanceof Error ? error.message : String(error);
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
  /**
   * List a directory for the picker.
   *
   * The picker also accepts a typed path, so a request may arrive as `~`,
   * `~/src`, or with `..` and doubled separators in it. `resolve` is the
   * caller saying so: a typed path is settled with realpath, which yields the
   * one spelling the breadcrumb, the workspace registry, and a later listing
   * agree on, while a path the picker built from a listing is already that
   * spelling. Skipping the call for the second case keeps a row click at one
   * request instead of two on a slow link.
   */
  async listDir(input) {
    const host = this.core.requireHost(input.hostId);
    const secret = await this.core.secret(host);
    const requested = (input.path ?? "").trim();
    const wantsHome = requested === "~" || requested.startsWith("~/");
    const home = wantsHome ? normalizeRemoteDirectory(await this.core.pool.sftpRealpath(host, secret, ".")) : null;
    if (wantsHome && home === null) throw new Error("the remote did not report a login home");
    const expanded = listingPath(requested, home ?? "");
    const resolved = input.resolve === true ? normalizeRemoteDirectory(await this.core.pool.sftpRealpath(host, secret, expanded)) ?? expanded : expanded;
    const entries = await this.core.pool.sftpList(host, secret, resolved);
    return { path: resolved, entries };
  }
  /**
   * Create one directory below an already-listed one, then return the new
   * listing so the picker shows it without a second round trip.
   *
   * The name is one path segment: a separator would create a tree the caller
   * never listed, and `.`/`..` would escape the directory the operator is
   * looking at.
   */
  async createDir(input) {
    const host = this.core.requireHost(input.hostId);
    const parent = input.path || "/";
    const child = childDirectoryPath(parent, input.name);
    if ("error" in child) {
      throw new Error(child.error === "empty" ? "new folder name is empty" : child.error === "dot" ? `"${input.name.trim()}" is not a folder name` : "new folder name must be one path segment");
    }
    const secret = await this.core.secret(host);
    await this.core.pool.sftpMkdir(host, secret, child.path);
    const entries = await this.core.pool.sftpList(host, secret, parent);
    return { path: parent, entries };
  }
  async createWorkspace(input) {
    const host = this.core.requireHost(input.hostId);
    const created = await this.core.registerWorkspace(host, input.path, input.title);
    return { path: created.path, title: created.title };
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
  /** Drop the cached login environment. The next workspace command reads it again. */
  async refreshLoginEnv(input) {
    this.core.refreshLoginEnv(input.hostId);
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
  /** The effective placeholder root plus the built-in default, for the Settings field. */
  async remoteRootInfo() {
    return this.core.remoteRootInfo();
  }
  /**
   * Change the placeholder root and move the old tree there.
   *
   * Without `strategy`, this only plans: an empty/absent target is copied and
   * switched at once, a non-empty target with conflicting files is reported
   * back so the page can ask before touching anything.
   */
  async changeRemoteRoot(input) {
    const accepted = Array.isArray(input.conflicts) ? input.conflicts.filter((item) => typeof item === "string") : void 0;
    return this.core.changeRemoteRoot(input.root, { strategy: input.strategy, force: input.force === true, acceptedConflicts: accepted });
  }
  /** Export the host list as JSON. No secrets are ever included. */
  async exportHosts() {
    return this.core.exportHostConfig();
  }
  /** Merge or replace the host list from a JSON export. */
  async importHosts(input) {
    return this.core.importHostConfig(input.payload, input.mode === "replace" ? "replace" : "merge");
  }
};
var Core = class {
  constructor(ctx, config, workspaces) {
    this.ctx = ctx;
    this.workspaces = workspaces;
    this.config = config;
    this.pool = new SshPool(config.maxConnections);
  }
  /** Migration bookkeeping loaded from its sidecar file; see `migration-state.ts`. */
  migrationState = emptyMigrationState();
  /** Single-flight load of the sidecar, awaited before any state is mutated. */
  migrationStateLoaded = null;
  /** False when the sidecar exists but could not be read; never overwrite then. */
  migrationStateWritable = true;
  /**
   * Tail of the session-relocation queue.
   *
   * `apply` starts `resumeSessionMigrationState` without awaiting it, and saving
   * the current root again also calls `relocateFromRoots`. Both rename the same
   * session directory; the loser used to record ENOENT as a failed move. A
   * rejection still settles the tail, so one failed sweep cannot wedge the next.
   */
  relocationTail = Promise.resolve();
  pool;
  config;
  status = /* @__PURE__ */ new Map();
  shellLists = /* @__PURE__ */ new Map();
  loginEnvs = new LoginEnvCache((hostId, signal) => this.readLoginEnv(hostId, signal));
  /** Drops realpath, stat, and containment records for one host. The file tree installs this. */
  remoteTrees = /* @__PURE__ */ new Set();
  /** The first apply installs the configured root; only a later change keeps the previous one routable. */
  remoteRootApplied = false;
  /** tool/call args for the approval-detail bridge, bounded and per session. */
  toolCalls = /* @__PURE__ */ new Map();
  sessionCwds = /* @__PURE__ */ new Map();
  listWorkspaces() {
    return remoteWorkspaces(this.workspaces.list());
  }
  /**
   * Remote roots registered for one host, normalised and de-duplicated.
   *
   * `remote-fs` needs these to decide whether a followed symlink stays inside a
   * workspace. It cannot derive the root from the placeholder spelling: the
   * encoded segment is the whole remote path for an absolute spelling and the
   * workspace root for a relative one.
   */
  workspaceRootsOf(hostId) {
    const roots = /* @__PURE__ */ new Set();
    for (const item of this.listWorkspaces()) {
      if (item.hostId !== hostId) continue;
      const normalized = normalizeRemoteDirectory(item.remotePath);
      if (normalized !== null) roots.add(normalized);
    }
    return [...roots];
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
    this.dropRemoteTree(hostId);
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
    this.dropRemoteTree(hostId);
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
  /** Ceiling and deadline for one ssh_upload / ssh_download; `0` means no limit. */
  transferLimits() {
    return { maxBytes: this.config.transferMaxBytes, timeoutMs: this.config.transferTimeoutMs };
  }
  async trust(hostId, fingerprint) {
    this.requireHost(hostId);
    this.config.hosts = this.config.hosts.map((item) => item.id === hostId ? { ...item, fingerprint } : item);
    this.pool.invalidate(hostId);
    this.status.delete(hostId);
    forgetOpsHost(hostId);
    this.loginEnvs.forget(hostId);
    await this.persistHosts();
  }
  /**
   * Drop everything derived from a connection that no longer applies: the
   * cached probe, the pooled session, the cached remote home, the sidebar
   * shell list, and the file tree's realpath and stat cache. Connecting is
   * interrupted, so an agent command running on that session is killed.
   */
  forgetStatus(hostId) {
    this.status.delete(hostId);
    this.pool.invalidate(hostId);
    forgetOpsHost(hostId);
    this.forgetShells(hostId);
    this.loginEnvs.forget(hostId);
    this.dropRemoteTree(hostId);
  }
  /** The installed file tree forgets one host when its connection is dropped. */
  bindRemoteTree(invalidate) {
    this.remoteTrees.add(invalidate);
    return () => {
      this.remoteTrees.delete(invalidate);
    };
  }
  dropRemoteTree(hostId) {
    for (const invalidate of this.remoteTrees) {
      try {
        invalidate(hostId);
      } catch (error) {
        this.ctx.logger?.warn(`[@dsh-permission-remote] remote file tree reset failed for ${hostId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  /**
   * Drop the cached login environment only. The pooled SSH session stays up.
   * The next workspace command captures again, bounded by {@link LOGIN_ENV_CAPTURE_MS}.
   */
  refreshLoginEnv(hostId) {
    this.requireHost(hostId);
    this.loginEnvs.forget(hostId);
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
    const normalized = {
      ...host,
      opsPolicy: normalizeOpsPolicy(host.opsPolicy),
      loginEnv: normalizeLoginEnv(host.loginEnv)
    };
    if (previous !== void 0 && connectionKeyChanged(previous, normalized)) {
      await this.dropSecret(host.id);
    }
    this.config.hosts = previous === void 0 ? [...this.config.hosts, normalized] : this.config.hosts.map((item) => item.id === host.id ? normalized : item);
    if (previous !== void 0 && connectionKeyChanged(previous, normalized)) {
      this.forgetStatus(host.id);
    } else {
      forgetOpsHost(host.id);
      if (previous !== void 0 && previous.loginEnv === true !== normalized.loginEnv) this.loginEnvs.forget(host.id);
    }
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
      this.commitTombstones([
        { host: removed, deletedAt: (/* @__PURE__ */ new Date()).toISOString() },
        ...this.config.deletedHosts.filter((item) => item.host.id !== hostId)
      ]);
    }
    this.config.hosts = this.config.hosts.filter((item) => item.id !== hostId);
    this.pool.invalidate(hostId);
    this.status.delete(hostId);
    forgetOpsHost(hostId);
    this.forgetShells(hostId);
    this.dropRemoteTree(hostId);
    await this.persistHosts();
  }
  /**
   * Replace the tombstone list.
   *
   * Hosts that still own a workspace always keep their row, so those workspaces
   * stay reachable; the newest 20 that own none are kept as the delete history.
   * Shared by `deleteHost` and the JSON import, which drops hosts the same way.
   */
  commitTombstones(rows) {
    const withWorkspaces = new Set(this.listWorkspaces().map((item) => item.hostId));
    let spare = 0;
    this.config.deletedHosts = rows.filter((row) => {
      if (withWorkspaces.has(row.host.id)) return true;
      spare += 1;
      return spare <= 20;
    }).map((row) => ({ host: { ...row.host }, deletedAt: row.deletedAt ?? "" }));
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
  /** Persist only the placeholder root, leaving the host rows untouched. */
  async persistRemoteRoot(root) {
    const row = this.ctx.settings.describe().find((item) => String(item.ns) === "permission-remote");
    if (row === void 0) {
      throw new Error('the settings row "permission-remote" is missing; the remote root was not saved');
    }
    await this.ctx.settings.update(String(row.ns), { remoteRoot: root });
  }
  /**
   * Save the root and point routing at it, in that order.
   *
   * The write goes first: a failure leaves the setting and the routing on the
   * old root, which still owns every placeholder. The reverse order would
   * report a switch the next load does not agree with.
   */
  async commitRemoteRoot(root) {
    await this.persistRemoteRoot(root);
    setRemoteRootOverride(root);
    try {
      this.config.remoteRoot = root;
    } catch (error) {
      this.ctx.logger?.warn(`[@dsh-permission-remote] could not store the remote root in memory: ${errorText3(error)}`);
    }
  }
  /**
   * Apply the configured root to the routing helpers.
   *
   * Called at load and again whenever the settings section is written by any
   * surface, so editing the value in the generic settings editor takes effect
   * without a restart. A root already superseded by a migration stays routable:
   * dropping it here would strand a session that is still on it.
   */
  applyRemoteRootOverride() {
    const previous = remoteRoot();
    const configured = this.config.remoteRoot.trim();
    let override = null;
    if (configured.length === 0) {
      override = null;
    } else {
      const expanded = expandRemoteRoot(configured);
      if (expanded === null) {
        this.ctx.logger?.warn(`[@dsh-permission-remote] the configured remote root ${JSON.stringify(configured)} is not an absolute path; falling back to ${defaultRemoteRoot()}`);
        override = null;
      } else {
        override = expanded;
        if (!existsSync2(expanded)) {
          this.ctx.logger?.warn(`[@dsh-permission-remote] the configured remote root ${expanded} does not exist; placeholders will be created there on demand`);
        }
      }
    }
    setRemoteRootOverride(override);
    if (this.remoteRootApplied && remoteRoot() !== previous) addSupersededRoot(previous);
    this.remoteRootApplied = true;
  }
  /** Re-read the root after a settings write from any surface. */
  onSettingsUpdated(ns) {
    if (String(ns) !== "permission-remote") return;
    this.applyRemoteRootOverride();
    this.ctx.logger?.info(`[@dsh-permission-remote] remote root setting changed; routing now uses ${remoteRoot()}`);
  }
  /** The effective placeholder root and the built-in default. */
  remoteRootInfo() {
    return { current: remoteRoot(), defaultRoot: defaultRemoteRoot() };
  }
  exportHostConfig() {
    return exportHostConfig(this.config.hosts, this.config.deletedHosts);
  }
  async importHostConfig(payload, mode) {
    const incoming = parseHostImport(payload);
    const previous = new Map(this.config.hosts.map((host) => [host.id, host]));
    const previousTags = /* @__PURE__ */ new Map();
    for (const host of [...this.config.hosts, ...this.config.deletedHosts.map((row) => row.host)]) {
      previousTags.set(host.id, hostTag(host));
    }
    const merged = mergeImportedHosts(this.config.hosts, this.config.deletedHosts, incoming, mode);
    let deletedHosts = merged.deletedHosts;
    if (mode === "replace") {
      const live = new Set(merged.hosts.map((host) => host.id));
      const already = new Set(deletedHosts.map((row) => row.host.id));
      const owned = new Set(this.listWorkspaces().map((item) => item.hostId));
      const retained = this.config.deletedHosts.filter((row) => owned.has(row.host.id) && !live.has(row.host.id) && !already.has(row.host.id));
      deletedHosts = [...deletedHosts, ...retained.map((row) => ({ host: { ...row.host }, deletedAt: row.deletedAt ?? "" }))];
    }
    for (const host of merged.hosts) {
      const before = previous.get(host.id) ?? this.config.deletedHosts.find((row) => row.host.id === host.id)?.host;
      if (before !== void 0 && connectionKeyChanged(before, host)) await this.dropSecret(host.id);
    }
    this.config.hosts = merged.hosts;
    this.commitTombstones(deletedHosts);
    const nextIds = new Set(merged.hosts.map((host) => host.id));
    for (const before of previous.values()) {
      if (!nextIds.has(before.id)) this.forgetStatus(before.id);
    }
    for (const host of merged.hosts) {
      const before = previous.get(host.id);
      if (before === void 0 || connectionKeyChanged(before, host) || before.loginEnv !== host.loginEnv) {
        this.forgetStatus(host.id);
      }
    }
    await this.persistHosts();
    if (this.config.tagWorkspaceTitles) {
      for (const host of merged.hosts) {
        const previousTag = previousTags.get(host.id);
        if (previousTag === void 0 || previousTag === hostTag(host)) continue;
        await this.tagWorkspaces(host.id, void 0, previousTag);
      }
    }
    return { ok: true, ...merged, deletedHosts };
  }
  /** Forget the password stored for one host id. `modifyRecord` returning undefined would keep it. */
  async dropSecret(hostId) {
    const drop = this.ctx.credentials.deleteRecord;
    if (drop === void 0) return;
    await drop(credentialKey("dsh-permission-remote", hostId));
  }
  /**
   * Move the placeholder tree to `inputRoot` and point routing at it.
   *
   * The old tree's workspace rows are re-created at the new placeholder paths,
   * keeping their titles. A change is refused (without touching anything) while
   * workspaces have live sessions, and a non-empty target whose files conflict
   * is reported before it is merged, so the operator can choose the strategy.
   *
   * Nothing is committed until the plan has been accepted and the copy has
   * finished: the old tree is only ever read, so a failure leaves it as the
   * authoritative root.
   */
  async changeRemoteRoot(inputRoot, opts) {
    await this.ensureMigrationStateLoaded();
    const oldRoot = remoteRoot();
    const trimmed = inputRoot.trim();
    const newRoot = trimmed.length === 0 ? resolveLocalPath(defaultRemoteRoot()) : expandRemoteRoot(inputRoot);
    if (newRoot === null) throw new Error("remote root must be an absolute path or start with ~/");
    if (newRoot === oldRoot) {
      if (trimmed.length > 0 && this.config.remoteRoot !== newRoot) await this.commitRemoteRoot(newRoot);
      const roots = this.catchupRoots(newRoot);
      if (roots.length === 0) return { status: "unchanged", oldRoot, root: newRoot };
      const relocation2 = await this.relocateFromRoots(roots, newRoot);
      return { status: "unchanged", oldRoot, root: newRoot, ...summaryCounts(relocation2) };
    }
    const opened = this.remoteWorkspaceRows();
    const strategy = opts.strategy ?? "auto";
    const plan = await planRemoteRoot(oldRoot, newRoot, strategy);
    const accounted = opened.reduce((sum, item) => sum + item.ws.sessionIds.length, 0);
    const sessions = Math.max(accounted, this.liveSessionsUnder(opened));
    if (sessions > 0 && !opts.force) return { status: "has-sessions", oldRoot, root: newRoot, sessions };
    if (!plan.targetWasEmpty && opts.strategy === void 0 && plan.conflicts.length > 0) {
      return { status: "needs-strategy", oldRoot, root: newRoot, conflicts: plan.conflicts };
    }
    if (opts.strategy !== void 0 && opts.acceptedConflicts !== void 0) {
      const accepted = new Set(opts.acceptedConflicts);
      if (plan.conflicts.some((conflict) => !accepted.has(conflict))) {
        return { status: "needs-strategy", oldRoot, root: newRoot, conflicts: plan.conflicts };
      }
    }
    for (const item of opened) {
      const rel = `${item.hostId}/${encodeRemotePath(item.remotePath)}`;
      const blocked = plan.conflicts.some((conflict) => conflict === rel || rel.startsWith(`${conflict}/`));
      if (blocked) {
        throw new Error(`cannot move the remote root to ${newRoot}: ${rel} conflicts with an existing file or directory and was left unchanged`);
      }
    }
    let migration;
    try {
      migration = await runMigration(plan);
    } catch (error) {
      throw new Error(`copying the remote root to ${newRoot} failed: ${errorText3(error)}`);
    }
    const relocating = this.remoteWorkspaceRows();
    const created = [];
    const existedIds = new Set(this.workspaces.list().map((row) => String(row.id)));
    let workspacesRemapped = 0;
    try {
      for (const item of relocating) {
        const local = this.placeholderAt(newRoot, item.hostId, item.remotePath);
        if (local === null) throw new Error(`workspace ${String(item.ws.id)} cannot be mapped under ${newRoot}`);
        if (resolveLocalPath(item.ws.path) === resolveLocalPath(local)) {
          workspacesRemapped += 1;
          continue;
        }
        await mkdir5(local, { recursive: true });
        const row = await this.workspaces.create(local, item.ws.title);
        const rowId = String(row.id);
        if (!existedIds.has(rowId)) {
          existedIds.add(rowId);
          created.push(row);
        }
      }
    } catch (error) {
      for (const row of created.reverse()) {
        try {
          await this.workspaces.delete(row.id);
        } catch (cleanup) {
          this.ctx.logger?.warn(`[@dsh-permission-remote] could not roll back workspace ${String(row.id)}: ${errorText3(cleanup)}`);
        }
      }
      throw new Error(`registering workspaces at ${newRoot} failed: ${errorText3(error)}; the old root is still in use`);
    }
    if (this.recordSupersededRoot(oldRoot)) await this.persistMigrationState();
    try {
      await this.commitRemoteRoot(newRoot);
    } catch (error) {
      for (const row of created.reverse()) {
        try {
          await this.workspaces.delete(row.id);
        } catch (cleanup) {
          this.ctx.logger?.warn(`[@dsh-permission-remote] could not roll back workspace ${String(row.id)}: ${errorText3(cleanup)}`);
        }
      }
      throw new Error(`the placeholders were copied to ${newRoot}, but the new root could not be saved (${errorText3(error)}); the old root is still in use`);
    }
    addSupersededRoot(oldRoot);
    const relocation = await this.relocateStoredSessions(oldRoot, newRoot);
    const pendingAdded = this.recordPendingGrouping(relocation);
    if (pendingAdded) await this.persistMigrationState();
    const stuck = [];
    for (const item of relocating) {
      const local = this.placeholderAt(newRoot, item.hostId, item.remotePath);
      if (local === null || resolveLocalPath(item.ws.path) === resolveLocalPath(local)) continue;
      try {
        await this.workspaces.delete(item.ws.id);
        workspacesRemapped += 1;
      } catch (error) {
        stuck.push(String(item.ws.id));
        this.ctx.logger?.warn(`[@dsh-permission-remote] could not remove workspace ${String(item.ws.id)} from the old remote root: ${errorText3(error)}`);
      }
    }
    if (stuck.length > 0) {
      throw new Error(`the remote root is now ${newRoot}, but ${stuck.length} workspace registration(s) could not be removed from the old root (${stuck.join(", ")})`);
    }
    return { status: "changed", oldRoot, root: newRoot, migration, workspacesRemapped, ...summaryCounts(relocation) };
  }
  /**
   * Roots an earlier migration left behind, for a catch-up sweep onto `current`.
   *
   * Reads both the persisted list (survives a restart) and the in-process one
   * (a root migrated away from in this run), so the "close the session and
   * save again" advice keeps working across restarts too.
   */
  catchupRoots(current) {
    const roots = [];
    const seen = /* @__PURE__ */ new Set([resolveLocalPath(current)]);
    for (const root of this.migrationState.supersededRemoteRoots) {
      const canonical = resolveLocalPath(root);
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      roots.push(root);
    }
    return roots;
  }
  /**
   * Queue `work` behind any relocation already running on this core.
   * Callers outside the queue use this; the queued body must not call it again.
   */
  enqueueRelocation(work) {
    const run = this.relocationTail.then(work, work);
    this.relocationTail = run.then(() => void 0, () => void 0);
    return run;
  }
  /**
   * Move stored sessions from each of `roots` onto `newRoot`.
   *
   * One pass at a time: the load-time sweep and a save of the same root both
   * enter here, and running them together renames one directory twice.
   */
  relocateFromRoots(roots, newRoot) {
    return this.enqueueRelocation(() => this.relocateFromRootsNow(roots, newRoot));
  }
  /** The body of {@link relocateFromRoots}. Must not enqueue relocation again. */
  async relocateFromRootsNow(roots, newRoot) {
    const summary = { relocated: [], skippedLive: [], failed: [] };
    const survivors = /* @__PURE__ */ new Set();
    let pruned = false;
    for (const root of roots) {
      const part = await this.relocateStoredSessions(root, newRoot, true);
      summary.relocated.push(...part.relocated);
      summary.skippedLive.push(...part.skippedLive);
      summary.failed.push(...part.failed);
      if (part.retainedRoots !== void 0 && part.retainedRoots.length > 0) {
        summary.retainedRoots = [...summary.retainedRoots ?? [], ...part.retainedRoots];
      }
      if (part.relocated.length > 0 || part.skippedLive.length > 0 || part.failed.length > 0 || (part.retainedRoots?.length ?? 0) > 0) {
        survivors.add(resolveLocalPath(root));
      } else {
        pruned = true;
        if (existsSync2(root)) {
          this.ctx.logger?.info(`[@dsh-permission-remote] old remote root ${root} is still on disk; the sweep moved, skipped, and failed nothing`);
        }
      }
    }
    if (pruned && this.migrationState.supersededRemoteRoots.length > 0) {
      const scanned = new Set(roots.map((root) => resolveLocalPath(root)));
      this.migrationState.supersededRemoteRoots = this.migrationState.supersededRemoteRoots.filter((root) => !scanned.has(resolveLocalPath(root)) || survivors.has(resolveLocalPath(root)));
    }
    if (this.recordPendingGrouping(summary) || pruned) await this.persistMigrationState();
    return summary;
  }
  /**
   * Move every stored session whose header names `oldRoot` onto `newRoot`.
   *
   * Nothing here may fail the migration: the tree copy and the registry switch
   * already succeeded, so a stuck file is collected and reported instead.
   * Membership is deliberately not attached here — the registry caches session
   * headers at startup, so an immediate attach would validate against the
   * stale cwd and throw; {@link resumeSessionMigrationState} retries on the
   * next load with headers rebuilt from disk.
   */
  async relocateStoredSessions(oldRoot, newRoot, repairBodies = false) {
    try {
      return await relocateSessions({ oldRoot, newRoot, liveSessionIds: () => this.liveSessionIds(), repairBodies });
    } catch (error) {
      this.ctx.logger?.warn(`[@dsh-permission-remote] could not scan the session store while migrating to ${newRoot}: ${errorText3(error)}`);
      return { relocated: [], skippedLive: [], failed: [{ id: "*", reason: `the session store could not be scanned: ${errorText3(error)}` }] };
    }
  }
  /** Open sessions whose recorded cwd sits under one of the given placeholders. */
  liveSessionsUnder(rows) {
    const agents = this.ctx.get("agents");
    const list = agents?.list?.() ?? [];
    if (list.length === 0) return 0;
    const roots = rows.map((row) => canonicalPath(row.ws.path));
    let count = 0;
    for (const agent of list) {
      const cwd = agent.session?.header?.cwd;
      if (typeof cwd !== "string" || cwd.length === 0) continue;
      const resolved = canonicalPath(cwd);
      if (roots.some((root) => resolved === root || resolved.startsWith(`${root}${sep2}`))) count += 1;
    }
    return count;
  }
  /** Ids of sessions with a live writer; their files must never be moved. */
  liveSessionIds() {
    const live = /* @__PURE__ */ new Set();
    const agents = this.ctx.get("agents");
    for (const agent of agents?.list?.() ?? []) {
      const id = agent.session?.id;
      if (typeof id === "string" && id.length > 0) live.add(id);
    }
    return live;
  }
  /** Remember a migrated-away root in the persisted list; true when it was new. */
  recordSupersededRoot(root) {
    const resolved = resolveLocalPath(root);
    if (this.migrationState.supersededRemoteRoots.some((item) => resolveLocalPath(item) === resolved)) return false;
    this.migrationState.supersededRemoteRoots = [...this.migrationState.supersededRemoteRoots, resolved];
    return true;
  }
  /** Queue every moved session for a membership attach on a later load; true when it added one. */
  recordPendingGrouping(summary) {
    let rows;
    try {
      rows = this.workspaces.list();
    } catch {
      rows = void 0;
    }
    const wanted = new Map(this.migrationState.pendingSessionGrouping.map((entry) => [entry.id, entry.path]));
    let changed = false;
    for (const row of summary.relocated) {
      let path4;
      if (rows !== void 0) {
        const target = rows.find((item) => sameRealPath(item.path, row.to));
        path4 = target !== void 0 ? target.path : row.to;
      } else {
        path4 = row.to;
      }
      if (wanted.get(row.id) === path4) continue;
      wanted.set(row.id, path4);
      changed = true;
    }
    if (changed) this.migrationState.pendingSessionGrouping = [...wanted].map(([id, path4]) => ({ path: path4, id }));
    if (summary.failed.length > 0) {
      this.ctx.logger?.warn(`[@dsh-permission-remote] ${summary.failed.length} session(s) could not follow the remote root: ${summary.failed.map((item) => `${item.id} (${item.reason})`).join("; ")}`);
    }
    if (summary.skippedLive.length > 0) {
      this.ctx.logger?.info(`[@dsh-permission-remote] left ${summary.skippedLive.length} open session(s) on the old root; closing them and saving the root again moves them`);
    }
    return changed;
  }
  /**
   * Persist the migration bookkeeping to its sidecar document.
   *
   * Best-effort: the tree copy and the root switch already succeeded, so a
   * failed write must not turn a completed migration into an apparent failure.
   * The moved session is still correct on disk; losing the bookkeeping only
   * means its group is restored by a later successful sweep.
   */
  async persistMigrationState() {
    if (!this.migrationStateWritable) {
      this.ctx.logger?.warn("[@dsh-permission-remote] the migration bookkeeping was not readable this run; leaving the file untouched rather than overwriting it");
      return;
    }
    try {
      await writeMigrationState(this.migrationState);
    } catch (error) {
      this.ctx.logger?.warn(`[@dsh-permission-remote] the session migration bookkeeping could not be persisted: ${errorText3(error)}`);
    }
  }
  /**
   * Load the sidecar once, before any code path mutates migration state.
   *
   * `resumeSessionMigrationState` runs detached from `apply`, so a "save and
   * migrate" can arrive before the load finishes; both entry points await this
   * single-flight promise, so a mutation never runs on the empty placeholder
   * and the load can never replace already-recorded entries.
   */
  ensureMigrationStateLoaded() {
    if (this.migrationStateLoaded === null) this.migrationStateLoaded = this.loadMigrationState();
    return this.migrationStateLoaded;
  }
  /** Load the sidecar bookkeeping into this instance (plugin load). */
  async loadMigrationState() {
    const { state, problem, readError } = await readMigrationState();
    this.migrationState = state;
    this.migrationStateWritable = readError !== true;
    if (problem !== void 0) this.ctx.logger?.warn(`[@dsh-permission-remote] ${problem}${readError === true ? "; it will not be overwritten this run" : "; starting from empty bookkeeping"}`);
  }
  /**
   * Resume what an earlier run could not finish, from the plugin load.
   *
   * Restores the persisted superseded roots into the router (a session still
   * on one must be refused as a remote placeholder, not silently treated as a
   * local directory), sweeps them onto the current root, and attaches the
   * sessions that were moved earlier. The registry rebuilds its header index
   * per process, so an attach that had to fail mid-migration succeeds here —
   * that is why the pending list is persisted instead of retried on the spot.
   */
  async resumeSessionMigrationState() {
    await this.ensureMigrationStateLoaded();
    for (const root of this.migrationState.supersededRemoteRoots) addSupersededRoot(root);
    if (this.migrationState.pendingSessionGrouping.length === 0 && this.migrationState.supersededRemoteRoots.length === 0) return;
    const preexisting = new Set(this.migrationState.pendingSessionGrouping.map((entry) => entry.id));
    const registryReady = await this.waitForWorkspaceRegistry();
    const roots = this.catchupRoots(remoteRoot());
    if (roots.length > 0) {
      try {
        await this.relocateFromRoots(roots, remoteRoot());
      } catch (error) {
        this.ctx.logger?.warn(`[@dsh-permission-remote] the session catch-up sweep failed: ${errorText3(error)}`);
      }
    }
    if (registryReady) {
      await this.flushPendingSessionGrouping(preexisting);
    } else {
      this.ctx.logger?.warn("[@dsh-permission-remote] the workspace registry was not ready; session grouping is deferred to the next load (the sweep still ran)");
    }
  }
  /** Poll the workspace registry until it answers, or give up after a short wait. */
  async waitForWorkspaceRegistry() {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        this.workspaces.list();
        return true;
      } catch {
      }
      await new Promise((resolve2) => setTimeout(resolve2, 250));
    }
    return false;
  }
  /**
   * Attach each pending session to the workspace now registered at its path.
   *
   * Success removes the entry; a failure keeps it for the next load (the
   * registry may still be indexing, or the workspace row may have been
   * renamed since). Attaching is idempotent, so a retry after a partial run is
   * safe.
   */
  async flushPendingSessionGrouping(onlyIds) {
    if (this.migrationState.pendingSessionGrouping.length === 0) return;
    let rows;
    try {
      rows = this.workspaces.list();
    } catch {
      return;
    }
    const remaining = [];
    for (const entry of this.migrationState.pendingSessionGrouping) {
      if (onlyIds !== void 0 && !onlyIds.has(entry.id)) {
        remaining.push(entry);
        continue;
      }
      const target = rows.find((item) => sameRealPath(item.path, entry.path));
      if (target === void 0) {
        if (await sessionLogExists(resolveDshHome4(), entry.path, entry.id)) remaining.push(entry);
        continue;
      }
      const attach = target.attachSession;
      if (attach === void 0) {
        remaining.push(entry);
        continue;
      }
      try {
        await attach.call(target, entry.id);
      } catch (error) {
        remaining.push(entry);
        this.ctx.logger?.warn(`[@dsh-permission-remote] session ${entry.id} is at ${entry.path} but could not join its workspace yet: ${errorText3(error)}`);
      }
    }
    if (remaining.length !== this.migrationState.pendingSessionGrouping.length) {
      this.migrationState.pendingSessionGrouping = remaining;
      await this.persistMigrationState();
    }
  }
  /** Workspaces whose placeholder still routes, including ones registered during a copy. */
  remoteWorkspaceRows() {
    const mapped = [];
    for (const ws of this.workspaces.list()) {
      const route = workspaceRoute(ws.path);
      if (route !== null) mapped.push({ ws, hostId: route.hostId, remotePath: route.remotePath });
    }
    return mapped;
  }
  /** The placeholder path under an explicit root, before routing has switched to it. */
  placeholderAt(root, hostId, remotePath) {
    if (!isValidHostId(hostId)) return null;
    return joinPath2(root, hostId, encodeRemotePath(remotePath));
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
  /**
   * Register one remote directory as a workspace: the placeholder directory is
   * created locally, the title carries the server when tagging is on, and the
   * workspace registry keeps an existing row's title if it already exists.
   *
   * Shared by the settings page and the `ssh_workspace` tool, so both entries
   * point at the same real directory and cannot disagree about the title.
   * Neither entry lets the calling session enter. A session starts there when
   * the user opens the workspace.
   */
  async registerWorkspace(host, remotePath, title, signal) {
    if (remotePath.trim().length === 0) throw new Error("remote path is required");
    const normalized = normalizeRemoteDirectory(remotePath);
    if (normalized === null) throw new Error(`remote path must be absolute: ${remotePath}`);
    if (normalized === "/") throw new Error(`refusing to register "/": a workspace rooted at the remote filesystem root covers every path on ${hostLabel(host)}`);
    throwIfAborted(signal);
    const secret = await this.secret(host);
    let info;
    try {
      info = await withSignal(this.pool.sftpStat(host, secret, normalized), signal);
    } catch (error) {
      if (isRemoteMissing(error)) {
        throw new Error(`remote directory not found on ${hostLabel(host)}: ${normalized}; create it first with ssh_exec (mkdir -p) or pick an existing directory`);
      }
      throw error;
    }
    if (!info.isDirectory) throw new Error(`remote path is not a directory: ${normalized}`);
    throwIfAborted(signal);
    const resolved = normalizeRemoteDirectory(await withSignal(this.pool.sftpRealpath(host, secret, normalized), signal));
    if (resolved === null) throw new Error(`remote path must be absolute: ${normalized}`);
    if (resolved === "/") throw new Error(`refusing to register "/": a workspace rooted at the remote filesystem root covers every path on ${hostLabel(host)}`);
    const local = mapRemoteToLocal(host.id, resolved);
    if (local === null) throw new Error(`remote path must be absolute: ${resolved}`);
    throwIfAborted(signal);
    const existing = await this.findRegisteredWorkspace(host, secret, resolved, signal);
    if (existing !== void 0) {
      return { path: existing.placeholderPath, remotePath: existing.remotePath, title: existing.title, created: false };
    }
    await mkdir5(local, { recursive: true });
    const requested = title?.trim() || posix11.basename(resolved) || resolved;
    const nextTitle = createdWorkspaceTitle(host, requested, this.taggingEnabled);
    const workspace = await this.workspaces.create(local, nextTitle);
    return { path: workspace.path, remotePath: resolved, title: workspace.title, created: true };
  }
  /**
   * A workspace this host already has for `resolved`.
   *
   * The stored remote path is whatever was encoded at registration. A later
   * realpath of that spelling is the same directory, including a trailing-slash
   * variant that `normalizeRemoteDirectory` already collapsed.
   */
  async findRegisteredWorkspace(host, secret, resolved, signal) {
    const rows = this.listWorkspaces().filter((row) => row.hostId === host.id);
    const direct = rows.find((row) => normalizeRemoteDirectory(row.remotePath) === resolved);
    if (direct !== void 0) return direct;
    for (const row of rows) {
      const spelled = normalizeRemoteDirectory(row.remotePath);
      if (spelled === null || spelled === resolved) continue;
      try {
        const real = normalizeRemoteDirectory(await withSignal(this.pool.sftpRealpath(host, secret, spelled), signal));
        if (real === resolved) return row;
      } catch {
      }
    }
    return void 0;
  }
  /**
   * Whether this session may route `route` to the host.
   *
   * A workspace row does not qualify. Only a header already on that host does:
   * the session was opened from that machine's workspace. A leftover
   * placeholder under a local header is not enough. An opened session may
   * `cd /etc` on that host. Routing cannot cross hosts.
   */
  allowsRemoteCwd(route, headerCwd, env = process.env) {
    const registry = this.workspaces;
    if (registry === void 0) return true;
    const opened = routeByCwd(headerCwd, env);
    return opened.kind === "remote" && opened.hostId === route.hostId;
  }
  /** Record the live cwd and raw tool-call args for approval presentation. */
  rememberSessionEvent(sessionId, event) {
    if (sessionId === void 0) return;
    if (event.type === "working-directory/change" && typeof event.data?.cwd === "string") {
      this.sessionCwds.set(sessionId, event.data.cwd);
      if (this.sessionCwds.size > 1024) {
        const oldest = this.sessionCwds.keys().next().value;
        if (oldest !== void 0) this.sessionCwds.delete(oldest);
      }
      return;
    }
    if (event.type !== "tool/call" || typeof event.data?.callId !== "string") return;
    if (event.data.name !== "write" && event.data.name !== "edit") return;
    let filePath;
    if (typeof event.data.arguments === "string") {
      try {
        const parsed = JSON.parse(event.data.arguments);
        if (typeof parsed.file_path === "string") filePath = parsed.file_path;
      } catch {
      }
    }
    this.toolCalls.set(`${sessionId}\0${event.data.callId}`, { filePath, cwd: this.sessionCwds.get(sessionId) });
    if (this.toolCalls.size > 1024) {
      const oldest = this.toolCalls.keys().next().value;
      if (oldest !== void 0) this.toolCalls.delete(oldest);
    }
  }
  toolCallDetail(sessionId, callId) {
    if (sessionId === void 0 || callId === void 0) return void 0;
    return this.toolCalls.get(`${sessionId}\0${callId}`);
  }
  forgetSession(sessionId) {
    if (sessionId === void 0) return;
    this.sessionCwds.delete(sessionId);
    const prefix = `${sessionId}\0`;
    for (const key of this.toolCalls.keys()) {
      if (key.startsWith(prefix)) this.toolCalls.delete(key);
    }
  }
  /** Probe data for the fs write path, without exposing the whole Core. */
  async statusOf(host) {
    return this.probe(host.id);
  }
  /**
   * Whether the session that supplied a sandbox policy was opened on `hostId`.
   * A policy without a session cannot prove that boundary, so it is refused.
   */
  allowsRemoteSession(sessionId, hostId) {
    if (sessionId === void 0 || sessionId.length === 0) return false;
    const agents = this.ctx.get("agents");
    const agent = (agents?.list?.() ?? []).find((item) => String(item.session?.id ?? "") === sessionId);
    if (agent === void 0) return false;
    return this.allowsRemoteCwd({ kind: "remote", hostId, remoteCwd: "/", placeholderCwd: "/" }, agent.session?.header?.cwd);
  }
  toolHost(jobs) {
    return {
      pool: this.pool,
      hostOf: (id) => this.config.hosts.find((item) => item.id === id),
      secretOf: (host) => this.secret(host),
      statusOf: (host) => this.probe(host.id),
      createWorkspace: (host, remotePath, title, signal) => this.registerWorkspace(host, remotePath, title, signal),
      resolveMode: buildResolveMode(this.ctx),
      loginEnvOf: (host, signal) => this.loginEnvs.get(host.id, signal),
      jobs
    };
  }
  /** Read startup files once. A cancelled read is not stored; a timeout is stored as empty. */
  async readLoginEnv(hostId, signal) {
    const host = this.requireHost(hostId);
    const result = await this.pool.exec(host, await this.secret(host), loginEnvCaptureCommand(), LOGIN_ENV_CAPTURE_MS, signal);
    if (signal?.aborted === true) {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }
    return { stdout: result.stdout, timedOut: result.timedOut, stdoutTruncated: result.stdoutTruncated };
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
  const methods = ["testConnection", "trustFingerprint", "probe", "installDeps", "installRipgrep", "listDir", "createDir", "createWorkspace", "listWorkspaces", "tagWorkspaces", "removeWorkspace", "restoreHost", "purgeHost", "saveSecret", "saveHost", "refreshLoginEnv", "deleteHost", "remoteRootInfo", "changeRemoteRoot", "exportHosts", "importHosts"];
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
  read_image: (host, route, args, exec, ctx) => runReadImage(host, route, args, async (data, fileName) => {
    const attachments = ctx.get("attachments");
    if (attachments === void 0) throw new Error("no attachment service is mounted");
    const mediaType = sniffImage(data);
    if (mediaType === void 0) throw new Error(`cannot read "${fileName}": the file content is not a PNG, JPEG, WebP, or GIF`);
    return attachments.saveImage({ data, mediaType, name: fileName });
  }, exec),
  glob: (host, route, args, exec) => runGlob(host, route, args, exec),
  grep: (host, route, args, exec) => runGrep(host, route, args, exec),
  // A local PTY backend would open a shell inside the placeholder directory
  // while the sidebar terminal is already on the server. Refuse instead of
  // handing the model a prompt that is not where the Session is.
  terminal_open: async () => {
    throw new Error(TERMINAL_OPEN_REFUSED);
  }
};
function installRemoteApprovalDetail(ctx, core) {
  const register = ctx.on;
  return register("approval/request", async (request, next) => {
    if (request.toolName !== "write" && request.toolName !== "edit") return next();
    try {
      const session = request.agent.session;
      const cached = core.toolCallDetail(session?.id, request.callId);
      const cwd = cached?.cwd ?? session?.header?.cwd;
      const route = routeByCwd(cwd);
      if (route.kind !== "remote") return next();
      const requested = cached?.filePath ?? "";
      const host = core.requireHost(route.hostId);
      const label = host.name || host.host || route.hostId;
      const path4 = requested.length > 0 ? resolveRemotePath(requested, route.remoteCwd, route.placeholderCwd) : route.remoteCwd;
      const action = request.toolName === "write" ? "write" : "edit";
      const currentEn = request.displayReason?.en ?? request.reason ?? "";
      const currentZh = request.displayReason?.zh ?? currentEn;
      const mutable = request;
      mutable.displayReason = {
        ...request.displayReason,
        en: currentEn.length > 0 ? `SSH ${label}: ${action} ${path4} \u2014 ${currentEn}` : `SSH ${label}: ${action} ${path4}`,
        zh: currentZh.length > 0 ? `SSH ${label}\uFF1A${action} ${path4} \u2014 ${currentZh}` : `SSH ${label}\uFF1A${action} ${path4}`
      };
    } catch {
    }
    return await next();
  }, { prepend: true });
}
function apply(rawCtx, rawConfig) {
  const ctx = rawCtx;
  const core = new Core(ctx, readConfig(rawConfig), ctx.workspaceRegistry);
  clearSupersededRoots();
  core.applyRemoteRootOverride();
  ctx.effect(() => ctx.on("settings/document-updated", (ns) => core.onSettingsUpdated(ns)));
  const api = new SshApi(rawCtx, core);
  const unregisters = /* @__PURE__ */ new Set();
  let fsPatchReady = false;
  ctx.effect(() => ctx.settings.configure({ auto: false }));
  ctx.effect(() => async () => {
    const failure = settleDisposers([...unregisters]);
    unregisters.clear();
    if (failure !== void 0) {
      ctx.logger?.warn(`[@dsh-permission-remote] plugin cleanup failed: ${errorText3(failure)}`);
    }
    await clearStagedPresentFiles();
    await core.pool.dispose();
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
  rawCtx.inject(["fs"], (bridged) => {
    const ready2 = bridged;
    const removeFs = installRemoteFs(ready2, core);
    fsPatchReady = removeFs !== void 0 || remoteFsInstalled(ready2);
    const removeUploads = installRemoteUploads(ready2, core);
    const unbinds = [];
    if (removeFs !== void 0) {
      unregisters.add(removeFs);
      const unbind = core.bindRemoteTree((hostId) => removeFs.invalidateHost(hostId));
      unbinds.push(unbind);
      unregisters.add(unbind);
    }
    if (removeUploads !== void 0) {
      unregisters.add(removeUploads);
      const unbind = core.bindRemoteTree((hostId) => removeUploads.invalidateHost(hostId));
      unbinds.push(unbind);
      unregisters.add(unbind);
    }
    bridged.effect(() => () => {
      removeFs?.();
      removeUploads?.();
      for (const unbind of unbinds) unbind();
      if (removeFs !== void 0) unregisters.delete(removeFs);
      if (removeUploads !== void 0) unregisters.delete(removeUploads);
      for (const unbind of unbinds) unregisters.delete(unbind);
    });
  });
  void api;
  const seen = /* @__PURE__ */ new Set();
  const denied = /* @__PURE__ */ new Map();
  const disarmRemoteDeny = (agent) => {
    const remove = denied.get(agent);
    if (remove === void 0) return;
    remove();
  };
  const armRemoteDeny = (agent) => {
    if (denied.has(agent)) return;
    let removeGuard;
    try {
      removeGuard = agent.ctx.tools.guard(() => REMOTE_SURFACE_UNMOUNTED);
    } catch (error) {
      ctx.logger?.warn(`[@dsh-permission-remote] remote tools stay unmounted and local tools could not be denied for agent ${agentLabel(agent)}: ${errorText3(error)}`);
      return;
    }
    let dropped = false;
    const drop = () => {
      if (dropped) return;
      dropped = true;
      denied.delete(agent);
      unregisters.delete(drop);
      try {
        removeGuard?.();
      } catch (error) {
        ctx.logger?.warn(`[@dsh-permission-remote] remote deny guard removal failed for agent ${agentLabel(agent)}: ${errorText3(error)}`);
      }
    };
    denied.set(agent, drop);
    unregisters.add(drop);
    try {
      agent.ctx.effect(() => drop);
    } catch (error) {
      ctx.logger?.warn(`[@dsh-permission-remote] remote deny guard is not tied to agent ${agentLabel(agent)}: ${errorText3(error)}`);
    }
  };
  const attach = (agent) => {
    if (seen.has(agent)) return;
    seen.add(agent);
    let installed = false;
    try {
      installed = installShadows(ctx, core, agent, unregisters, () => {
        seen.delete(agent);
      }, () => fsPatchReady);
    } catch (error) {
      if (!installed && sessionIsRemote(ctx, agent)) armRemoteDeny(agent);
      throw error;
    } finally {
      if (!installed) seen.delete(agent);
    }
    disarmRemoteDeny(agent);
  };
  ctx.on("agent/created", ({ agent }) => attach(agent));
  const agents = ctx.get("agents");
  if (typeof agents?.list === "function") {
    for (const agent of agents.list()) {
      try {
        attach(agent);
      } catch (error) {
        ctx.logger?.warn(`[@dsh-permission-remote] shadow install failed for agent ${agentLabel(agent)}: ${errorText3(error)}`);
      }
    }
  }
  void core.autoTagWorkspaces().catch((error) => {
    ctx.logger?.warn(`[@dsh-permission-remote] workspace title tagging failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  void core.resumeSessionMigrationState().catch((error) => {
    ctx.logger?.warn(`[@dsh-permission-remote] could not resume the session migration state: ${error instanceof Error ? error.message : String(error)}`);
  });
  ctx.logger?.info("[@dsh-permission-remote] loaded");
}
function assertEnterableRemoteCwd(core, route, headerCwd) {
  if (core.allowsRemoteCwd(route, headerCwd)) return;
  throw new Error(`refusing to use ${route.remoteCwd} on SSH host ${route.hostId}: this session was not opened on that host. Open the workspace from the list.`);
}
function assertResolvedRemoteCwd(core, hostId, remotePath, headerCwd) {
  const local = mapRemoteToLocal(hostId, remotePath);
  if (local === null) throw new Error("remote directory cannot be mapped to a workspace path");
  const mapped = routeByCwd(local);
  if (mapped.kind !== "remote" || mapped.hostId !== hostId) {
    throw new Error("remote directory cannot be mapped to a workspace path");
  }
  assertEnterableRemoteCwd(core, { kind: "remote", hostId, remoteCwd: remotePath, placeholderCwd: local }, headerCwd);
}
function assertRemoteWorkingDirectoryTarget(core, route, args, headerCwd) {
  const requested = typeof args.cd === "string" ? args.cd.trim() : "";
  if (requested.length === 0) return;
  assertResolvedRemoteCwd(core, route.hostId, resolveRemotePath(requested, route.remoteCwd, route.placeholderCwd), headerCwd);
}
function commitRemoteWorkingDirectory(core, ctx, host, route, args, exec, headerCwd) {
  assertRemoteWorkingDirectoryTarget(core, route, args, headerCwd);
  return runWorkingDirectory(host, route, args, exec, async (directory) => {
    const directories = ctx.get("workingDirectory");
    if (directories === void 0 || exec.agent === void 0) throw new Error("working_directory requires an agent Session");
    return directories.set(exec.agent, directory, exec.signal);
  }, (remote) => {
    assertResolvedRemoteCwd(core, route.hostId, remote, headerCwd);
  });
}
async function runPresent(official, host, route, args, exec) {
  if (official === void 0) throw new Error("dsh-permission-remote: present is not mounted in this session");
  const requested = Array.isArray(args.files) ? args.files : [];
  if (requested.length === 0) return official(args, exec);
  const files = requested.map((file) => {
    const record = file;
    if (typeof record.path !== "string") throw new FsError4("Cannot present a file: each entry needs a string path", "FS_NOT_FOUND");
    return { path: record.path };
  });
  const staged = await stagePresentFiles(host, route, files, exec);
  const presented = requested.map((file, index) => ({ ...file, path: staged[index].path }));
  return official({ ...args, files: presented }, exec);
}
function canonicalFs(ctx) {
  const fs = ctx.get("fs");
  if (typeof fs?.resolve !== "function" || typeof fs.processPath !== "function") return void 0;
  return fs;
}
async function assertLocalWorkingDirectory(core, args, current, headerCwd, fs, signal) {
  const requested = typeof args.cd === "string" ? args.cd.trim() : "";
  if (requested.length === 0 || current === void 0) return;
  const lexical = resolveLocalPath(current, requested);
  if (fs === void 0) {
    const lexicalRoute = routeByCwd(lexical);
    if (lexicalRoute.kind === "remote") {
      assertEnterableRemoteCwd(core, lexicalRoute, headerCwd);
      return;
    }
    throw new Error("refusing to change directory: the filesystem service is unavailable, so a symlink into a remote workspace cannot be checked");
  }
  let canonical;
  try {
    canonical = fs.processPath(await fs.resolve(requested, { cwd: current, signal }));
  } catch (error) {
    if (signal?.aborted === true || error instanceof Error && error.name === "AbortError") throw error;
    const lexicalRoute = routeByCwd(lexical);
    if (lexicalRoute.kind === "remote") assertEnterableRemoteCwd(core, lexicalRoute, headerCwd);
    return;
  }
  const route = routeByCwd(canonical);
  if (route.kind === "remote") assertEnterableRemoteCwd(core, route, headerCwd);
}
function installShadows(ctx, core, agent, unregisters, forget, fsReady) {
  const headerCwd = agent.session?.header?.cwd;
  const opened = routeByCwd(effectiveCwd(ctx, { agent }, headerCwd));
  const disposers = [];
  let disposeDynamic = () => {
  };
  try {
    const plans = planShadows((name2) => agent.ctx.tools.get(name2, agent));
    disposers.push(installRemoteApprovalDetail(agent.ctx, core));
    const hasOfficialBash = plans.some((plan) => plan.name === "bash" && plan.official !== void 0);
    const host = core.toolHost(agent.ctx.get("jobs"));
    for (const plan of plans) {
      if (plan.official === void 0) continue;
      const official = plan.official;
      const base = capturedSchema(agent.ctx.tools, plan.name, agent);
      const definition = {
        ...base,
        name: plan.name,
        async execute(args, exec) {
          const cwd = effectiveCwd(ctx, exec, headerCwd);
          const current = routeByCwd(cwd);
          const record = args;
          if (current.kind !== "remote") {
            if (plan.name === "working_directory") await assertLocalWorkingDirectory(core, record, cwd, headerCwd, canonicalFs(ctx), exec.signal);
            return dispatchShadow(official, false, async () => {
              throw new Error("dsh-permission-remote: local call has no official tool");
            }, args, exec);
          }
          assertEnterableRemoteCwd(core, current, headerCwd);
          if (plan.name === "working_directory") return commitRemoteWorkingDirectory(core, ctx, host, current, record, exec, headerCwd);
          if (plan.name === "present") return runPresent(official, host, current, record, exec);
          return RUNNERS[plan.name](host, current, record, exec, ctx);
        }
      };
      if (plan.name === "working_directory") definition.output = workingDirectoryOutput(base.output);
      disposers.push(agent.ctx.tools.register(withRemoteTimeout(definition)));
    }
    const surface = installRemoteShellSurface(ctx, core, agent, host, headerCwd, hasOfficialBash, disposers, fsReady);
    disposeDynamic = surface.disposeDynamic;
    surface.sync(opened);
  } catch (error) {
    const cleanup = releaseShadows(disposeDynamic, disposers);
    ctx.logger?.warn(`[@dsh-permission-remote] shadow install failed for agent ${agentLabel(agent)}: ${errorText3(error)}`);
    if (cleanup !== void 0) {
      ctx.logger?.warn(`[@dsh-permission-remote] shadow cleanup failed for agent ${agentLabel(agent)}: ${errorText3(cleanup)}`);
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
    core.forgetSession(agent.session?.id);
    unregisters.delete(drop);
    try {
      forget();
    } catch (error) {
      ctx.logger?.warn(`[@dsh-permission-remote] shadow cleanup failed for agent ${agentLabel(agent)}: ${errorText3(error)}`);
    }
    if (failure !== void 0) {
      ctx.logger?.warn(`[@dsh-permission-remote] shadow cleanup failed for agent ${agentLabel(agent)}: ${errorText3(failure)}`);
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
function installRemoteShellSurface(ctx, core, agent, host, headerCwd, hasOfficialBash, disposers, fsReady) {
  const dynamic = [];
  let applied = { kind: "local" };
  const currentRoute = () => routeByCwd(effectiveCwd(ctx, { agent }, headerCwd));
  const remoteNow = () => currentRoute().kind === "remote";
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
            if (current.kind === "remote") assertEnterableRemoteCwd(core, current, headerCwd);
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
    const remote = routeByCwd(effectiveCwd(ctx, execution, headerCwd)).kind === "remote";
    if (isWindowsShell(execution.name)) return windowsShellGuardReason(remote);
    if (!remote || fsReady()) return void 0;
    if (FS_SURFACE_TOOLS.has(execution.name)) return REMOTE_FS_UNPATCHED;
    return void 0;
  }));
  disposers.push(agent.ctx.on("system-prompt/assemble", async (_assembly, context, next) => {
    const assembled = await next();
    if (context.scope !== void 0 && context.scope !== agent) return assembled;
    if (!remoteNow()) return assembled;
    const declared = assembled.tools;
    if (!Array.isArray(declared)) return assembled;
    return { ...assembled, tools: withoutWindowsShells(declared, true) };
  }));
  disposers.push(agent.ctx.systemPrompt.section({
    name: REMOTE_POSIX_SECTION,
    order: agent.ctx.systemPrompt.getSectionOrder("TOOL_BASH") + 5,
    text: () => remotePosixPrompt(remoteNow())
  }));
  const contextOrder = typeof agent.ctx.systemPrompt.getContextOrder === "function" ? agent.ctx.systemPrompt.getContextOrder("WORKING_DIRECTORY") : void 0;
  if (typeof agent.ctx.systemPrompt.context === "function" && typeof contextOrder === "number" && Number.isFinite(contextOrder)) {
    disposers.push(agent.ctx.systemPrompt.context({
      name: REMOTE_WORKSPACE_CONTEXT,
      order: contextOrder + 1,
      required: true,
      interpolate: false,
      text: () => remoteWorkspaceContextText(currentRoute())
    }));
  }
  disposers.push(agent.ctx.on("session/event", (_session, event) => {
    core.rememberSessionEvent(agent.session?.id, event);
    if (event.type !== "working-directory/change") return;
    if (typeof event.data?.cwd !== "string") return;
    const route = routeByCwd(event.data.cwd);
    try {
      sync(route);
    } catch (error) {
      const remoteMounted = shellSurfacePlan(applied, hasOfficialBash).remote;
      if (route.kind === "remote" && !remoteMounted) {
        const bash = hasOfficialBash ? "The preset bash tool is still registered." : "No bash tool was registered.";
        ctx.logger?.warn(`[@dsh-permission-remote] remote shell surface was not mounted for agent ${agentLabel(agent)}: ${errorText3(error)}. Windows shells stay off the native tool list and cannot run. ${bash} A later working-directory change retries.`);
        return;
      }
      ctx.logger?.warn(`[@dsh-permission-remote] shell surface sync failed for agent ${agentLabel(agent)}: ${errorText3(error)}`);
    }
  }));
  return { sync, disposeDynamic };
}
function summaryCounts(summary) {
  return {
    sessionsRelocated: summary.relocated.length,
    sessionsSkippedLive: summary.skippedLive.length,
    sessionsFailed: summary.failed.length
  };
}
function errorText3(error) {
  return error instanceof Error ? error.message : String(error);
}
function canonicalPath(path4) {
  try {
    return realpathSync3(path4);
  } catch {
    return resolveLocalPath(path4);
  }
}
function sameRealPath(left, right) {
  const canon = (path4) => {
    try {
      return realpathSync3(path4);
    } catch {
      return resolveLocalPath(path4);
    }
  };
  return canon(left) === canon(right);
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
var REMOTE_SURFACE_UNMOUNTED = "SSH tools did not mount for this remote workspace, so tool calls are refused";
var REMOTE_FS_UNPATCHED = "the remote filesystem patch is unavailable, so file tools are refused instead of writing into the local placeholder";
var FS_SURFACE_TOOLS = /* @__PURE__ */ new Set([
  "read",
  "read_image",
  "write",
  "edit",
  "apply_patch",
  "str_replace_editor"
]);
function agentLabel(agent) {
  return agent.session?.id ?? agent.session?.header?.cwd ?? "unknown";
}
function sessionIsRemote(ctx, agent) {
  try {
    return routeByCwd(effectiveCwd(ctx, { agent }, agent.session?.header?.cwd)).kind === "remote";
  } catch {
    return false;
  }
}
var REMOTE_TIMEOUT_DESCRIPTION = "Timeout in milliseconds. When it expires this remote command is killed. Without a sandbox runner, child processes of the command may keep running on the remote host.";
function withRemoteTimeout(definition) {
  const parameters = definition.parameters;
  if (parameters === void 0) return definition;
  const properties = parameters.properties;
  const timeoutField = properties?.timeoutMs ?? parameters.timeoutMs;
  if (timeoutField === void 0) return definition;
  const withDescription = { ...timeoutField, description: REMOTE_TIMEOUT_DESCRIPTION };
  if (properties !== void 0) {
    return { ...definition, parameters: { ...parameters, properties: { ...properties, timeoutMs: withDescription } } };
  }
  return { ...definition, parameters: { ...parameters, timeoutMs: withDescription } };
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
var DEFAULT_WORKING_DIRECTORY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { cwd: { type: "string", description: "Current absolute working directory." } },
  required: ["cwd"]
};
function workingDirectoryOutput(official) {
  const base = official ?? {};
  const schema = base.schema ?? DEFAULT_WORKING_DIRECTORY_SCHEMA;
  return {
    ...base,
    schema: {
      ...schema,
      properties: {
        ...schema.properties ?? {},
        remote: { type: "string", description: "The real directory on the SSH host that this placeholder path maps to." }
      }
    },
    render: (_args, value) => [{
      type: "text",
      text: typeof value?.remote === "string" && value.remote.length > 0 ? `${String(value.cwd)}
(remote: ${value.remote})` : String(value?.cwd ?? "")
    }]
  };
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
  const limits = () => core.transferLimits();
  return [publishOpsTool({
    name: "ssh_hosts",
    description: 'List the configured SSH hosts for ops on another machine: id, name, address, user, ops policy, and whether the host key is trusted. Call this before ssh_exec, ssh_read, ssh_write, ssh_upload, ssh_download, or ssh_workspace when you do not know the host id or name. Policy "ask" allows reads but needs danger-full-access for commands, writes, uploads, downloads, and workspace registration, so pass sandbox_permissions "danger-full-access" and a justification; "trust" runs without a prompt; "deny" accepts nothing. An untrusted host must be trusted in Settings \u2192 SSH hosts first.',
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
    name: "ssh_workspace",
    description: 'Add a workspace for an existing SSH host: register one remote directory as a DSH workspace. Opening that workspace from the list starts a session on that machine, and file and command tools in that session run there. The directory must already exist and be a directory; create it with ssh_exec first if it does not, and call ssh_hosts when you do not know the host id or name. The filesystem root "/" is refused. This call only adds the sidebar workspace. It does not move the current session, does not return the placeholder, and does not let this session enter that directory. On an "ask" host this needs danger-full-access, because opening the new workspace starts a session on that machine: pass sandbox_permissions "danger-full-access" and a one-sentence justification when the call is denied. Remote files are not modified. The host key must already be trusted in Settings \u2192 SSH hosts. The title defaults to the directory name; registering the same directory again keeps the existing row and its title (the result then reports created: false).',
    parameters: {
      host: { type: "string", required: true, description: "SSH host id, name, or address from ssh_hosts" },
      directory: { type: "string", required: true, description: 'Absolute remote directory to register, or a path starting with "~/". "/" is refused' },
      title: { type: "string", description: "Sidebar title; defaults to the directory name, prefixed with the server when title tagging is on" },
      ...OPS_ESCALATION
    },
    output: textOutput(renderSshWorkspace),
    execute(args, exec) {
      const record = args;
      const host = pick(record);
      return runSshWorkspace(hostApi, host, record, exec);
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
  }), publishOpsTool({
    name: "ssh_upload",
    description: 'Copy one local file to a configured SSH host over the SSH connection. This is for ops on a machine that is not your current workspace. local_path is an absolute path on the machine running DSH (not the remote host, and not a placeholder path when the session itself is remote); remote_path is an absolute remote path or starts with "~/". The bytes are written beside the target and renamed with mv -f, so a dropped connection never truncates the original, an existing file keeps its permission bits when the server reports them, and a new file uses the remote umask. The filesystem root "/" is refused, and so is a final symlink, a directory, or a special file (FIFO/device). Single files only; the byte ceiling and timeout come from Settings and 0 means unlimited. On an "ask" host this needs danger-full-access: pass sandbox_permissions "danger-full-access" and a one-sentence justification when the call is denied. Call ssh_hosts when you do not know the host id or name.',
    parameters: {
      host: { type: "string", required: true, description: "SSH host id, name, or address from ssh_hosts" },
      local_path: { type: "string", required: true, description: "Absolute path on the machine running DSH" },
      remote_path: { type: "string", required: true, description: 'Absolute remote path or a path starting with "~/"' },
      ...OPS_ESCALATION
    },
    output: textOutput(renderOpsUpload),
    execute(args, exec) {
      const record = args;
      const host = pick(record);
      return runSshUpload(hostApi, host, record, exec, limits());
    }
  }), publishOpsTool({
    name: "ssh_download",
    description: 'Copy one file from a configured SSH host to a local path over SFTP. This is for ops on a machine that is not your current workspace. remote_path is an absolute remote path or starts with "~/"; local_path is an absolute path on the machine running DSH whose parent directory already exists. The file is replaced atomically and gets mode 0600. A remote symlink, directory, or special file (FIFO/device) is refused, and so is a local directory or symlink at the target. Single files only; the byte ceiling and timeout come from Settings and 0 means unlimited. Downloading writes a local file, so it is gated like ssh_write: on an "ask" host it needs danger-full-access, with sandbox_permissions "danger-full-access" and a one-sentence justification when the call is denied. Call ssh_hosts when you do not know the host id or name.',
    parameters: {
      host: { type: "string", required: true, description: "SSH host id, name, or address from ssh_hosts" },
      remote_path: { type: "string", required: true, description: 'Absolute remote path or a path starting with "~/"' },
      local_path: { type: "string", required: true, description: "Absolute path on the machine running DSH; its parent must already exist" },
      ...OPS_ESCALATION
    },
    output: textOutput(renderOpsDownload),
    execute(args, exec) {
      const record = args;
      const host = pick(record);
      return runSshDownload(hostApi, host, record, exec, limits());
    }
  })];
}
export {
  Config,
  Core,
  apply,
  inject,
  installRemoteApprovalDetail,
  name
};
