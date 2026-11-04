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
  description: "Turn a remote directory into a workspace. File and command tools run on that machine, under this session's sandbox mode and approval. An ordinary workspace can also run ops on a host with ssh_hosts / ssh_exec / ssh_read / ssh_write / ssh_upload / ssh_download, and register a remote directory as a workspace with ssh_workspace.",
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
  ripgrepNote: 'On connect, ripgrep is uploaded for the remote architecture. When this machine has no build for that platform \u2014 a Windows DSH managing a Linux remote, for example \u2014 the host row offers "Install ripgrep", which downloads the matching binary and caches it. It is also the fallback after a failed upload. Nothing is downloaded until you press that button. Installing bubblewrap does not install ripgrep.',
  directory: "Remote directory",
  up: "Up",
  refresh: "Refresh",
  emptyDir: "No subdirectories in this directory.",
  filter: "Filter directories",
  filterPlaceholder: "Filter by name, or paste a path such as /home/me to complete",
  filterHint: "Tab reaches the rows; press / to come back",
  noMatch: "No subdirectory matches this filter.",
  pathComplete: "Completing",
  pathIncomplete: "Finish the path first: pick a row, or end it with /",
  pathLoading: "Listing {path}\u2026",
  cannotOpen: "Cannot open {path}: {reason}",
  dirMissing: "no such directory, or no permission to read it.",
  closeBrowser: "Close directory browser",
  newFolder: "New folder",
  newFolderName: "Folder name",
  newFolderPlaceholder: "Create below this directory",
  newFolderCreate: "Create",
  newFolderCancel: "Cancel",
  newFolderExists: "A folder with that name already exists.",
  newFolderBadName: "Enter one path segment: no / and not empty.",
  createdFolder: "Created folder:",
  createWorkspace: "Use this directory as a workspace",
  workspaces: "Workspaces",
  workspacesNote: 'Sidebar titles read "server \xB7 directory" so a workspace shows which machine it lives on.',
  noWorkspaces: 'No workspace from this server yet. Use Browse, pick a directory, then "Use this directory as a workspace".',
  sessions: "sessions",
  tagSidebar: "Tag sidebar titles",
  tagTitles: "Show the server in sidebar titles",
  tagTitlesHint: "Automatic tagging only touches workspaces still titled after their directory; names you changed are left alone. The button on a host tags all of its workspaces.",
  tagToggleSaved: "Title tagging setting saved.",
  titlesUpdated: "Sidebar titles updated.",
  titlesUnchanged: "Sidebar titles already name this server.",
  deletedHosts: "Deleted hosts",
  deletedHostsNote: "These hosts were removed from the list, but their workspaces are still registered in DSH. Restore a host, or unregister its workspaces one by one; files on the remote host are never deleted.",
  hostRemoved: "removed",
  restoreHost: "Restore host",
  restoredHost: "Host restored.",
  restoreUnavailable: "This host can no longer be restored; add it again",
  workspaceGone: "That workspace is no longer in the list.",
  unregister: "Unregister",
  workspaceRemoved: "Removed from the workspace list. Files on the remote host are untouched.",
  workspaceCreated: "Workspace created",
  opsPolicy: "Remote call approval",
  opsAsk: "Ask each time",
  opsTrust: "Do not ask",
  opsDeny: "Block calls",
  opsNote: "When a session in another workspace runs ssh_exec, ssh_write, ssh_upload, or ssh_download against this host: Ask each time approves each command, write, and transfer once, at danger-full-access; Do not ask runs them directly; Block calls refuses every remote command and write on this host. Reading remote files (ssh_read) is not affected; a download counts as a write and needs approval.",
  loginEnv: "Environment source",
  loginOff: "SSH login environment",
  loginBash: "Read bash startup files",
  loginNote: "SSH login environment: workspace commands keep the variables SSH logged in with, usually just the few in /etc/environment. Read bash startup files: once per SSH connection, /etc/profile, the first readable of ~/.bash_profile, ~/.bash_login, and ~/.profile, then /etc/bash.bashrc and ~/.bashrc, are sourced and the variables they export are added to later workspace commands. A file an earlier file already sourced is not read again. Output is discarded. Reading stops after 10 seconds; if it times out or fails, later commands on this connection keep the SSH environment. The variables are reused until the connection drops, the switch goes back to SSH login environment, or Re-read environment is pressed on the host card; re-reading only drops the cache and leaves the SSH connection up. PATH from bashrc, such as nvm or cargo, is kept. A PATH that points at the wrong directories stays until re-read, disconnect, or switching back. PWD, OLDPWD, and SHLVL are session state and are not cached. ~/.zshrc is not read. Aliases and functions are not kept: commands found through PATH work, shell functions such as nvm do not. ssh_exec ignores this setting and always runs bash -lc.",
  loginReread: "Re-read environment",
  loginRereadNote: "The cached environment was dropped. The SSH connection stays up. The next workspace command reads the startup files again, up to 10 seconds.",
  badgeOpsTrust: "Remote calls need no approval",
  badgeOpsDeny: "Remote calls blocked",
  installRipgrep: "Install ripgrep",
  rgRegistry: "ripgrep download source",
  rgRegistryHint: 'Only read by "Install ripgrep": the npm source the platform package is downloaded from. Leave it empty for npmjs, or set a mirror where npmjs is slow or blocked. A bare host name is used over https. Cached binaries keep working offline.',
  registrySaved: "Download source saved.",
  transferMaxBytes: "Transfer ceiling (bytes)",
  transferTimeoutMs: "Transfer timeout (ms)",
  transferLimitsHint: "Ceiling and deadline shared by ssh_upload / ssh_download. Leave the byte count empty or 0 for no ceiling (the whole file is held in memory); leave the timeout empty or 0 for no deadline. Saves take effect immediately.",
  transferLimitsSaved: "Transfer ceiling and timeout saved.",
  transferLimitsInvalid: "The ceiling and timeout must be non-negative integers; empty or 0 means unlimited.",
  transferLimitsClamped: "Over the limit, saved as 2147483647 ms:",
  rgInstalled: "ripgrep ready:",
  rgStillMissing: "Downloaded, but the remote still reports it missing",
  installOk: "bubblewrap is available.",
  installNoEffect: "The command reported success, but the remote sandbox is still unavailable.",
  installFailed: "Install failed.",
  installNoOutput: "(the command printed nothing)",
  tabHosts: "Hosts",
  tabDeleted: "Deleted",
  tabSettings: "Settings",
  tabHelp: "Help",
  deletedEmpty: "No deleted hosts.",
  purgeHost: "Delete permanently",
  purgeConfirm: "Workspaces to unregister:",
  purgeConfirmAction: "Delete permanently",
  purgedHost: "Deleted permanently; workspaces unregistered:",
  rgUploadFailed: "Downloaded, but the remote refused the upload",
  rgInstallFailed: "ripgrep install failed.",
  panel: "SSH hosts",
  backToSession: "Back to session",
  remoteRoot: "Remote root directory",
  remoteRootSave: "Save and migrate",
  remoteRootHint: "Local directory that holds the placeholder for every remote workspace. Defaults to ~/.dsh/remote. Changing it copies the old tree over; a non-empty target is merged automatically (keep existing files, add missing ones), and a same-named file with different content asks you first. Clear the field to go back to the default.",
  remoteRootCurrent: "Current:",
  remoteRootUnchanged: "The remote root did not change.",
  remoteRootChanged: "Remote root switched:",
  remoteRootCopied: "copied",
  remoteRootSkipped: "skipped",
  remoteRootOverwritten: "overwritten",
  remoteRootRemapped: "workspaces re-registered",
  remoteRootConflictsLeft: "left untouched",
  remoteRootHasSessions: "Workspaces have live sessions:",
  remoteRootForceHint: "Migrating re-registers these workspaces and moves their stored sessions to the new root; sessions that are open stay in place until you close them and save again. Continue anyway?",
  remoteRootForce: "Migrate anyway",
  remoteRootSessionsMoved: "sessions moved",
  remoteRootSessionsOpen: "Open sessions were left in place; close them and save again to move them",
  remoteRootSessionsRegroup: "grouping is restored after DSH restarts",
  remoteRootSessionsFailed: "failed",
  remoteRootConflicts: "The target already has different files with the same names:",
  remoteRootConflictHint: "Keep the target's files (add only missing ones), or overwrite them from the old root.",
  remoteRootKeepTarget: "Keep target (auto-merge)",
  remoteRootOverwrite: "Overwrite from old root",
  hostBackup: "Host configuration backup",
  exportHosts: "Export config",
  importMerge: "Import and merge",
  importReplace: "Import and replace",
  importReplaceConfirm: "Replacing drops every host the file does not list (they move to deleted hosts). Continue?",
  importRiskConfirm: "This file changes a host address or relaxes its approval policy. A changed address drops the saved password. Import anyway?",
  importRiskContinue: "Import anyway",
  hostBackupHint: "The exported JSON holds only the host list, never passwords or key passphrases. Merge updates only the fields the file contains; a changed address drops the saved password. Replace makes the file the whole list and keeps a deleted host that still has workspaces. After importing, test connections again and re-enter secrets as needed.",
  exportedHosts: "Host configuration exported.",
  importedHosts: "Host configuration imported (added/updated/removed):",
  importTrusted: "hosts set to trust (commands run without asking):"
};

