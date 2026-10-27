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

// src/client/api.ts
var NS = "permission-remote";
async function readHosts(ctx) {
  const described = await ctx.remote.settings.describe();
  const row = described.namespaces.find((item) => item.ns === NS);
  const hosts = Array.isArray(row?.value?.hosts) ? row.value.hosts : [];
  return { hosts, revision: row?.revision ?? 0 };
}
async function callHost(ctx, method, input) {
  const result = await ctx.connection.rpc.call("/api", `sshPermission/${method}`, { args: { input } });
  if (!result.ok) throw new Error(result.error?.message ?? `${method} failed`);
  return result.value;
}

// src/client/copy.ts
var MANUAL_INSTALLS = [
  { title: "Debian/Ubuntu", command: "sudo apt-get update && sudo apt-get install -y bubblewrap" },
  { title: "Fedora/RHEL", command: "sudo dnf install -y bubblewrap" },
  { title: "Arch", command: "sudo pacman -S bubblewrap" },
  { title: "Alpine", command: "sudo apk add bubblewrap" }
];
var MACOS_NOTE = "macOS uses the system sandbox-exec. There is nothing to install. If the read-only probe fails, confined bash needs a one-shot approval up to danger-full-access.";
var RIPGREP_NOTE = "Ripgrep is uploaded for the remote architecture. If that fails, install ripgrep so rg is on PATH. Bubblewrap install does not install ripgrep.";

