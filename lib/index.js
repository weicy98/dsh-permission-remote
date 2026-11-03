// src/index.ts
import { existsSync as existsSync2, realpathSync as realpathSync2 } from "node:fs";
import { mkdir as mkdir5 } from "node:fs/promises";
import { join as joinPath2, posix as posix7, resolve as resolveLocalPath } from "node:path";
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

// src/router.ts
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
function supersededRootsSnapshot() {
  return [...supersededRoots];
}
function routingRoots(env = process.env) {
  const roots = [remoteRoot(env)];
  for (const root of supersededRoots) {
    if (!roots.includes(root)) roots.push(root);
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
  for (const root of routingRoots(env)) {
    const route = routeUnderRoot(root, cwd);
    if (route.kind === "remote") return route;
  }
  return { kind: "local" };
}
function workspaceBinding(cwd, env = process.env) {
  if (!cwd) return null;
  for (const root of routingRoots(env)) {
    const rel = path.relative(root, cwd);
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
   * Placeholder roots this profile migrated away from, persisted so the
   * in-memory router survives a restart: a session still on one must keep
   * being refused as a remote placeholder instead of silently becoming a
   * local directory, and the session catch-up sweep needs the list to find it.
   *
   * Internal bookkeeping, not operator input. It is `.volatile()` only because
   * that is what lets `settings.update` persist it (`hosts`/`deletedHosts`
   * work the same way). Both lists are sanitized on read, so an accidental
   * edit self-heals: a dropped root is re-derived by a later migration, a
   * dropped pending entry re-groups on the next relocation.
   */
  supersededRemoteRoots: Schema.array(Schema.string()).default([]).volatile(),
  /**
   * Sessions whose logs were relocated to a new root but whose workspace
   * membership could not be restored in the same process: the workspace
   * registry caches session headers at startup, so an immediate attach would
   * validate against the stale cwd and throw. Entries retry on the next
   * plugin load, when the registry reads headers from disk again.
   */
  /** Relocated sessions awaiting a membership attach on the next load; see above. */
  pendingSessionGrouping: Schema.array(Schema.object({
    path: Schema.string().default(""),
    id: Schema.string().default("")
  })).default([]).volatile()
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
  const supersededRef = refOf(record.supersededRemoteRoots);
  const pendingRef = refOf(record.pendingSessionGrouping);
  const supersededRaw = normalizeRootList(supersededRef !== void 0 ? supersededRef.get() : record.supersededRemoteRoots);
  const pendingRaw = normalizePendingList(pendingRef !== void 0 ? pendingRef.get() : record.pendingSessionGrouping);
  const parsed = Config({
    ...record,
    hosts: copyHostRows(hostRef !== void 0 ? hostRef.get() : record.hosts),
    deletedHosts: copyDeletedRows(deletedRef !== void 0 ? deletedRef.get() : record.deletedHosts),
    // A volatile reference cannot be validated; resolve it to a value first.
    tagWorkspaceTitles: tagRef !== void 0 ? tagRef.get() !== false : tagDefault,
    rgRegistry: registryRef !== void 0 ? String(registryRef.get() ?? "") : registryDefault,
    remoteRoot: rootRef !== void 0 ? String(rootRef.get() ?? "") : rootDefault,
    supersededRemoteRoots: supersededRaw,
    pendingSessionGrouping: pendingRaw
  });
  const maxConnections = parsed.maxConnections ?? 4;
  const tag = tagRef === void 0 ? () => tagDefault : () => tagRef.get() !== false;
  const registry = () => String(registryRef === void 0 ? registryDefault : registryRef.get() ?? "").trim();
  const root = () => String(rootRef === void 0 ? rootDefault : rootRef.get() ?? "").trim();
  const supersededRemoteRoots = normalizeRootList(supersededRaw);
  const pendingSessionGrouping = normalizePendingList(pendingRaw);
  const ref = hostRef ?? parsed.hosts;
  const deletedRowRef = deletedRef ?? refOf(parsed.deletedHosts);
  const deletedRows = copyDeletedRows(deletedRowRef !== void 0 ? deletedRowRef.get() : record.deletedHosts) ?? [];
  if (isHostRef(ref)) return viewConfig(ref, maxConnections, tag, registry, root, rootRef, deletedRowRef, deletedRows, supersededRemoteRoots, pendingSessionGrouping);
  return { hosts: asHostArray(ref), deletedHosts: deletedRows, maxConnections, tagWorkspaceTitles: tagDefault, rgRegistry: registry(), remoteRoot: root(), supersededRemoteRoots, pendingSessionGrouping };
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
    if (!isRecord(item)) continue;
    const path2 = typeof item.path === "string" ? item.path : "";
    const id = typeof item.id === "string" ? item.id : "";
    if (path2.length === 0 || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    out.push({ path: path2, id });
  }
  return out;
}
function refOf(value) {
  return isVolatile(value) ? value : void 0;
}
function viewConfig(ref, maxConnections, tagWorkspaceTitles, rgRegistry, remoteRoot2, rootRef, deletedRef, deletedRows, supersededRemoteRoots, pendingSessionGrouping) {
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
    set remoteRoot(value) {
      if (rootRef === void 0) throw new Error("the remote root setting is not writable in this config");
      updateVolatile(rootRef, createVolatile(String(value ?? "")));
    },
    supersededRemoteRoots,
    pendingSessionGrouping
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
function declarationName(line) {
  const match = /^(?:declare\s+-x|export)\s+([A-Za-z_][A-Za-z0-9_]*)(?:=|$)/.exec(line);
  return match?.[1];
}
function stripSessionState(text2) {
  const lines = text2.split("\n");
  const kept = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const name2 = declarationName(line);
    if (name2 === void 0) {
      kept.push(line);
      index += 1;
      continue;
    }
    let end = index;
    let block = line;
    while (!quotesBalanced(block) && end + 1 < lines.length) {
      end += 1;
      block += `
${lines[end] ?? ""}`;
    }
    if (!SESSION_STATE.has(name2) || !quotesBalanced(block)) kept.push(block);
    index = end + 1;
  }
  return kept.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
}
function quotesBalanced(text2) {
  let state = "none";
  let index = 0;
  while (index < text2.length) {
    const char = text2[index] ?? "";
    if (state === "none") {
      if (char === '"') state = "double";
      else if (char === "'") state = "single";
      else if (char === "$" && text2[index + 1] === "'") {
        state = "ansi";
        index += 1;
      }
      index += 1;
      continue;
    }
    if (state === "single") {
      if (char === "'") state = "none";
      index += 1;
      continue;
    }
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "'" && state === "ansi") state = "none";
    else if (char === '"' && state === "double") state = "none";
    index += 1;
  }
  return state === "none";
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
  const chmod2 = bits === void 0 ? "" : ` && chmod ${bits.toString(8)} ${quotedTarget}`;
  const write = `if test -d ${quotedTarget}; then echo 'remote path is a directory' >&2; false; else cat > ${shJoin([tmp])} && mv -f ${shJoin([tmp, target])}${chmod2}; fi`;
  const cleanup = `{ status=$?; rm -f ${shJoin([tmp])}; exit $status; }`;
  return `mkdir -p ${shJoin([directory])} && ${write} || ${cleanup}`;
}

// src/probe.ts
import { posix as posix3 } from "node:path";
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
    if (posix3.isAbsolute(line) && !/\s/.test(line)) return line;
  }
  return "";
}
function absoluteOr(value, fallback) {
  return posix3.isAbsolute(value) ? value : fallback;
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
var require2 = createRequire(import.meta.url);
var READ_CAP = 1024 * 1024;
var IMAGE_CAP = 8 * 1024 * 1024;
var denialMarker = sandboxDenialMarker;
var hintMarker = escalationHintMarker;
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
function sandboxWorkspaceRoot(route, exec) {
  const opened = workspaceBinding(exec.agent?.session?.header?.cwd);
  if (opened !== null && opened.hostId === route.hostId) return opened.remotePath;
  return route.remoteCwd;
}
function sandboxRoots(hostApi, route, exec, status, host, secret) {
  return rootsFor(status, sandboxWorkspaceRoot(route, exec), hostApi.pool, host, secret);
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
async function runRead(hostApi, route, args, exec) {
  throwIfAborted(exec?.signal);
  const host = requireHost(hostApi, route.hostId);
  const secret = await hostApi.secretOf(host);
  const remotePath = resolveRemotePath(String(args.file_path ?? ""), route.remoteCwd, route.placeholderCwd);
  const bytes = await withSignal(hostApi.pool.sftpRead(host, secret, remotePath, READ_CAP), exec?.signal);
  const text2 = bytes.toString("utf8");
  const all = text2.split(/\n/);
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
  const roots = await sandboxRoots(hostApi, route, exec, status, host, secret);
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
  const roots = await sandboxRoots(hostApi, route, exec, status, host, secret);
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
  return new Promise((resolve2, reject) => {
    const fail = () => reject(abortError());
    signal.addEventListener("abort", fail, { once: true });
    const detach = () => signal.removeEventListener("abort", fail);
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
function clip(text2, max = 160) {
  const flat = text2.replace(/\s+/g, " ").trim();
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
  if (!posix5.isAbsolute(requested) && requested !== "~" && !requested.startsWith("~/")) {
    throw new Error(`directory must be an absolute remote path or start with "~/": ${requested}`);
  }
  if (posix5.isAbsolute(requested)) refuseFilesystemRoot(requested, host);
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
  const path2 = String(value.remotePath ?? "");
  if (value.created === false) {
    return `workspace already registered: "${title}" for ${path2} on ${label}; nothing changed, and the existing title was kept`;
  }
  return `workspace added: "${title}" for ${path2} on ${label}. This session stays here. Open the workspace from the list to start a session on that machine`;
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
function refuseFilesystemRoot(remotePath, host) {
  if (normalizeRemoteDirectory(remotePath) !== "/") return;
  throw new Error(`refusing to register "/": a workspace rooted at the remote filesystem root covers every path on ${hostLabel(host)}`);
}
async function resolveOpsPath(hostApi, host, secret, requested, field = "file_path") {
  const path2 = requested.trim();
  if (path2.length === 0) throw new Error(`${field} is required`);
  if (posix5.isAbsolute(path2)) return posix5.normalize(path2);
  if (path2 === "~") return remoteHome(hostApi, host, secret);
  if (path2.startsWith("~/")) {
    const home = await remoteHome(hostApi, host, secret);
    return posix5.normalize(posix5.join(home, path2.slice(2)));
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
    if (posix5.isAbsolute(home)) return home;
  }
  return void 0;
}

// src/session-relocate.ts
import { chmod, mkdir as mkdir2, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join as joinPath, relative as relativePath, resolve as resolvePath, sep } from "node:path";
import { constants as zconst, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { resolveDshHome as resolveDshHome2 } from "@deepseek-ai/dsh-home-paths";
var ZSTD_MAGIC = 4247762216;
var SESSION_FORMAT_VERSION = 4;
var CHECKSUM_OPTIONS = { params: { [zconst.ZSTD_c_checksumFlag]: 1 } };
var LOG_NAME = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/;
var MAX_REWRITE_BYTES = 64 * 1024 * 1024;
var HEADER_PROBE_BYTES = 64 * 1024;
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
function sitsUnder(cwd, root) {
  const rel = relativePath(root, cwd);
  if (rel === "") return true;
  if (rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith("../")) return false;
  return !(rel.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(rel));
}
function mapPlaceholderCwd(cwd, oldRoot, newRoot) {
  const trimmedOld = oldRoot.replace(/[\\/]+$/, "");
  const trimmedNew = newRoot.replace(/[\\/]+$/, "");
  const rest = relativePath(trimmedOld, cwd);
  if (rest === "") return trimmedNew;
  if (rest.startsWith("..") || rest.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(rest)) {
    const lexical = cwd.slice(trimmedOld.length).replace(/^[\\/]+/, "");
    return lexical.length === 0 ? trimmedNew : joinPath(trimmedNew, lexical);
  }
  return joinPath(trimmedNew, rest);
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
async function readLogHeader(path2, size) {
  if (size === 0) throw new Error("the log is empty");
  const handle = await open(path2, "r");
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
function rewriteHeader(buffer, expectedId, to, compression) {
  if (!compression) return rewritePlainHeader(buffer, expectedId, to);
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
  const bytes = Buffer.concat([head, buffer.subarray(first.end)]);
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
    if (before.length !== after.length || !before.equals(after)) throw new Error(`frame ${i} changed`);
  }
  if (scan.tornStart !== void 0) {
    if (check.tornStart === void 0) throw new Error("the rewritten log lost its torn tail");
    if (!bytes.subarray(check.tornStart).equals(buffer.subarray(scan.tornStart))) throw new Error("the torn tail changed");
  }
  return bytes;
}
function rewritePlainHeader(buffer, expectedId, to) {
  const cut = buffer.indexOf(10);
  const headerText = cut < 0 ? buffer : buffer.subarray(0, cut);
  const header = JSON.parse(headerText.toString("utf8"));
  if (header.type !== "session") throw new Error(`first record is not a Session header (type ${String(header.type)})`);
  if (header.id !== expectedId) throw new Error(`header id ${String(header.id)} does not match directory ${expectedId}`);
  if (typeof header.cwd !== "string" || header.cwd.length === 0) throw new Error("header carries no cwd");
  const rewritten = { ...header, version: header.version ?? SESSION_FORMAT_VERSION, cwd: to };
  const body = cut < 0 ? Buffer.alloc(0) : buffer.subarray(cut + 1);
  return Buffer.concat([Buffer.from(`${JSON.stringify(rewritten)}
`, "utf8"), body]);
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
    projects = await readdir(sessionsRoot);
  } catch (error) {
    if (error.code === "ENOENT") return summary;
    throw error;
  }
  const live = options.liveSessionIds ?? /* @__PURE__ */ new Set();
  const touchedProjects = /* @__PURE__ */ new Set();
  for (const project of projects) {
    const projectDir = joinPath(sessionsRoot, project);
    let entries;
    try {
      entries = await readdir(projectDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const dir = joinPath(projectDir, entry);
      let names;
      try {
        names = await readdir(dir);
      } catch {
        continue;
      }
      for (const name2 of names) {
        if (/\.relocate-\d+\.tmp$/.test(name2)) await rm(joinPath(dir, name2), { force: true }).catch(() => void 0);
      }
      names = names.filter((name2) => !/\.relocate-\d+\.tmp$/.test(name2));
      const log = newestLog(names);
      if (log === void 0) continue;
      const moved = await relocateSession(
        { sessionsRoot, projectDir, dir, entry, logName: log.name, options, live, summary }
      );
      if (moved) touchedProjects.add(projectDir);
    }
  }
  for (const projectDir of touchedProjects) {
    try {
      if ((await readdir(projectDir)).length === 0) await rm(projectDir, { recursive: true, force: false });
    } catch {
    }
  }
  return summary;
}
async function relocateSession(context) {
  const { sessionsRoot, projectDir, dir, entry, logName, options, live, summary } = context;
  const fail = (id2, reason) => {
    summary.failed.push({ id: id2, reason });
    return false;
  };
  const logPath = joinPath(dir, logName);
  let size;
  try {
    size = (await stat(logPath)).size;
  } catch (error) {
    return fail(entry, `unreadable log: ${text(error)}`);
  }
  let head;
  try {
    head = await readLogHeader(logPath, size);
  } catch (error) {
    return fail(entry, `unreadable header: ${text(error)}`);
  }
  const header = head.header;
  const cwd = header.cwd;
  if (header.type !== "session" || typeof cwd !== "string" || cwd.length === 0) return false;
  if (!sitsUnder(cwd, options.oldRoot)) return false;
  const id = typeof header.id === "string" ? header.id : "";
  if (id.length === 0) return fail(entry, "header carries no id");
  if (encodeSegment(id) !== entry) return fail(id, `directory name ${entry} does not match encodeSegment(id) ${encodeSegment(id)}`);
  const to = mapPlaceholderCwd(cwd, options.oldRoot, options.newRoot);
  const destDir = joinPath(sessionsRoot, projectKey(to), encodeSegment(id));
  const here = basename(projectDir);
  const expectedProject = projectKey(cwd);
  if (here !== expectedProject && here !== projectKey(to)) {
    return fail(id, `project directory ${here} matches neither projectKey(cwd) ${expectedProject} nor projectKey(newCwd): the layout encoder drifted`);
  }
  if (live.has(id)) {
    summary.skippedLive.push(id);
    return false;
  }
  if (resolvePath(dir) === resolvePath(destDir)) {
    if (!await rewriteLogAt(destDir, logName, id, to, head.compression, summary)) return false;
    summary.relocated.push({ id, from: cwd, to });
    return true;
  }
  let destExists = false;
  try {
    destExists = (await stat(destDir)).isDirectory();
  } catch (error) {
    if (error.code !== "ENOENT") return fail(id, text(error));
  }
  if (destExists) {
    return reconcileExistingDestination({ ...context, destDir, id, from: cwd, to });
  }
  return moveAndRewrite({ ...context, destDir, id, from: cwd, to, compression: head.compression });
}
async function moveAndRewrite(context) {
  const { destDir, dir, id, to, from, logName, summary, compression } = context;
  const fail = (reason) => {
    summary.failed.push({ id, reason });
    return false;
  };
  const sourceLog = joinPath(dir, logName);
  let rewritten;
  let srcMode;
  try {
    const info = await stat(sourceLog);
    if (info.size > MAX_REWRITE_BYTES) throw new Error(`the log is ${info.size} bytes, above the ${MAX_REWRITE_BYTES}-byte rewrite ceiling`);
    srcMode = info.mode & 511;
    const bytes = await readFile(sourceLog);
    rewritten = rewriteHeader(bytes, id, to, compression);
  } catch (error) {
    return fail(`refusing to move the session: ${text(error)}`);
  }
  const staged = `${logName}.relocate-${process.pid}.tmp`;
  try {
    await writeFile(joinPath(dir, staged), rewritten, { mode: 384 });
    if (srcMode !== void 0) await chmod(joinPath(dir, staged), srcMode);
  } catch (error) {
    await rm(joinPath(dir, staged)).catch(() => void 0);
    return fail(`could not stage the rewritten log: ${text(error)}`);
  }
  try {
    await mkdir2(dirname(destDir), { recursive: true });
    await rename(dir, destDir);
  } catch (error) {
    await rm(joinPath(dir, staged)).catch(() => void 0);
    return fail(`could not move the session directory: ${text(error)}`);
  }
  try {
    await rename(joinPath(destDir, staged), joinPath(destDir, logName));
  } catch (error) {
    let rolledBack = true;
    try {
      await rename(destDir, dir);
      await rm(joinPath(dir, staged)).catch(() => void 0);
    } catch {
      rolledBack = false;
    }
    return fail(`could not publish the rewritten log${rolledBack ? " (the move was rolled back)" : ` (ROLLBACK FAILED \u2014 the session directory is left at ${destDir} with its header still naming the old root)`}: ${text(error)}`);
  }
  summary.relocated.push({ id, from, to });
  return true;
}
async function reconcileExistingDestination(context) {
  const { destDir, dir, id, from, to, options: _options, summary } = context;
  const fail = (reason) => {
    summary.failed.push({ id, reason });
    return false;
  };
  let names;
  try {
    names = await readdir(destDir);
  } catch (error) {
    return fail(`unreadable destination: ${text(error)}`);
  }
  const destLog = newestLog(names);
  if (destLog === void 0) return fail("the destination holds no committed generation to reconcile with");
  const sourceVersion = logVersion(context.logName);
  if (sourceVersion === void 0 || destLog.version !== sourceVersion) {
    return fail(`the destination holds generation v${destLog.version}, the source v${String(sourceVersion)}; refusing an automatic reconcile across generations`);
  }
  const destPath = joinPath(destDir, destLog.name);
  let destHeader;
  let size;
  try {
    size = (await stat(destPath)).size;
    destHeader = (await readLogHeader(destPath, size)).header;
  } catch (error) {
    return fail(`unreadable destination header: ${text(error)}`);
  }
  if (destHeader.id !== id) {
    return fail(`the destination already holds session ${String(destHeader.id)}; refusing to overwrite it`);
  }
  if (destHeader.cwd === to) {
    try {
      await rm(dir, { recursive: true, force: false });
      summary.relocated.push({ id, from, to });
      return true;
    } catch (error) {
      return fail(`the destination is already correct, but the stale source could not be removed: ${text(error)}`);
    }
  }
  if (destHeader.cwd === from) {
    const compression = destLog.name.endsWith(".zstd");
    if (!await rewriteLogAt(destDir, destLog.name, id, to, compression, summary)) return false;
    try {
      await rm(dir, { recursive: true, force: false });
    } catch (error) {
      summary.failed.push({ id, reason: `the session was repaired at its destination, but the stale source could not be removed: ${text(error)}` });
    }
    summary.relocated.push({ id, from, to });
    return true;
  }
  return fail(`the destination header names ${String(destHeader.cwd)}, which is neither the old nor the new root; refusing to touch it`);
}
async function rewriteLogAt(dir, logName, expectedId, to, compression, summary) {
  const path2 = joinPath(dir, logName);
  try {
    const size = (await stat(path2)).size;
    if (size > MAX_REWRITE_BYTES) throw new Error(`the log is ${size} bytes, above the ${MAX_REWRITE_BYTES}-byte rewrite ceiling`);
    const bytes = await readFile(path2);
    const rewritten = rewriteHeader(bytes, expectedId, to, compression);
    await publish(path2, rewritten);
    const published = await readFile(path2);
    const back = (await readLogHeader(path2, published.length)).header;
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
      if (beforeCut < 0 || afterCut < 0 || !published.subarray(afterCut + 1).equals(bytes.subarray(beforeCut + 1))) {
        throw new Error("the published plaintext log changed its event body");
      }
    }
    return true;
  } catch (error) {
    summary.failed.push({ id: expectedId, reason: `could not rewrite the header at ${path2}: ${text(error)}` });
    return false;
  }
}
async function publish(path2, bytes) {
  await mkdir2(dirname(path2), { recursive: true });
  let mode;
  try {
    mode = (await stat(path2)).mode & 511;
  } catch {
    mode = void 0;
  }
  const temp = `${path2}.relocate-${process.pid}.tmp`;
  await writeFile(temp, bytes, { mode: 384 });
  if (mode !== void 0) await chmod(temp, mode);
  await rename(temp, path2);
}
function text(error) {
  return error instanceof Error ? error.message : String(error);
}

// src/migrate.ts
import { constants } from "node:fs";
import { copyFile, lstat, mkdir as mkdir3, open as open2, readdir as readdir2, readlink, realpath, rmdir, stat as stat2, symlink } from "node:fs/promises";
import { basename as basename2, dirname as dirname2, isAbsolute, join as join2, relative, resolve } from "node:path";
var COMPARE_CHUNK = 64 * 1024;
var NOFOLLOW = constants.O_NOFOLLOW;
async function pathKind(target, follow = false) {
  try {
    const info = follow ? await stat2(target) : await lstat(target);
    if (info.isSymbolicLink()) return "symlink";
    if (info.isDirectory()) return "dir";
    if (info.isFile()) return "file";
    return "other";
  } catch {
    return "missing";
  }
}
async function isEmptyDir(target) {
  return (await readdir2(target)).length === 0;
}
async function countTree(root) {
  let count = 0;
  for (const entry of await readdir2(root, { withFileTypes: true })) {
    count += entry.isDirectory() ? await countTree(join2(root, entry.name)) : 1;
  }
  return count;
}
function within(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || !rel.startsWith("..") && !isAbsolute(rel);
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
      return join2(ancestor, ...tail);
    }
  }
}
async function resolvesInside(rootReal, target) {
  return within(rootReal, await physicalPath(target));
}
async function sameContent(a, b) {
  const [left, right] = await Promise.all([stat2(a), stat2(b)]);
  if (!left.isFile() || !right.isFile()) return false;
  if (left.size !== right.size) return false;
  const [leftHandle, rightHandle] = await Promise.all([open2(a, "r"), open2(b, "r")]);
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
  const sourceDir = rel.length === 0 ? oldRoot : join2(oldRoot, rel);
  for (const entry of await readdir2(sourceDir, { withFileTypes: true })) {
    const childRel = rel.length === 0 ? entry.name : `${rel}/${entry.name}`;
    const source = join2(oldRoot, childRel);
    const target = join2(newRoot, childRel);
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
  const info = await lstat(target);
  if (!info.isFile()) {
    const error = new Error(`refusing to replace ${target}`);
    error.code = "EEXIST";
    throw error;
  }
  if (typeof NOFOLLOW !== "number") {
    await copyFile(source, target);
    return;
  }
  const src = await open2(source, constants.O_RDONLY);
  try {
    const dest = await open2(target, constants.O_WRONLY | constants.O_TRUNC | NOFOLLOW);
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
  const info = await lstat(source);
  if (info.isSymbolicLink()) {
    await symlink(await readlink(source), target);
    return;
  }
  if (info.isDirectory()) {
    await mkdir3(target);
    for (const name2 of await readdir2(source)) await copyEntry(join2(source, name2), join2(target, name2), rootReal);
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
    for (const name2 of await readdir2(plan.oldRoot)) {
      await copyEntry(join2(plan.oldRoot, name2), join2(plan.newRoot, name2), rootReal2);
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
function parseShellProbe(text2, label) {
  const shells = [];
  const seen = /* @__PURE__ */ new Set();
  const add = (path2) => {
    if (!path2.startsWith("/")) return;
    const kind = shellKind(path2);
    if (kind.length === 0 || WINDOWS_SHELLS2.has(kind) || seen.has(kind)) return;
    seen.add(kind);
    shells.push({ path: path2, name: `${label} \xB7 ${kind}`, args: shellArgs(kind) });
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

// src/ssh-pool.ts
import { readFile as readFile2 } from "node:fs/promises";
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
    const rows = await readdir3(session, remotePath);
    return rows.filter((row) => row.attrs.isDirectory()).map((row) => ({
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
    live.sftp ??= openSftp(live.client).catch((error) => {
      live.sftp = void 0;
      throw error;
    });
    const session = await live.sftp;
    return session.api;
  }
  async sftpUpload(host, secret, localPath, remotePath) {
    const body = await readFile2(localPath);
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
    const fail = (error) => {
      client.end();
      reject(error instanceof Error ? error : new SshFailure(String(error), "connect"));
    };
    client.once("ready", () => resolve2(client));
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
      void readFile2(host.privateKeyPath).then((key) => {
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
  return new Promise((resolve2, reject) => {
    client.sftp((error, sftp) => {
      if (error) {
        reject(new SshFailure(error.message, "sftp"));
        return;
      }
      const api = sftp;
      api.on("error", () => void 0);
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
      if (error) reject(new SshFailure(error.message, "sftp-stat"));
      else resolve2({ isDirectory: stats.isDirectory(), size: stats.size, mode: typeof stats.mode === "number" ? stats.mode : void 0 });
    });
  });
}
function statSize(sftp, remotePath) {
  return statInfo(sftp, remotePath).then((info) => info.size);
}
function readAll(sftp, remotePath) {
  return new Promise((resolve2, reject) => {
    sftp.readFile(remotePath, (error, data) => {
      if (error) reject(new SshFailure(error.message, "sftp-read"));
      else resolve2(data);
    });
  });
}
function writeAll(sftp, remotePath, body) {
  return new Promise((resolve2, reject) => {
    sftp.writeFile(remotePath, body, (error) => {
      if (error) reject(new SshFailure(error.message, "sftp-write"));
      else resolve2();
    });
  });
}
function makeDirectory(sftp, remotePath) {
  return new Promise((resolve2, reject) => {
    sftp.mkdir(remotePath, (error) => {
      if (error) reject(new SshFailure(error.message, "sftp-mkdir"));
      else resolve2();
    });
  });
}
function realpathOf(sftp, remotePath) {
  return new Promise((resolve2, reject) => {
    sftp.realpath(remotePath, (error, resolved) => {
      if (error) reject(new SshFailure(error.message, "sftp-realpath"));
      else resolve2(resolved);
    });
  });
}
function readdir3(sftp, remotePath) {
  return new Promise((resolve2, reject) => {
    sftp.readdir(remotePath, (error, list) => {
      if (error) reject(new SshFailure(error.message, "sftp-list"));
      else resolve2(list);
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
  const roots = [];
  for (const root of routingRoots(env)) {
    if (!roots.includes(root)) roots.push(root);
    try {
      const real = realpathSync(root);
      if (!roots.includes(real)) roots.push(real);
    } catch {
    }
  }
  return roots;
}
function workspaceRoute(workspacePath, env = process.env) {
  for (const root of candidateRoots(env)) {
    const route = routeUnderRoot(root, workspacePath);
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
  pool;
  config;
  status = /* @__PURE__ */ new Map();
  shellLists = /* @__PURE__ */ new Map();
  loginEnvs = new LoginEnvCache((hostId, signal) => this.readLoginEnv(hostId, signal));
  /** The first apply installs the configured root; only a later change keeps the previous one routable. */
  remoteRootApplied = false;
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
    this.loginEnvs.forget(hostId);
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
      this.ctx.logger?.warn(`[@dsh-permission-remote] could not store the remote root in memory: ${errorText(error)}`);
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
      if (before !== void 0 && before.host !== host.host) await this.dropSecret(host.id);
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
    const sessions = opened.reduce((sum, item) => sum + item.ws.sessionIds.length, 0);
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
      throw new Error(`copying the remote root to ${newRoot} failed: ${errorText(error)}`);
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
          this.ctx.logger?.warn(`[@dsh-permission-remote] could not roll back workspace ${String(row.id)}: ${errorText(cleanup)}`);
        }
      }
      throw new Error(`registering workspaces at ${newRoot} failed: ${errorText(error)}; the old root is still in use`);
    }
    try {
      await this.commitRemoteRoot(newRoot);
    } catch (error) {
      for (const row of created.reverse()) {
        try {
          await this.workspaces.delete(row.id);
        } catch (cleanup) {
          this.ctx.logger?.warn(`[@dsh-permission-remote] could not roll back workspace ${String(row.id)}: ${errorText(cleanup)}`);
        }
      }
      throw new Error(`the placeholders were copied to ${newRoot}, but the new root could not be saved (${errorText(error)}); the old root is still in use`);
    }
    addSupersededRoot(oldRoot);
    const relocation = await this.relocateStoredSessions(oldRoot, newRoot);
    const rootRecorded = this.recordSupersededRoot(oldRoot);
    const pendingAdded = this.recordPendingGrouping(relocation);
    if (rootRecorded || pendingAdded) await this.persistMigrationState();
    const stuck = [];
    for (const item of relocating) {
      const local = this.placeholderAt(newRoot, item.hostId, item.remotePath);
      if (local === null || resolveLocalPath(item.ws.path) === resolveLocalPath(local)) continue;
      try {
        await this.workspaces.delete(item.ws.id);
        workspacesRemapped += 1;
      } catch (error) {
        stuck.push(String(item.ws.id));
        this.ctx.logger?.warn(`[@dsh-permission-remote] could not remove workspace ${String(item.ws.id)} from the old remote root: ${errorText(error)}`);
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
    for (const root of [...this.config.supersededRemoteRoots, ...supersededRootsSnapshot()]) {
      if (resolveLocalPath(root) === resolveLocalPath(current)) continue;
      if (!roots.includes(root)) roots.push(root);
    }
    return roots;
  }
  /** Move stored sessions from each of `roots` onto `newRoot`. */
  async relocateFromRoots(roots, newRoot) {
    const summary = { relocated: [], skippedLive: [], failed: [] };
    const survivors = /* @__PURE__ */ new Set();
    let pruned = false;
    for (const root of roots) {
      const part = await this.relocateStoredSessions(root, newRoot);
      summary.relocated.push(...part.relocated);
      summary.skippedLive.push(...part.skippedLive);
      summary.failed.push(...part.failed);
      if (part.relocated.length > 0 || part.skippedLive.length > 0 || part.failed.length > 0) {
        survivors.add(resolveLocalPath(root));
      } else {
        pruned = true;
      }
    }
    if (pruned && this.config.supersededRemoteRoots.length > 0) {
      const scanned = new Set(roots.map((root) => resolveLocalPath(root)));
      this.config.supersededRemoteRoots = this.config.supersededRemoteRoots.filter((root) => !scanned.has(resolveLocalPath(root)) || survivors.has(resolveLocalPath(root)));
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
  async relocateStoredSessions(oldRoot, newRoot) {
    const live = this.liveSessionIds();
    try {
      return await relocateSessions({ oldRoot, newRoot, liveSessionIds: live });
    } catch (error) {
      this.ctx.logger?.warn(`[@dsh-permission-remote] could not scan the session store while migrating to ${newRoot}: ${errorText(error)}`);
      return { relocated: [], skippedLive: [], failed: [{ id: "*", reason: `the session store could not be scanned: ${errorText(error)}` }] };
    }
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
    if (this.config.supersededRemoteRoots.some((item) => resolveLocalPath(item) === resolved)) return false;
    this.config.supersededRemoteRoots = [...this.config.supersededRemoteRoots, resolved];
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
    const wanted = new Map(this.config.pendingSessionGrouping.map((entry) => [entry.id, entry.path]));
    let changed = false;
    for (const row of summary.relocated) {
      let path2;
      if (rows !== void 0) {
        const target = rows.find((item) => sameRealPath(item.path, row.to));
        path2 = target !== void 0 ? target.path : row.to;
      } else {
        path2 = row.to;
      }
      if (wanted.get(row.id) === path2) continue;
      wanted.set(row.id, path2);
      changed = true;
    }
    if (changed) this.config.pendingSessionGrouping = [...wanted].map(([id, path2]) => ({ path: path2, id }));
    if (summary.failed.length > 0) {
      this.ctx.logger?.warn(`[@dsh-permission-remote] ${summary.failed.length} session(s) could not follow the remote root: ${summary.failed.map((item) => `${item.id} (${item.reason})`).join("; ")}`);
    }
    if (summary.skippedLive.length > 0) {
      this.ctx.logger?.info(`[@dsh-permission-remote] left ${summary.skippedLive.length} open session(s) on the old root; closing them and saving the root again moves them`);
    }
    return changed;
  }
  /**
   * Persist the migration bookkeeping next to the host rows.
   *
   * Best-effort: the tree copy and the root switch already succeeded, so a
   * settings write that fails must not turn a completed migration into an
   * apparent failure. The moved session is still correct on disk; losing the
   * bookkeeping only means its group is restored by a later successful save.
   */
  async persistMigrationState() {
    const row = this.ctx.settings.describe().find((item) => String(item.ns) === "permission-remote");
    if (row === void 0) {
      this.ctx.logger?.warn('[@dsh-permission-remote] settings row "permission-remote" is missing; the session migration bookkeeping was not persisted');
      return;
    }
    try {
      await this.ctx.settings.update(String(row.ns), {
        supersededRemoteRoots: this.config.supersededRemoteRoots,
        pendingSessionGrouping: this.config.pendingSessionGrouping
      });
    } catch (error) {
      this.ctx.logger?.warn(`[@dsh-permission-remote] the session migration bookkeeping could not be persisted: ${errorText(error)}`);
    }
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
    for (const root of this.config.supersededRemoteRoots) addSupersededRoot(root);
    if (this.config.pendingSessionGrouping.length === 0 && this.config.supersededRemoteRoots.length === 0) return;
    const preexisting = new Set(this.config.pendingSessionGrouping.map((entry) => entry.id));
    const roots = this.catchupRoots(remoteRoot());
    if (roots.length > 0) {
      try {
        await this.relocateFromRoots(roots, remoteRoot());
      } catch (error) {
        this.ctx.logger?.warn(`[@dsh-permission-remote] the session catch-up sweep failed: ${errorText(error)}`);
      }
    }
    if (await this.waitForWorkspaceRegistry()) {
      await this.flushPendingSessionGrouping(preexisting);
    } else {
      this.ctx.logger?.warn("[@dsh-permission-remote] the workspace registry was not ready; session grouping is deferred to the next load (sessions were still swept)");
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
    if (this.config.pendingSessionGrouping.length === 0) return;
    let rows;
    try {
      rows = this.workspaces.list();
    } catch {
      return;
    }
    const remaining = [];
    for (const entry of this.config.pendingSessionGrouping) {
      if (onlyIds !== void 0 && !onlyIds.has(entry.id)) {
        remaining.push(entry);
        continue;
      }
      const target = rows.find((item) => sameRealPath(item.path, entry.path));
      if (target === void 0) {
        if (routeByCwd(entry.path).kind === "remote") remaining.push(entry);
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
        this.ctx.logger?.warn(`[@dsh-permission-remote] session ${entry.id} is at ${entry.path} but could not join its workspace yet: ${errorText(error)}`);
      }
    }
    if (remaining.length !== this.config.pendingSessionGrouping.length) {
      this.config.pendingSessionGrouping = remaining;
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
    const requested = title?.trim() || posix7.basename(resolved) || resolved;
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
  clearSupersededRoots();
  core.applyRemoteRootOverride();
  ctx.effect(() => ctx.on("settings/document-updated", (ns) => core.onSettingsUpdated(ns)));
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
          return RUNNERS[plan.name](host, current, record, exec, ctx);
        }
      };
      if (plan.name === "working_directory") definition.output = workingDirectoryOutput(base.output);
      disposers.push(agent.ctx.tools.register(withRemoteTimeout(definition)));
    }
    const surface = installRemoteShellSurface(ctx, core, agent, host, headerCwd, hasOfficialBash, disposers);
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
function installRemoteShellSurface(ctx, core, agent, host, headerCwd, hasOfficialBash, disposers) {
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
function summaryCounts(summary) {
  return {
    sessionsRelocated: summary.relocated.length,
    sessionsSkippedLive: summary.skippedLive.length,
    sessionsFailed: summary.failed.length
  };
}
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}
function sameRealPath(left, right) {
  const canon = (path2) => {
    try {
      return realpathSync2(path2);
    } catch {
      return resolveLocalPath(path2);
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
  return [publishOpsTool({
    name: "ssh_hosts",
    description: 'List the configured SSH hosts for ops on another machine: id, name, address, user, ops policy, and whether the host key is trusted. Call this before ssh_exec, ssh_read, ssh_write, or ssh_workspace when you do not know the host id or name. Policy "ask" allows reads but needs danger-full-access for commands, writes, and workspace registration, so pass sandbox_permissions "danger-full-access" and a justification; "trust" runs without a prompt; "deny" accepts nothing. An untrusted host must be trusted in Settings \u2192 SSH hosts first.',
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
  })];
}
export {
  Config,
  Core,
  apply,
  inject,
  name
};