// locale/zh.json
var zh_default = {
  nav: "SSH \u4E3B\u673A",
  title: "SSH \u4E3B\u673A",
  description: "\u628A\u8FDC\u7AEF\u76EE\u5F55\u505A\u6210\u5DE5\u4F5C\u533A\u3002\u6587\u4EF6\u548C\u547D\u4EE4\u5DE5\u5177\u5728\u90A3\u53F0\u673A\u5668\u4E0A\u6267\u884C\uFF0C\u6743\u9650\u4ECD\u7528\u8FD9\u4E2A\u4F1A\u8BDD\u73B0\u6709\u7684\u6C99\u7BB1\u6863\u4F4D\u548C\u5BA1\u6279\u3002\u666E\u901A\u5DE5\u4F5C\u533A\u4E5F\u53EF\u4EE5\u7528 ssh_hosts / ssh_exec / ssh_read / ssh_write / ssh_upload / ssh_download \u5BF9\u4E3B\u673A\u505A\u8FD0\u7EF4\uFF0C\u7528 ssh_workspace \u628A\u8FDC\u7AEF\u76EE\u5F55\u6CE8\u518C\u6210\u5DE5\u4F5C\u533A\u3002",
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
  ripgrepNote: "\u8FDE\u63A5\u65F6\u4F1A\u6309\u8FDC\u7AEF\u67B6\u6784\u4E0A\u4F20 ripgrep\u3002\u672C\u673A\u6CA1\u6709\u8BE5\u5E73\u53F0\u7684\u6784\u5EFA\u65F6\uFF08\u4F8B\u5982 Windows \u4E0A\u7684 DSH \u7BA1 Linux \u8FDC\u7AEF\uFF09\uFF0C\u4E3B\u673A\u884C\u4F1A\u51FA\u73B0\u300C\u5B89\u88C5 ripgrep\u300D\uFF0C\u6309\u9700\u4E0B\u8F7D\u5E76\u7F13\u5B58\u5BF9\u5E94\u5E73\u53F0\u7684\u4E8C\u8FDB\u5236\uFF1B\u4E0A\u4F20\u5931\u8D25\u540E\u4E5F\u53EF\u4EE5\u7528\u5B83\u91CD\u8BD5\u3002\u4E0D\u70B9\u8FD9\u4E2A\u6309\u94AE\u5C31\u4E0D\u4F1A\u8054\u7F51\u3002\u5B89\u88C5 bubblewrap \u4E0D\u4F1A\u9644\u5E26 ripgrep\u3002",
  directory: "\u8FDC\u7AEF\u76EE\u5F55",
  up: "\u4E0A\u4E00\u7EA7",
  refresh: "\u5237\u65B0",
  emptyDir: "\u8FD9\u4E2A\u76EE\u5F55\u4E0B\u6CA1\u6709\u5B50\u76EE\u5F55\u3002",
  filter: "\u7B5B\u9009\u76EE\u5F55",
  filterPlaceholder: "\u8F93\u5165\u540D\u79F0\u7B5B\u9009\uFF0C\u6216\u7C98\u8D34 /home/me \u8FD9\u6837\u7684\u8DEF\u5F84\u8865\u5168",
  filterHint: "Tab \u8FDB\u76EE\u5F55\u884C\uFF1B\u6309 / \u56DE\u5230\u8FD9\u91CC",
  noMatch: "\u6CA1\u6709\u5339\u914D\u7684\u5B50\u76EE\u5F55\u3002",
  pathComplete: "\u8865\u5168",
  pathIncomplete: "\u5148\u628A\u8DEF\u5F84\u8865\u6210\u76EE\u5F55\uFF1A\u9009\u4E2D\u4E00\u884C\uFF0C\u6216\u5728\u672B\u5C3E\u52A0 /",
  pathLoading: "\u6B63\u5728\u5217\u51FA {path}\u2026",
  cannotOpen: "\u65E0\u6CD5\u8FDB\u5165 {path}\uFF1A{reason}",
  dirMissing: "\u6CA1\u6709\u8FD9\u4E2A\u76EE\u5F55\uFF0C\u6216\u6CA1\u6709\u8BBF\u95EE\u6743\u9650\u3002",
  closeBrowser: "\u5173\u95ED\u76EE\u5F55\u6D4F\u89C8",
  newFolder: "\u65B0\u5EFA\u6587\u4EF6\u5939",
  newFolderName: "\u6587\u4EF6\u5939\u540D",
  newFolderPlaceholder: "\u5728\u5F53\u524D\u76EE\u5F55\u4E0B\u65B0\u5EFA",
  newFolderCreate: "\u521B\u5EFA",
  newFolderCancel: "\u53D6\u6D88",
  newFolderExists: "\u540C\u540D\u6587\u4EF6\u5939\u5DF2\u5B58\u5728\u3002",
  newFolderBadName: "\u53EA\u80FD\u8F93\u5165\u4E00\u7EA7\u540D\u5B57\uFF0C\u4E0D\u80FD\u542B / \u6216\u4E3A\u7A7A\u3002",
  createdFolder: "\u5DF2\u65B0\u5EFA\u6587\u4EF6\u5939\uFF1A",
  createWorkspace: "\u628A\u5F53\u524D\u76EE\u5F55\u505A\u6210\u5DE5\u4F5C\u533A",
  workspaces: "\u5DF2\u6DFB\u52A0\u7684\u5DE5\u4F5C\u533A",
  workspacesNote: "\u4FA7\u680F\u6807\u9898\u4F1A\u5199\u6210\u300C\u670D\u52A1\u5668 \xB7 \u76EE\u5F55\u540D\u300D\uFF0C\u65B9\u4FBF\u8BA4\u51FA\u5DE5\u4F5C\u533A\u5728\u54EA\u53F0\u673A\u5668\u4E0A\u3002",
  noWorkspaces: "\u8FD8\u6CA1\u6709\u4ECE\u8FD9\u53F0\u670D\u52A1\u5668\u6DFB\u52A0\u5DE5\u4F5C\u533A\u3002\u7528\u300C\u6D4F\u89C8\u76EE\u5F55\u300D\u9009\u4E00\u4E2A\u76EE\u5F55\uFF0C\u518D\u70B9\u300C\u628A\u5F53\u524D\u76EE\u5F55\u505A\u6210\u5DE5\u4F5C\u533A\u300D\u3002",
  sessions: "\u4E2A\u4F1A\u8BDD",
  tagSidebar: "\u6807\u6CE8\u4FA7\u680F\u6807\u9898",
  tagTitles: "\u5728\u4FA7\u680F\u6807\u9898\u4E2D\u663E\u793A\u670D\u52A1\u5668",
  tagTitlesHint: "\u81EA\u52A8\u6807\u6CE8\u53EA\u5904\u7406\u6807\u9898\u4ECD\u662F\u76EE\u5F55\u540D\u7684\u5DE5\u4F5C\u533A\uFF1B\u4F60\u6539\u8FC7\u7684\u540D\u5B57\u4E0D\u4F1A\u88AB\u81EA\u52A8\u6539\u5199\u3002\u4E3B\u673A\u4E0A\u7684\u300C\u6807\u6CE8\u4FA7\u680F\u6807\u9898\u300D\u4F1A\u7ED9\u8BE5\u4E3B\u673A\u7684\u5168\u90E8\u5DE5\u4F5C\u533A\u6807\u6CE8\u3002",
  tagToggleSaved: "\u6807\u9898\u6807\u6CE8\u8BBE\u7F6E\u5DF2\u4FDD\u5B58\u3002",
  titlesUpdated: "\u5DF2\u66F4\u65B0\u4FA7\u680F\u6807\u9898\u3002",
  titlesUnchanged: "\u4FA7\u680F\u6807\u9898\u5DF2\u7ECF\u662F\u5F53\u524D\u670D\u52A1\u5668\u7684\u6807\u6CE8\u3002",
  deletedHosts: "\u5DF2\u5220\u9664\u7684\u4E3B\u673A",
  deletedHostsNote: "\u8FD9\u4E9B\u4E3B\u673A\u5DF2\u4ECE\u5217\u8868\u79FB\u9664\uFF0C\u4F46\u5DE5\u4F5C\u533A\u4ECD\u6CE8\u518C\u5728 DSH \u91CC\u3002\u53EF\u4EE5\u6062\u590D\u4E3B\u673A\uFF0C\u6216\u9010\u4E2A\u6CE8\u9500\u5DE5\u4F5C\u533A\uFF1B\u8FDC\u7AEF\u6587\u4EF6\u4E0D\u4F1A\u88AB\u5220\u9664\u3002",
  hostRemoved: "\u5DF2\u79FB\u9664",
  restoreHost: "\u6062\u590D\u4E3B\u673A",
  restoredHost: "\u4E3B\u673A\u5DF2\u6062\u590D\u3002",
  restoreUnavailable: "\u4E3B\u673A\u914D\u7F6E\u5DF2\u4E0D\u53EF\u6062\u590D\uFF0C\u8BF7\u91CD\u65B0\u6DFB\u52A0",
  workspaceGone: "\u8FD9\u4E2A\u5DE5\u4F5C\u533A\u5DF2\u7ECF\u4E0D\u5728\u5217\u8868\u91CC\u4E86\u3002",
  unregister: "\u4ECE\u5217\u8868\u79FB\u9664",
  workspaceRemoved: "\u5DF2\u4ECE\u5DE5\u4F5C\u533A\u5217\u8868\u79FB\u9664\uFF0C\u8FDC\u7AEF\u6587\u4EF6\u672A\u6539\u52A8\u3002",
  workspaceCreated: "\u5DE5\u4F5C\u533A\u5DF2\u521B\u5EFA",
  opsPolicy: "\u8FDC\u7A0B\u8C03\u7528\u5BA1\u6279",
  opsAsk: "\u6BCF\u6B21\u8BE2\u95EE",
  opsTrust: "\u4E0D\u518D\u8BE2\u95EE",
  opsDeny: "\u7981\u6B62\u8C03\u7528",
  opsNote: "\u5176\u4ED6\u5DE5\u4F5C\u533A\u91CC\u7684\u4F1A\u8BDD\u7528 ssh_exec / ssh_write / ssh_upload / ssh_download \u64CD\u4F5C\u8FD9\u53F0\u4E3B\u673A\u65F6\uFF1A\u6BCF\u6B21\u8BE2\u95EE\uFF0C\u6267\u884C\u547D\u4EE4\u3001\u5199\u6587\u4EF6\u548C\u4F20\u6587\u4EF6\u5404\u8981\u4E00\u6B21 danger-full-access \u5BA1\u6279\uFF1B\u4E0D\u518D\u8BE2\u95EE\uFF0C\u76F4\u63A5\u6267\u884C\uFF1B\u7981\u6B62\u8C03\u7528\uFF0C\u8FD9\u53F0\u4E3B\u673A\u62D2\u7EDD\u6240\u6709\u8FDC\u7A0B\u547D\u4EE4\u548C\u5199\u5165\u3002\u8BFB\u53D6\u8FDC\u7AEF\u6587\u4EF6\uFF08ssh_read\uFF09\u4E0D\u53D7\u8FD9\u4E2A\u8BBE\u7F6E\u5F71\u54CD\uFF0C\u4E0B\u8F7D\u7B97\u5199\u5165\u3001\u9700\u8981\u5BA1\u6279\u3002",
  loginEnv: "\u73AF\u5883\u53D8\u91CF\u6765\u6E90",
  loginOff: "SSH \u767B\u5F55\u73AF\u5883",
  loginBash: "\u8BFB\u53D6 bash \u542F\u52A8\u811A\u672C",
  loginNote: "SSH \u767B\u5F55\u73AF\u5883\uFF1A\u5DE5\u4F5C\u533A\u547D\u4EE4\u6CBF\u7528 SSH \u767B\u5F55\u65F6\u62FF\u5230\u7684\u53D8\u91CF\uFF0C\u901A\u5E38\u53EA\u6709 /etc/environment \u91CC\u90A3\u51E0\u4E2A\u3002\u8BFB\u53D6 bash \u542F\u52A8\u811A\u672C\uFF1A\u6BCF\u6B21 SSH \u8FDE\u63A5\u8BFB\u4E00\u6B21 /etc/profile\u3001~/.bash_profile\uFF08\u6CA1\u6709\u5219 ~/.bash_login\uFF0C\u518D\u6CA1\u6709\u5219 ~/.profile\uFF09\u3001/etc/bash.bashrc \u548C ~/.bashrc\uFF0C\u628A\u5B83\u4EEC export \u7684\u53D8\u91CF\u6CE8\u5165\u4E4B\u540E\u7684\u5DE5\u4F5C\u533A\u547D\u4EE4\u3002\u524D\u9762\u5DF2\u7ECF source \u8FC7\u7684\u6587\u4EF6\u4E0D\u4F1A\u518D\u8BFB\uFF0C\u8BFB\u53D6\u65F6\u4E22\u6389\u8F93\u51FA\uFF0C\u6700\u591A 10 \u79D2\uFF1B\u8D85\u65F6\u6216\u5931\u8D25\u540E\uFF0C\u8FD9\u6B21\u8FDE\u63A5\u91CC\u7684\u540E\u7EED\u547D\u4EE4\u6CBF\u7528 SSH \u539F\u6765\u7684\u73AF\u5883\u3002\u8BFB\u5230\u7684\u53D8\u91CF\u4F1A\u590D\u7528\uFF0C\u76F4\u5230\u8FDE\u63A5\u65AD\u5F00\u3001\u5207\u56DE SSH \u767B\u5F55\u73AF\u5883\uFF0C\u6216\u70B9\u4E3B\u673A\u5361\u7247\u4E0A\u7684\u300C\u91CD\u65B0\u8BFB\u53D6\u73AF\u5883\u300D\u2014\u2014\u91CD\u65B0\u8BFB\u53D6\u53EA\u4E22\u6389\u7F13\u5B58\uFF0C\u4E0D\u65AD\u5F00 SSH\u3002\u5199\u5728 bashrc \u91CC\u7684 PATH\uFF08\u5982 nvm\u3001cargo\uFF09\u4F1A\u4FDD\u7559\uFF1B\u8BBE\u9519\u7684 PATH \u4E5F\u4F1A\u4E00\u76F4\u7559\u5230\u91CD\u65B0\u8BFB\u53D6\u3001\u65AD\u5F00\u6216\u5207\u56DE\u3002PWD\u3001OLDPWD \u548C SHLVL \u5C5E\u4E8E\u4F1A\u8BDD\u72B6\u6001\uFF0C\u4E0D\u4F1A\u5199\u5165\u7F13\u5B58\u3002\u4E0D\u8BFB\u53D6 ~/.zshrc\u3002\u522B\u540D\u548C\u51FD\u6570\u4E0D\u4F1A\u4FDD\u7559\uFF1B\u8981\u9760 PATH \u627E\u5230\u7684\u547D\u4EE4\u4F1A\u751F\u6548\uFF0C\u9760 shell \u51FD\u6570\u7684\uFF08\u5982 nvm\uFF09\u4E0D\u4F1A\u3002ssh_exec \u4E0D\u53D7\u8FD9\u4E2A\u8BBE\u7F6E\u5F71\u54CD\uFF0C\u5B83\u56FA\u5B9A\u7528 bash -lc\u3002",
  loginReread: "\u91CD\u65B0\u8BFB\u53D6\u73AF\u5883",
  loginRereadNote: "\u5DF2\u4E22\u6389\u7F13\u5B58\u7684\u73AF\u5883\u53D8\u91CF\u3002SSH \u8FDE\u63A5\u8FD8\u5728\u3002\u4E0B\u4E00\u6761\u5DE5\u4F5C\u533A\u547D\u4EE4\u4F1A\u91CD\u65B0\u8BFB\u53D6\u542F\u52A8\u811A\u672C\uFF0C\u6700\u591A 10 \u79D2\u3002",
  badgeOpsTrust: "\u8FDC\u7A0B\u8C03\u7528\u514D\u5BA1\u6279",
  badgeOpsDeny: "\u8FDC\u7A0B\u8C03\u7528\u5DF2\u7981\u6B62",
  installRipgrep: "\u5B89\u88C5 ripgrep",
  rgRegistry: "ripgrep \u4E0B\u8F7D\u6E90",
  rgRegistryHint: "\u4EC5\u300C\u5B89\u88C5 ripgrep\u300D\u4F1A\u8BFB\u53D6\uFF1A\u4E0B\u8F7D\u5E73\u53F0\u5305\u6240\u7528\u7684 npm \u6E90\u3002\u7559\u7A7A\u7528 npmjs\uFF0Cnpmjs \u6162\u6216\u88AB\u5899\u65F6\u53EF\u586B\u955C\u50CF\uFF1B\u53EA\u5199\u4E3B\u673A\u540D\u65F6\u6309 https \u5904\u7406\u3002\u5DF2\u4E0B\u8F7D\u7684\u4E8C\u8FDB\u5236\u79BB\u7EBF\u53EF\u7528\u3002",
  registrySaved: "\u4E0B\u8F7D\u6E90\u5DF2\u4FDD\u5B58\u3002",
  transferMaxBytes: "\u5355\u6B21\u4F20\u8F93\u4E0A\u9650\uFF08\u5B57\u8282\uFF09",
  transferTimeoutMs: "\u5355\u6B21\u4F20\u8F93\u8D85\u65F6\uFF08\u6BEB\u79D2\uFF09",
  transferLimitsHint: "ssh_upload / ssh_download \u5171\u7528\u7684\u4E0A\u9650\u4E0E\u8D85\u65F6\u3002\u5B57\u8282\u6570\u7559\u7A7A\u6216\u586B 0 \u8868\u793A\u4E0D\u5C01\u9876\uFF08\u6574\u4E2A\u6587\u4EF6\u4F1A\u8FDB\u5185\u5B58\uFF09\uFF1B\u8D85\u65F6\u7559\u7A7A\u6216\u586B 0 \u8868\u793A\u4E0D\u9650\u65F6\u3002\u4FDD\u5B58\u540E\u7ACB\u5373\u751F\u6548\u3002",
  transferLimitsSaved: "\u4F20\u8F93\u4E0A\u9650\u4E0E\u8D85\u65F6\u5DF2\u4FDD\u5B58\u3002",
  transferLimitsInvalid: "\u4E0A\u9650\u548C\u8D85\u65F6\u53EA\u80FD\u586B\u975E\u8D1F\u6574\u6570\uFF1B\u7559\u7A7A\u6216 0 \u8868\u793A\u4E0D\u9650\u5236\u3002",
  transferLimitsClamped: "\u8D85\u8FC7\u4E0A\u9650\uFF0C\u5DF2\u6309 2147483647 \u6BEB\u79D2\u4FDD\u5B58\uFF1A",
  rgInstalled: "ripgrep \u5DF2\u5C31\u7EEA\uFF1A",
  rgStillMissing: "\u4E0B\u8F7D\u5B8C\u6210\u4F46\u8FDC\u7AEF\u4ECD\u4E0D\u53EF\u7528",
  installOk: "bubblewrap \u5DF2\u53EF\u7528\u3002",
  installNoEffect: "\u547D\u4EE4\u62A5\u544A\u6210\u529F\uFF0C\u4F46\u8FDC\u7AEF\u6C99\u7BB1\u4ECD\u4E0D\u53EF\u7528\u3002",
  installFailed: "\u5B89\u88C5\u5931\u8D25\u3002",
  installNoOutput: "\uFF08\u547D\u4EE4\u6CA1\u6709\u8F93\u51FA\uFF09",
  tabHosts: "\u4E3B\u673A",
  tabDeleted: "\u5DF2\u5220\u9664",
  tabSettings: "\u8BBE\u7F6E",
  tabHelp: "\u5E2E\u52A9",
  deletedEmpty: "\u6CA1\u6709\u5DF2\u5220\u9664\u7684\u4E3B\u673A\u3002",
  purgeHost: "\u5F7B\u5E95\u5220\u9664",
  purgeConfirm: "\u5C06\u4E00\u5E76\u6CE8\u9500\u5DE5\u4F5C\u533A\uFF1A",
  purgeConfirmAction: "\u786E\u8BA4\u5220\u9664",
  purgedHost: "\u5DF2\u5F7B\u5E95\u5220\u9664\uFF0C\u6CE8\u9500\u5DE5\u4F5C\u533A\u6570\uFF1A",
  rgUploadFailed: "\u5DF2\u4E0B\u8F7D\uFF0C\u4F46\u8FDC\u7AEF\u5199\u5165\u5931\u8D25",
  rgInstallFailed: "ripgrep \u5B89\u88C5\u5931\u8D25\u3002",
  panel: "SSH \u4E3B\u673A",
  backToSession: "\u8FD4\u56DE\u4F1A\u8BDD",
  remoteRoot: "\u8FDC\u7AEF\u6839\u76EE\u5F55",
  remoteRootSave: "\u4FDD\u5B58\u5E76\u8FC1\u79FB",
  remoteRootHint: "\u672C\u5730\u5B58\u653E\u6240\u6709\u8FDC\u7AEF\u5DE5\u4F5C\u533A\u5360\u4F4D\u76EE\u5F55\u7684\u4F4D\u7F6E\uFF0C\u9ED8\u8BA4 ~/.dsh/remote\u3002\u6539\u5230\u65B0\u76EE\u5F55\u65F6\uFF0C\u65E7\u76EE\u5F55\u4F1A\u590D\u5236\u8FC7\u53BB\uFF1B\u65B0\u76EE\u5F55\u5DF2\u6709\u5185\u5BB9\u65F6\u81EA\u52A8\u5408\u5E76\uFF08\u4FDD\u7559\u76EE\u6807\u5DF2\u6709\u6587\u4EF6\uFF0C\u53EA\u8865\u7F3A\u5931\uFF09\uFF0C\u540C\u540D\u4E14\u5185\u5BB9\u4E0D\u540C\u7684\u6587\u4EF6\u4F1A\u5148\u95EE\u4F60\u3002\u7559\u7A7A\u8868\u793A\u56DE\u5230\u9ED8\u8BA4\u76EE\u5F55\u3002",
  remoteRootCurrent: "\u5F53\u524D\uFF1A",
  remoteRootUnchanged: "\u8FDC\u7AEF\u6839\u76EE\u5F55\u6CA1\u6709\u53D8\u5316\u3002",
  remoteRootChanged: "\u8FDC\u7AEF\u6839\u76EE\u5F55\u5DF2\u5207\u6362\uFF1A",
  remoteRootCopied: "\u590D\u5236",
  remoteRootSkipped: "\u8DF3\u8FC7",
  remoteRootOverwritten: "\u8986\u76D6",
  remoteRootRemapped: "\u91CD\u6CE8\u518C\u5DE5\u4F5C\u533A",
  remoteRootConflictsLeft: "\u4FDD\u7559\u672A\u52A8",
  remoteRootHasSessions: "\u6709\u4F1A\u8BDD\u6B63\u6253\u5F00\u5728\u8FD9\u4E9B\u5DE5\u4F5C\u533A\u91CC\uFF0C\u6570\u91CF\uFF1A",
  remoteRootForceHint: "\u8FC1\u79FB\u4F1A\u91CD\u65B0\u6CE8\u518C\u8FD9\u4E9B\u5DE5\u4F5C\u533A\uFF0C\u5E76\u628A\u5DF2\u5B58\u50A8\u7684\u4F1A\u8BDD\u4E00\u8D77\u642C\u5230\u65B0\u6839\u76EE\u5F55\uFF1B\u6B63\u5728\u6253\u5F00\u7684\u4F1A\u8BDD\u5148\u7559\u5728\u539F\u5904\uFF0C\u5173\u95ED\u5B83\u4EEC\u540E\u518D\u6B21\u4FDD\u5B58\u5373\u53EF\u8865\u8FC1\u3002\u4ECD\u8981\u7EE7\u7EED\u5417\uFF1F",
  remoteRootForce: "\u4ECD\u7136\u8FC1\u79FB",
  remoteRootSessionsMoved: "\u5DF2\u8FC1\u79FB\u4F1A\u8BDD",
  remoteRootSessionsOpen: "\u6253\u5F00\u4E2D\u7684\u4F1A\u8BDD\u5DF2\u7559\u5728\u539F\u5904\uFF0C\u5173\u95ED\u5B83\u4EEC\u540E\u518D\u6B21\u4FDD\u5B58\u5373\u53EF\u8865\u8FC1",
  remoteRootSessionsRegroup: "\u91CD\u542F DSH \u540E\u81EA\u52A8\u6062\u590D\u5206\u7EC4",
  remoteRootSessionsFailed: "\u672A\u80FD\u8FC1\u79FB",
  remoteRootConflicts: "\u65B0\u76EE\u5F55\u91CC\u5DF2\u6709\u540C\u540D\u7684\u4E0D\u540C\u6587\u4EF6\uFF0C\u6570\u91CF\uFF1A",
  remoteRootConflictHint: "\u53EF\u4EE5\u9009\u62E9\u4FDD\u7559\u76EE\u6807\u5DF2\u6709\u6587\u4EF6\uFF08\u53EA\u8865\u7F3A\u5931\uFF09\uFF0C\u6216\u7528\u65E7\u76EE\u5F55\u8986\u76D6\u8FD9\u4E9B\u6587\u4EF6\u3002",
  remoteRootKeepTarget: "\u4FDD\u7559\u76EE\u6807\uFF08\u81EA\u52A8\u5408\u5E76\uFF09",
  remoteRootOverwrite: "\u7528\u65E7\u76EE\u5F55\u8986\u76D6",
  hostBackup: "\u4E3B\u673A\u914D\u7F6E\u5907\u4EFD",
  exportHosts: "\u5BFC\u51FA\u914D\u7F6E",
  importMerge: "\u5BFC\u5165\u5E76\u5408\u5E76",
  importReplace: "\u5BFC\u5165\u5E76\u66FF\u6362",
  importReplaceConfirm: "\u66FF\u6362\u4F1A\u79FB\u9664\u6587\u4EF6\u91CC\u6CA1\u6709\u7684\u4E3B\u673A\uFF08\u79FB\u5230\u201C\u5DF2\u5220\u9664\u4E3B\u673A\u201D\u91CC\uFF09\u3002\u7EE7\u7EED\u5417\uFF1F",
  importRiskConfirm: "\u8FD9\u4E2A\u6587\u4EF6\u4F1A\u6539\u4E3B\u673A\u5730\u5740\uFF0C\u6216\u653E\u5BBD\u64CD\u4F5C\u5BA1\u6279\u3002\u5730\u5740\u53D8\u4E86\u4F1A\u4E22\u6389\u5DF2\u4FDD\u5B58\u7684\u53E3\u4EE4\u3002\u4ECD\u8981\u5BFC\u5165\u5417\uFF1F",
  importRiskContinue: "\u4ECD\u7136\u5BFC\u5165",
  hostBackupHint: "\u5BFC\u51FA\u7684 JSON \u53EA\u542B\u4E3B\u673A\u5217\u8868\uFF0C\u4E0D\u542B\u53E3\u4EE4\u548C\u79C1\u94A5\u53E3\u4EE4\u3002\u5408\u5E76\u53EA\u66F4\u65B0\u6587\u4EF6\u91CC\u5199\u4E86\u7684\u5B57\u6BB5\uFF1B\u5730\u5740\u53D8\u4E86\u4F1A\u4E22\u6389\u5DF2\u4FDD\u5B58\u7684\u53E3\u4EE4\u3002\u6574\u4F53\u66FF\u6362\u4EE5\u6587\u4EF6\u4E3A\u51C6\uFF0C\u5E76\u4FDD\u7559\u4ECD\u6709\u5DE5\u4F5C\u533A\u7684\u5DF2\u5220\u9664\u4E3B\u673A\u3002\u5BFC\u5165\u540E\u8BF7\u91CD\u65B0\u6D4B\u8BD5\u8FDE\u63A5\u5E76\u6309\u9700\u91CD\u586B\u53E3\u4EE4\u3002",
  exportedHosts: "\u4E3B\u673A\u914D\u7F6E\u5DF2\u5BFC\u51FA\u3002",
  importedHosts: "\u4E3B\u673A\u914D\u7F6E\u5DF2\u5BFC\u5165\uFF08\u65B0\u589E/\u66F4\u65B0/\u79FB\u9664\uFF09\uFF1A",
  importTrusted: "\u8BBE\u4E3A trust \u7684\u4E3B\u673A\uFF08\u547D\u4EE4\u4E0D\u518D\u8BE2\u95EE\uFF09\uFF1A"
};

