window.__ModuleLoader__.load({
  id: "dsh-permission-remote",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.tsx
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);
var import_react = require("react");

// locale/en.json
var en_default = {
  nav: "SSH hosts",
  title: "SSH hosts",
  description: "Turn a remote directory into a workspace. File and command tools run on that machine, under this session's sandbox mode and approval.",
  addHost: "Add host",
  name: "Name",
  address: "Address",
  port: "Port",
  user: "User",
  auth: "Authentication",
  authKey: "Private key path",
  authPassword: "Password",
  keyPath: "Private key path",
  passphrase: "Key passphrase (optional)",
  password: "Password",
  save: "Save",
  saved: "Host saved. Passwords and key passphrases are stored only in the credential store.",
  test: "Test connection",
  browse: "Browse",
  remove: "Remove",
  trust: "Trust fingerprint",
  trusted: "Fingerprint trusted.",
  untrusted: "First connection. Confirm this is your machine before trusting it.",
  connected: "Connected.",
  sandbox: "Sandbox",
  available: "available",
  unavailable: "unavailable",
  ripgrep: "ripgrep",
  install: "Install remote sandbox dependency",
  manualTitle: "Install bubblewrap yourself",
  copy: "Copy",
  copied: "Copied",
  macosNote: "macOS uses the system sandbox-exec. There is nothing to install. If the probe fails, confined bash needs a one-shot approval up to full access.",
  ripgrepNote: "On connect, ripgrep is uploaded for the remote architecture. If that fails, install ripgrep on the remote so rg is on PATH. Installing bubblewrap does not install ripgrep.",
  directory: "Remote directory",
  up: "Up",
  createWorkspace: "Use this directory as a workspace",
  workspaceCreated: "Workspace created"
};

// locale/zh.json
var zh_default = {
  nav: "SSH \u4E3B\u673A",
  title: "SSH \u4E3B\u673A",
  description: "\u628A\u8FDC\u7AEF\u76EE\u5F55\u505A\u6210\u5DE5\u4F5C\u533A\u3002\u6587\u4EF6\u548C\u547D\u4EE4\u5DE5\u5177\u5728\u90A3\u53F0\u673A\u5668\u4E0A\u6267\u884C\uFF0C\u6743\u9650\u4ECD\u7528\u8FD9\u4E2A\u4F1A\u8BDD\u73B0\u6709\u7684\u6C99\u7BB1\u6863\u4F4D\u548C\u5BA1\u6279\u3002",
  addHost: "\u6DFB\u52A0\u4E3B\u673A",
  name: "\u540D\u79F0",
  address: "\u5730\u5740",
  port: "\u7AEF\u53E3",
  user: "\u7528\u6237",
  auth: "\u8BA4\u8BC1",
  authKey: "\u79C1\u94A5\u8DEF\u5F84",
  authPassword: "\u53E3\u4EE4",
  keyPath: "\u79C1\u94A5\u8DEF\u5F84",
  passphrase: "\u79C1\u94A5\u53E3\u4EE4\uFF08\u53EF\u7A7A\uFF09",
  password: "\u53E3\u4EE4",
  save: "\u4FDD\u5B58",
  saved: "\u4E3B\u673A\u5DF2\u4FDD\u5B58\u3002\u53E3\u4EE4\u548C\u79C1\u94A5\u53E3\u4EE4\u53EA\u5199\u5165\u51ED\u636E\u5B58\u50A8\u3002",
  test: "\u6D4B\u8BD5\u8FDE\u63A5",
  browse: "\u6D4F\u89C8\u76EE\u5F55",
  remove: "\u5220\u9664",
  trust: "\u4FE1\u4EFB\u6307\u7EB9",
  trusted: "\u5DF2\u4FE1\u4EFB\u8BE5\u6307\u7EB9\u3002",
  untrusted: "\u9996\u6B21\u8FDE\u63A5\u3002\u8BF7\u786E\u8BA4\u8FD9\u662F\u4F60\u7684\u673A\u5668\u540E\u518D\u4FE1\u4EFB\u3002",
  connected: "\u8FDE\u63A5\u6210\u529F\u3002",
  sandbox: "\u6C99\u7BB1",
  available: "\u53EF\u7528",
  unavailable: "\u4E0D\u53EF\u7528",
  ripgrep: "ripgrep",
  install: "\u5B89\u88C5\u8FDC\u7AEF\u6C99\u7BB1\u4F9D\u8D56",
  manualTitle: "\u81EA\u884C\u5B89\u88C5 bubblewrap",
  copy: "\u590D\u5236",
  copied: "\u5DF2\u590D\u5236",
  macosNote: "macOS \u4F7F\u7528\u7CFB\u7EDF\u81EA\u5E26\u7684 sandbox-exec\uFF0C\u65E0\u9700\u5B89\u88C5\u3002\u82E5\u63A2\u6D4B\u5931\u8D25\uFF0C\u53D7\u9650 bash \u9700\u8981\u7ECF\u5BA1\u6279\u628A\u8FD9\u4E00\u6B21\u5347\u5230\u5B8C\u5168\u653E\u5F00\u3002",
  ripgrepNote: "\u8FDE\u63A5\u65F6\u4F1A\u6309\u8FDC\u7AEF\u67B6\u6784\u4E0A\u4F20 ripgrep\u3002\u4E0A\u4F20\u5931\u8D25\u65F6\uFF0C\u8BF7\u5728\u8FDC\u7AEF\u5B89\u88C5 ripgrep\uFF0C\u4F7F rg \u51FA\u73B0\u5728 PATH \u4E2D\u3002\u5B89\u88C5 bubblewrap \u4E0D\u4F1A\u9644\u5E26 ripgrep\u3002",
  directory: "\u8FDC\u7AEF\u76EE\u5F55",
  up: "\u4E0A\u4E00\u7EA7",
  createWorkspace: "\u628A\u5F53\u524D\u76EE\u5F55\u505A\u6210\u5DE5\u4F5C\u533A",
  workspaceCreated: "\u5DE5\u4F5C\u533A\u5DF2\u521B\u5EFA"
};

// src/client/api.ts
var NS = "permission-remote";
async function readHosts(ctx) {
  const response = await ctx.remote.settings.describe();
  const described = response.value ?? response;
  const namespaces = described.namespaces ?? [];
  const row = namespaces.find((item) => item.ns === NS);
  const hosts = Array.isArray(row?.value?.hosts) ? row.value.hosts : [];
  return { hosts, revision: row?.revision ?? 0 };
}
async function callHost(ctx, method, input) {
  const result = await ctx.connection.rpc.call("/api", `sshPermission/${method}`, { args: { input } });
  if (!result.ok) throw new Error(result.error?.message ?? `${method} failed`);
  return result.value;
}

// src/client/styles.ts
var PLUGIN_ID = "dsh-permission-remote";
var CSS = `
.dsh-ssh-page {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 720px;
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
}
.dsh-ssh-title {
  margin: 0;
  font-size: 16px;
  font-weight: 500;
  line-height: 24px;
}
.dsh-ssh-intro,
.dsh-ssh-note {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 14px;
  line-height: 22px;
}
.dsh-ssh-status {
  margin: 0;
  color: var(--dsw-alias-state-success-primary);
  font-size: 12px;
  line-height: 18px;
}
.dsh-ssh-status[data-tone="warn"] {
  color: var(--dsw-alias-state-warn-label);
}
.dsh-ssh-card,
.dsh-ssh-host {
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  background: var(--dsw-alias-settings-card-fill);
  border-radius: var(--dsw-radius-xl);
  padding: 14px 16px;
}
.dsh-ssh-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.dsh-ssh-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.dsh-ssh-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 12px;
}
.dsh-ssh-legend {
  margin: 0;
  font-size: 14px;
  line-height: 22px;
  font-weight: 500;
}
.dsh-ssh-label {
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 20px;
}
.dsh-ssh-input,
.dsh-ssh-select {
  box-sizing: border-box;
  width: 100%;
  height: 32px;
  margin: 0;
  padding: 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
}
.dsh-ssh-input:focus,
.dsh-ssh-select:focus {
  outline: none;
  border-color: var(--dsw-alias-brand-primary);
}
.dsh-ssh-actions {
  display: flex;
  justify-content: flex-end;
}
.dsh-ssh-hosts {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.dsh-ssh-host {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.dsh-ssh-host-name {
  min-width: 0;
  font-size: 14px;
  line-height: 22px;
}
.dsh-ssh-host-meta {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}
.dsh-ssh-row-actions,
.dsh-ssh-inline {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.dsh-ssh-button {
  height: 28px;
  margin: 0;
  padding: 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
.dsh-ssh-button:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsh-ssh-button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.dsh-ssh-button[data-primary="true"] {
  border-color: transparent;
  background: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-label-invert, #fff);
}
.dsh-ssh-section-title {
  margin: 4px 0 0;
  font-size: 14px;
  font-weight: 500;
  line-height: 22px;
}
.dsh-ssh-manual {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.dsh-ssh-command {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
}
.dsh-ssh-command-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.dsh-ssh-command code {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--dsw-alias-label-secondary);
  font-family: var(--ds-font-family-code, ui-monospace, monospace);
  font-size: 12px;
  line-height: 18px;
}
.dsh-ssh-log {
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font-family: var(--ds-font-family-code, ui-monospace, monospace);
  font-size: 12px;
  line-height: 18px;
  white-space: pre-wrap;
}
.dsh-ssh-dirs {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.dsh-ssh-dir {
  justify-content: flex-start;
  width: fit-content;
}
`;
function installStyles() {
  if (typeof document === "undefined") return;
  if (document.querySelector(`style[data-plugin="${PLUGIN_ID}"]`)) return;
  const tag = document.createElement("style");
  tag.dataset.plugin = PLUGIN_ID;
  tag.textContent = CSS;
  document.head.appendChild(tag);
}

// src/client/index.tsx
var import_jsx_runtime = require("react/jsx-runtime");
var inject = ["remote", "remote.settings", "connection", "slots", "locale"];
var NS2 = "permission-remote";
var MANUAL = [
  { title: "Debian/Ubuntu", command: "sudo apt-get update && sudo apt-get install -y bubblewrap" },
  { title: "Fedora/RHEL", command: "sudo dnf install -y bubblewrap" },
  { title: "Arch", command: "sudo pacman -S bubblewrap" },
  { title: "Alpine", command: "sudo apk add bubblewrap" }
];
function apply(ctx) {
  installStyles();
  ctx.effect(() => ctx.locale.register(NS2, "zh", zh_default), "dsh-permission-remote: zh");
  ctx.effect(() => ctx.locale.register(NS2, "en", en_default), "dsh-permission-remote: en");
  const nav = ctx.locale.bind(NS2);
  ctx.effect(() => ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section",
    id: "permission-remote",
    order: 80,
    label: () => nav("nav"),
    locale: NS2,
    inject: () => ({ ctx })
  }, Section)), "dsh-permission-remote: settings section");
}
function Section(props) {
  const { ctx, t } = props;
  const [hosts, setHosts] = (0, import_react.useState)([]);
  const [draft, setDraft] = (0, import_react.useState)(blankHost());
  const [secret, setSecret] = (0, import_react.useState)("");
  const [message, setMessage] = (0, import_react.useState)("");
  const [tone, setTone] = (0, import_react.useState)("ok");
  const [selected, setSelected] = (0, import_react.useState)("");
  const [status, setStatus] = (0, import_react.useState)(null);
  const [installLog, setInstallLog] = (0, import_react.useState)("");
  const [dir, setDir] = (0, import_react.useState)("/");
  const [entries, setEntries] = (0, import_react.useState)([]);
  const [busy, setBusy] = (0, import_react.useState)(false);
  const [pendingTrust, setPendingTrust] = (0, import_react.useState)("");
  async function reload() {
    const loaded = await readHosts(ctx);
    setHosts(loaded.hosts);
  }
  (0, import_react.useEffect)(() => {
    void reload().catch((error) => fail(error));
  }, []);
  function fail(error) {
    setTone("warn");
    setMessage(error instanceof Error ? error.message : String(error));
  }
  function note(text) {
    setTone("ok");
    setMessage(text);
  }
  async function saveDraft() {
    setBusy(true);
    setMessage("");
    try {
      const id = draft.id || newId();
      const next = { ...draft, id, port: Number(draft.port) || 22 };
      await callHost(ctx, "saveHost", next);
      setDraft(next);
      if (next.auth === "password" || secret.trim().length > 0) {
        await callHost(ctx, "saveSecret", {
          hostId: id,
          password: next.auth === "password" ? secret : void 0,
          passphrase: next.auth === "key" && secret.trim().length > 0 ? secret : void 0
        });
      }
      setSecret("");
      setDraft(blankHost());
      await reload();
      note(t("saved"));
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }
  async function test(host) {
    setBusy(true);
    setMessage("");
    setSelected(host.id);
    try {
      const offered = await callHost(ctx, "testConnection", { hostId: host.id });
      if (!offered.trusted) {
        setPendingTrust(offered.fingerprint);
        setTone("warn");
        setMessage(`${t("untrusted")} ${offered.fingerprint}`);
        return;
      }
      setPendingTrust("");
      note(offered.banner.length > 0 ? `${t("connected")} ${offered.banner}` : t("connected"));
      setStatus(await callHost(ctx, "probe", { hostId: host.id, refresh: true }));
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }
  async function trust(host) {
    if (pendingTrust.trim().length === 0) return;
    setBusy(true);
    try {
      await callHost(ctx, "trustFingerprint", { hostId: host.id, fingerprint: pendingTrust });
      setPendingTrust("");
      await reload();
      note(t("trusted"));
      setStatus(await callHost(ctx, "probe", { hostId: host.id, refresh: true }));
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }
  async function install(hostId) {
    setBusy(true);
    setInstallLog("");
    try {
      const result = await callHost(ctx, "installDeps", { hostId });
      setStatus(result.status);
      setInstallLog([result.stdout, result.stderr].filter(Boolean).join("\n") || `exit ${result.code ?? "null"}`);
    } catch (error) {
      setInstallLog(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  async function removeHost(hostId) {
    setBusy(true);
    try {
      await callHost(ctx, "deleteHost", { hostId });
      if (selected === hostId) {
        setSelected("");
        setStatus(null);
        setEntries([]);
      }
      await reload();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }
  async function browse(hostId, path) {
    setBusy(true);
    try {
      const listed = await callHost(ctx, "listDir", { hostId, path });
      setDir(listed.path);
      setEntries(listed.entries);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }
  async function createWorkspace(hostId, path) {
    setBusy(true);
    try {
      const created = await callHost(ctx, "createWorkspace", { hostId, path });
      note(`${t("workspaceCreated")} ${created.path}`);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }
  const current = hosts.find((item) => item.id === selected);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "dsh-ssh-page", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", { className: "dsh-ssh-title", children: t("title") }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dsh-ssh-intro", children: t("description") }),
    message.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dsh-ssh-status", "data-tone": tone === "warn" ? "warn" : void 0, children: message }) : null,
    hosts.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", { className: "dsh-ssh-hosts", children: hosts.map((host) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", { className: "dsh-ssh-host", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-ssh-host-name", children: host.name || host.host }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-ssh-host-meta", children: [
          host.username,
          "@",
          host.host,
          ":",
          host.port
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-ssh-row-actions", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ssh-button", disabled: busy, onClick: () => void test(host), children: t("test") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ssh-button", disabled: busy, onClick: () => void browse(host.id, "/"), children: t("browse") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ssh-button", disabled: busy, onClick: () => void removeHost(host.id), children: t("remove") })
      ] })
    ] }, host.id)) }) : null,
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("form", { className: "dsh-ssh-card", onSubmit: (event) => {
      event.preventDefault();
      void saveDraft();
    }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-ssh-legend", children: t("addHost") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-ssh-grid", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label: t("name"), value: draft.name, onChange: (value) => setDraft({ ...draft, name: value }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label: t("address"), value: draft.host, onChange: (value) => setDraft({ ...draft, host: value }) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-ssh-grid", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label: t("port"), value: String(draft.port), onChange: (value) => setDraft({ ...draft, port: Number(value) || 22 }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label: t("user"), value: draft.username, onChange: (value) => setDraft({ ...draft, username: value }) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "dsh-ssh-field", htmlFor: "dsh-ssh-auth", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-ssh-label", children: t("auth") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("select", { id: "dsh-ssh-auth", className: "dsh-ssh-select", value: draft.auth, onChange: (event) => setDraft({ ...draft, auth: event.target.value === "password" ? "password" : "key" }), children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "key", children: t("authKey") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "password", children: t("authPassword") })
        ] })
      ] }),
      draft.auth === "key" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label: t("keyPath"), value: draft.privateKeyPath, onChange: (value) => setDraft({ ...draft, privateKeyPath: value }) }) : null,
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label: draft.auth === "password" ? t("password") : t("passphrase"), value: secret, secret: true, onChange: setSecret }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-ssh-actions", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "submit", className: "dsh-ssh-button", "data-primary": "true", disabled: busy || draft.host.trim().length === 0 || draft.username.trim().length === 0, children: t("save") }) })
    ] }),
    pendingTrust.length > 0 && current !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", { type: "button", className: "dsh-ssh-button", "data-primary": "true", disabled: busy, onClick: () => void trust(current), children: [
      t("trust"),
      " ",
      pendingTrust
    ] }) : null,
    status !== null && current !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-ssh-host", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-ssh-host-name", children: [
          t("sandbox"),
          ": ",
          status.sandboxTool,
          " ",
          status.sandbox.available ? t("available") : `${t("unavailable")} (${status.sandbox.reason})`
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-ssh-host-meta", children: [
          t("ripgrep"),
          ": ",
          status.ripgrep
        ] })
      ] }),
      status.os === "linux" && !status.sandbox.available ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ssh-button", disabled: busy || status.install === null, onClick: () => void install(current.id), children: t("install") }) : null
    ] }) : null,
    installLog.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("pre", { className: "dsh-ssh-log", children: installLog }) : null,
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { className: "dsh-ssh-section-title", children: t("manualTitle") }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-ssh-manual", children: MANUAL.map((item) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-ssh-command", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-ssh-command-text", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-ssh-label", children: item.title }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { children: item.command })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ssh-button", onClick: () => void navigator.clipboard.writeText(item.command), children: t("copy") })
    ] }, item.title)) }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dsh-ssh-note", children: t("macosNote") }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dsh-ssh-note", children: t("ripgrepNote") }),
    selected.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("h3", { className: "dsh-ssh-section-title", children: [
        t("directory"),
        " ",
        dir
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-ssh-inline", children: [
        dir !== "/" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ssh-button", disabled: busy, onClick: () => void browse(selected, parentDir(dir)), children: t("up") }) : null,
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ssh-button", "data-primary": "true", disabled: busy, onClick: () => void createWorkspace(selected, dir), children: t("createWorkspace") })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", { className: "dsh-ssh-dirs", children: entries.map((entry) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("li", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ssh-button dsh-ssh-dir", disabled: busy, onClick: () => void browse(selected, entry.path), children: entry.name }) }, entry.path)) })
    ] }) : null
  ] });
}
function Field(props) {
  const id = `dsh-ssh-${props.label}`;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "dsh-ssh-field", htmlFor: id, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-ssh-label", children: props.label }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { id, className: "dsh-ssh-input", type: props.secret ? "password" : "text", value: props.value, onChange: (event) => props.onChange(event.target.value) })
  ] });
}
function blankHost() {
  return { id: "", name: "", host: "", port: 22, username: "", auth: "key", privateKeyPath: "", fingerprint: "" };
}
function parentDir(dir) {
  const trimmed = dir.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  if (slash <= 0) return "/";
  return trimmed.slice(0, slash);
}
function newId() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(8));
  return `h${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

    return module.exports;
  }
});
