# dsh-permission-remote

把一台 Linux 或 macOS 机器上的目录做成 DeepSeek Harness（DSH）工作区。标准会话里的 `bash`、`read`、`write`、`edit`、`read_image`、`glob`、`grep` 在那台机器上执行。只读、工作区可写、完全放开，以及一次放宽，仍用这个会话现有的 Permissions 和审批卡片。

[English](#english).

## 安装

前置：DSH `0.2.1-rc.3`、`web` profile、Node `>= 22.5`。仓库：[weicy98/dsh-permission-remote](https://github.com/weicy98/dsh-permission-remote)。

从 GitHub 安装：

```sh
dsh plugin --profile web add github:weicy98/dsh-permission-remote
```

从 npm 安装：

```sh
dsh plugin --profile web add dsh-permission-remote
```

也可以用本机目录：`dsh plugin --profile web add /绝对路径/dsh-permission-remote`。

然后重启 `dsh web` 并硬刷新页面。设置里会出现 **SSH 主机**。

![SSH hosts](docs/images/ssh-hosts.png)

## 用法

1. **添加主机。** 设置 → SSH 主机。填写地址、端口、用户，以及私钥路径或口令。口令和私钥口令只写入 DSH 凭据存储；私钥只记录本机路径。
2. **测试并信任。** 第一次连接会给出主机指纹。确认后再信任，随后用只读沙箱 profile 真跑一次 `true`。
3. **沙箱依赖。** Linux 上没有可用的 bubblewrap 时，可以点 **安装远端沙箱依赖**。按钮按发行版执行 `sudo -n`，避免卡在密码提示。页上同时有可复制的自行安装命令：
   - Debian/Ubuntu：`sudo apt-get update && sudo apt-get install -y bubblewrap`
   - Fedora/RHEL：`sudo dnf install -y bubblewrap`
   - Arch：`sudo pacman -S bubblewrap`
   - Alpine：`sudo apk add bubblewrap`
   - macOS 使用系统自带的 `sandbox-exec`，没有安装按钮。探测失败时，受限 bash 需要经审批把这一次升到 `danger-full-access`。
4. **ripgrep。** `glob` / `grep` 需要远端有 `rg`。连接时会按远端架构上传随插件带上的二进制；上传不了时，在远端安装 ripgrep，让 `rg` 出现在 `PATH` 里。
5. **创建工作区。** 在同一页浏览远端目录，把当前目录作成工作区。它会出现在原来的工作区列表里。左侧文件列表和终端仍显示你这台电脑上的目录，远端文件要在对话的执行结果里看。

打开这个工作区的会话后，对话和 Permissions 与本地会话相同。相对路径按远端工作目录解析。工具结果里的路径写成占位目录，模型下一轮仍用这条路径。`working_directory` 也留在这条占位路径上：切换目录会确认远端目录存在，再把会话目录改成对应的占位路径，不会改到你这台电脑上的真实目录。

`workspace-write` 的文件写入在远端沙箱进程里完成：内容先进入同目录的临时文件，再 `mv -f` 换成目标文件。中途断开留下的是临时文件，原来的内容还在。`danger-full-access` 用同一步替换，但不包沙箱。

## 权限

| 档位 | 文件写入 | bash |
|---|---|---|
| `read-only` | 拒绝 | 有可用 runner 时在约束下执行；没有则 `SANDBOX_UNAVAILABLE`，命令不跑 |
| `workspace-write` | 只允许远端工作区和远端临时目录 | 同上。bubblewrap 的 `/tmp` 是私有 tmpfs；文件工具写的是真实临时目录 |
| `danger-full-access` | 按远端登录用户执行 | 不包壳。没有 runner 时，停掉任务可能收不齐子孙进程 |

模型带 `sandbox_permissions` 和一句话理由重试时，仍走现有审批。批准只放宽这一次调用。

## 使用上要注意

对话里的读文件、改文件、搜索和运行命令发生在远端。左侧的文件列表和终端还是你自己的电脑，里面看不到远端工程。

模型用「运行代码」，或者会话要读取项目里的 `AGENTS.md` 时，读到的也是你电脑上的这个工作区目录，不是远端那一份。

目前只能直接连接一台 Linux 或 macOS。不能经跳板机连接，也不能把 Windows 当作远端。网络中断时，正在进行的操作会失败。已经写到远端的文件会留在那里：重新连上之后不会再写一遍，也不会自动撤回。

Linux 上要让命令遵守当前权限，需要在那台机器上安装 bubblewrap。设置页可以代为安装，页面上也有可以自己执行的命令。

## 开发

```sh
npm install
npm test
npm run typecheck
npm run build
```

`lib/` 是安装入口，改完源码需要重新构建。

## English

SSH remote workspaces for the DSH web GUI. On a workspace created from **Settings → SSH hosts**, the standard tools `bash`, `read`, `write`, `edit`, `read_image`, `glob`, and `grep` run on that Linux or macOS host. The session keeps its existing Permissions selector and approval card.

Requires DSH `0.2.1-rc.3`, the `web` profile, and Node `>= 22.5`. Source: [weicy98/dsh-permission-remote](https://github.com/weicy98/dsh-permission-remote).

From GitHub:

```sh
dsh plugin --profile web add github:weicy98/dsh-permission-remote
```

From npm:

```sh
dsh plugin --profile web add dsh-permission-remote
```

A local checkout also works: `dsh plugin --profile web add /absolute/path/to/dsh-permission-remote`.

Restart `dsh web` and hard-refresh. Add a host, trust its fingerprint, then browse a remote directory and create a workspace. Passwords stay in the DSH credential store. Private keys are referenced by local path.

`working_directory` stays on the placeholder path for that remote directory. Under `workspace-write`, the confined command writes a temp file in the same directory and `mv -f` replaces the target, so a dropped connection does not truncate the original. `danger-full-access` uses the same replace without confinement.

Linux bash confinement needs bubblewrap. The settings page can install it with `sudo -n`, and also shows the manual command for Debian, Fedora, Arch, and Alpine. macOS uses the system `sandbox-exec`. `glob` and `grep` need ripgrep on the remote; the plugin uploads a matching binary when it has one.

In the conversation, reading, editing, searching, and shell commands run on the remote machine. The file list and the terminal on the left still show your own computer.

Run Code, and the session's reading of `AGENTS.md`, also use the workspace directory on your computer, not the copy on the remote host.

You can connect directly to one Linux or macOS machine. Jump hosts and Windows remotes are not supported. If the network drops, the operation in progress fails. Files already written on the remote stay there: reconnecting does not write them again and does not undo them.

On Linux, install bubblewrap on that machine if commands should follow the current permission mode. The settings page can install it, and it also shows the command you can run yourself.