// src/client/api.ts
var NS = "permission-remote";
var TRANSFER_MAX_BYTES_DEFAULT = 32 * 1024 * 1024;
var TRANSFER_TIMEOUT_MS_DEFAULT = 12e4;
function transferLimit(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}
async function readHosts(ctx) {
  const response = await ctx.remote.settings.describe();
  const described = response.value ?? response;
  const namespaces = described.namespaces ?? [];
  const row = namespaces.find((item) => item.ns === NS);
  const listed = Array.isArray(row?.value?.hosts) ? row.value.hosts : [];
  const hosts = listed.map((host) => ({ ...host, loginEnv: host.loginEnv === true }));
  const tagWorkspaceTitles = row?.value?.tagWorkspaceTitles !== false;
  const rgRegistry = typeof row?.value?.rgRegistry === "string" ? row.value.rgRegistry : "";
  const remoteRoot = typeof row?.value?.remoteRoot === "string" ? row.value.remoteRoot : "";
  const transferMaxBytes = transferLimit(row?.value?.transferMaxBytes, TRANSFER_MAX_BYTES_DEFAULT);
  const transferTimeoutMs = transferLimit(row?.value?.transferTimeoutMs, TRANSFER_TIMEOUT_MS_DEFAULT);
  return { hosts, tagWorkspaceTitles, rgRegistry, remoteRoot, transferMaxBytes, transferTimeoutMs, revision: row?.revision ?? 0 };
}
async function writeTagWorkspaceTitles(ctx, enabled, revision) {
  await ctx.remote.settings.mutate(NS, [{ op: "set", path: ["tagWorkspaceTitles"], value: enabled }], revision);
}
async function writeRgRegistry(ctx, registry, revision) {
  await ctx.remote.settings.mutate(NS, [{ op: "set", path: ["rgRegistry"], value: registry }], revision);
}
async function writeTransferLimits(ctx, maxBytes, timeoutMs, revision) {
  await ctx.remote.settings.mutate(NS, [
    { op: "set", path: ["transferMaxBytes"], value: wholeLimit(maxBytes) },
    { op: "set", path: ["transferTimeoutMs"], value: wholeLimit(timeoutMs) }
  ], revision);
}
function wholeLimit(value) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
async function purgeHost(ctx, hostId) {
  const result = await callHost(ctx, "purgeHost", { hostId });
  return { workspaces: result.workspaces ?? 0 };
}
async function installRipgrep(ctx, hostId) {
  return callHost(ctx, "installRipgrep", { hostId });
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
  return {
    items: Array.isArray(listed.items) ? listed.items : [],
    deleted: Array.isArray(listed.deleted) ? listed.deleted : []
  };
}
async function readRemoteRootInfo(ctx) {
  return callHost(ctx, "remoteRootInfo");
}
async function changeRemoteRoot(ctx, root, options) {
  return callHost(ctx, "changeRemoteRoot", {
    root,
    strategy: options?.strategy,
    force: options?.force === true,
    // The list the page showed. A conflict that was not on it is asked again.
    conflicts: options?.conflicts
  });
}
async function exportHosts(ctx) {
  return callHost(ctx, "exportHosts");
}
async function importHosts(ctx, payload, mode) {
  return callHost(ctx, "importHosts", { payload, mode });
}