// src/client/index.tsx
var import_jsx_runtime = require("react/jsx-runtime");
var inject = ["remote", "remote.settings", "connection", "slots", "locale"];
var NS2 = "permission-remote";
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS2, "zh", { title: "SSH \u4E3B\u673A" }), "dsh-permission-remote: zh");
  ctx.effect(() => ctx.locale.register(NS2, "en", { title: "SSH hosts" }), "dsh-permission-remote: en");
  ctx.effect(() => ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section",
    id: "permission-remote",
    order: 80,
    label: () => typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("en") ? "SSH hosts" : "SSH \u4E3B\u673A",
    locale: NS2,
    inject: () => ({ ctx })
  }, Section)), "dsh-permission-remote: settings section");
}
function Section(props) {
  const { ctx } = props;
  const [hosts, setHosts] = (0, import_react.useState)([]);
  const [draft, setDraft] = (0, import_react.useState)(blankHost());
  const [secret, setSecret] = (0, import_react.useState)("");
  const [message, setMessage] = (0, import_react.useState)("");
  const [selected, setSelected] = (0, import_react.useState)("");
  const [status, setStatus] = (0, import_react.useState)(null);
  const [installLog, setInstallLog] = (0, import_react.useState)("");
  const [dir, setDir] = (0, import_react.useState)("/");
  const [entries, setEntries] = (0, import_react.useState)([]);
  const [busy, setBusy] = (0, import_react.useState)(false);
  async function reload() {
    const loaded = await readHosts(ctx);
    setHosts(loaded.hosts);
  }
  (0, import_react.useEffect)(() => {
    void reload().catch((error) => setMessage(error instanceof Error ? error.message : String(error)));
  }, []);
  async function saveDraft() {
    setBusy(true);
    setMessage("");
    try {
      const id = draft.id || newId();
      const next = { ...draft, id, port: Number(draft.port) || 22 };
      if (next.auth === "password" || secret.trim().length > 0) {
        await callHost(ctx, "saveSecret", {
          hostId: id,
          password: next.auth === "password" ? secret : void 0,
          passphrase: next.auth === "key" ? secret : void 0
        });
      }
      await callHost(ctx, "saveHost", next);
      setSecret("");
      setDraft(blankHost());
      await reload();
      setMessage("\u4E3B\u673A\u5DF2\u4FDD\u5B58\u3002\u53E3\u4EE4\u548C\u79C1\u94A5\u53E3\u4EE4\u53EA\u8FDB\u51ED\u636E\u5B58\u50A8\u3002");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
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
        setMessage(`\u9996\u6B21\u8FDE\u63A5\uFF0C\u6307\u7EB9 ${offered.fingerprint}\u3002\u786E\u8BA4\u8FD9\u662F\u4F60\u7684\u673A\u5668\u540E\u518D\u4FE1\u4EFB\u3002`);
        setDraft({ ...host, fingerprint: offered.fingerprint });
        return;
      }
      setMessage(offered.banner.length > 0 ? `\u8FDE\u63A5\u6210\u529F\uFF1A${offered.banner}` : "\u8FDE\u63A5\u6210\u529F\u3002");
      const probed = await callHost(ctx, "probe", { hostId: host.id, refresh: true });
      setStatus(probed);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  async function trust(host) {
    if (host.fingerprint.trim().length === 0) return;
    setBusy(true);
    try {
      await callHost(ctx, "trustFingerprint", { hostId: host.id, fingerprint: host.fingerprint });
      await reload();
      setMessage("\u5DF2\u4FE1\u4EFB\u8BE5\u6307\u7EB9\u3002");
      const probed = await callHost(ctx, "probe", { hostId: host.id, refresh: true });
      setStatus(probed);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
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
      setMessage(error instanceof Error ? error.message : String(error));
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
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  async function createWorkspace(hostId, path) {
    setBusy(true);
    try {
      const created = await callHost(ctx, "createWorkspace", { hostId, path });
      setMessage(`\u5DE5\u4F5C\u533A\u5DF2\u521B\u5EFA\uFF1A${created.path}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  const current = hosts.find((item) => item.id === selected);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { style: { display: "grid", gap: 16, maxWidth: 720 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", { style: { margin: 0 }, children: "SSH \u4E3B\u673A" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: { margin: 0 }, children: "\u8FDC\u7AEF\u76EE\u5F55\u4F1A\u505A\u6210\u5DE5\u4F5C\u533A\u3002\u6587\u4EF6\u548C\u547D\u4EE4\u5DE5\u5177\u5728\u90A3\u53F0\u673A\u5668\u4E0A\u6267\u884C\uFF0C\u6743\u9650\u4ECD\u662F\u4F1A\u8BDD\u91CC\u73B0\u6709\u7684\u6C99\u7BB1\u6863\u4F4D\u548C\u5BA1\u6279\u3002" }),
    message.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: message }) : null,
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", { style: { paddingLeft: 18 }, children: hosts.map((host) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", { children: [
      host.name || host.host,
      " (",
      host.username,
      "@",
      host.host,
      ":",
      host.port,
      ")",
      " ",
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", disabled: busy, onClick: () => void test(host), children: "\u6D4B\u8BD5\u8FDE\u63A5" }),
      " ",
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", disabled: busy, onClick: () => void browse(host.id, "/"), children: "\u6D4F\u89C8\u76EE\u5F55" }),
      " ",
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", disabled: busy, onClick: () => void removeHost(host.id), children: "\u5220\u9664" })
    ] }, host.id)) }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("fieldset", { style: { display: "grid", gap: 8 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("legend", { children: "\u6DFB\u52A0\u4E3B\u673A" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { children: [
        "\u540D\u79F0 ",
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { value: draft.name, onChange: (event) => setDraft({ ...draft, name: event.target.value }) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { children: [
        "\u5730\u5740 ",
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { value: draft.host, onChange: (event) => setDraft({ ...draft, host: event.target.value }) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { children: [
        "\u7AEF\u53E3 ",
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { value: String(draft.port), onChange: (event) => setDraft({ ...draft, port: Number(event.target.value) || 22 }) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { children: [
        "\u7528\u6237 ",
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { value: draft.username, onChange: (event) => setDraft({ ...draft, username: event.target.value }) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { children: [
        "\u8BA4\u8BC1",
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("select", { value: draft.auth, onChange: (event) => setDraft({ ...draft, auth: event.target.value === "password" ? "password" : "key" }), children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "key", children: "\u79C1\u94A5\u8DEF\u5F84" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "password", children: "\u53E3\u4EE4" })
        ] })
      ] }),
      draft.auth === "key" ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { children: [
        "\u79C1\u94A5\u8DEF\u5F84 ",
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { value: draft.privateKeyPath, onChange: (event) => setDraft({ ...draft, privateKeyPath: event.target.value }) })
      ] }) : null,
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { children: [
        draft.auth === "password" ? "\u53E3\u4EE4" : "\u79C1\u94A5\u53E3\u4EE4\uFF08\u53EF\u7A7A\uFF09",
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { type: "password", value: secret, onChange: (event) => setSecret(event.target.value) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", disabled: busy || draft.host.trim().length === 0 || draft.username.trim().length === 0, onClick: () => void saveDraft(), children: "\u4FDD\u5B58" })
    ] }),
    draft.fingerprint.length > 0 && selected.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", { type: "button", disabled: busy, onClick: () => void trust({ ...current ?? draft, fingerprint: draft.fingerprint }), children: [
      "\u4FE1\u4EFB\u6307\u7EB9 ",
      draft.fingerprint
    ] }) : null,
    status !== null && current !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { children: [
        "\u6C99\u7BB1\uFF1A",
        status.sandboxTool,
        " ",
        status.sandbox.available ? "\u53EF\u7528" : `\u4E0D\u53EF\u7528\uFF08${status.sandbox.reason}\uFF09`
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { children: [
        "ripgrep\uFF1A",
        status.ripgrep
      ] }),
      status.os === "linux" && !status.sandbox.available ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", disabled: busy || status.install === null, onClick: () => void install(current.id), children: "\u5B89\u88C5\u8FDC\u7AEF\u6C99\u7BB1\u4F9D\u8D56" }) : null,
      status.os === "darwin" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: MACOS_NOTE }) : null,
      installLog.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("pre", { children: installLog }) : null
    ] }) : null,
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { style: { marginBottom: 8 }, children: "\u81EA\u884C\u5B89\u88C5 bubblewrap" }),
      MANUAL_INSTALLS.map((item) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { children: [
        item.title,
        " ",
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { children: item.command }),
        " ",
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", onClick: () => void navigator.clipboard.writeText(item.command), children: "\u590D\u5236" })
      ] }, item.title)),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: MACOS_NOTE }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: RIPGREP_NOTE })
    ] }),
    selected.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("h3", { style: { marginBottom: 8 }, children: [
        "\u8FDC\u7AEF\u76EE\u5F55 ",
        dir
      ] }),
      dir !== "/" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", disabled: busy, onClick: () => void browse(selected, parentDir(dir)), children: "\u4E0A\u4E00\u7EA7" }) : null,
      " ",
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", disabled: busy, onClick: () => void createWorkspace(selected, dir), children: "\u628A\u5F53\u524D\u76EE\u5F55\u4F5C\u6210\u5DE5\u4F5C\u533A" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", { children: entries.map((entry) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("li", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", disabled: busy, onClick: () => void browse(selected, entry.path), children: entry.name }) }, entry.path)) })
    ] }) : null
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
