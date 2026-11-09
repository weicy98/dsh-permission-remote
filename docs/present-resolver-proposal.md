# 提案：让 `present` 直接支持远端交付（`DeliverableResolver`）

**状态**：设计文档，未实现。本次改造**没有**动上游代码，插件侧仍然预复制字节。

## 问题

`@deepseek-ai/dsh-tool-present` 的契约是「路径字符串」：

```js
const entry = await ctx.fs.lstat(file.path, { cwd }, exec.signal);
const target = await ctx.fs.resolve(file.path, options);
const info = await ctx.fs.stat(target, exec.signal);
files.push({ ...file, path: ctx.fs.processPath(target) });
```

事件 `deliverables/presented` 里只有 `{ path, description }`，没有字节、URL 或句柄。

打开卡片时，`dsh-client-ui-deliverables` 用 `workspaceFiles.stat({ workspaceRoot }, file.path)` 取 `absolutePath`，再进 `openVerified`：

```js
const mapped = fs.processPathFromHostPath(path);
if (mapped === void 0 || fs.processPath(await fs.resolve(mapped, { signal })) !== path)
  return new Response("Path has no verified Host path.", { status: 422 });
await ctx.sessionController.openWorkspacePath({ path, ... }, signal);
```

会话控制器里的 `verifyDesktopPath` 是同一个强等判断。

于是有三条硬约束，插件一个都绕不过：

1. 事件里的 `path` 必须能被 Host 的原生打开器当作**本机绝对路径**打开；
2. 它必须能在 `processPath(resolve(...))` 往返后**逐字符相等**；
3. 事件不带内容，所以本机必须真实存在一份字节。

远端会话没有本地文件，所以插件只能预复制。这就是 `docs/advanced.md` 里那套快照机制的由来，也是它全部复杂度的来源：内容寻址、流式落盘、只读守卫、TTL 回收、`lexicalPath` carve-out、`{ cwd }` 探针。

**只要约束 1 和 2 不松动，预复制就省不掉。**

## 提案

给事件条目加一个可选的来源描述，并让 Host 在打开时按需物化。

### 1. 事件 schema（向后兼容的加字段）

```ts
interface PresentedFile {
  path: string            // 保持原样：本机路径，旧 Host 只认它
  description?: string
  source?: {              // 新增，可选
    kind: 'remote'
    hostId: string
    remotePath: string
  }
  displayPath?: string    // 新增，可选：给用户/模型看的名字
}
```

`path` 仍然是必填的本机路径。旧 Host、旧客户端、旧的日志读取方全部不受影响——新字段被忽略。

### 2. Host 侧 `DeliverableResolver` 服务

```ts
interface DeliverableResolver {
  /** 这个条目现在是否可以打开（文件存在 / 远端可达）。 */
  available(file: PresentedFile, signal: AbortSignal): Promise<boolean>
  /** 打开前把条目物化成 Host 可打开的本机路径。 */
  materialize(file: PresentedFile, signal: AbortSignal): Promise<{ hostPath: string } | undefined>
  /** 可选的清理钩子。 */
  release?(hostPath: string): Promise<void>
}
```

`handlePresentOpen` 改成：

1. 若条目有 `source` 且注册了 resolver，先 `materialize()`；
2. 拿到 `hostPath` 后，**仍然**走现有 `openVerified` 的往返校验（不放松约束 2）；
3. 没有 `source` 时行为与现在完全一致。

关键点：`materialize()` 是**懒**的，只在用户点开时发生。所以

- 不需要在工具调用期间复制字节，模型那次调用不需要等传输；
- 用户不点的交付不产生任何磁盘占用；
- 远端失联时，`available()` 返回 false，卡片显示"远端不可达"而不是 404；
- 物化仍然要落盘，但可以落在 Host 自己的缓存里并由 Host 管理生命周期，插件不必再实现一套 TTL。

### 3. 需要改的包

| 包 | 改动 |
| --- | --- |
| `@deepseek-ai/dsh-tool-present` | 参数/输出 schema 加可选 `source`；`execute` 里对 `kind: 'remote'` 的条目跳过本地 `lstat`/`resolve`/`stat`，保留 `path` 作为兼容占位；`presentCall` 展示 `displayPath` |
| `@deepseek-ai/dsh-fs`（或 Host 新包） | 定义 `DeliverableResolver` 契约与注册点 |
| `@deepseek-ai/dsh-client-ui-deliverables` | `handlePresentOpen` 先 `materialize()`；卡片按 `displayPath` 显示名字，`available()` 为 false 时显示不可达 |
| `@deepseek-ai/dsh-api-session-controller` | `verifyDesktopPath` 不变（物化后的路径仍要往返） |
| 本插件 | 注册 resolver：`materialize()` 从远端流式读一份到 Host 给的缓存路径；删掉现有的预复制与快照生命周期 |

### 4. 兼容策略

- **旧事件**：没有 `source`，行为不变，仍然按 `path` 打开。
- **旧 Host + 新事件**：`source` 被忽略，`path` 要是有效本机路径——所以实现时**仍然要**写一份，或者接受旧 Host 上打不开。这是提案里唯一需要产品决定的地方：要么接受"新交付在旧 Host 上不可打开"，要么继续双写。
- **SSH 断连**：`available()` 返回 false；`materialize()` 可以返回最近一次物化的副本（如果 Host 缓存还在），否则明确报不可达。
- **远端文件已删除**：卡片报"远端文件已不存在"，不再尝试本地副本。

### 5. 为什么这是唯一能彻底去掉预复制的路径

只要事件里只有本机路径、且打开时要求本机路径往返成立，远端字节就必须在用户打开之前存在于本机。可以变化的只有**何时**和**由谁**复制：

- 现在：工具调用时、由插件复制到插件管理的快照里；
- 提案：用户点开时、由 Host 复制到 Host 管理的缓存里。

后者省掉了插件侧的全部复杂度（快照命名、只读守卫、carve-out、TTL、探针），也顺手解决了"交付了但没人看"的磁盘浪费。但它需要改四个上游包和一次产品决定，所以本文档只写设计，不在这次改造里做。

## 附录：这次改造实际依赖的上游事实

`scripts/check-upstream.mjs` 会断言这四条，任何一条变了说明接缝位移：

1. `present` 用 `ctx.fs.lstat(path, { cwd }, …)` 校验——带 Session cwd；
2. `present` 用 `ctx.fs.resolve(path, options)` 解析，`options` 含 `cwd`；
3. `present` 对解析后的 target 做 `ctx.fs.stat(target, …)`；
4. 事件里记录的是 `ctx.fs.processPath(target)`，不是模型传的字符串。

第 1、2 条的 `{ cwd }` 尤其承重：插件在 `remote-fs.ts` 的 `lexicalPath` 里给快照路径留了一条早退，只有调用方带着远端 cwd 时这条早退才被走到。上游哪天不再传 cwd，这条 carve-out 就变成死代码，而 mock 测试看不出来。