// src/client/draft.ts
var DEFAULT_PORT = 22;
function toDraft(host) {
  return {
    id: host.id,
    name: host.name,
    host: host.host,
    port: String(host.port),
    username: host.username,
    auth: host.auth,
    privateKeyPath: host.privateKeyPath,
    opsPolicy: host.opsPolicy,
    loginEnv: host.loginEnv === true
  };
}
function blankDraft() {
  return {
    id: "",
    name: "",
    host: "",
    port: String(DEFAULT_PORT),
    username: "",
    auth: "key",
    privateKeyPath: "",
    opsPolicy: "ask",
    loginEnv: false
  };
}
function draftPort(draft) {
  return Number(draft.port) || DEFAULT_PORT;
}
function draftPortValid(draft) {
  const port = Number(draft.port);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}
function mergeEditedHost(latest, form) {
  const port = draftPort(form);
  const moved = latest !== void 0 && (latest.host !== form.host || latest.port !== port);
  return {
    id: latest?.id ?? form.id,
    name: form.name,
    host: form.host,
    port,
    username: form.username,
    auth: form.auth,
    privateKeyPath: form.privateKeyPath,
    fingerprint: moved ? "" : latest?.fingerprint ?? "",
    opsPolicy: form.opsPolicy,
    loginEnv: form.loginEnv === true
  };
}
function createTarget(browsing, listed) {
  return browsing.length > 0 && listed ? browsing : null;
}
function filterEntries(entries, query) {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return entries;
  return entries.filter((entry) => entry.name.toLowerCase().includes(needle));
}
function isPathQuery(query) {
  const text = query.trim();
  return text === ".." || text.startsWith("~") || text.includes("/");
}
function splitPath(text) {
  const raw = text.trim();
  const trimmed = raw.replace(/\/+$/, "");
  if (trimmed.length === 0) return { base: "/", needle: "" };
  if (raw.endsWith("/")) return { base: trimmed, needle: "" };
  if (trimmed.startsWith("~") && trimmed.indexOf("/") < 0) return { base: trimmed, needle: "" };
  const slash = trimmed.lastIndexOf("/");
  const last = slash < 0 ? trimmed : trimmed.slice(slash + 1);
  if (last === "." || last === "..") return { base: trimmed, needle: "" };
  return { base: slash < 0 ? "" : trimmed.slice(0, slash), needle: last };
}
function resolveUnder(base, origin) {
  const text = base.trim();
  if (text.length === 0 || text === ".") return origin;
  if (text === "~" || text.startsWith("~/")) {
    const parts = normalizeSegments(text.slice(1), false);
    return parts.length === 0 ? "~" : `~/${parts.join("/")}`;
  }
  if (text.startsWith("~")) return text;
  if (text.startsWith("/")) return absolutePath(text);
  return absolutePath(`${origin.replace(/\/+$/, "")}/${text}`);
}
function joinPath(base, name) {
  const raw = base.trim();
  const text = raw.replace(/\/+$/, "");
  if (text.length === 0) return raw.startsWith("/") ? `/${name}/` : `${name}/`;
  return `${text}/${name}/`;
}
function matchRange(name, needle) {
  const text = needle.trim().toLowerCase();
  if (text.length === 0) return null;
  const at = name.toLowerCase().indexOf(text);
  return at < 0 ? null : [at, at + text.length];
}
function pickCompletion(input) {
  if (input.highlighted >= 0) return input.highlighted;
  if (input.needle.trim().length === 0) return "none";
  if (input.visibleCount === 1) return 0;
  if (input.exact >= 0) return input.exact;
  return "missing";
}
function absolutePath(text) {
  const parts = normalizeSegments(text, true);
  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}
