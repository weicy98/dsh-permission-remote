# dsh-permission-remote

把一台 Linux 或 macOS 机器上的目录做成 DeepSeek Harness（DSH）工作区。标准会话里的 `bash`、`read`、`write`、`edit`、`read_image`、`glob`、`grep` 在那台机器上执行。在 DSH 0.2.2 上，如果组合里启用了可选的 `apply_patch` 和 `str_replace_editor`，它们同样在那台机器上执行。只读、工作区可写、完全放开，以及一次放宽，仍用这个会话现有的 Permissions 和审批卡片。

[English](#english).

## 安装

前置：DSH `>=0.2.2-rc.1 <0.3.0`、`web` profile、Node `>= 22.5`。仓库：[weicy98/dsh-permission-remote](https://github.com/weicy98/dsh-permission-remote)。

从 GitHub 安装：

```sh
dsh plugin --profile web add github:weicy98/dsh-permission-remote
```

从 npm 安装：

```sh
dsh plugin --profile web add dsh-permission-remote
```

不需要改 profile 的 `pnpm-workspace.yaml`。SSH 库随插件带上，安装时没有要批准的构建脚本。

也可以用本机目录：`dsh plugin --profile web add /绝对路径/dsh-permission-remote`。

然后重启 `dsh web` 并硬刷新页面。设置里会出现 **SSH 主机**，左侧栏上方也会多一个 **SSH 主机** 图标（在「插件」和「定时任务」之后），点它直接在中间打开同一页，右上角的「返回会话」回到对话。两个入口是同一份界面和同一份配置。

![SSH hosts](docs/images/ssh-hosts.png)

## 用法

1. **添加主机。** 从两个地方都能进来：左侧栏的 **SSH 主机** 图标，或 设置 → SSH 主机。填写地址、端口、用户，以及私钥路径或口令。口令和私钥口令只写入 DSH 凭据存储；私钥只记录本机路径。已保存的主机可以点 **编辑** 改地址、端口、用户、认证方式和运维策略；改地址或端口会清掉旧指纹，需要重新测试并信任。
2. **测试并信任。** 第一次连接会给出主机指纹。确认后再信任，随后用只读沙箱 profile 真跑一次 `true`。
3. **沙箱依赖。** Linux 上没有可用的 bubblewrap 时，可以点 **安装远端沙箱依赖**。按钮按发行版执行 `sudo -n`，避免卡在密码提示。页上同时有可复制的自行安装命令：
   - Debian/Ubuntu：`sudo apt-get update && sudo apt-get install -y bubblewrap`
   - Fedora/RHEL：`sudo dnf install -y bubblewrap`
   - Arch：`sudo pacman -S bubblewrap`
   - Alpine：`sudo apk add bubblewrap`
   - macOS 使用系统自带的 `sandbox-exec`，没有安装按钮。探测失败时，受限 bash 需要经审批把这一次升到 `danger-full-access`。
4. **ripgrep。** `glob` / `grep` 需要远端有 `rg`。连接时会按远端架构上传随插件带上的二进制。本机没有该平台的包时（典型是 Windows 上的 DSH 管 Linux 远端，包管理器只装本平台的 `@vscode/ripgrep-win32-x64`），如果远端 `$HOME/.dsh-permission-remote/rg` 已经能跑 `--version`，探测直接用它，不再下载。还没有这份文件时，主机行会出现「安装 ripgrep」：按远端平台从 npm 源下载 `@vscode/ripgrep-<platform>`，取出 `package/bin/rg` 缓存到 `$DSH_HOME/cache/ripgrep/<platform>/rg`，再重新探测；上传被远端拒绝时也用同一个按钮重试。只有点这个按钮才联网，下载源在设置页填（留空用 npmjs，可填镜像）。都不想用的话，可以在远端自己安装 ripgrep，让 `rg` 出现在 `PATH` 里。
5. **创建工作区。** 在同一页浏览远端目录，把当前目录作成工作区。点某台主机的「浏览目录」，目录面板就展开在**这台主机那一行下面**（再点一次收起），不会跑到整个列表底下；面板内再点「把当前目录做成工作区」后自动收起，新工作区直接出现在这台主机的列表里。面板上方的筛选框边打字边过滤当前已列出的名字，不发远端请求；换目录时清空，同一目录刷新时保留。框里也可以直接输入或粘贴整条路径：框里放的是完整路径，下面列的是**最后一个 `/` 之前那层目录**的子目录，并按还没输完的那一段过滤——`/home/me/co` 列出 `/home/me` 里匹配 `co` 的目录，粘贴 `/home/me/code` 也一样。选一行或按 Enter 就把那一段补全、末尾补上 `/`，面板随即进入该目录，框里仍是完整路径；粘贴带尾斜杠的 `/home/me/code/` 直接就位。输入过程中面板跟着路径走（面包屑是远端 realpath，符号链接和 `..` 都收成一个写法），相对路径（`a/b`、`../shared`、`home/me`）按**开始输路径时所在的目录**解析，`~` 由远端展开。路径还没补成目录时「创建工作区」不可用（title 会说明）；Esc 清空路径、停在当前目录，点「上一级」「刷新」或面包屑也会先清空路径再跳。父目录不存在或没权限时提示就在框下面，框里的内容保留着可以改。**「新建文件夹」** 在筛选框下方展开一个输入行，回车即在该目录下建一级子目录，列表随即刷新、名字保留在输入框里，方便连着建几个；名字里带 `/` 或为空会被拦下，重名会照远端返回的结果提示。键盘：面板打开或换目录时焦点就地落在筛选框，框空着时右侧有一行提示「Tab 进目录行；按 / 回到这里」——从框里按 Tab 才进目录行（Tab 走到哪一行，高亮就跟到哪一行），在行上按 Esc 或 Backspace 回到筛选框；点过面板别处后用 `/` 回到框里（只在 SSH 主机页生效，输入框里按 `/` 照常输入）。↑/↓ 在目录间移动高亮，Enter 接受高亮行（没有高亮时取唯一匹配，再取与最后一段同名的行；都没有就原地提示，不发请求），按名字筛选时只取唯一匹配，Esc 先清空路径或筛选、再按一次退出输入框，Home/End 跳到首尾。它会出现在原来的工作区列表里。左侧文件列表仍是本机的占位目录。右侧栏的文件树列出远端目录里的内容，标题仍是这条占位路径，自动刷新不可用。手动刷新会再向远端要这一层的名字；文件是否存在、大小这些属性在大约 5 秒内可能仍是刚才的结果。用户上传的非图片文件会先复制到远端 `~/.dsh-permission-remote/uploads/`，模型看到的是远端绝对路径。右侧栏终端会连到远端，见下面「侧栏终端」。
6. **查看各台服务器的工作区。** 每台主机下面有「已添加的工作区」，列出从这台机器创建的工作区、远端目录和会话数。可以只从 DSH 列表移除（远端文件不动），也可以把侧栏标题重新标注。
7. **侧栏认主机。** DSH 的侧栏工作区行只显示标题、没有可挂标记的 slot，所以插件把主机名写进标题：`服务器 · 目录名`。加载时只标注标题仍是目录名的那些；你改过的名字不会被自动改写，可以随时用该主机下的「标注侧栏标题」手动重标——它会给该主机的全部工作区标注，并把旧服务器的前缀换成当前的。设置页的开关（`tagWorkspaceTitles`）可以整体关掉标注，重新打开时会立即标注一遍。
8. **删除与恢复主机。** 删除主机只是把它从列表移走，工作区仍然注册在 DSH 里，标题保留原前缀。设置页的「已删除的主机」分组里可以「恢复主机」（配置和指纹都还在），也可以逐个「注销工作区」。

打开这个工作区的会话后，对话和 Permissions 与本地会话相同。相对路径按远端工作目录解析。工具结果里的路径写成占位目录，模型下一轮仍用这条路径。`working_directory` 也留在这条占位路径上：切换目录会确认远端目录存在，再把会话目录改成对应的占位路径，不会改到你这台电脑上的真实目录。从**本地**会话切进远端路径时，占位目录会随着工作区注销留下来，而进了占位目录就等于拿到那台机器的远端 shell，所以插件不会只凭「目录还在」或「列表里已经有这个工作区」放行。`ssh_workspace` 和设置页都只注册工作区，不让当前会话进入；要在那台机器上工作，从侧栏打开。拒绝发生在目录写进会话之前，错误里也不写出占位路径，并说明这个会话不是从那台主机打开的。本地会话即使当前目录已经是某个已注册的占位目录，工具同样拒绝。从这台主机的工作区打开的会话不受影响——在这台机器上 `cd /etc` 照常，跨主机本来也跳不过去。`workspace-write` 的可写根钉在会话头里记下的工作区目录上，不跟着当前目录走，所以打开的会话即使 `cd /` 也不会把整台机器绑成可写。这样一来，`deny` 主机也无法靠残留的占位目录绕开「拒绝所有远端读取」。每轮的运行时上下文还会写明这条占位路径对应的远端真实目录（`Remote directory: "..."`），`working_directory` 的结果也会在占位路径下面多给一行 `(remote: /home/...)`，命令里可以直接用这条绝对路径，不必先跑 pwd。

## 主机设置：远程调用审批与环境变量来源

每台主机卡片上的两个设置都在**编辑对话框**里。卡片上平时只显示操作按钮；某一项偏离默认值时，卡片上会多出一个标签写明它，点标签直接打开编辑对话框。

### 远程调用审批（默认「每次询问」）

控制其他工作区里的会话用 `ssh_exec` / `ssh_write` / `ssh_upload` / `ssh_download` 操作这台主机时放不放行：

| 选项 | 行为 |
|---|---|
| 每次询问 | 执行命令、写文件和传文件各要一次 `danger-full-access` 审批（默认） |
| 不再询问 | 直接执行，不弹卡。卡片上显示琥珀色标签「远程调用免审批」 |
| 禁止调用 | 这台主机拒绝所有远程命令和写入。卡片上显示灰色标签「远程调用已禁止」 |

读取远端文件（`ssh_read`）不受这个设置影响。下载算写入：它会在运行 DSH 的机器上落盘，所以和其它写入一起走这道闸门，而不是随读取放行。

### 环境变量来源（默认「SSH 登录环境」）

远端工作区里的 `bash` 用哪一套环境变量：

| 选项 | 行为 |
|---|---|
| SSH 登录环境 | 沿用 SSH 登录时拿到的变量，通常只有 `/etc/environment` 里那几个（默认） |
| 读取 bash 启动脚本 | 捕获一次启动文件导出的变量并复用。卡片上显示标签「读取 bash 启动脚本」和「重新读取环境」 |

选「读取 bash 启动脚本」后，这条 SSH 连接上的第一条工作区命令会读一次启动文件：`/etc/profile`，然后 `~/.bash_profile`、`~/.bash_login`、`~/.profile` 里第一个能读的，再是 `/etc/bash.bashrc` 和 `~/.bashrc`。前面已经 source 过的 `~/.bashrc` 和 `/etc/bash.bashrc` 不会再读。读取时丢掉这些文件的输出，最多 10 秒。超时或失败时，这次连接后面的命令继续用 SSH 原来的环境，也不会反复重试。

读到的变量会复用，直到断开连接、切回「SSH 登录环境」，或在卡片上点「重新读取环境」。重新读取只丢掉这份缓存，不断开 SSH；下一条工作区命令会再读一次，同样最多 10 秒。bashrc 里导出的 `PATH`（例如 nvm、cargo）会保留。如果 bashrc 把 `PATH` 设成了错误的值，之后的命令会一直用这份 `PATH`，直到重新读取、断开连接或切回。

`PWD`、`OLDPWD` 和 `SHLVL` 是当前会话的状态，不会进缓存。每条命令自己的 bash 再设置它们。不读取 `~/.zshrc`。别名和函数不会保留：靠 `PATH` 找到的命令会生效，靠 shell 函数的（如 `nvm`）不会。每条用户命令仍是一个新的 bash。`ssh_exec` 不受这个设置影响，它还是 `bash -lc`。


`workspace-write` 的文件写入在远端沙箱进程里完成：内容先进入同目录的临时文件，再 `mv -f` 换成目标文件。中途断开留下的是临时文件，原来的内容还在。`danger-full-access` 用同一步替换，但不包沙箱。

### 远端根目录与配置备份

设置页的「远端根目录」是本地存放所有远端工作区占位目录的位置，默认 `~/.dsh/remote`（可用 `DSH_SSH_REMOTE_ROOT` 覆盖）。把这一栏清空再保存，会回到内置默认目录。改到新目录并点「保存并迁移」时：

- 新目录不存在或是空的：把旧的 `remote` 目录整棵复制过去。
- 新目录已有内容：自动合并——缺失的补上、完全相同的跳过、同名但内容不同的文件先不覆盖，页面上会问你要「保留目标（自动合并）」还是「用旧目录覆盖」。同名但一侧是目录、另一侧是文件的情况一律不动，会列在冲突里，由你手工处理。符号链接按链接原样复制、不跟随；目标里已有的符号链接保持不动并列为冲突，避免写穿链接。
- 新目录不能放在旧目录里面（反过来也不行），否则直接报错，不会开始复制。
- 工作区里有打开着的会话时，会先提示；迁移会按远端路径把这些工作区重新注册到新占位目录下，并把已存储的会话一起搬到新位置。会话的**分组**要等下次启动 DSH 时才会恢复（工作区注册表在启动时缓存会话头，插件无法在本次进程内安全改归属）；待归组记录保存在 `~/.dsh/data/dsh-permission-remote/migration.json`（权限 0600，属于插件自身状态，不放进设置页）。正在打开的会话先留在原处（期间仍连着原服务器），关闭它们后再次保存即可补迁，但补迁后的分组同样要再下一次启动才归位。

**从旧版本升级：** 本修复只对之后发生的迁移生效。如果你的会话是在旧版本里迁移受损的（仍挂在旧占位根下、没有任何待归组记录），升级后不会被自动修好——需要手工告诉插件旧根在哪：

1. 退出 DSH；
2. 编辑 `~/.dsh/data/dsh-permission-remote/migration.json`（不存在就新建），把旧占位根加入废弃根列表，例如
   `{ "version": 1, "supersededRemoteRoots": ["<旧根绝对路径>"], "pendingSessionGrouping": [] }`；
3. 启动 DSH：启动时的补扫会把旧根下的会话搬到当前根、改好头部 cwd 并登记待归组；
4. **再启动一次** DSH，分组即恢复。

（补扫在每次启动都会跑；若旧根写错只是扫不到东西、不会损坏任何文件。）

旧目录不会被删除，确认无误后可自行清理；迁移只搬本机的占位目录，不动远端服务器上的文件。若在通用设置编辑器里直接改这个值，会立即生效但**不会**迁移旧目录——要搬目录仍请用「保存并迁移」。本次运行期间，旧目录里的路径仍按「远端占位目录」解析——挂在旧占位目录上的会话还能继续连到那台服务器；但旧目录里没有已注册工作区覆盖时，会明确报错拒绝，而不是悄悄变成本地目录。重启后旧目录不再被识别。

设置页还有「主机配置备份」：**导出配置**把主机列表存成 JSON（不含口令和私钥口令，它们只在凭据存储里）；**导入并合并**按主机 id 更新或新增，且只更新文件里真正写了的字段——只改名字的行会保留指纹、私钥路径和审批策略；地址变了会丢掉已保存的口令，文件没给新指纹时会清掉旧主机密钥。**导入并替换**用文件整体替换现有列表（会先确认一次；文件里没有的主机会移到「已删除主机」，可以恢复）；之前已删除、但仍有工作区的主机，即使文件没提到也会保留在「已删除主机」里。合并只并入主机行，不采用文件里的「已删除主机」记录。导入后请重新测试连接，并按需重填口令；文件里设为 `trust` 的主机会在结果里提示数量。若文件改动现有主机的地址、把主机设为 `trust`，或把 `deny` 放宽成 `ask`，页面会先询问再导入；文件新增的主机直接生效。

## 权限

| 档位 | 文件写入 | bash |
|---|---|---|
| `read-only` | 拒绝 | 有可用 runner 时在约束下执行；没有则 `SANDBOX_UNAVAILABLE`，命令不跑 |
| `workspace-write` | 只允许打开时的工作区根和远端临时目录 | 同上。可写根不跟着 `cd` 变。bubblewrap 的 `/tmp` 是私有 tmpfs；文件工具写的是真实临时目录 |
| `danger-full-access` | 按远端登录用户执行 | 不包壳。没有 runner 时，停掉任务可能收不齐子孙进程 |

模型带 `sandbox_permissions` 和一句话理由重试时，仍走现有审批。批准只放宽这一次调用。

## 远程运维

普通工作区（目录在你这台电脑上）也可以让模型操作一台已配置的 SSH 主机，用来查日志、重启服务、改配置、传文件，或者把远端目录注册成工作区。打开会话即可看到七个工具：

| 工具 | 作用 |
|---|---|
| `ssh_hosts` | 列出主机 id、名称、地址、用户、运维策略和指纹是否已信任 |
| `ssh_exec` | 在那台机器上执行 `bash -lc`，可选绝对路径 `workdir` 和 `timeoutMs` |
| `ssh_read` | 读取远端文件，1 MiB 上限，按行分页；支持 `~/` |
| `ssh_write` | 用临时文件加 `mv -f` 原子替换远端文件。已有文件保留权限位，新文件按远端 umask 创建，目录路径会被拒绝 |
| `ssh_upload` | 把一个本机文件传到远端。本机路径必须是**运行 DSH 那台机器**上的绝对路径，远端路径是绝对路径或以 `~/` 开头。字节写在目标同目录的临时文件里再 `mv -f` 替换：断线不会截断原文件，服务器返回 mode 时已有文件保留权限位，新文件按远端 umask 创建 |
| `ssh_download` | 把远端一个文件取回本机。远端路径是绝对路径或以 `~/` 开头，本机路径的上级目录必须已经存在。文件原子替换并置为 `0600` |
| `ssh_workspace` | 给某台已有主机、以某个远端目录创建一个工作区。目录必须已经存在且是目录，不能是文件系统根 `/`。标题默认取目录名，开了标题标注时会带上服务器前缀。重复添加同一目录不会产生第二行，保留原标题，结果里会说明 |

每台主机在设置里有一个**远程运维**策略：

| 策略 | 读取 `ssh_read` | 命令 `ssh_exec` / 写入 `ssh_write` / 上传 `ssh_upload` / 下载 `ssh_download` / 添加工作区 `ssh_workspace` |
|---|---|---|
| 询问（默认） | 允许 | 只在本会话是 `danger-full-access` 时直接执行；否则第一次被拒，模型必须带 `sandbox_permissions: "danger-full-access"` 和理由重试后弹审批卡。卡片上有主机和截断后的命令或路径，批准只放宽这一次。其它档位不会弹卡 |
| 信任 | 允许 | 直接执行，不弹审批 |
| 禁止 | 拒绝 | 拒绝 |

`ssh_exec`、`ssh_write`、`ssh_upload`、`ssh_download` 和 `ssh_workspace` 在远端不受远端工作区沙箱约束，因为运维目标通常是本机工作区之外的机器。它们要么走当前会话的 `danger-full-access`，要么走这台主机的信任策略，要么走一次审批。读取只受「禁止」限制。

下载按**写入**处理：它对远端只是读，但会在运行 DSH 的机器上落盘，所以和 `ssh_write` 同一道闸门。注意这道闸门只约束「询问」策略下的主机：切到「信任」后，下载和 `ssh_write` 一样不再看当前会话的档位，也不弹审批，只读会话同样能写本机文件。上传方向也一样：`ssh_upload` 在「信任」主机上不弹审批就读本机文件并发往那台主机——信任一台主机也意味着信任它会拿到会话让它上传的本机内容。纯文本读取仍用 `ssh_read`，它只受「禁止」限制。

**单文件，不递归。** 两个工具都不传目录，也不做断点续传。最终组件是符号链接时两端都拒绝（远端用 `lstat`，本机也用 `lstat`，再加 `O_NOFOLLOW`），因为 `mv -f` 会替换链接本身而 `realpath` 会把有效链接解析到目标，两种语义都容易写出意外结果；中间目录是链接则按普通路径处理。FIFO、设备、socket 一律拒绝，不会被当成文件读取。

**上限与超时在设置页配置**（「设置」标签页里的「单次传输上限（字节）」和「单次传输超时（毫秒）」）：默认 32 MiB 和 120 秒，改完立即生效。填 `0` 或留空表示**不封顶 / 不限时**——不封顶时整个文件会进内存；超时/取消在本地读取、远端 stat、`~` 展开和远端写入阶段都会让调用立即返回，底层 SFTP 或 `$HOME` 探测本身无法中断，可能仍在后台跑完（`$HOME` 结果仍会缓存）。超时或取消**可能仍完成落盘**，失败也可能在远端留下同目录临时文件；已经写好的结果不回滚。超时上限是 `2147483647` 毫秒（Node 定时器的 32 位上限，再大的值会立刻触发或直接报错），超过时设置页会说明已按上限保存。超时和用户取消在上层都表现为中止，但插件会把**超时**改写成 `TimeoutError` 并在消息里写明生效的毫秒数，取消仍是 `AbortError`，模型因此能分辨是该调大设置还是别重试。

上传的远端父目录由脚本 `mkdir -p` 创建，且不会改动已有目录的权限（这里没有复用 `sftpPutFile`，那个函数会把父目录 `chmod 700`）。下载**不会**自动创建本机目录树，上级目录不存在就直接报错。

远端工作区里的会话也能调这两个工具，但那里的 `local_path` 指的是**运行 DSH 的机器**：模型看到的 `~/.dsh/remote/...` 占位路径在本机只是一个目录骨架，远端主机看不到它。要在远端会话内搬运文件，用那台机器上的 `bash`。

`ssh_workspace` 做一次远端 `stat`，再按远端真实路径注册（符号链接记成它指向的目录，标题默认取这个真实路径的目录名）。`realpath` 失败则这次注册失败。它不改远端文件。它只在侧栏加一条工作区。打开这条工作区会在那台机器上开始一个会话，所以询问策略下仍和命令一样要审批。这次调用不让当前会话进入，结果里也不给出占位目录。要在那台机器上工作，从侧栏打开。文件系统根 `/` 不能注册，真实路径解析成 `/` 时同样拒绝：那一棵会盖住整台机器。对同一个远端真实路径重复添加不会产生第二行，保留已有的标题，结果里会说明它已经注册过。

运维工具的前提：

- 目标主机必须已经在设置里信任过指纹，否则连接失败
- `ssh_exec` 用 `bash -lc`，会读登录 shell 的 profile，这样 `PATH` 里才有 `systemctl`、`docker` 这类命令；profile 若往 stdout 打东西，会出现在命令输出里
- `sudo` 只能走免密（`sudo -n`）。SSH 非交互执行没有 TTY，需要口令的 `sudo` 会卡住
- 只支持直连的 Linux 或 macOS；不支持跳板机和 Windows 远端
- 上传和下载只处理单个文件：不跟目录、不续传，单次上限和超时见上面的设置项
- 网络中断时，正在执行的远端命令会失败；已经写入的文件留在远端，不会回滚

## 侧栏终端

在远端工作区里，右侧栏的终端连的是那台服务器，不是你这台电脑：新建终端时 shell 菜单里列的是远端 `$SHELL` 和远端装了的 `bash` / `zsh` / `fish` / `sh`，标签名带主机名（`lo · zsh`）。缩放、滚屏、复制、刷新页面后重连都由 DSH 原来的终端界面负责。

几点要注意：

- **权限。** 侧栏终端是远端登录用户自己的 shell，和本地会话里的侧栏终端一样**不套 bubblewrap**，也不按按键走 Agent 审批。闸门只有「这台主机的指纹已经信任」。要按当前权限档位跑命令，用对话里的 `bash` 工具。
- **连接是共享的。** 一个标签页一条 SSH 通道，和文件传输、远端命令共用这台主机的那一条连接。OpenSSH 默认 `MaxSessions 10`，而 DSH 每个会话最多 8 个终端。通道占满时新标签页会报这台主机拒绝再开一个 SSH 会话；只关侧栏终端不一定腾得出名额，也可以在远端调高 `MaxSessions`。
- **不跟随后续的 `working_directory`。** 已经开着的终端留在打开时那个远端目录；新开的用当时的目录。占位子目录不存在时，新建终端会先把它建出来，这样不会退回工作区根。建不出来时仍由 DSH 退回工作区根。
- **断线即结束。** 连接断了终端就结束，不会自动重连，也没有回滚：关掉标签页重开一个即可。
- **只有侧栏接上了。** 模型侧的 `terminal_open` 在远端工作区里会直接报错并提示改用 `bash` 或侧栏终端——它请求的是本机 PTY 后端，会把 shell 开在你这台电脑的占位目录里。`terminal_send` / `terminal_read` / `terminal_list` 不动：它们操作的是已经存在的终端。

## 使用上要注意

对话里的读文件、改文件、搜索和运行命令发生在远端。左侧的文件列表，以及输入框里的 `@` 补全，仍用本机文件系统扫占位目录，列不出远端文件。右侧栏的文件树列出远端目录里的内容，标题仍是这条占位路径，自动刷新不可用。手动刷新会再向远端要这一层的名字；文件是否存在、大小这些属性在大约 5 秒内可能仍是刚才的结果。用户上传的非图片文件会先复制到远端 `~/.dsh-permission-remote/uploads/`，模型看到的是远端绝对路径。右侧栏终端见上一节，它连的是远端。

**交付文件（`present`）在远端工作区里也能用。** DSH 的 `present` 只认本机文件：它逐个 `stat` 参数里的路径，再把路径写进会话事件，卡片打开时读的还是本机文件系统。不接管的话，远端会话每次交付都会报 `Cannot present ...: file not found`——路径指向的占位目录里只有目录，没有文件。插件接管这个调用：先按远端确认每个文件存在、是普通文件、不超过 32 MiB，再把字节复制到对应的占位路径，最后用这些占位路径调用官方的 `present`。所以卡片、侧栏预览和"在应用中打开"拿到的是本机真实文件；同时远端那份原件不动。参数和输出仍是官方形状，`description` 原样保留。

由此有几点要知道：

- **占位路径里会多出一份文件。** 复制品落在占位根（默认 `~/.dsh/remote`）下，权限 `0600`。同一个路径再次交付会覆盖成最新内容——事件里只记路径，卡片显示的是当前那份，不覆盖就会一直显示第一次的字节。
- **超过 32 MiB 会被拒。** 报错里给出实际大小和远端真实路径，方便改用别的交付方式；截断的副本比拒绝更糟。
- **单个文件失败即整次失败。** 任一文件缺失、是目录或超限，整次交付都不写事件，不会出现"只交付了一半"。
- **只复制、不搬运。** 远端服务器上的文件不动；占位目录里的副本也不会因为远端文件后来改变而自动更新，需要重新交付一次。

DSH 本身跑在 Windows 上时，远端工作区的对话只暴露远端 `bash`。`pwsh`、`powershell`、`cmd` 不会出现在原生工具列表里，官方那段 Windows 进程结束说明（`tool:pwsh`）在停在这个工作区时也会被盖住。回到本机目录后，这些 Windows 工具和原来的说明恢复。`minimal` 这类把提示词写成完整 persona 的预设不会被改写；挡住 Windows shell 的是工具列表过滤和执行守卫。内置预设的 `pwsh` 在祖先层，进入远端时会被从原生工具列表和 `ptc` SDK 正文里去掉。注册在 agent 本层的 `pwsh` 去不掉：SDK 正文仍可能列出它，原生列表会被滤掉，调用会被拒绝。文件工具的参数继续用工具返回的占位路径。

模型用「运行代码」时，跑的仍是你电脑上这个占位目录里的运行时，不是远端那一份。会话读取项目里的 `AGENTS.md`、`CLAUDE.md`（以及同名的 `.local`）时走文件系统接口，占位路径会读到远端那一份。`$DSH_HOME/AGENTS.md` 这种不在占位根下的全局文件仍是本机。每轮组装提示词会沿祖先目录对这些文件多做几次远端查询。提示词内容和本机那份不一样，已经缓存的前缀对不上。

目前只能直接连接一台 Linux 或 macOS。不能经跳板机连接，也不能把 Windows 当作远端。网络中断时，正在进行的操作会失败。已经写到远端的文件会留在那里：重新连上之后不会再写一遍，也不会自动撤回。远程工作区里的 `bash`、`read`、`write`、`edit` 只能操作那台机器；要在当前本地工作区操作另一台主机，用上面的 `ssh_hosts` / `ssh_exec` / `ssh_read` / `ssh_write` / `ssh_upload` / `ssh_download` / `ssh_workspace`。

Linux 上要让命令遵守当前权限，需要在那台机器上安装 bubblewrap。设置页可以代为安装，页面上也有可以自己执行的命令。

### 可选的 `apply_patch` 与 `str_replace_editor`（DSH 0.2.2）

DSH 0.2.2 还有两个可选的文件工具，在远端工作区里同样落在这台机器上。两者默认都关着，插件不会替你启用，要在预设或组合里自己打开：把 `@deepseek-ai/dsh-tool-fs` 的 `applyPatch` 设为 `true` 才注册 `apply_patch`（所有官方预设都默认 `false`）；`@deepseek-ai/dsh-tool-str-replace-editor` 是独立包，只在自定义组合里挂载，官方预设不带它。

路径写法：

- `apply_patch` 的路径按会话工作目录（本机占位目录）解析，也可以直接给绝对占位路径。
- `str_replace_editor` 只收绝对路径，把 `read` 或右侧栏文件树返回的占位路径原样传回去就好。若给了它一个远端真实绝对路径（例如 `/home/me/project/a.ts`），插件会把它改写成同一台主机对应的占位路径，绝不会在本机按这个名字读写文件；若该工具的转发层没有挂载，这类调用会被直接拒绝，同样不会碰本机文件。远端真实绝对路径只用于 `bash` 命令。

行为：`apply_patch` 的新增、更新、删除、移动，和编辑器的 `view`、`create`、`str_replace`、`insert`，都在远端执行，并遵守会话的 Permissions 档位、审批卡片和远端沙箱，删除与移动也不例外。整个补丁先整体预检，再按顺序逐条提交；中途失败不会回滚，已提交的操作留在远端。一次「移动」若已发布目标、却删不掉源文件，目标保留，调用只报告这一步失败。

限制：只处理 UTF-8 文本，不支持二进制；没有回滚。`str_replace_editor` 没有一次性的 `sandbox_permissions` / `justification` 提权，请用会话里已经设好的常驻 Permissions 档位。移动涉及两个路径，不是原子操作；删除只涉及一个路径。

## 开发

```sh
npm install
npm test
npm run test:ci   # 官方工具探针缺失时直接失败，CI 用这个
npm run typecheck
npm run build
```

`lib/` 是安装入口，改完源码需要重新构建。`npm run test:ci` 需要本机装有 DSH 0.2.2；`npm test` 在找不到时会把官方工具集成用例跳过。

## English

SSH remote workspaces for the DSH web GUI. On a workspace created from **Settings → SSH hosts**, the standard tools `bash`, `read`, `write`, `edit`, `read_image`, `glob`, and `grep` run on that Linux or macOS host. On DSH 0.2.2, the optional `apply_patch` and `str_replace_editor` tools, when enabled in the composition, run on that host too. The session keeps its existing Permissions selector and approval card.

Requires DSH `>=0.2.2-rc.1 <0.3.0`, the `web` profile, and Node `>= 22.5`. Source: [weicy98/dsh-permission-remote](https://github.com/weicy98/dsh-permission-remote).

From GitHub:

```sh
dsh plugin --profile web add github:weicy98/dsh-permission-remote
```

From npm:

```sh
dsh plugin --profile web add dsh-permission-remote
```

No `pnpm-workspace.yaml` edit. The SSH library ships inside the plugin, so install does not ask to approve a build script.

A local checkout also works: `dsh plugin --profile web add /absolute/path/to/dsh-permission-remote`.

Restart `dsh web` and hard-refresh. **SSH hosts** appears in Settings, and an **SSH hosts** icon joins the top of the left sidebar (after Plugins and the task manager): it opens the same page in the centre column, and **Back to session** at the top right returns to the conversation. Both entries are one UI over one configuration. Add a host, trust its fingerprint, then browse a remote directory and create a workspace. **Browse** opens the picker inside that host's row, right under the button you pressed (press it again to close), not below the whole list. Creating a workspace closes the picker so the new row is visible. A filter box above the listing narrows the listed names as you type, without a remote round trip; it clears when you walk to another directory and survives a refresh of the same one. It also takes a whole path, typed or pasted: the box keeps the full path and the rows below are the children of the directory before its last `/`, filtered by the segment still being typed — `/home/me/co` lists what matches `co` under `/home/me`, and pasting `/home/me/code` does the same. Accepting a row (click, or Enter) completes that segment, adds the trailing `/`, and the panel enters the directory while the box still shows the whole path; pasting `/home/me/code/` lands there directly. The panel follows the path as you type, and the breadcrumb shows the remote realpath, so symlinks and `..` collapse to one spelling. A relative path (`a/b`, `../shared`, `home/me`) resolves against the directory the box was empty in, and `~` is expanded by the remote. **Create workspace** stays disabled until the path names a directory, and its tooltip says so. A directory that cannot be listed explains itself under the box and leaves the text for fixing. **New folder** opens an input row under the filter and creates one child directory of the listed one on Enter: the listing refreshes in place and the name stays in the field, so several folders can be made in a row. A name containing `/` or an empty one is refused; a duplicate is reported from the remote's own reply. Keyboard: opening the picker or walking into another directory puts the caret in the filter, and a hint in the box says where Tab and `/` go — from the box, Tab reaches the listing (the row you tab to is the row that is highlighted), and `/` brings the caret back from anywhere on the page. Esc or Backspace on a row returns to the box (`/` works only on the SSH hosts page, and a literal `/` still types inside any field). ↑/↓ move the highlight, and Enter accepts the highlighted row (or the only match, or the row named exactly like the segment being typed; an unmatched segment is reported in place without a round trip), while a name filter only takes a single match. Esc clears the path or query first and then leaves the box, Home/End jump to the ends. Passwords stay in the DSH credential store. Private keys are referenced by local path. A saved host can be **edited** to change its address, port, user, authentication, or ops policy; changing the address or port clears the stored fingerprint, so trust the new host key again.

Each host lists the workspaces created from it, with the remote directory and session count. Unregistering removes the row from DSH only; files on the host stay. DSH renders a sidebar workspace row from its title and exposes no slot on that row, so the plugin writes the server into the title as `server · directory`. Load-time tagging touches only titles that are still the directory name; a name you changed is left alone, and each host has a “Tag sidebar titles” button that prefixes every workspace under it, replacing an old server prefix. The Settings switch (`tagWorkspaceTitles`) turns tagging off entirely; turning it back on labels the existing workspaces right away.

Deleting a host only removes it from the list: its workspaces stay registered with their old title prefix. The “Deleted hosts” group in Settings can restore the host (configuration and fingerprint are kept) or unregister its workspaces one by one.

`working_directory` stays on the placeholder path for that remote directory. From a **local** session, entering a remote path is not authorized by a leftover placeholder, by a workspace that merely exists in the list, or by `ssh_workspace`. Registration only adds the sidebar row; start a session there by opening that workspace. The plugin refuses before the session directory changes. The error does not include the placeholder path, and it says this session was not opened on that host. A local session whose current directory is already a registered placeholder is refused the same way. A session **opened** on that host keeps working — `cd /etc` is ordinary navigation there, and routing cannot cross hosts — so a leftover placeholder can no longer be used to read a `deny` host. Under `workspace-write`, the writable root stays the workspace encoded in the header. It does not follow the live directory, so `cd /` does not bind the whole machine. Every turn's runtime context also names the real remote directory that placeholder maps to (`Remote directory: "..."`), and the `working_directory` result adds a second line `(remote: /home/...)` under the placeholder, so a command can use the absolute path without running `pwd` first. Under `workspace-write`, the confined command writes a temp file in the same directory and `mv -f` replaces the target, so a dropped connection does not truncate the original. `danger-full-access` uses the same replace without confinement.

Linux bash confinement needs bubblewrap. The settings page can install it with `sudo -n`, and also shows the manual command for Debian, Fedora, Arch, and Alpine. macOS uses the system `sandbox-exec`.

`glob` and `grep` need ripgrep on the remote; the plugin uploads a matching binary when it has one. A package manager installs only its own platform's package, so a Windows DSH managing a Linux remote has no Linux binary to upload. A binary already at `$HOME/.dsh-permission-remote/rg` that runs `--version` is used as-is. Otherwise the host row offers “Install ripgrep”: it downloads `@vscode/ripgrep-<platform>` for the remote from the configured npm source (empty means npmjs; a mirror works), takes `package/bin/rg` out of the tarball, caches it at `$DSH_HOME/cache/ripgrep/<platform>/rg`, and re-probes. The same button retries after a remote refused the upload. Nothing reaches the network unless that button is pressed. Alternatively install ripgrep on the remote so `rg` is on `PATH`.

## Per-host settings: remote call approval and environment source

Both settings live in the **edit dialog**. The card normally shows only actions; when one of them leaves its default, the card gains a label naming it, and clicking that label opens the dialog.

### Remote call approval (default: ask each time)

Controls whether a session in another workspace may use `ssh_exec` / `ssh_write` / `ssh_upload` / `ssh_download` against this host:

| Option | Behaviour |
|---|---|
| Ask each time | Each command, write, and transfer needs one `danger-full-access` approval (default) |
| Do not ask | Runs directly with no prompt. The card shows an amber label: remote calls need no approval |
| Block calls | This host refuses every remote command and write. The card shows a grey label: remote calls blocked |

Reading remote files (`ssh_read`) is not affected by this setting. A download counts as a write: it creates a file on the machine running DSH, so it follows the write gate rather than the read one.

### Environment source (default: SSH login environment)

Which variables a remote workspace's `bash` runs with:

| Option | Behaviour |
|---|---|
| SSH login environment | Keeps what SSH logged in with, usually just the few in `/etc/environment` (default) |
| Read bash startup files | Captures the variables the startup files export once, and reuses them. The card shows the label plus Re-read environment |

With Read bash startup files, the first workspace command on that SSH connection reads `/etc/profile`, the first readable of `~/.bash_profile`, `~/.bash_login`, and `~/.profile`, then `/etc/bash.bashrc` and `~/.bashrc`. A `~/.bashrc` or `/etc/bash.bashrc` that an earlier file already sourced is not read again. Output from those files is discarded. Reading stops after 10 seconds. If it times out or fails, later commands on this connection keep the SSH environment and the read is not retried.

The variables are reused until the connection drops, the switch goes back to SSH login environment, or Re-read environment is pressed on the card. Re-reading drops only the cache and leaves the SSH connection up; the next workspace command reads the files again, with the same 10 second cap. `PATH` exported by bashrc, such as nvm or cargo, is kept. A bashrc that sets a bad `PATH` keeps that `PATH` for later commands until re-read, disconnect, or switching back.

`PWD`, `OLDPWD`, and `SHLVL` are session state and are not cached. Each command's own bash sets them. `~/.zshrc` is not read. Aliases and functions are not kept: commands found through `PATH` work, shell functions such as `nvm` do not. Each user command is still a fresh bash. `ssh_exec` ignores this setting and stays `bash -lc`.

In the conversation, reading, editing, searching, and shell commands run on the remote machine. The file list on the left, and `@` file completion, still walk the local placeholder directory with the local filesystem, so they do not list remote files. The file tree on the right lists the remote directory; its title stays the placeholder path, and automatic refresh is unavailable. A manual refresh asks the remote host for that directory's names again; whether a file exists, and its size, can stay the previous answer for about 5 seconds. Non-image uploads are copied to `~/.dsh-permission-remote/uploads/` on the remote machine, and the model sees that remote absolute path.

When DSH itself is running on Windows, a remote workspace exposes only the remote `bash` tool. `pwsh`, `powershell`, and `cmd` stay off the native tool list, and the static `tool:pwsh` note about Windows process termination is covered while the session remains on that workspace. Returning to a local directory restores those Windows tools and the original note. A `complete: true` persona such as `minimal` is not rewritten; the tool-list filter and an execution guard keep the Windows shells from running. A built-in preset's `pwsh` sits on an ancestor scope, so entering a remote workspace removes it from the native tool list and from the `ptc` SDK text. A `pwsh` registered on the agent scope itself cannot be removed that way: the SDK text may still name it, the native list is filtered, and the call is denied. File-tool arguments keep the placeholder paths the tools already return.

### Remote root directory and config backup

The Settings page's **Remote root directory** is where every remote-workspace placeholder lives on this machine. It defaults to `~/.dsh/remote` (overridable with `DSH_SSH_REMOTE_ROOT`). Clearing the field and saving goes back to the default. Pressing **Save and migrate** with a new directory:

- copies the whole old `remote` tree when the target is absent or empty;
- merges when the target already has content: missing entries are added, identical files skipped, and a same-named file with different content is left alone until you choose **Keep target (auto-merge)** or **Overwrite from old root**. A name that is a directory on one side and a file on the other is never replaced; it is listed as a conflict for you to resolve by hand. A symlink is copied as a symlink and is never followed; a symlink already in the target is left untouched and listed as a conflict, so the copy cannot write through it;
- refuses a target inside the old root (or the old root inside the target) before copying anything.

If a workspace has a live session the page asks first; the migration re-registers those workspaces under the new placeholder paths and moves their stored sessions to the new root. A moved session's **workspace grouping** is restored on the next DSH start (the registry caches session headers at startup, so the plugin cannot safely re-home them within the running process). Sessions that are open stay in place — they keep talking to their server through the superseded root — and follow once you close them and save again, but a session caught up this way is grouped one start later than the run that moved it. The old directory is kept, so you can delete it once you are happy; only the local placeholder tree moves, and files on the remote servers are untouched. Editing the value in the generic settings editor takes effect immediately but does **not** migrate the old tree; use **Save and migrate** for that. For the rest of this process the old paths still read as remote placeholders, so a session left on one keeps talking to its server — and a placeholder no registered workspace covers is refused instead of quietly becoming a local directory. After a restart the old directory is no longer recognised.

**Host configuration backup** exports the host list as JSON with no passwords or key passphrases (those live only in the credential store). **Import and merge** updates or adds by host id, and only the fields the file actually contains: a row that only renames a host keeps its fingerprint, private-key path, and ops policy. A changed address drops the saved password and, when the file does not include a new fingerprint, clears the old host key. **Import and replace** makes the file the whole list, asks first, and moves hosts the file drops to **deleted hosts** so they can be restored. A host that was already deleted and still has workspaces stays in that list even when the file does not mention it. A merge takes host rows only and ignores the file's deleted-host records. After importing, test the connections again and re-enter secrets as needed; hosts set to `trust` in the file are reported by count. If the file changes an existing host's address, sets that host to `trust`, or relaxes `deny` to `ask`, the page asks before importing. A host the file adds is applied immediately.

### Sidebar terminal

The right sidebar's terminal on a remote workspace connects to that host, not to your computer: the shell menu lists the remote `$SHELL` plus whichever of `bash`, `zsh`, `fish`, and `sh` the host has, and each tab is named after the server (`lo · zsh`). Resize, scrollback, copy, and reattachment after a page reload stay with DSH's own terminal UI.

- **Permissions.** A sidebar terminal is the remote login user's own shell. Like the local sidebar terminal it is **not** wrapped in bubblewrap and does not prompt per keystroke; the only gate is a trusted host fingerprint. Use the `bash` tool when a command should follow the session's permission mode.
- **One shared connection.** Each tab is one SSH channel on this host's single connection, shared with file transfer and remote commands. OpenSSH defaults to `MaxSessions 10` and DSH allows 8 terminals per session. A full connection makes the next tab fail because the host refused another SSH session; closing a sidebar terminal may not free a slot. Raise `MaxSessions` on the remote when it does not.
- **No follow on `working_directory`.** An open terminal keeps the remote directory it started in; a new tab uses the current one. A missing placeholder subdirectory is created before the terminal opens, so the session does not fall back to the workspace root. If that directory cannot be created, DSH restores the workspace root as usual.
- **A dropped connection ends the terminal.** There is no reconnect and no rollback; open a new tab.
- **Sidebar only.** `terminal_open` refuses in a remote workspace and points at `bash` or the sidebar terminal: it asks the local PTY backend for a shell, which would open on your own computer inside the placeholder directory. `terminal_send`, `terminal_read`, and `terminal_list` are untouched; they operate on terminals that already exist.

### Remote ops from an ordinary workspace

A workspace whose directory is on your own computer can also act on a configured SSH host. Every session gets seven tools:

| Tool | Purpose |
|---|---|
| `ssh_hosts` | List host id, name, address, user, ops policy, and whether the host key is trusted |
| `ssh_exec` | Run `bash -lc` on that host, with optional absolute `workdir` and `timeoutMs` |
| `ssh_read` | Read a remote file, capped at 1 MiB, paginated by line; `~/` is expanded |
| `ssh_write` | Replace a remote file atomically with a temp file and `mv -f`. An existing file keeps its permission bits, a new file uses the remote umask, and a directory path is rejected |
| `ssh_upload` | Copy one local file to the remote host. `local_path` is an absolute path on the **machine running DSH**; `remote_path` is absolute or starts with `~/`. The bytes go to a same-directory temp file and are renamed with `mv -f`: a dropped connection never truncates the original, an existing file keeps its permission bits when the server reports them, and a new file uses the remote umask |
| `ssh_download` | Copy one remote file back to this machine. `remote_path` is absolute or starts with `~/`; the parent of `local_path` must already exist. The target is replaced atomically with mode `0600` |
| `ssh_workspace` | Add a workspace for an existing host from one remote directory. The directory must already exist and be a directory, and it cannot be the filesystem root `/`. The title defaults to its name, carrying the server prefix when title tagging is on. Registering the same directory again keeps the existing row and its title, and the result says so |

Each host has a **Remote ops** policy in Settings:

| Policy | `ssh_read` | `ssh_exec` / `ssh_write` / `ssh_upload` / `ssh_download` / `ssh_workspace` |
|---|---|---|
| Ask (default) | allowed | runs only when the session is `danger-full-access`; otherwise the first call is denied and a retry must pass `sandbox_permissions: "danger-full-access"` plus a justification. The approval card names the host and the truncated command or path, and grants this one call. Any other mode does not open a card |
| Trust | allowed | runs without a prompt |
| Deny | denied | denied |

Ops commands, writes, uploads, downloads, and workspace registration are not wrapped in the remote workspace sandbox, because the target is usually a machine outside your local workspace. They need the session's `danger-full-access`, a trusted host, or a one-shot approval. Reads are only limited by Deny.

A download is gated like a **write**: it only reads on the remote side, but it creates a file on the machine running DSH, so it uses `ssh_write`'s gate. That gate only constrains an **Ask** host: under **Trust**, a download — like `ssh_write` — stops consulting the session's mode and shows no prompt, so even a read-only session can write a local file. The same applies in the upload direction: under **Trust** `ssh_upload` reads the local file and sends it without a prompt, so trusting a host also trusts it with the local files a session asks it to upload. Plain text reads still use `ssh_read`, which Deny alone limits.

**One file, no recursion.** Neither tool accepts a directory or resumes a partial transfer. When the final component is a symbolic link both ends refuse it (the remote with `lstat`, the local side with `lstat` plus `O_NOFOLLOW`): `mv -f` would replace the link itself while `realpath` would resolve a live link to its target, and either behavior silently writes somewhere the caller did not name. Linked intermediate directories are ordinary path components. FIFOs, devices, and sockets are refused rather than read as files.

**The ceiling and deadline live on the Settings page** ("Transfer ceiling (bytes)" and "Transfer timeout (ms)" under the Settings tab): 32 MiB and 120 seconds by default, applied to the next call. `0` or an empty field means **no ceiling / no deadline** — with no ceiling the whole file is held in memory; a deadline or cancellation rejects the call during the local read, the remote stat, `~` expansion, and the remote write. The underlying SFTP or `$HOME` probe cannot be interrupted and may finish in the background (`$HOME` stays cached). A timeout or cancellation **may still complete the write**, and a failure may leave a same-directory temp file on the remote; nothing already written is rolled back. The deadline is capped at `2147483647` ms, Node's 32-bit timer limit: a larger delay would fire at once (`setTimeout`) or throw (`AbortSignal.timeout`), so the settings page says it saved the capped value. Both a deadline and a cancellation abort the call, but the plugin renames the **timeout** to `TimeoutError` with the effective milliseconds in the message; a cancellation stays `AbortError`, so the model can tell whether to raise the setting or not retry.

The remote parent directory is created by the upload's `mkdir -p` and keeps its existing permissions (this does not reuse `sftpPutFile`, which would `chmod 700` the parent). A download never creates a local directory tree: a missing parent is an error.

A session in a remote workspace can call both tools too, but there `local_path` means the **machine running DSH**: the `~/.dsh/remote/...` placeholder path the model sees is only a directory skeleton there, and the remote host cannot see it. To move files inside that session, use `bash` on that machine.

`ssh_workspace` does one remote `stat`, then registers the remote real path (a symlink is stored as its target, and the default title is that real path's directory name). A `realpath` failure fails the registration. It does not modify remote files. It only adds a sidebar workspace. Opening that workspace starts a session on that machine, which is why an ask host still requires the same approval as a command. This call does not let the current session enter, and the placeholder path is not returned. Start a session there by opening the workspace from the sidebar. The filesystem root `/` is refused, including when the real path is `/`, because that one workspace would cover the whole machine. Registering the same real path again keeps the existing row and its title, and the result says so.

Requirements: the host fingerprint must already be trusted; `ssh_exec` runs `bash -lc`, so the login profile is sourced to get `systemctl`, `docker`, and similar commands on `PATH` (profile output lands in the command output); `sudo` works only without a password prompt (`sudo -n`) because SSH exec has no TTY; direct Linux or macOS only, with no jump hosts or Windows remotes. Transfers are single files with no recursion or resume; the ceiling and deadline are the settings described above. If the network drops, the running command fails and files already written stay on the remote.

Run Code still executes in the placeholder directory on your computer. The session's `AGENTS.md`, `CLAUDE.md`, and their `.local` files are read through the filesystem service, so a placeholder path reads the remote copy. A global file outside that placeholder, such as `$DSH_HOME/AGENTS.md`, stays on your computer. Each prompt walks the ancestor directories and stats those files on the remote host. The prompt text differs from the local copy, so a previously cached prefix no longer matches.

**`present` works in a remote workspace too.** DSH's `present` only understands local files: it `stat`s each path, records the path in the session, and the delivery card opens that same path through your local filesystem. Left alone, every remote delivery failed with `Cannot present ...: file not found`, because the placeholder directory holds directories, not the remote file. The plugin takes the call over: it confirms on the remote that each file exists, is a regular file, and is at most 32 MiB, copies the bytes to the matching placeholder path, then calls the official `present` with those placeholder paths. The card, the sidebar preview, and open-in-application all get a real local file, and the original on the remote is untouched. Arguments and output keep the official shape, and `description` is passed through.

A few consequences:

- **A copy appears under the placeholder root** (default `~/.dsh/remote`), mode `0600`. Delivering the same path again replaces the copy: the event records only the path and the card shows whatever is there, so a second delivery of an updated file would otherwise keep showing the first bytes.
- **Files over 32 MiB are refused**, naming the real size and the remote path. A silently truncated copy is worse than a refusal.
- **One bad file fails the whole call.** A missing file, a directory, or an oversized one means no delivery event is written, so a half-delivered turn never reaches the log.
- **Copy, not move.** The file on the remote host is untouched, and the placeholder copy is not refreshed when the remote file later changes; deliver it again.

You can connect directly to one Linux or macOS machine. Jump hosts and Windows remotes are not supported. If the network drops, the operation in progress fails. Files already written on the remote stay there: reconnecting does not write them again and does not undo them.

On Linux, install bubblewrap on that machine if commands should follow the current permission mode. The settings page can install it, and it also shows the command you can run yourself.

### Optional `apply_patch` and `str_replace_editor` (DSH 0.2.2)

DSH 0.2.2 brings two optional file tools that, in a remote workspace, also act on the remote host. Both are off by default and the plugin does not enable them for you; you opt in through the preset or composition. Setting `applyPatch: true` on `@deepseek-ai/dsh-tool-fs` registers `apply_patch` (every official preset leaves it `false`), while `@deepseek-ai/dsh-tool-str-replace-editor` is a standalone package mounted only in custom compositions and absent from the default presets.

Paths:

- `apply_patch` paths are resolved against the session working directory (the local placeholder directory), or given as absolute placeholder paths.
- `str_replace_editor` requires absolute paths, so pass back the placeholder paths that `read` or the file tree returned. A real remote absolute path such as `/home/me/project/a.ts` is rewritten by the plugin to that same host's placeholder path, so it never reads or writes a local file by that name; when the tool's rewriting shadow is not mounted, such a call is refused instead, still without touching a local file. Real remote absolute paths belong in `bash` commands only.

Behaviour: `apply_patch` add / update / delete / move and the editor's view / create / str_replace / insert all run on the remote host and obey the session Permissions selector, approval cards, and the remote sandbox, delete and move included. A whole patch is preflighted first, then its operations commit in order and are not rolled back on failure. A move that has published its destination but cannot delete the source keeps that destination and reports the failure.

Limits: UTF-8 text only, no binary files, and no rollback. `str_replace_editor` has no one-shot `sandbox_permissions` / `justification` escalation, so use the session's standing Permissions mode. Move spans two paths and is not atomic; delete touches a single path.
