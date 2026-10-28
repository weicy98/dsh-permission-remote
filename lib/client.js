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
  description: "Turn a remote directory into a workspace. File and command tools run on that machine, under this session's sandbox mode and approval. An ordinary workspace can also run ops on a host with ssh_hosts / ssh_exec / ssh_read / ssh_write.",
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
  edit: "Edit",
  editHost: "Edit host",
  cancel: "Cancel",
  secretKeep: "Leave blank to keep the stored placeholder or key passphrase.",
  retrust: "Address or port changed, so test the connection and trust the new host key again.",
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
  refresh: "Refresh",
  emptyDir: "No subdirectories in this directory.",
  createWorkspace: "Use this directory as a workspace",
  workspaces: "Workspaces",
  workspacesNote: 'Sidebar titles read "server \xB7 directory" so a workspace shows which machine it lives on.',
  noWorkspaces: 'No workspace from this server yet. Use Browse, pick a directory, then "Use this directory as a workspace".',
  sessions: "sessions",
  tagSidebar: "Tag sidebar titles",
  taggedSidebar: "Sidebar titles now name their server.",
  unregister: "Unregister",
  workspaceRemoved: "Removed from the workspace list. Files on the remote host are untouched.",
  workspaceCreated: "Workspace created",
  opsPolicy: "Remote ops",
  opsAsk: "Ask",
  opsTrust: "Trust",
  opsDeny: "Deny",
  opsNote: "Ask: in an ordinary workspace, reading remote files needs no prompt, while commands and writes need a one-shot danger-full-access approval. Trust: commands and writes run without a prompt. Deny: this host accepts no remote ops at all.",
  policySaved: "Remote ops policy saved."
};