function normalizeSegments(text, absolute) {
  const out = [];
  for (const part of text.split("/")) {
    if (part.length === 0 || part === ".") continue;
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
      continue;
    }
    out.push(part);
  }
  return out;
}
function clampActive(current, count) {
  if (count <= 0) return -1;
  if (current < 0) return -1;
  return Math.min(current, count - 1);
}
function stepActive(current, delta, count) {
  if (count <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : count - 1;
  return Math.min(Math.max(current + delta, 0), count - 1);
}
function parentDir(dir) {
  const trimmed = dir.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  if (slash <= 0) return "/";
  return trimmed.slice(0, slash);
}

// src/client/import-risk.ts
function importNeedsConfirm(payload, current) {
  const byId = new Map(current.map((host) => [host.id, host]));
  for (const row of hostRows(payload)) {
    if (typeof row.id !== "string") continue;
    const existing = byId.get(row.id);
    if (existing === void 0) continue;
    if (owns(row, "host") && typeof row.host === "string" && row.host.trim() !== existing.host.trim()) return true;
    if (!owns(row, "opsPolicy")) continue;
    if (row.opsPolicy === "trust" && existing.opsPolicy !== "trust") return true;
    if (row.opsPolicy === "ask" && existing.opsPolicy === "deny") return true;
  }
  return false;
}
function hostRows(payload) {
  const rows = Array.isArray(payload) ? payload : typeof payload === "object" && payload !== null && Array.isArray(payload.hosts) ? payload.hosts : [];
  return rows.filter((row) => typeof row === "object" && row !== null);
}
function owns(row, key) {
  return Object.prototype.hasOwnProperty.call(row, key);
}

// src/client/root-prompt.ts
function rootPromptFor(result, force) {
  if (result.status === "has-sessions") {
    return { prompt: { kind: "sessions", root: result.root, sessions: result.sessions ?? 0 }, force: false };
  }
  if (result.status === "needs-strategy") {
    return { prompt: { kind: "conflicts", root: result.root, conflicts: result.conflicts ?? [] }, force };
  }
  return { prompt: null, force: false };
}

// src/client/styles.ts
var PLUGIN_ID = "dsh-permission-remote";
var CSS = `
/* The main-panel wrapper: the centre column is the whole panel, so the scroll
   box and the desktop title-bar clearance belong here, not to the settings
   card the page was written as. */
.dsh-ssh-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: auto;
  box-sizing: border-box;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  padding: calc(24px + var(--dsh-frame-top-clearance, 0px)) 28px 32px max(28px, var(--dsh-frame-leading-clearance, 0px));
}
.dsh-ssh-panel-inner {
  width: 100%;
  max-width: 960px;
  min-width: 0;
  margin: 0 auto;
}
/* In the panel the page is the only thing on screen, so it may use the full
   inner width; the settings shell keeps its narrower card. */
.dsh-ssh-panel .dsh-ssh-page {
  max-width: none;
}
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
.dsh-ssh-registry {
  display: flex;
  align-items: flex-end;
  flex-wrap: wrap;
  gap: 8px;
}
.dsh-ssh-registry > .dsh-ssh-field {
  flex: 1 1 240px;
}
.dsh-ssh-registry > .dsh-ssh-note {
  flex-basis: 100%;
}
/* Inline action inside a meta line: reads as a link, not a card button. */
.dsh-ssh-link {
  appearance: none;
  border: 0;
  background: transparent;
  padding: 0;
  margin-left: 8px;
  color: var(--dsw-alias-brand-primary);
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
}
.dsh-ssh-link:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
.dsh-ssh-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
}
.dsh-ssh-tab {
  appearance: none;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 13px;
  padding: 6px 10px;
  /* A transparent underline reserves the space so switching tabs does not
     shift the text, and the negative margin lets the active line sit exactly
     on the container rule instead of floating above it. */
  border: 0;
  border-bottom: 2px solid transparent; /* after border:0, so it survives */
  border-radius: 0;
  margin-bottom: -1px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.dsh-ssh-tab:hover:not([data-active]) {
  color: var(--dsw-alias-label-primary);
}
/* An underline only. A filled pill read as a heavy control sitting on a page
   that is otherwise flat, and the theme's layer backgrounds are all one white
   in its light variant so a fill could not carry the state anyway. */
.dsh-ssh-tab[data-active] {
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
  border-bottom-color: var(--dsw-alias-brand-primary);
}
.dsh-ssh-danger {
  color: var(--dsw-alias-state-warn-label);
  border-color: var(--dsw-alias-state-warn-label);
}
.dsh-ssh-danger-note {
  color: var(--dsw-alias-state-warn-label);
}
/* The paths a merge would leave alone: monospace and wrappable so a long name
   stays readable beside the strategy buttons. */
.dsh-ssh-conflict-list {
  margin: 2px 0;
  color: var(--dsw-alias-label-secondary);
  font-family: var(--ds-font-family-code, ui-monospace, monospace);
  font-size: 12px;
  line-height: 18px;
  word-break: break-all;
}
/* Title and its action read as one group on the left rather than the button
   floating at the far edge of a wide settings page. */
/* The add button only exists on the hosts tab, and it is taller than the title
   alone; a fixed row height keeps the content below from shifting when the tab
   changes. */
.dsh-ssh-header {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 10px;
  min-height: 28px;
}
/* The way back sits at the far end, away from Add host, so the header keeps
   its grouping and the button is not one mis-click from adding a host. */
.dsh-ssh-close-panel {
  margin-left: auto;
}
/* The add/edit form is a modal so it never sits between the host list and the
   page bottom. The backdrop pseudo-element dims the list without unmounting it. */
.dsh-ssh-dialog {
  margin: auto;
  padding: 0;
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  border-radius: var(--dsw-radius-xl);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  max-width: min(560px, calc(100vw - 32px));
  max-height: calc(100vh - 64px);
  overflow-y: auto;
  box-shadow: 0 24px 64px rgb(0 0 0 / 32%);
}
.dsh-ssh-dialog::backdrop {
  background: rgb(0 0 0 / 32%);
}
.dsh-ssh-dialog > .dsh-ssh-card {
  border: 0;
  border-radius: 0;
  background: transparent;
}
.dsh-ssh-dialog-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.dsh-ssh-close {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 20px;
  line-height: 1;
  padding: 2px 6px;
  border-radius: var(--dsw-radius-sm);
  cursor: pointer;
}
.dsh-ssh-close:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dsh-ssh-close:disabled {
  cursor: not-allowed;
  opacity: 0.5;
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
/* The row holding the open picker: a brand edge ties the card to its host, so
   scrolling a long list cannot make it look attached to a neighbour. */
.dsh-ssh-host[data-browsing="true"] {
  border-color: var(--dsw-alias-brand-primary);
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
.dsh-ssh-banner {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 42ch;
}
.dsh-ssh-status-row {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 12px;
}
/* Sits directly under the host row it belongs to, so the offer stays visible
   while the operator works on that host instead of at the page bottom. */
.dsh-ssh-trust {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 12px;
  padding: 10px 12px;
  border-radius: var(--dsw-radius-lg);
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  background: var(--dsw-alias-bg-layer-2);
}
.dsh-ssh-fingerprint {
  font-family: var(--ds-font-family-code, ui-monospace, monospace);
  font-size: 12px;
  word-break: break-all;
  padding: 2px 6px;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-layer-3);
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
/* In a tab the count is a quiet hint, not a pill; the filled variant was the
   heaviest thing in an otherwise flat tab row. */
.dsh-ssh-tab .dsh-ssh-count {
  min-width: 0;
  padding: 0;
  background: transparent;
  line-height: inherit;
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
.dsh-ssh-toggle {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 13px;
  line-height: 20px;
}
.dsh-ssh-toggle input {
  width: 14px;
  height: 14px;
  margin: 0;
  accent-color: var(--dsw-alias-brand-primary);
}
.dsh-ssh-toggle .dsh-ssh-note {
  flex-basis: 100%;
  padding-left: 22px;
}
.dsh-ssh-deleted {
  display: flex;
  flex-direction: column;
  gap: 8px;
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
  color: var(--dsw-alias-label-primary-inverted, #fff);
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
/* The picker renders inside the host card, so it is a sunken section of that
   card rather than a second card: a nested card border read as an unrelated
   panel, and its own padding pushed the listing down. */
.dsh-ssh-browser {
  display: flex;
  flex-direction: column;
  gap: 10px;
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-layer-1);
  padding: 12px;
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
.dsh-ssh-browser-tools {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.dsh-ssh-browser-host {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-ssh-browser-filter {
  display: flex;
  align-items: center;
  gap: 8px;
}
.dsh-ssh-search {
  /* The shared input rule is width: 100%, which in this flex row would push the
     match count out of view; the filter row sizes the box instead. */
  width: auto;
  flex: 1 1 auto;
  min-width: 0;
  height: 28px;
  font-size: 12px;
}
/* The count and the hint share the end of the row: the count answers "how many
   match" while typing, the hint says where Tab and "/" go while the box is
   empty. One slot, sized by its content, so the box never jumps. */
.dsh-ssh-filter-count {
  flex: none;
  color: var(--dsw-alias-label-tertiary);
  font-family: var(--ds-font-family-code, ui-monospace, monospace);
  font-size: 11px;
  line-height: 18px;
  white-space: nowrap;
}
/* Where Tab and "/" go, said while the box is empty. It is also the box's
   aria-describedby target, so the same sentence reaches a screen reader. */
.dsh-ssh-filter-hint {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 18px;
}
/* The segment the rows below would add to. It says where the suggestions come
   from in the operator's own spelling, which the breadcrumb cannot: the box may
   read ~/src while the breadcrumb shows the resolved /home/me/src. */
.dsh-ssh-complete {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 18px;
}
.dsh-ssh-complete-label {
  flex: none;
  white-space: nowrap;
}
.dsh-ssh-complete-base,
.dsh-ssh-complete-needle {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--ds-font-family-code, ui-monospace, monospace);
  font-size: 12px;
}
/* The part still being typed is the emphasised one: it is what the next row
   adds to, and it matches the highlight inside the row names. */
.dsh-ssh-complete-needle {
  color: var(--dsw-alias-label-primary);
  font-weight: 600;
}
/* A failed listing belongs under the box that asked for it, not at page top. */
.dsh-ssh-browser-error {
  margin: 0;
  color: var(--dsw-alias-state-warn-label);
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}
/* Inline create row: it sits between the filter and the listing so the names
   already on screen stay visible while the operator picks one that is free. */
.dsh-ssh-newfolder {
  display: flex;
  align-items: center;
  gap: 8px;
}
.dsh-ssh-newfolder-input {
  flex: 1 1 auto;
  min-width: 0;
  height: 28px;
  font-size: 12px;
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
/* Keyboard highlight: an outline keeps it distinct from a hovered row, and it
   still applies while a listing loads and the rows are :disabled. */
.dsh-ssh-dir[data-active="true"] {
  background: var(--dsw-alias-interactive-bg-hover);
  outline: 1px solid var(--dsw-alias-brand-primary);
  outline-offset: -1px;
}
.dsh-ssh-dir:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
/* A loading listing still shows which row Enter would open, so the outline
   must not be dimmed away with the rest of the disabled row. */
.dsh-ssh-dir[data-active="true"]:disabled {
  opacity: 1;
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
/* While a query is typed, the match is what the row contributes to the box and
   the rest is context, so only the match keeps the row's normal weight. */
.dsh-ssh-dir-match {
  color: var(--dsw-alias-label-primary);
  font-weight: 600;
}
.dsh-ssh-dir-rest {
  color: var(--dsw-alias-label-secondary);
}
.dsh-ssh-empty {
  padding: 8px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}
/*
 * A host row's non-default settings. They are named only when they differ from
 * the defaults, so the one host that runs remote calls without approval is not
 * hidden among nine that say "Ask each time". Clicking opens the edit dialog,
 * where both settings live with their explanations.
 */
.dsh-ssh-badges {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
}
.dsh-ssh-badge,
.dsh-ssh-badge-action {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 8px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
.dsh-ssh-badge[data-tone="warn"] {
  border-color: var(--dsw-alias-state-warn-label);
  color: var(--dsw-alias-state-warn-label);
}
.dsh-ssh-badge:disabled,
.dsh-ssh-badge-action:disabled {
  cursor: default;
  opacity: 0.6;
}
.dsh-ssh-badge-action {
  border-style: dashed;
  color: var(--dsw-alias-label-tertiary);
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
var TRANSFER_TIMEOUT_MS_MAX = 2 ** 31 - 1;
var PANEL_ID = "permission-remote";
var TABS = [
  { id: "hosts", label: "tabHosts" },
  { id: "deleted", label: "tabDeleted" },
  { id: "settings", label: "tabSettings" },
  { id: "help", label: "tabHelp" }
];
var MANUAL = [
  // Match the installer's `;` on purpose: a broken third-party apt source makes
  // `apt-get update` fail forever, and `&&` would then skip the install.
  { title: "Debian/Ubuntu", command: "sudo apt-get update; sudo apt-get install -y bubblewrap" },
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
  ctx.effect(() => ctx.slots.inject("main", () => ctx.slots.register({
    name: "main",
    key: PANEL_ID,
    locale: NS2,
    inject: () => ({ ctx, onClose: closePanel })
  }, PanelPage)), "dsh-permission-remote: main panel");
  ctx.effect(() => ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
    name: "sidebar.panellist",
    id: PANEL_ID,
    // Plugins is 0 and the task manager 10; sit after them, before the rest.
    order: 30,
    label: () => nav("panel"),
    locale: NS2
  }, PanelIcon)), "dsh-permission-remote: sidebar panel");
  function closePanel() {
    const layout = typeof ctx.get === "function" ? ctx.get("layout") : void 0;
    const select = layout?.selectPanel;
    if (typeof select === "function") select.call(layout, null);
  }
}
function PanelIcon({ size }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 16 16",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "1",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
      focusable: "false",
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("rect", { x: "1.5", y: "1.5", width: "13", height: "5", rx: "1.5" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("rect", { x: "1.5", y: "9.5", width: "13", height: "5", rx: "1.5" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M4 4h.01M4 12h.01M6.5 4h2M6.5 12h2" })
      ]
    }
  );
}
function PanelPage(props) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-ssh-panel", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-ssh-panel-inner", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Section, { ...props }) }) });
}
function Section(props) {
  const { ctx, t } = props;
  const panel = typeof props.onClose === "function";
  const [hosts, setHosts] = (0, import_react.useState)([]);
  const [draft, setDraft] = (0, import_react.useState)(blankDraft());
  const [formOpen, setFormOpen] = (0, import_react.useState)(false);
  const dialogRef = (0, import_react.useRef)(null);
  const [secret, setSecret] = (0, import_react.useState)("");
  const [message, setMessage] = (0, import_react.useState)("");
  const [tone, setTone] = (0, import_react.useState)("ok");
  const [browsing, setBrowsing] = (0, import_react.useState)("");
  const [listed, setListed] = (0, import_react.useState)(false);
  const [status, setStatus] = (0, import_react.useState)(null);
  const [installLog, setInstallLog] = (0, import_react.useState)(null);
  const [dir, setDir] = (0, import_react.useState)("/");
  const [entries, setEntries] = (0, import_react.useState)([]);
  const [filter, setFilter] = (0, import_react.useState)("");
  const [pathMode, setPathMode] = (0, import_react.useState)(false);
  const [origin, setOrigin] = (0, import_react.useState)("/");
  const [shown, setShown] = (0, import_react.useState)(null);
  const [baseError, setBaseError] = (0, import_react.useState)(null);
  const [pathError, setPathError] = (0, import_react.useState)("");
  const [active, setActive] = (0, import_react.useState)(-1);
  const [newFolder, setNewFolder] = (0, import_react.useState)(null);
  const newFolderRef = (0, import_react.useRef)(null);
  const searchRef = (0, import_react.useRef)(null);
  const rowRefs = (0, import_react.useRef)([]);
  const known = (0, import_react.useRef)(null);
  const panelRef = (0, import_react.useRef)(null);
  const [busy, setBusy] = (0, import_react.useState)(false);
  const [pendingTrust, setPendingTrust] = (0, import_react.useState)(null);
  const [workspaces, setWorkspaces] = (0, import_react.useState)([]);
  const [deleted, setDeleted] = (0, import_react.useState)([]);
  const [openWorkspaces, setOpenWorkspaces] = (0, import_react.useState)({});
  const [tagTitles, setTagTitles] = (0, import_react.useState)(true);
  const [rgRegistry, setRgRegistry] = (0, import_react.useState)("");
  const [transferMaxDraft, setTransferMaxDraft] = (0, import_react.useState)("");
  const [transferTimeoutDraft, setTransferTimeoutDraft] = (0, import_react.useState)("");
  const [rootInfo, setRootInfo] = (0, import_react.useState)(null);
  const [rootDraft, setRootDraft] = (0, import_react.useState)("");
  const [rootPrompt, setRootPrompt] = (0, import_react.useState)(null);
  const rootForceRef = (0, import_react.useRef)(false);
  const [importConfirm, setImportConfirm] = (0, import_react.useState)(false);
  const [importRisk, setImportRisk] = (0, import_react.useState)(null);
  const importInputRef = (0, import_react.useRef)(null);
  const importModeRef = (0, import_react.useRef)("merge");
  const [revision, setRevision] = (0, import_react.useState)(0);
  const [tab, setTab] = (0, import_react.useState)("hosts");
  const [purgeTarget, setPurgeTarget] = (0, import_react.useState)("");
  async function reload() {
    const loaded = await readHosts(ctx);
    setHosts(loaded.hosts);
    setTagTitles(loaded.tagWorkspaceTitles);
    setRgRegistry(loaded.rgRegistry);
    setTransferMaxDraft(String(loaded.transferMaxBytes));
    setTransferTimeoutDraft(String(loaded.transferTimeoutMs));
    setRootDraft(loaded.remoteRoot);
    setRevision(loaded.revision);
    return loaded.hosts;
  }
  async function reloadRoot() {
    try {
      setRootInfo(await readRemoteRootInfo(ctx));
    } catch {
      setRootInfo(null);
    }
  }
  async function toggleTagTitles(enabled) {
    setBusy(true);
    try {
      await writeTagWorkspaceTitles(ctx, enabled, revision);
      setTagTitles(enabled);
      const saved = await readHosts(ctx);
      setRevision(saved.revision);
      if (enabled) {
        const tagged = await callHost(ctx, "tagWorkspaces", {});
        const changed = tagged.changed ?? 0;
        note(changed > 0 ? `${changed} ${t("titlesUpdated")}` : t("tagToggleSaved"));
      } else {
        note(t("tagToggleSaved"));
      }
      await reloadWorkspaces();
    } catch (error) {
      await reload().catch(() => void 0);
      fail(error);
    } finally {
      setBusy(false);
    }
  }
  function applyTagged(tagged) {
    if (Array.isArray(tagged.items)) setWorkspaces(tagged.items);
    if (Array.isArray(tagged.deleted)) setDeleted(tagged.deleted);
    return tagged.changed ?? 0;
  }
  async function reloadWorkspaces() {
    const listed2 = await readWorkspaces(ctx);
    setWorkspaces(listed2.items);
    setDeleted(listed2.deleted);
  }
  (0, import_react.useEffect)(() => {
    void reload().catch((error) => fail(error));
    void reloadRoot();
    void reloadWorkspaces().catch(() => setWorkspaces([]));
  }, []);
  (0, import_react.useEffect)(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (formOpen && !dialog.open) dialog.showModal();
    if (!formOpen && dialog.open) dialog.close();
  }, [formOpen]);
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
      const latest = hosts.find((item) => item.id === id);
      const next = mergeEditedHost(latest, { ...draft, id });
      const moved = latest !== void 0 && (latest.host !== next.host || latest.port !== next.port);
      await callHost(ctx, "saveHost", next);
      setDraft((current) => ({ ...current, id }));
      if (next.auth === "password" || secret.trim().length > 0) {
        await callHost(ctx, "saveSecret", {
          hostId: id,
          password: next.auth === "password" && secret.trim().length > 0 ? secret : void 0,
          passphrase: next.auth === "key" && secret.trim().length > 0 ? secret : void 0
        });
      }
      setSecret("");
      setDraft(blankDraft());
      setFormOpen(false);
      if (moved && status?.hostId === id) setStatus(null);
      await Promise.all([reload(), reloadWorkspaces()]);
      note(moved ? `${t("saved")} ${t("retrust")}` : t("saved"));
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }
  function beginAdd() {
    setDraft(blankDraft());
    setSecret("");
    setPendingTrust(null);
    setMessage("");
    setTone("ok");
    setFormOpen(true);
  }
  function beginEdit(host) {
    setDraft(toDraft(host));
    setSecret("");
    setPendingTrust(null);
    setMessage("");
    setTone("ok");
    setFormOpen(true);
  }
  function cancelEdit() {
    setDraft(blankDraft());
    setSecret("");
    setFormOpen(false);
  }
  async function test(host) {
    setBusy(true);
    setMessage("");
    setStatus(null);
    setPendingTrust(null);
    setInstallLog(null);
    try {
      const offered = await callHost(ctx, "testConnection", { hostId: host.id });
      if (!offered.trusted) {
        setPendingTrust({ hostId: host.id, fingerprint: offered.fingerprint });
        setMessage("");
        return;
      }
      setMessage("");
      setStatus({
        hostId: host.id,
        banner: offered.banner,
        runner: await callHost(ctx, "probe", { hostId: host.id, refresh: true })
      });
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }
  async function trust(host) {
    if (pendingTrust === null || pendingTrust.hostId !== host.id) return;
    setBusy(true);
    try {
      await callHost(ctx, "trustFingerprint", { hostId: host.id, fingerprint: pendingTrust.fingerprint });
      setPendingTrust(null);
      await reload();
      note(t("trusted"));
      setStatus({ hostId: host.id, banner: "", runner: await callHost(ctx, "probe", { hostId: host.id, refresh: true }) });
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }
  async function saveRegistry() {
    setBusy(true);
    try {
      await writeRgRegistry(ctx, rgRegistry.trim(), revision);
      const saved = await readHosts(ctx);
      setRgRegistry(saved.rgRegistry);
      setRevision(saved.revision);
      note(t("registrySaved"));
    } catch (error) {
      await reload().catch(() => void 0);
      fail(error);
    } finally {
      setBusy(false);
    }
  }
  async function saveTransferLimits() {
    const maxBytes = Number.parseInt(transferMaxDraft.trim(), 10);
    const timeoutMs = Number.parseInt(transferTimeoutDraft.trim(), 10);
    if (transferMaxDraft.trim().length > 0 && !Number.isFinite(maxBytes)) {
      note(t("transferLimitsInvalid"));
      return;
    }
    if (transferTimeoutDraft.trim().length > 0 && !Number.isFinite(timeoutMs)) {
      note(t("transferLimitsInvalid"));
      return;
    }
    if (Number.isFinite(timeoutMs) && timeoutMs > TRANSFER_TIMEOUT_MS_MAX) {
      note(`${t("transferLimitsClamped")} ${TRANSFER_TIMEOUT_MS_MAX}`);
    }
    setBusy(true);
    try {
      await writeTransferLimits(ctx, Number.isFinite(maxBytes) ? maxBytes : 0, Number.isFinite(timeoutMs) ? timeoutMs : 0, revision);
      const saved = await readHosts(ctx);
      setTransferMaxDraft(String(saved.transferMaxBytes));
      setTransferTimeoutDraft(String(saved.transferTimeoutMs));
      setRevision(saved.revision);
      note(saved.transferTimeoutMs === timeoutMs ? t("transferLimitsSaved") : `${t("transferLimitsClamped")} ${saved.transferTimeoutMs}`);
    } catch (error) {
      await reload().catch(() => void 0);
      fail(error);
    } finally {
      setBusy(false);
    }
  }
  async function saveRemoteRoot() {
    setBusy(true);
    setRootPrompt(null);
    rootForceRef.current = false;
    try {
      await applyRootResult(await changeRemoteRoot(ctx, rootDraft));
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }
  function relocationNote(result) {
    const moved = result.sessionsRelocated ?? 0;
    const skipped = result.sessionsSkippedLive ?? 0;
    const failed2 = result.sessionsFailed ?? 0;
    const reported = result.sessionsRelocated !== void 0 || result.sessionsSkippedLive !== void 0 || result.sessionsFailed !== void 0;
    if (!reported || moved === 0 && skipped === 0 && failed2 === 0) return "";
    const parts = [];
    if (moved > 0) {
      parts.push(`${t("remoteRootSessionsMoved")} ${moved}`);
      parts.push(t("remoteRootSessionsRegroup"));
    }
    if (skipped > 0) parts.push(t("remoteRootSessionsOpen"));
    if (failed2 > 0) parts.push(`${t("remoteRootSessionsFailed")} ${failed2}`);
    return ` \xB7 ${parts.join(" \xB7 ")}`;
  }
  async function applyRootResult(result) {
    if (result.status === "unchanged") {
      note(`${t("remoteRootUnchanged")}${relocationNote(result)}`);
      setRootDraft(result.root);
      await reloadRoot();
      return;
    }
    const next = rootPromptFor(result, rootForceRef.current);
    rootForceRef.current = next.force;
    if (next.prompt !== null) {
      setRootPrompt(next.prompt);
      return;
    }
    const migration = result.migration;
    const counts = [
      `${t("remoteRootCopied")} ${migration?.copied ?? 0}`,
      `${t("remoteRootSkipped")} ${migration?.skipped ?? 0}`,
      `${t("remoteRootOverwritten")} ${migration?.overwritten ?? 0}`,
      `${t("remoteRootRemapped")} ${result.workspacesRemapped ?? 0}`
    ].join(" \xB7 ");
    const left = migration?.conflicts.length ?? 0;
    note(`${t("remoteRootChanged")} ${result.oldRoot} \u2192 ${result.root} \xB7 ${counts}${left > 0 ? ` \xB7 ${t("remoteRootConflictsLeft")} ${left}` : ""}${relocationNote(result)}`);
    setRootDraft(result.root);
    await reloadRoot();
    await reloadWorkspaces().catch(() => void 0);
  }
  async function resolveRootPrompt(strategy) {
    if (rootPrompt === null) return;
    const target2 = rootPrompt.root;
    setBusy(true);
    try {
      const result = await changeRemoteRoot(ctx, target2, {
        strategy,
        force: rootForceRef.current,
        conflicts: rootPrompt.kind === "conflicts" ? rootPrompt.conflicts : void 0
      });
      setRootPrompt(null);
      await applyRootResult(result);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }
  async function doExport() {
    setBusy(true);
    try {
      const payload = await exportHosts(ctx);
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `dsh-ssh-hosts-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      note(t("exportedHosts"));
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }
  function trustCountOf(payload) {
    const rows2 = Array.isArray(payload) ? payload : typeof payload === "object" && payload !== null && Array.isArray(payload.hosts) ? payload.hosts : [];
    return rows2.filter((row) => typeof row === "object" && row !== null && row.opsPolicy === "trust").length;
  }
  function conflictPreview(paths) {
    const shown2 = paths.slice(0, 8);
    return `${shown2.join("  \xB7  ")}${paths.length > shown2.length ? `  \u2026 +${paths.length - shown2.length}` : ""}`;
  }
  function pickImport(mode) {
    importModeRef.current = mode;
    importInputRef.current?.click();
  }
  async function finishImport(payload, mode) {
    const result = await importHosts(ctx, payload, mode);
    await reload();
    await reloadWorkspaces().catch(() => void 0);
    const trusted = trustCountOf(payload);
    note(`${t("importedHosts")} +${result.added} ~${result.updated} -${result.removed}${trusted > 0 ? ` \xB7 ${t("importTrusted")} ${trusted}` : ""}`);
  }
  async function doImport(file) {
    setBusy(true);
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      const mode = importModeRef.current;
      if (importNeedsConfirm(payload, hosts)) {
        setImportRisk({ payload, mode });
        return;
      }
      setImportRisk(null);
      await finishImport(payload, mode);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }
  async function confirmImportRisk() {
    if (importRisk === null) return;
    const pending2 = importRisk;
    setImportRisk(null);
    setBusy(true);
    try {
      await finishImport(pending2.payload, pending2.mode);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }
  async function installRg(hostId) {
    setBusy(true);
    setInstallLog(null);
    try {
      const result = await installRipgrep(ctx, hostId);
      setStatus((current) => ({ hostId, banner: current?.hostId === hostId ? current.banner : "", runner: result.status }));
      const tag = `${result.platform} ${result.version}`;
      if (result.status.ripgrep === "uploaded") {
        setInstallLog({ hostId, text: `${t("rgInstalled")} ${tag} -> ${result.status.ripgrepPath}` });
        note(t("rgInstalled"));
      } else if (result.status.ripgrep === "upload-failed") {
        const text = `${t("rgUploadFailed")} (${tag})`;
        setInstallLog({ hostId, text });
        fail(text);
      } else {
        const text = `${t("rgStillMissing")} (${tag})`;
        setInstallLog({ hostId, text });
        fail(text);
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setInstallLog({ hostId, text });
      fail(text);
    } finally {
      setBusy(false);
    }
  }
  async function install(hostId) {
    setBusy(true);
    setInstallLog(null);
    try {
      const result = await callHost(ctx, "installDeps", { hostId });
      setStatus({ hostId, banner: "", runner: result.status });
      const ready = result.status.sandbox.available;
      const verdict = ready ? t("installOk") : result.ok ? t("installNoEffect") : t("installFailed");
      const exit = `exit ${result.code ?? "null"}`;
      const body = [result.stdout, result.stderr].filter(Boolean).join("\n");
      setInstallLog({ hostId, text: `${verdict} (${exit})
${body.length > 0 ? body : t("installNoOutput")}` });
      if (ready) note(t("installOk"));
      else if (result.ok) fail(t("installNoEffect"));
      else fail(t("installFailed"));
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setInstallLog({ hostId, text: `${t("installFailed")}
${text}` });
      fail(text);
    } finally {
      setBusy(false);
    }
  }
  async function rereadLoginEnv(hostId) {
    setBusy(true);
    try {
      await callHost(ctx, "refreshLoginEnv", { hostId });
      note(t("loginRereadNote"));
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
      if (browsing === hostId) closeBrowser();
      if (status?.hostId === hostId) setStatus(null);
      if (pendingTrust?.hostId === hostId) setPendingTrust(null);
      if (installLog?.hostId === hostId) setInstallLog(null);
      if (draft.id === hostId) cancelEdit();
      await Promise.all([reload(), reloadWorkspaces()]);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }
  async function listPath(hostId, path, options = {}) {
    try {
      const listed2 = await callHost(ctx, "listDir", { hostId, path, resolve: options.resolve === true });
      if (options.ifCurrent !== void 0 && !options.ifCurrent()) return { ok: true };
      setBrowsing(hostId);
      setDir(listed2.path);
      setEntries(listed2.entries);
      setListed(true);
      setShown(options.request ?? null);
      setPathError("");
      setBaseError(null);
      if (listed2.path !== dir || hostId !== browsing) {
        setActive(-1);
        if (options.keepQuery !== true) {
          editFilter("");
          setNewFolder(null);
        }
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error };
    }
  }
  async function browse(hostId, path) {
    setBusy(true);
    try {
      const listed2 = await listPath(hostId, path);
      if (!listed2.ok) failBrowse(hostId, path, listed2.error);
    } finally {
      setBusy(false);
    }
  }
  function editFilter(next) {
    setFilter(next);
    setPathMode(next.trim().length === 0 ? false : pathMode || isPathQuery(next));
    setActive(-1);
    setPathError("");
    if (next.trim().length === 0) setBaseError(null);
  }
  function acceptCompletion(base, entry) {
    const next = joinPath(base, entry.name);
    editFilter(next);
    searchRef.current?.focus();
    known.current = { request: resolveUnder(next, origin), path: entry.path };
    setTimeout(() => {
      const node = searchRef.current;
      node?.setSelectionRange(next.length, next.length);
    }, 0);
  }
  function describeListingError(path, error) {
    const text = error instanceof Error ? error.message : String(error);
    const reason = /no such file|not found|does not exist|permission denied/i.test(text) ? t("dirMissing") : text;
    return t("cannotOpen").replace("{path}", path).replace("{reason}", reason);
  }
  function failBrowse(hostId, path, error) {
    const message2 = describeListingError(path, error);
    if (browsing === hostId) {
      setPathError(message2);
      return;
    }
    fail(message2);
  }
  function navigate(hostId, path) {
    if (pathMode) editFilter("");
    void browse(hostId, path);
  }
  function closeBrowser() {
    setBrowsing("");
    setEntries([]);
    setDir("/");
    setListed(false);
    setFilter("");
    setPathMode(false);
    setOrigin("/");
    setShown(null);
    setBaseError(null);
    known.current = null;
    setActive(-1);
    setPathError("");
    setNewFolder(null);
  }
  async function createWorkspace(hostId, path) {
    setBusy(true);
    try {
      const created = await callHost(ctx, "createWorkspace", { hostId, path });
      note(`${t("workspaceCreated")} ${created.title ?? created.path}`);
      closeBrowser();
      await reloadWorkspaces();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }
  async function createFolder(hostId, path) {
    const name = (newFolder ?? "").trim();
    if (name.length === 0 || name.includes("/")) {
      fail(t("newFolderBadName"));
      return;
    }
    setBusy(true);
    try {
      const listed2 = await callHost(ctx, "createDir", { hostId, path, name });
      setEntries(listed2.entries);
      setNewFolder("");
      note(`${t("createdFolder")} ${name}`);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      fail(/exists/i.test(text) ? t("newFolderExists") : error);
    } finally {
      setBusy(false);
      newFolderRef.current?.focus();
    }
  }
  async function tagWorkspaces(hostId, workspaceId) {
    setBusy(true);
    try {
      const changed = applyTagged(await callHost(ctx, "tagWorkspaces", { hostId, workspaceId }));
      note(changed > 0 ? `${changed} ${t("titlesUpdated")}` : t("titlesUnchanged"));
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }
  async function removeWorkspace(hostId, workspaceId) {
    setBusy(true);
    try {
      const removed = await callHost(ctx, "removeWorkspace", { hostId, workspaceId });
      await reloadWorkspaces();
      note(removed.ok === false ? t("workspaceGone") : t("workspaceRemoved"));
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }
  function switchTab(next) {
    setTab(next);
    setPurgeTarget("");
    if (next === "hosts") return;
    setFormOpen(false);
    closeBrowser();
  }
  async function purgeHost2(hostId) {
    setBusy(true);
    try {
      const result = await purgeHost(ctx, hostId);
      setPurgeTarget("");
      await Promise.all([reload(), reloadWorkspaces()]);
      note(`${t("purgedHost")} ${result.workspaces}`);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }
  async function restoreHost(hostId) {
    setBusy(true);
    try {
      await callHost(ctx, "restoreHost", { hostId });
      await Promise.all([reload(), reloadWorkspaces()]);
      note(t("restoredHost"));
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }
  function onSearchKeyDown(event) {
    const count = visible.length;
    if (event.key === "Escape") {
      if (filter.length > 0) {
        event.preventDefault();
        editFilter("");
        return;
      }
      event.preventDefault();
      searchRef.current?.blur();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (count === 0) return;
      event.preventDefault();
      setActive((current) => stepActive(clampActive(current, count), event.key === "ArrowDown" ? 1 : -1, count));
      return;
    }
    if (event.key === "Enter") {
      if (busy || browsing.length === 0) return;
      event.preventDefault();
      if (context !== null) {
        if (!settled) return;
        const choice = pickCompletion({
          highlighted,
          visibleCount: count,
          exact: visible.findIndex((entry2) => entry2.name === context.needle),
          needle: context.needle
        });
        if (choice === "none") return;
        if (choice === "missing") {
          setPathError(t("cannotOpen").replace("{path}", filter.trim()).replace("{reason}", t("dirMissing")));
          return;
        }
        const entry = visible[choice];
        if (entry !== void 0) acceptCompletion(context.base, entry);
        return;
      }
      const highlightedEntry = highlighted >= 0 ? visible[highlighted] : void 0;
      if (highlightedEntry !== void 0) {
        void browse(browsing, highlightedEntry.path);
        return;
      }
      const only = visible[0];
      if (filter.trim().length > 0 && count === 1 && only !== void 0) void browse(browsing, only.path);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      if (count === 0) return;
      event.preventDefault();
      setActive(event.key === "Home" ? 0 : count - 1);
    }
  }
  const crumbs = dir.split("/").filter(Boolean);
  const context = pathMode ? splitPath(filter) : null;
  const request = context === null ? null : resolveUnder(context.base, origin);
  const settled = context === null || shown === request || shown === null && listed && dir === request;
  const rows = settled ? entries : [];
  const needle = context === null ? filter : context.needle;
  const visible = filterEntries(rows, needle);
  const highlighted = clampActive(active, visible.length);
  const namedPath = context === null || needle.length === 0 ? dir : void 0;
  const target = createTarget(browsing, listed && settled);
  const failed = baseError !== null && baseError.request === request;
  const errorText = pathError.length > 0 ? pathError : baseError !== null && baseError.request === request ? baseError.text : "";
  const pending = context !== null && !settled && !failed;
  (0, import_react.useEffect)(() => {
    function onKeyDown(event) {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      if (tab !== "hosts" || searchRef.current === null) return;
      const target2 = event.target;
      if (target2 instanceof HTMLElement) {
        const tag = target2.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target2.isContentEditable) return;
      }
      event.preventDefault();
      searchRef.current.focus();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [tab, browsing]);
  (0, import_react.useEffect)(() => {
    if (highlighted < 0) return;
    rowRefs.current[highlighted]?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);
  (0, import_react.useEffect)(() => {
    if (browsing.length === 0 || request === null) return;
    if (settled) {
      known.current = null;
      return;
    }
    const hostId = browsing;
    const wanted = request;
    const label = context !== null && context.base.length > 0 ? context.base : origin;
    const knownPath = known.current !== null && known.current.request === wanted ? known.current.path : null;
    if (knownPath !== null) known.current = null;
    let stale = false;
    const timer = setTimeout(() => {
      void listPath(hostId, knownPath ?? wanted, { resolve: knownPath === null, keepQuery: true, request: wanted, ifCurrent: () => !stale }).then((result) => {
        if (stale || result.ok) return;
        setBaseError({ request: wanted, text: describeListingError(label, result.error) });
      });
    }, knownPath === null ? 160 : 0);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [browsing, request, settled, dir, listed]);
  (0, import_react.useEffect)(() => {
    if (pathMode) return;
    setOrigin(dir);
  }, [pathMode, dir]);
  (0, import_react.useEffect)(() => {
    if (browsing.length === 0) return;
    panelRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [browsing]);
  (0, import_react.useEffect)(() => {
    if (browsing.length === 0) return;
    if (typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches) return;
    searchRef.current?.focus({ preventScroll: true });
  }, [browsing, dir]);
  const byHost = /* @__PURE__ */ new Map();
  for (const workspace of workspaces) {
    const rows2 = byHost.get(workspace.hostId);
    if (rows2 === void 0) byHost.set(workspace.hostId, [workspace]);
    else rows2.push(workspace);
  }
  const orphans = /* @__PURE__ */ new Map();
  for (const [hostId, rows2] of byHost) {
    if (hosts.every((host) => host.id !== hostId)) orphans.set(hostId, rows2);
  }
  for (const row of deleted) {
    if (hosts.every((host) => host.id !== row.id) && !orphans.has(row.id)) orphans.set(row.id, []);
  }
  const workspaceRow = (workspace) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", { className: "dsh-ssh-workspace", children: [
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
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ssh-button", disabled: busy, onClick: () => void removeWorkspace(workspace.hostId, workspace.workspaceId), children: t("unregister") })
    ] })
  ] }, workspace.workspaceId);
  function renderBrowser(host) {
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-ssh-browser", ref: panelRef, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-ssh-browser-head", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-ssh-browser-heading", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-ssh-legend", children: t("directory") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-ssh-browser-host", children: host.name || host.host })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-ssh-browser-tools", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-ssh-inline", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ssh-button", disabled: busy || dir === "/", onClick: () => navigate(host.id, parentDir(dir)), children: t("up") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ssh-button", disabled: busy, onClick: () => navigate(host.id, dir), children: t("refresh") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "button",
              {
                type: "button",
                className: "dsh-ssh-button",
                "aria-expanded": newFolder !== null,
                disabled: busy || !listed || !settled,
                title: settled ? void 0 : t("pathIncomplete"),
                onClick: () => {
                  if (newFolder !== null) {
                    setNewFolder(null);
                    return;
                  }
                  setNewFolder("");
                  setTimeout(() => newFolderRef.current?.focus(), 0);
                },
                children: t("newFolder")
              }
            ),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "button",
              {
                type: "button",
                className: "dsh-ssh-button",
                "data-primary": "true",
                disabled: busy || target === null || namedPath === void 0,
                title: namedPath === void 0 ? t("pathIncomplete") : void 0,
                onClick: () => {
                  if (target !== null && namedPath !== void 0) void createWorkspace(target, namedPath);
                },
                children: t("createWorkspace")
              }
            )
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ssh-close", "aria-label": t("closeBrowser"), title: t("closeBrowser"), disabled: busy, onClick: closeBrowser, children: "\xD7" })
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-ssh-breadcrumb", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ssh-crumb", disabled: busy, onClick: () => navigate(host.id, "/"), children: "/" }),
        crumbs.map((name, index) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dsh-ssh-crumb-part", children: [
          index > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-ssh-crumb-sep", children: "/" }) : null,
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ssh-crumb", disabled: busy, onClick: () => navigate(host.id, `/${crumbs.slice(0, index + 1).join("/")}`), children: name })
        ] }, `${name}-${index}`))
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-ssh-browser-filter", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "input",
          {
            ref: searchRef,
            className: "dsh-ssh-input dsh-ssh-search",
            type: "search",
            role: "combobox",
            "aria-expanded": "true",
            "aria-controls": "dsh-ssh-dirs",
            "aria-autocomplete": "list",
            "aria-activedescendant": highlighted >= 0 ? `dsh-ssh-dir-${highlighted}` : void 0,
            value: filter,
            "aria-label": t("filter"),
            "aria-describedby": context !== null && needle.length > 0 ? "dsh-ssh-complete" : "dsh-ssh-filter-hint",
            placeholder: t("filterPlaceholder"),
            autoComplete: "off",
            spellCheck: false,
            onChange: (event) => editFilter(event.target.value),
            onKeyDown: onSearchKeyDown
          }
        ),
        settled && needle.trim().length > 0 && entries.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dsh-ssh-filter-count", children: [
          visible.length,
          " / ",
          entries.length
        ] }) : filter.trim().length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-ssh-filter-hint", id: "dsh-ssh-filter-hint", children: t("filterHint") }) : null
      ] }),
      context !== null && needle.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { className: "dsh-ssh-complete", id: "dsh-ssh-complete", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-ssh-complete-label", children: t("pathComplete") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { className: "dsh-ssh-complete-base", children: context.base.length === 0 ? "./" : `${context.base}/` }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { className: "dsh-ssh-complete-needle", children: needle })
      ] }) : null,
      errorText.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dsh-ssh-browser-error", role: "status", children: errorText }) : null,
      newFolder !== null ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
        "form",
        {
          className: "dsh-ssh-newfolder",
          onSubmit: (event) => {
            event.preventDefault();
            void createFolder(host.id, dir);
          },
          children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "input",
              {
                ref: newFolderRef,
                className: "dsh-ssh-input dsh-ssh-newfolder-input",
                type: "text",
                value: newFolder,
                "aria-label": t("newFolderName"),
                placeholder: t("newFolderPlaceholder"),
                autoComplete: "off",
                spellCheck: false,
                disabled: busy,
                onChange: (event) => setNewFolder(event.target.value),
                onKeyDown: (event) => {
                  if (event.key !== "Escape") return;
                  event.preventDefault();
                  setNewFolder(null);
                  searchRef.current?.focus();
                }
              }
            ),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "submit", className: "dsh-ssh-button", "data-primary": "true", disabled: busy || newFolder.trim().length === 0 || newFolder.includes("/"), children: t("newFolderCreate") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ssh-button", disabled: busy, onClick: () => {
              setNewFolder(null);
              searchRef.current?.focus();
            }, children: t("newFolderCancel") })
          ]
        }
      ) : null,
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
        "ul",
        {
          id: "dsh-ssh-dirs",
          className: "dsh-ssh-dirs",
          role: "listbox",
          "aria-label": t("directory"),
          "aria-busy": pending,
          onKeyDown: (event) => {
            if (event.key !== "Escape" && event.key !== "Backspace") return;
            event.preventDefault();
            searchRef.current?.focus();
          },
          children: [
            visible.map((entry, index) => {
              const range = matchRange(entry.name, needle);
              return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("li", { role: "none", children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
                "button",
                {
                  ref: (node) => {
                    rowRefs.current[index] = node;
                  },
                  id: `dsh-ssh-dir-${index}`,
                  type: "button",
                  role: "option",
                  "aria-selected": index === highlighted,
                  className: "dsh-ssh-dir",
                  "data-active": index === highlighted ? "true" : void 0,
                  disabled: busy,
                  onClick: () => {
                    if (context === null) void browse(host.id, entry.path);
                    else acceptCompletion(context.base, entry);
                  },
                  onFocus: () => setActive(index),
                  onMouseEnter: () => setActive(index),
                  children: [
                    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-ssh-dir-icon", "aria-hidden": "true", children: "\u25B8" }),
                    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-ssh-dir-name", children: range === null ? entry.name : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
                      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-ssh-dir-rest", children: entry.name.slice(0, range[0]) }),
                      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-ssh-dir-match", children: entry.name.slice(range[0], range[1]) }),
                      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-ssh-dir-rest", children: entry.name.slice(range[1]) })
                    ] }) })
                  ]
                }
              ) }, entry.path);
            }),
            pending ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("li", { className: "dsh-ssh-empty", children: t("pathLoading").replace("{path}", context !== null && context.base.length > 0 ? context.base : origin) }) : null,
            settled && entries.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("li", { className: "dsh-ssh-empty", children: t("emptyDir") }) : null,
            settled && entries.length > 0 && visible.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("li", { className: "dsh-ssh-empty", children: t("noMatch") }) : null
          ]
        }
      )
    ] });
  }
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "dsh-ssh-page", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-ssh-header", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", { className: "dsh-ssh-title", children: t("title") }),
      tab === "hosts" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ssh-button", disabled: busy, onClick: beginAdd, children: t("addHost") }) : null,
      panel ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ssh-button dsh-ssh-close-panel", onClick: () => props.onClose?.(), children: t("backToSession") }) : null
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("nav", { className: "dsh-ssh-tabs", role: "tablist", children: TABS.map((item) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
      "button",
      {
        type: "button",
        role: "tab",
        className: "dsh-ssh-tab",
        "aria-selected": tab === item.id,
        "data-active": tab === item.id ? "true" : void 0,
        onClick: () => switchTab(item.id),
        children: [
          t(item.label),
          item.id === "hosts" && hosts.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-ssh-count", children: hosts.length }) : null,
          item.id === "deleted" && orphans.size > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-ssh-count", children: orphans.size }) : null
        ]
      },
      item.id
    )) }),
    message.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dsh-ssh-status", "data-tone": tone === "warn" ? "warn" : void 0, children: message }) : null,
    tab === "hosts" ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dsh-ssh-intro", children: t("description") }),
      hosts.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", { className: "dsh-ssh-hosts", children: hosts.map((host) => {
        const owned = byHost.get(host.id) ?? [];
        const expanded = openWorkspaces[host.id] ?? true;
        return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", { className: "dsh-ssh-host", "data-editing": draft.id === host.id ? "true" : void 0, "data-browsing": browsing === host.id ? "true" : void 0, children: [
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
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ssh-button", disabled: busy, onClick: () => beginEdit(host), children: t("edit") }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ssh-button", disabled: busy, onClick: () => void test(host), children: t("test") }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                "button",
                {
                  type: "button",
                  className: "dsh-ssh-button",
                  "aria-expanded": browsing === host.id,
                  disabled: busy,
                  onClick: () => {
                    if (browsing === host.id) closeBrowser();
                    else void browse(host.id, "/");
                  },
                  children: t("browse")
                }
              ),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ssh-button", disabled: busy, onClick: () => void removeHost(host.id), children: t("remove") })
            ] })
          ] }),
          host.opsPolicy !== "ask" || host.loginEnv === true ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-ssh-badges", children: [
            host.opsPolicy !== "ask" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "button",
              {
                type: "button",
                className: "dsh-ssh-badge",
                "data-tone": host.opsPolicy === "trust" ? "warn" : "muted",
                disabled: busy,
                title: t("opsNote"),
                onClick: () => beginEdit(host),
                children: t(host.opsPolicy === "trust" ? "badgeOpsTrust" : "badgeOpsDeny")
              }
            ) : null,
            host.loginEnv === true ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "button",
              {
                type: "button",
                className: "dsh-ssh-badge",
                "data-tone": "muted",
                disabled: busy,
                title: t("loginNote"),
                onClick: () => beginEdit(host),
                children: t("loginBash")
              }
            ) : null,
            host.loginEnv === true ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ssh-badge-action", disabled: busy, title: t("loginRereadNote"), onClick: () => void rereadLoginEnv(host.id), children: t("loginReread") }) : null
          ] }) : null,
          browsing === host.id ? renderBrowser(host) : null,
          pendingTrust !== null && pendingTrust.hostId === host.id ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-ssh-trust", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-ssh-note", children: t("untrusted") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { className: "dsh-ssh-fingerprint", children: pendingTrust.fingerprint }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ssh-button", "data-primary": "true", disabled: busy, onClick: () => void trust(host), children: t("trust") })
          ] }) : null,
          status !== null && status.hostId === host.id ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-ssh-status-row", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
              status.banner.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-ssh-host-meta dsh-ssh-banner", title: status.banner, children: status.banner }) : null,
              /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-ssh-host-name", children: [
                t("sandbox"),
                ": ",
                status.runner.sandboxTool,
                " ",
                status.runner.sandbox.available ? t("available") : `${t("unavailable")} (${status.runner.sandbox.reason})`
              ] }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-ssh-host-meta", children: [
                t("ripgrep"),
                ": ",
                status.runner.ripgrep,
                status.runner.ripgrep === "missing" || status.runner.ripgrep === "upload-failed" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ssh-link", disabled: busy, onClick: () => void installRg(host.id), children: t("installRipgrep") }) : null
              ] })
            ] }),
            status.runner.os === "linux" && !status.runner.sandbox.available ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ssh-button", disabled: busy || status.runner.install === null, onClick: () => void install(host.id), children: t("install") }) : null
          ] }) : null,
          installLog !== null && installLog.hostId === host.id ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("pre", { className: "dsh-ssh-log", children: installLog.text }) : null,
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
            expanded ? owned.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", { className: "dsh-ssh-workspace-list", children: owned.map(workspaceRow) }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dsh-ssh-note dsh-ssh-workspaces-empty", children: t("noWorkspaces") }) : null
          ] })
        ] }, host.id);
      }) }) : null,
      hosts.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dsh-ssh-note", children: t("workspacesNote") }) : null
    ] }) : null,
    tab === "settings" ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "dsh-ssh-toggle", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "input",
          {
            type: "checkbox",
            checked: tagTitles,
            disabled: busy,
            onChange: (event) => void toggleTagTitles(event.target.checked)
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: t("tagTitles") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-ssh-note", children: t("tagTitlesHint") })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-ssh-registry", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "dsh-ssh-field", htmlFor: "dsh-ssh-registry", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-ssh-label", children: t("rgRegistry") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "input",
            {
              id: "dsh-ssh-registry",
              className: "dsh-ssh-input",
              type: "text",
              value: rgRegistry,
              placeholder: "https://registry.npmjs.org",
              disabled: busy,
              onChange: (event) => setRgRegistry(event.target.value)
            }
          )
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ssh-button", disabled: busy, onClick: () => void saveRegistry(), children: t("save") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-ssh-note", children: t("rgRegistryHint") })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-ssh-registry", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "dsh-ssh-field", htmlFor: "dsh-ssh-transfer-max", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-ssh-label", children: t("transferMaxBytes") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "input",
            {
              id: "dsh-ssh-transfer-max",
              className: "dsh-ssh-input",
              type: "text",
              inputMode: "numeric",
              value: transferMaxDraft,
              placeholder: "33554432",
              disabled: busy,
              onChange: (event) => setTransferMaxDraft(event.target.value.replace(/[^0-9]/g, ""))
            }
          )
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "dsh-ssh-field", htmlFor: "dsh-ssh-transfer-timeout", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-ssh-label", children: t("transferTimeoutMs") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "input",
            {
              id: "dsh-ssh-transfer-timeout",
              className: "dsh-ssh-input",
              type: "text",
              inputMode: "numeric",
              value: transferTimeoutDraft,
              placeholder: "120000",
              disabled: busy,
              onChange: (event) => setTransferTimeoutDraft(event.target.value.replace(/[^0-9]/g, ""))
            }
          )
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ssh-button", disabled: busy, onClick: () => void saveTransferLimits(), children: t("save") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-ssh-note", children: t("transferLimitsHint") })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-ssh-registry", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "dsh-ssh-field", htmlFor: "dsh-ssh-root", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-ssh-label", children: t("remoteRoot") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "input",
            {
              id: "dsh-ssh-root",
              className: "dsh-ssh-input",
              type: "text",
              value: rootDraft,
              placeholder: rootInfo?.defaultRoot ?? "~/.dsh/remote",
              disabled: busy,
              onChange: (event) => setRootDraft(event.target.value)
            }
          )
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ssh-button", disabled: busy, onClick: () => void saveRemoteRoot(), children: t("remoteRootSave") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dsh-ssh-note", children: [
          t("remoteRootHint"),
          rootInfo !== null ? ` ${t("remoteRootCurrent")} ${rootInfo.current}` : ""
        ] }),
        rootPrompt !== null ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-ssh-note dsh-ssh-danger-note", children: [
          rootPrompt.kind === "sessions" ? `${t("remoteRootHasSessions")} ${rootPrompt.sessions}. ${t("remoteRootForceHint")}` : `${t("remoteRootConflicts")} ${rootPrompt.conflicts?.length ?? 0}. ${t("remoteRootConflictHint")}`,
          rootPrompt.kind === "conflicts" && (rootPrompt.conflicts?.length ?? 0) > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-ssh-conflict-list", children: conflictPreview(rootPrompt.conflicts ?? []) }) : null,
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dsh-ssh-inline", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ssh-button", disabled: busy, onClick: () => setRootPrompt(null), children: t("cancel") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "button",
              {
                type: "button",
                className: "dsh-ssh-button",
                disabled: busy,
                onClick: () => {
                  if (rootPrompt.kind === "sessions") rootForceRef.current = true;
                  void resolveRootPrompt(rootPrompt.kind === "conflicts" ? "auto" : void 0);
                },
                children: rootPrompt.kind === "sessions" ? t("remoteRootForce") : t("remoteRootKeepTarget")
              }
            ),
            rootPrompt.kind === "conflicts" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ssh-button dsh-ssh-danger", disabled: busy, onClick: () => void resolveRootPrompt("overwrite"), children: t("remoteRootOverwrite") }) : null
          ] })
        ] }) : null
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-ssh-registry", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-ssh-label", children: t("hostBackup") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ssh-button", disabled: busy, onClick: () => void doExport(), children: t("exportHosts") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ssh-button", disabled: busy, onClick: () => pickImport("merge"), children: t("importMerge") }),
        importConfirm ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-ssh-note dsh-ssh-danger-note", children: t("importReplaceConfirm") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ssh-button", disabled: busy, onClick: () => setImportConfirm(false), children: t("cancel") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "button",
            {
              type: "button",
              className: "dsh-ssh-button dsh-ssh-danger",
              disabled: busy,
              onClick: () => {
                setImportConfirm(false);
                pickImport("replace");
              },
              children: t("importReplace")
            }
          )
        ] }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ssh-button", disabled: busy, onClick: () => setImportConfirm(true), children: t("importReplace") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "input",
          {
            ref: importInputRef,
            type: "file",
            accept: "application/json,.json",
            style: { display: "none" },
            onChange: (event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file !== void 0) void doImport(file);
            }
          }
        ),
        importRisk !== null ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-ssh-note dsh-ssh-danger-note", children: t("importRiskConfirm") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ssh-button", disabled: busy, onClick: () => setImportRisk(null), children: t("cancel") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ssh-button dsh-ssh-danger", disabled: busy, onClick: () => void confirmImportRisk(), children: t("importRiskContinue") })
        ] }) : null,
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-ssh-note", children: t("hostBackupHint") })
      ] })
    ] }) : null,
    tab === "deleted" ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-ssh-deleted", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dsh-ssh-note", children: t("deletedHostsNote") }),
      orphans.size === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dsh-ssh-empty", children: t("deletedEmpty") }) : null,
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", { className: "dsh-ssh-hosts", children: [...orphans.entries()].map(([hostId, rows2]) => {
        const tombstone = deleted.find((item) => item.id === hostId);
        return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", { className: "dsh-ssh-host", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-ssh-host-head", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-ssh-host-identity", children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-ssh-host-name", children: tombstone?.name ?? hostId }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-ssh-host-meta", children: tombstone === void 0 ? hostId : `${tombstone.username}@${tombstone.address}:${tombstone.port} \xB7 ${t("hostRemoved")}` })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-ssh-row-actions", children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                "button",
                {
                  type: "button",
                  className: "dsh-ssh-button",
                  disabled: busy || tombstone === void 0,
                  title: tombstone === void 0 ? t("restoreUnavailable") : void 0,
                  onClick: () => void restoreHost(hostId),
                  children: t("restoreHost")
                }
              ),
              purgeTarget === hostId ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
                /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dsh-ssh-note dsh-ssh-danger-note", children: [
                  t("purgeConfirm"),
                  " ",
                  rows2.length,
                  rows2.some((row) => row.sessions > 0) ? ` \xB7 ${rows2.reduce((sum, row) => sum + row.sessions, 0)} ${t("sessions")}` : ""
                ] }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ssh-button", disabled: busy, onClick: () => setPurgeTarget(""), children: t("cancel") }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ssh-button dsh-ssh-danger", disabled: busy, onClick: () => void purgeHost2(hostId), children: t("purgeConfirmAction") })
              ] }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                "button",
                {
                  type: "button",
                  className: "dsh-ssh-button",
                  disabled: busy,
                  onClick: () => setPurgeTarget(hostId),
                  children: t("purgeHost")
                }
              )
            ] })
          ] }),
          rows2.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", { className: "dsh-ssh-workspace-list", children: rows2.map(workspaceRow) }) : null
        ] }, hostId);
      }) })
    ] }) : null,
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("dialog", { ref: dialogRef, className: "dsh-ssh-dialog", "aria-label": draft.id.length > 0 ? t("editHost") : t("addHost"), onCancel: (event) => {
      event.preventDefault();
      if (!busy) cancelEdit();
    }, children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("form", { id: "dsh-ssh-form", className: "dsh-ssh-card", "data-editing": draft.id.length > 0 ? "true" : void 0, onSubmit: (event) => {
      event.preventDefault();
      void saveDraft();
    }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-ssh-dialog-head", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-ssh-legend", children: draft.id.length > 0 ? t("editHost") : t("addHost") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ssh-close", "aria-label": t("cancel"), title: t("cancel"), disabled: busy, onClick: cancelEdit, children: "\xD7" })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-ssh-grid", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { id: "dsh-ssh-name", label: t("name"), value: draft.name, onChange: (value) => setDraft({ ...draft, name: value }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { id: "dsh-ssh-host", label: t("address"), value: draft.host, onChange: (value) => setDraft({ ...draft, host: value }) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-ssh-grid", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { id: "dsh-ssh-port", label: t("port"), value: draft.port, onChange: (value) => setDraft({ ...draft, port: value.replace(/[^0-9]/g, "") }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { id: "dsh-ssh-user", label: t("user"), value: draft.username, onChange: (value) => setDraft({ ...draft, username: value }) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "dsh-ssh-field", htmlFor: "dsh-ssh-auth", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-ssh-label", children: t("auth") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("select", { id: "dsh-ssh-auth", className: "dsh-ssh-select", value: draft.auth, onChange: (event) => setDraft({ ...draft, auth: event.target.value === "password" ? "password" : "key" }), children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "key", children: t("authKey") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "password", children: t("authPassword") })
        ] })
      ] }),
      draft.auth === "key" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { id: "dsh-ssh-key", label: t("keyPath"), value: draft.privateKeyPath, onChange: (value) => setDraft({ ...draft, privateKeyPath: value }) }) : null,
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "dsh-ssh-field", htmlFor: "dsh-ssh-ops-approval", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-ssh-label", children: t("opsPolicy") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("select", { id: "dsh-ssh-ops-approval", className: "dsh-ssh-select", value: draft.opsPolicy, onChange: (event) => setDraft({ ...draft, opsPolicy: event.target.value }), children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "ask", children: t("opsAsk") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "trust", children: t("opsTrust") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "deny", children: t("opsDeny") })
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dsh-ssh-note", children: t("opsNote") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "dsh-ssh-field", htmlFor: "dsh-ssh-env-source", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-ssh-label", children: t("loginEnv") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("select", { id: "dsh-ssh-env-source", className: "dsh-ssh-select", value: draft.loginEnv ? "on" : "off", onChange: (event) => setDraft({ ...draft, loginEnv: event.target.value === "on" }), children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "off", children: t("loginOff") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "on", children: t("loginBash") })
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dsh-ssh-note", children: t("loginNote") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { id: "dsh-ssh-secret", label: draft.auth === "password" ? t("password") : t("passphrase"), value: secret, secret: true, onChange: setSecret }),
      draft.id.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dsh-ssh-note", children: t("secretKeep") }) : null,
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-ssh-actions", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-ssh-button", disabled: busy, onClick: cancelEdit, children: t("cancel") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "submit", className: "dsh-ssh-button", "data-primary": "true", disabled: busy || draft.host.trim().length === 0 || draft.username.trim().length === 0 || !draftPortValid(draft), children: t("save") })
      ] })
    ] }) }),
    tab === "help" ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
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
    ] }) : null
  ] });
}
function Field(props) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "dsh-ssh-field", htmlFor: props.id, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-ssh-label", children: props.label }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { id: props.id, className: "dsh-ssh-input", type: props.secret ? "password" : "text", value: props.value, onChange: (event) => props.onChange(event.target.value) })
  ] });
}
function newId() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(8));
  return `h${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

    return module.exports;
  }
});