// locale/zh.json
var zh_default = {
  nav: "SSH \u4E3B\u673A",
  title: "SSH \u4E3B\u673A",
  description: "\u628A\u8FDC\u7AEF\u76EE\u5F55\u505A\u6210\u5DE5\u4F5C\u533A\u3002\u6587\u4EF6\u548C\u547D\u4EE4\u5DE5\u5177\u5728\u90A3\u53F0\u673A\u5668\u4E0A\u6267\u884C\uFF0C\u6743\u9650\u4ECD\u7528\u8FD9\u4E2A\u4F1A\u8BDD\u73B0\u6709\u7684\u6C99\u7BB1\u6863\u4F4D\u548C\u5BA1\u6279\u3002\u666E\u901A\u5DE5\u4F5C\u533A\u4E5F\u53EF\u4EE5\u7528 ssh_hosts / ssh_exec / ssh_read / ssh_write \u5BF9\u4E3B\u673A\u505A\u8FD0\u7EF4\u3002",
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
  edit: "\u7F16\u8F91",
  editHost: "\u7F16\u8F91\u4E3B\u673A",
  cancel: "\u53D6\u6D88",
  secretKeep: "\u7559\u7A7A\u5219\u4FDD\u7559\u5DF2\u4FDD\u5B58\u7684\u53E3\u4EE4\u6216\u79C1\u94A5\u53E3\u4EE4\u3002",
  retrust: "\u5730\u5740\u6216\u7AEF\u53E3\u5DF2\u66F4\u6539\uFF0C\u8BF7\u91CD\u65B0\u6D4B\u8BD5\u8FDE\u63A5\u5E76\u4FE1\u4EFB\u65B0\u7684\u4E3B\u673A\u6307\u7EB9\u3002",
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
  refresh: "\u5237\u65B0",
  emptyDir: "\u8FD9\u4E2A\u76EE\u5F55\u4E0B\u6CA1\u6709\u5B50\u76EE\u5F55\u3002",
  createWorkspace: "\u628A\u5F53\u524D\u76EE\u5F55\u505A\u6210\u5DE5\u4F5C\u533A",
  workspaces: "\u5DF2\u6DFB\u52A0\u7684\u5DE5\u4F5C\u533A",
  workspacesNote: "\u4FA7\u680F\u6807\u9898\u4F1A\u5199\u6210\u300C\u670D\u52A1\u5668 \xB7 \u76EE\u5F55\u540D\u300D\uFF0C\u65B9\u4FBF\u8BA4\u51FA\u5DE5\u4F5C\u533A\u5728\u54EA\u53F0\u673A\u5668\u4E0A\u3002",
  noWorkspaces: "\u8FD8\u6CA1\u6709\u4ECE\u8FD9\u53F0\u670D\u52A1\u5668\u6DFB\u52A0\u5DE5\u4F5C\u533A\u3002\u7528\u300C\u6D4F\u89C8\u76EE\u5F55\u300D\u9009\u4E00\u4E2A\u76EE\u5F55\uFF0C\u518D\u70B9\u300C\u628A\u5F53\u524D\u76EE\u5F55\u505A\u6210\u5DE5\u4F5C\u533A\u300D\u3002",
  sessions: "\u4E2A\u4F1A\u8BDD",
  tagSidebar: "\u6807\u6CE8\u4FA7\u680F\u6807\u9898",
  taggedSidebar: "\u4FA7\u680F\u6807\u9898\u5DF2\u6807\u6CE8\u670D\u52A1\u5668\u3002",
  unregister: "\u4ECE\u5217\u8868\u79FB\u9664",
  workspaceRemoved: "\u5DF2\u4ECE\u5DE5\u4F5C\u533A\u5217\u8868\u79FB\u9664\uFF0C\u8FDC\u7AEF\u6587\u4EF6\u672A\u6539\u52A8\u3002",
  workspaceCreated: "\u5DE5\u4F5C\u533A\u5DF2\u521B\u5EFA",
  opsPolicy: "\u8FDC\u7A0B\u8FD0\u7EF4",
  opsAsk: "\u8BE2\u95EE",
  opsTrust: "\u4FE1\u4EFB",
  opsDeny: "\u7981\u6B62",
  opsNote: "\u8BE2\u95EE\uFF1A\u666E\u901A\u5DE5\u4F5C\u533A\u8BFB\u53D6\u8FDC\u7AEF\u6587\u4EF6\u4E0D\u5F39\u5361\uFF0C\u6267\u884C\u547D\u4EE4\u548C\u5199\u6587\u4EF6\u9700\u8981\u4E00\u6B21 danger-full-access \u5BA1\u6279\u3002\u4FE1\u4EFB\uFF1A\u547D\u4EE4\u548C\u5199\u5165\u4E0D\u518D\u5F39\u5361\u3002\u7981\u6B62\uFF1A\u8FD9\u53F0\u4E3B\u673A\u4E0D\u6267\u884C\u4EFB\u4F55\u8FDC\u7A0B\u8FD0\u7EF4\u64CD\u4F5C\u3002",
  policySaved: "\u8FDC\u7A0B\u8FD0\u7EF4\u7B56\u7565\u5DF2\u4FDD\u5B58\u3002"
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
  const result = await ctx.connection.rpc.call("/api", `sshPermission/${method}`, {
    args: input === void 0 ? {} : { input }
  });
  if (!result.ok) throw new Error(result.error?.message ?? `${method} failed`);
  return result.value;
}
async function readWorkspaces(ctx) {
  const listed = await callHost(ctx, "listWorkspaces");
  return Array.isArray(listed.items) ? listed.items : [];
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
.dsh-ssh-host[data-editing="true"] {
  border-color: var(--dsw-alias-brand-primary);
}
.dsh-ssh-card[data-editing="true"] {
  border-color: var(--dsw-alias-brand-primary);
}
.dsh-ssh-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
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
  flex-direction: column;
  gap: 10px;
}
.dsh-ssh-host-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 12px;
}
.dsh-ssh-host-identity {
  min-width: 0;
}
.dsh-ssh-status-row {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 12px;
}
.dsh-ssh-workspaces {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 8px;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}
.dsh-ssh-workspaces-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}
.dsh-ssh-disclosure {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 2px 4px 2px 0;
  border: none;
  border-radius: var(--dsw-radius-sm, 4px);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  cursor: pointer;
}
.dsh-ssh-disclosure:hover {
  color: var(--dsw-alias-label-primary);
}
.dsh-ssh-chevron {
  display: inline-block;
  color: var(--dsw-alias-label-tertiary);
  transition: transform 0.15s var(--ds-ease-in-out, ease);
}
.dsh-ssh-chevron[data-open="true"] {
  transform: rotate(90deg);
}
.dsh-ssh-count {
  min-width: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 16px;
  text-align: center;
}
.dsh-ssh-workspace-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.dsh-ssh-workspace {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
  padding: 6px 8px;
  border-radius: var(--dsw-radius-md);
}
.dsh-ssh-workspace:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsh-ssh-workspace-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.dsh-ssh-workspace-title,
.dsh-ssh-workspace-path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-ssh-workspace-title {
  font-size: 13px;
  line-height: 20px;
}
.dsh-ssh-workspace-path {
  color: var(--dsw-alias-label-tertiary);
  font-family: var(--ds-font-family-code, ui-monospace, monospace);
  font-size: 11px;
  line-height: 16px;
}
.dsh-ssh-workspace-meta {
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
}
.dsh-ssh-workspaces-empty {
  padding: 2px 2px 4px;
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
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 280px;
  overflow-y: auto;
}
.dsh-ssh-browser {
  display: flex;
  flex-direction: column;
  gap: 10px;
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  border-radius: var(--dsw-radius-xl);
  background: var(--dsw-alias-settings-card-fill);
  padding: 14px 16px;
}
.dsh-ssh-browser-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 12px;
}
.dsh-ssh-browser-heading {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.dsh-ssh-browser-host {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-ssh-breadcrumb {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
  padding: 6px 10px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1);
  font-size: 12px;
  line-height: 18px;
}
.dsh-ssh-crumb-part {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.dsh-ssh-crumb {
  margin: 0;
  padding: 2px 4px;
  border: none;
  border-radius: var(--dsw-radius-sm, 4px);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  cursor: pointer;
}
.dsh-ssh-crumb:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dsh-ssh-crumb:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
.dsh-ssh-crumb-sep {
  color: var(--dsw-alias-label-tertiary);
}
.dsh-ssh-dir {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: 28px;
  margin: 0;
  padding: 0 8px;
  border: none;
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  text-align: left;
  cursor: pointer;
}
.dsh-ssh-dir:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsh-ssh-dir:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
.dsh-ssh-dir-icon {
  flex: none;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-ssh-dir-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-ssh-empty {
  padding: 8px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}
.dsh-ssh-policy {
  width: auto;
  min-width: 92px;
  height: 28px;
  padding: 0 6px;
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
  const [workspaces, setWorkspaces] = (0, import_react.useState)([]);
  const [openWorkspaces, setOpenWorkspaces] = (0, import_react.useState)({});
  async function reload() {
    const loaded = await readHosts(ctx);
    setHosts(loaded.hosts);
  }
  async function reloadWorkspaces() {
    setWorkspaces(await readWorkspaces(ctx));
  }
  (0, import_react.useEffect)(() => {
    void Promise.all([reload(), reloadWorkspaces()]).catch((error) => fail(error));
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
      const port = Number(draft.port) || 22;
      const previous = hosts.find((item) => item.id === id);
      const moved = previous !== void 0 && (previous.host !== draft.host || previous.port !== port);
      const next = { ...draft, id, port, fingerprint: moved ? "" : draft.fingerprint };
      await callHost(ctx, "saveHost", next);
      setDraft(next);
      if (next.auth === "password" || secret.trim().length > 0) {
        await callHost(ctx, "saveSecret", {
          hostId: id,
          password: next.auth === "password" && secret.trim().length > 0 ? secret : void 0,
          passphrase: next.auth === "key" && secret.trim().length > 0 ? secret : void 0
        });
      }
      setSecret("");
      setDraft(blankHost());
      if (moved && selected === id) setStatus(null);
      await Promise.all([reload(), reloadWorkspaces()]);
      note(moved ? `${t("saved")} ${t("retrust")}` : t("saved"));
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }
  function beginEdit(host) {
    setDraft({ ...host });
    setSecret("");
    setPendingTrust("");
    setMessage("");
    setTone("ok");
    const form = document.getElementById("dsh-ssh-form");
    if (form !== null && typeof form.scrollIntoView === "function") form.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  function cancelEdit() {
    setDraft(blankHost());
    setSecret("");
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
  async function savePolicy(host, opsPolicy) {
    setBusy(true);
    try {
      await callHost(ctx, "saveHost", { ...host, opsPolicy });
      await reload();
      note(t("policySaved"));
    } catch (error) {
      fail(error);
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
      if (draft.id === hostId) cancelEdit();
      await Promise.all([reload(), reloadWorkspaces()]);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }
  async function browse(hostId, path) {
    setBusy(true);
    setSelected(hostId);
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
      note(`${t("workspaceCreated")} ${created.title ?? created.path}`);
      await reloadWorkspaces();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }
  async function tagWorkspaces(hostId, workspaceId) {
    setBusy(true);
    try {
      const tagged = await callHost(ctx, "tagWorkspaces", { hostId, workspaceId });
      if (Array.isArray(tagged.items)) setWorkspaces(tagged.items);
      note(t("taggedSidebar"));
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }
  async function removeWorkspace(workspaceId) {
    setBusy(true);
    try {
      await callHost(ctx, "removeWorkspace", { workspaceId });
      await reloadWorkspaces();
      note(t("workspaceRemoved"));
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }
  const current = hosts.find((item) => item.id === selected);
  const crumbs = dir.split("/").filter(Boolean);
  const byHost = /* @__PURE__ */ new Map();
  for (const workspace of workspaces) {
    const rows = byHost.get(workspace.hostId);
    if (rows === void 0) byHost.set(workspace.hostId, [workspace]);
    else rows.push(workspace);
  }
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "dsh-ssh-page", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", { className: "dsh-ssh-title", children: t("title") }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dsh-ssh-intro", children: t("description") }),
    message.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dsh-ssh-status", "data-tone": tone === "warn" ? "warn" : void 0, children: message }) : null,
    hosts.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", { className: "dsh-ssh-hosts", children: hosts.map((host) => {
      const owned = byHost.get(host.id) ?? [];
      const expanded = openWorkspaces[host.id] ?? owned.length > 0;
      return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", { className: "dsh-ssh-host", "data-editing": draft.id === host.id ? "true" : void 0, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-ssh-host-head", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-ssh-host-identity", children: [
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
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
              "select",
              {
                className: "dsh-ssh-select dsh-ssh-policy",
                "aria-label": t("opsPolicy"),
                value: host.opsPolicy ?? "ask",
                disabled: busy,
                onChange: (event) => void savePolicy(host, event.target.value),
                children: [
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "ask", children: t("opsAsk") }),
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "trust", children: t("opsTrust") }),
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "deny", children: t("opsDeny") })
                ]
              }
            ),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ssh-button", disabled: busy, onClick: () => beginEdit(host), children: t("edit") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ssh-button", disabled: busy, onClick: () => void test(host), children: t("test") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ssh-button", disabled: busy, onClick: () => void browse(host.id, "/"), children: t("browse") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ssh-button", disabled: busy, onClick: () => void removeHost(host.id), children: t("remove") })
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-ssh-workspaces", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-ssh-workspaces-head", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
              "button",
              {
                type: "button",
                className: "dsh-ssh-disclosure",
                "aria-expanded": expanded,
                onClick: () => setOpenWorkspaces({ ...openWorkspaces, [host.id]: !expanded }),
                children: [
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-ssh-chevron", "data-open": expanded ? "true" : void 0, "aria-hidden": "true", children: "\u25B8" }),
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: t("workspaces") }),
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-ssh-count", children: owned.length })
                ]
              }
            ),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ssh-button", disabled: busy || owned.length === 0, onClick: () => void tagWorkspaces(host.id), children: t("tagSidebar") })
          ] }),
          expanded ? owned.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", { className: "dsh-ssh-workspace-list", children: owned.map((workspace) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", { className: "dsh-ssh-workspace", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-ssh-workspace-text", children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-ssh-workspace-title", title: workspace.title, children: workspace.title }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-ssh-workspace-path", title: workspace.remotePath, children: workspace.remotePath })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-ssh-inline", children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dsh-ssh-workspace-meta", children: [
                workspace.sessions,
                " ",
                t("sessions")
              ] }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ssh-button", disabled: busy, onClick: () => void removeWorkspace(workspace.workspaceId), children: t("unregister") })
            ] })
          ] }, workspace.workspaceId)) }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dsh-ssh-note dsh-ssh-workspaces-empty", children: t("noWorkspaces") }) : null
        ] })
      ] }, host.id);
    }) }) : null,
    hosts.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dsh-ssh-note", children: t("workspacesNote") }) : null,
    selected.length > 0 && current !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-ssh-browser", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-ssh-browser-head", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-ssh-browser-heading", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-ssh-legend", children: t("directory") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-ssh-browser-host", children: current.name || current.host })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-ssh-inline", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ssh-button", disabled: busy || dir === "/", onClick: () => void browse(selected, parentDir(dir)), children: t("up") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ssh-button", disabled: busy, onClick: () => void browse(selected, dir), children: t("refresh") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ssh-button", "data-primary": "true", disabled: busy, onClick: () => void createWorkspace(selected, dir), children: t("createWorkspace") })
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-ssh-breadcrumb", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ssh-crumb", disabled: busy, onClick: () => void browse(selected, "/"), children: "/" }),
        crumbs.map((name, index) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dsh-ssh-crumb-part", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-ssh-crumb-sep", children: "/" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ssh-crumb", disabled: busy, onClick: () => void browse(selected, `/${crumbs.slice(0, index + 1).join("/")}`), children: name })
        ] }, `${name}-${index}`))
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("ul", { className: "dsh-ssh-dirs", children: [
        entries.map((entry) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("li", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", { type: "button", className: "dsh-ssh-dir", disabled: busy, onClick: () => void browse(selected, entry.path), children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-ssh-dir-icon", "aria-hidden": "true", children: "\u25B8" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-ssh-dir-name", children: entry.name })
        ] }) }, entry.path)),
        entries.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("li", { className: "dsh-ssh-empty", children: t("emptyDir") }) : null
      ] })
    ] }) : null,
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("form", { id: "dsh-ssh-form", className: "dsh-ssh-card", "data-editing": draft.id.length > 0 ? "true" : void 0, onSubmit: (event) => {
      event.preventDefault();
      void saveDraft();
    }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-ssh-legend", children: draft.id.length > 0 ? t("editHost") : t("addHost") }),
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
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "dsh-ssh-field", htmlFor: "dsh-ssh-policy", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-ssh-label", children: t("opsPolicy") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("select", { id: "dsh-ssh-policy", className: "dsh-ssh-select", value: draft.opsPolicy, onChange: (event) => setDraft({ ...draft, opsPolicy: event.target.value }), children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "ask", children: t("opsAsk") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "trust", children: t("opsTrust") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "deny", children: t("opsDeny") })
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dsh-ssh-note", children: t("opsNote") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label: draft.auth === "password" ? t("password") : t("passphrase"), value: secret, secret: true, onChange: setSecret }),
      draft.id.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dsh-ssh-note", children: t("secretKeep") }) : null,
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-ssh-actions", children: [
        draft.id.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ssh-button", disabled: busy, onClick: cancelEdit, children: t("cancel") }) : null,
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "submit", className: "dsh-ssh-button", "data-primary": "true", disabled: busy || draft.host.trim().length === 0 || draft.username.trim().length === 0, children: t("save") })
      ] })
    ] }),
    pendingTrust.length > 0 && current !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", { type: "button", className: "dsh-ssh-button", "data-primary": "true", disabled: busy, onClick: () => void trust(current), children: [
      t("trust"),
      " ",
      pendingTrust
    ] }) : null,
    status !== null && current !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-ssh-host dsh-ssh-status-row", children: [
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
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dsh-ssh-note", children: t("ripgrepNote") })
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
  return { id: "", name: "", host: "", port: 22, username: "", auth: "key", privateKeyPath: "", fingerprint: "", opsPolicy: "ask" };
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
