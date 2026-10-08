# dsh-archive-cleanup

一键清理 DeepSeek Harness（DSH）里**已归档的会话**。

中文 | [English](README.md)

> **0.4.0 行为变化（本次）**：清掉的行**不再回来**。0.3.0 只把那一行从浏览器**当前**的列表快照里去掉，但 host 会为每一次列表拉取重新算一份——而 DSH 的列表**优先返回还活着的内存会话，且不检查它的文件是否还在**，所以刷新页面、重连、或者点开「上下文洞察」（它会调 `sessions.refresh()` 重新拉一次 `session.list`）都会把刚删掉的那一行又拉回来。0.4.0 让 host 半边把自己清掉的 id 记住，并把这些 id 从 host 的会话列表读口（`sessionController.list`）过滤掉（§1.3），于是**任何一次后续拉取都不再返回它**。进程内存里那条会话对象仍然留到进程退出（DSH 没有卸载常驻 Agent 的 API），但它不再出现在任何列表里。
>
> **0.3.0 行为变化**：点一次「永久删除」**当场完结**——磁盘产物删掉，归档登记也当场撤掉，浏览器里那一行立刻消失，**不需要重启 Harness**。0.2.x 为了不让"有会话、没文件"的空行回到侧栏，把被进程持有会话的登记写进 `pending.json`，等下次启动才清；0.3.0 改成"当场释放 + 主动告诉浏览器丢掉这一行"（§1.2），并把 0.2.x 留下的 `pending.json` 一次性迁移掉。0.1.x/0.2.x 的旧行为见 §7 的历史记录。

DSH 能归档一个会话（把它从所有分组界面隐藏），但**没有删除会话的能力**：归档集合、`$DSH_HOME/sessions` 下的 JSONL 日志目录、`$DSH_HOME/storages/session_projcache` 下的投影缓存记录都会永久留在磁盘上。这个插件给归档会话补上一条受支持的删除路径。

```
侧边栏左下角  🧹 12   ← 点一下 → 确认对话框 → 真的删得掉
设置 → 归档清理        ← 完整列表：标题 / 目录 / 时间 / 占用，逐条勾选
```

左下角那个数字是**跟着归档集合实时走的**：在侧边栏右键归档一个会话，芯片立刻出现并显示 `1`；再归档一个就是 `2`；取消归档（或清理掉）回到 `0` 时芯片自己消失——不需要刷新页面、不需要重新扫描。原理见 §1.1。

---

## 1. 它到底删了什么

对每一条被确认删除的归档会话：

| 目标 | 位置 | 手段 |
| --- | --- | --- |
| 会话日志目录（含 `session.v4.jsonl.zstd`、`session.lock`、会话私有产物） | `$DSH_HOME/sessions/<project-key>/<session-id>/` | `fs.rm(recursive)`，删除前做**根目录包含性校验** + 目录名必须等于会话 id |
| 投影缓存文档 | `$DSH_HOME/storages/session_projcache/sessions/<session-id>.json` | `fs.rm`，同样做包含性校验 |
| 归档登记 | `$DSH_HOME/storages/workspace.json` → `global.archivedSessionIds` | **不直接写文件**，调用 `WorkspaceRegistry.unarchiveSession(id)`；**当场完成**（0.3.0 起不再有 `pending.json`，见 §1.2） |
| 工作区登记 | `workspace.json` → `tables.workspaces[*].sessionIds` | **不直接写文件**，调用 `Workspace.detachSession(id)` |
| 浏览器里的会话行 | 已连接 Web GUI 的 Session 列表 | 由 host 发出 DSH 自己的 `api-session/removed` 帧（`session/disposed` 用的同一条边），侧栏当场把那行从列表里去掉，不用刷新页面（见 §1.2） |
| 之后每一次列表拉取 | host 的会话列表读口 `sessionController.list`（侧栏、`sessions.refresh()`、上下文洞察都走它） | host 半边把自己清掉的 id 记在内存里，并把这个读口包起来过滤掉它们（见 §1.3） |
| 只剩归档登记的"幽灵"条目（日志目录与缓存都已不在） | 同「归档登记」 | 没有文件可删，`unarchiveSession(id)` 就是全部工作；报告里记为 `released`，不写 `skipped` |

后两项是这套实现最关键的设计：`workspace.json` 由 `dsh-storage-json` + `dsh-storage-domain` 托管，有一份内存权威状态和一条写链。绕过它直接改文件会与内存态冲突，所以插件只走公开 API（`Workspace` 接口上的 `detachSession`、`WorkspaceRegistry` 上的 `unarchiveSession`），由 storage domain 自己负责落盘和事件广播。

### 1.1 左下角为什么能「点完就变」

芯片的显示与否、以及那个数字，**不是**拿扫描结果算的，而是直接跟着浏览器里 Workspace Controller 客户端的归档集合走：

```js
// ctx.workspaces.list（dsh-api-workspace-controller 的客户端服务）
const { phase, archivedSessionIds } = source.getSnapshot()
source.subscribe(sync)   // 归档 / 取消归档 / 别的标签页归档，都会推到这里
```

* **数字 = `archivedSessionIds.length`**。这个集合就是 host 侧 `WorkspaceRegistry.archivedSessionIds` 在浏览器里的投影，也就是 `GET scan` 遍历的同一个集合，所以两边永远一致。0.3.0 起清理会**当场**把这个 id 从集合里拿掉，因此"点完就归零"不需要任何减法或补偿逻辑。侧边栏自己的右键菜单走的也是同一个服务（`ctx.workspaces.archiveSession`），归档一落盘订阅就响——芯片随即出现/加一/消失。
* **计数 = 0 时芯片不渲染**（`return null`）。这正是「点完归档左下角就显示出来」：没有归档时左下角是干净的，第一条归档进来它才出现。
* **字节数仍来自 `GET scan`**。归档集合一变，插件会在 250 ms 防抖后悄悄重扫一次列表（一次归档会先后收到一元回显和流增量两个通知，防抖把它们并成一次请求）；芯片的数字不等这次扫描，只有 tooltip 里的占用空间等它。清理（purge）自己会刷新列表，所以那条路径不会再排一次扫描。
* **没有基线就不猜**。客户端快照的 `archivedSessionIds` 初始是 `[]`、`phase` 是 `'pending'`，直到 follow 流装上 baseline 才作数；`phase !== 'ready'` 时插件读成「未知」（`null`），回落到扫描结果，而不是把「还没加载」显示成「没有归档」。

服务获取用 `ctx.get('workspaces')` 而不是把它写进 `inject`：写进去就等于「没有 Workspace 层的 profile 里整个插件不激活」（连设置页都没有），而那种 profile 里 host 侧的 `GET scan` 本来也只回 501。服务还没起来时用 `ctx.inject(['workspaces'], …)` 等它，而不是轮询（测试里两条路径都覆盖了）。

### 1.2 被进程持有的归档会话：一次点击，当场完结

**问题**：DSH 只要**打开过**一个会话，host 就把它 `promote()` 成一个常驻内存的 Agent（`promote → agents.resume`），而 `archiveSession` 只写归档集合 + 停掉正在跑的工作，**没有任何卸载它的 API**（§2 的调研结论）。于是「刚看过的那个会话」在被归档之后依然 `live`，日志写锁还在 host 手里。更麻烦的是 host 的会话列表 `ApiSessionList.list()` 会**优先列出还活着的内存会话**（`ctx.sessionQuery.listSessions()` 含 live 记录，命中 live 时连 `cwd` 都不检查），所以只要进程还活着，这条会话就会一直作为一行被列出来。

**0.1.x 的做法是整条跳过**（`skipped: {reason: "live"}`，提示"重启 dsh web 之后再来清理"）；**0.2.x 改成两段式**：磁盘当场释放，登记写进 `pending.json`，下次启动补完——用户不用再点，但"重启才生效"的观感还在。

**0.3.0 的做法是三层，全都在这一次请求里完成**：

```
点「永久删除」
  ├─ 冷会话                    → 删文件 + 释放登记（detach + unarchive，一步到位）
  ├─ 被本进程持有的归档会话      → flush 写句柄 → 删文件 → 释放登记 → 发 api-session/removed
  │                              （浏览器当场把那一行从 Session 列表里去掉）
  └─ 回合仍在跑               → 先不动（queued），在该 Agent 转入 idle 的那一刻自动补做
```

1. **文件为什么能当场删**：`ArchivedSessionGate` 会对归档 lineage 的每一步 `agent/pre-step` 直接 `reject`，这条会话不会再产生新事件；删除前先 `sessions.flush(session)`（`sessionPersistence.flush()` 兜底）把写句柄里缓冲的事件排空，句柄的 `state.materialized` 已是 `true`，向后的 `append` 是对**旧路径** `open(path, "a")`，目录不在就 ENOENT，**不会重建目录**；被删的只有归档集合里的 id，存活的**派生会话**（子代理 / fork 子会话）依然整条跳过。
2. **登记为什么能当场撤**：`unarchiveSession(id)` 只是把 id 从归档集合里拿掉——这是权威状态，storage domain 落盘并广播 `domain/changed`，`WorkspaceFeed` 随即推 `archived` 帧，侧栏的归档过滤、`GET scan`、芯片计数同时更新。0.2.x 担心的"有会话、没文件的行冒出来"由第 3 层解决。
3. **为什么要主动发 `api-session/removed`**：host 之所以会重新列出这条会话，是因为它还在内存里（见上）。插件没法把它卸载，但可以发**DSH 自己那条列表移除边**——`dsh-api-remotes` 的转发白名单里有 `api-session/removed`，浏览器端 `dsh-api-session-controller` 收到就把它从列表快照里 `remove` 掉，这正是 `session/disposed` 平时触发的路径。于是侧栏那一行在点击落下的一瞬间就消失，不需要刷新页面。emit 是 best-effort：profile 里没有远端桥时退化为"只完成持久层释放"。这一帧只管**浏览器此刻手里那份快照**；让后面的每一次拉取也看不到它，是 §1.3 的事。
4. **回合还在跑的行**：不在写入过程中 unlink，登记也一起留着。插件监听 `agent/status`，一旦该 Agent 不再是 `running` 就自动重跑这一条（`queued` → 完成），**不依赖重启**。

`pending.json` 作为机制已经删除。只保留一段**一次性迁移**：0.2.x 的进程可能留下这个文件，插件激活时读它、把其中"已归档且当前为冷"的 id 释放掉，然后删掉文件；仍然被持有的、或用户已经取消归档的 id 一律原样放过（文件也不动）。没有 Workspace 层的 profile 会保留这个文件，等下一次启动再迁移。


### 1.3 为什么刷新 / 重连 / 点「上下文洞察」都不会把那一行拉回来

**症状**：刚才那条归档会话清理完确实从侧栏消失了，但一点「上下文洞察」（`dsh-context` 的第一级面板）它又冒出来了。

**根因**：`api-session/removed` 只作用在浏览器**此刻**持有的那份列表快照上，而列表是可以重新拉取的：

```
点开「上下文洞察」
  └─ dsh-context 客户端 refreshSessions()          // dsh-context/lib/client.js
       └─ ctx.sessions.refresh()                    // dsh-api-session-controller 客户端
            └─ remote.session.list({})              // RPC
                 └─ host: SessionController.list()
                      └─ ApiSessionList.list()
                           └─ 先看 ctx.sessions.get(id) 是否还活着   ← 这里
```

`ApiSessionList.list()` 对每一条记录**优先取还活着的内存会话**，命中就直接 `summaryFor(live)`，既不检查文件是否还在、也不看归档集合（归档只影响界面过滤，不影响这个读口）。而 DSH 只要**打开过**一个会话就把它 `promote()` 成常驻 Agent（§1.2，没有卸载 API），于是插件清完文件、撤完登记之后，这一条**仍然是 live**：下一次拉取照样把它当一行返回。侧栏刷新、浏览器重连、`dsh-context` 的 `sessions.refresh()`——三条路走的是同一个读口，所以行为一致。

**修法**：host 半边把"本进程清掉的 id"记在一个内存集合里（`purgedSessionIds`），并在插件激活时把 `sessionController` 这个读口包一层过滤器（`hideRemovedSessions`）：

```js
controller.list = async (request, signal) => {
  const value = await inner(request, signal)
  const kept = value.items.filter((row) => !purgedSessionIds.has(String(row.sessionId)))
  return kept.length === items.length ? value : { ...value, items: kept }
}
```

几个刻意的选择：

* **记的是 id，不是"从列表里删过的行"**。`deleted` / `released` / `freed` 三种结局都会进这个集合（`queued` 不会：它的文件和登记都留着）。`dryRun` 和 `skipped` 不进。
* **不落盘**。id 一旦被清掉就没有文件、也不该再被列出，下一个进程既看不到它的持久化记录、也不会有它的 live 会话，所以不需要任何状态文件（这正是 0.3.0 删掉 `pending.json` 的同一个理由）。
* **过滤只发生在这个读口**。`sessionQuery` 的语义（"live 优先的逻辑全量")没有被改，`session/disposed`、归档集合、workspace 记账也都照旧；被过滤的只有"服务端准备发给浏览器的那份列表"。
* **包装是实例级的、跟着插件 fiber 卸载**：`hideRemovedSessions` 返回卸载闭包，由 cordis 在插件卸载 / 重载时调用（§9），重复加载不会套娃。
* **拿不到这个读口就降级**：`sessionController.list` 不是一个可包装的函数（上游改了服务名或读口）时，插件只记录一条诊断，行为退回 0.3.0 的"当前快照移除"。
* **内存里那份副本依然在**。这不是卸载，也没有让 DSH 释放它——DSH 没有这个能力（§2）。被清掉的会话在进程内存里留到进程退出，只是它**不再出现在任何列表里**，也不再占用"待清理"计数（归档集合里已经没有它了）。


### 为什么靠"目录名匹配"定位文件

插件的 host 半边**没有**重新实现 session-persistence-jsonl 的路径编码（`projectKey(cwd)` + `encodeSegment(id)`）：

```js
// 索引 $DSH_HOME/sessions/*/ 下每个目录的 basename
// → Map<sessionId, "/abs/path/to/session/dir">
```

因为"会话目录永远以它自己的 id 命名"，按 basename 建索引既准确又和后端编码解耦——上游哪天改了 `projectKey` 的转义规则，这个插件不用改。

---

## 2. 为什么 DSH 需要这个插件（调研结论）

翻遍 `@deepseek-ai/*` 全部包后确认：

* `WorkspaceRegistry` 只有 `archiveSession` / `unarchiveSession` / `pinSession` / `unpinSession`，**没有任何 delete**。
* `SessionPersistence`（`dsh-session-persistence` 抽象类）只有 `create` / `open` / `stat` / `list` / `flush`——**没有 delete**。
* `SessionProjectionCache` 是"fold shortcut, never an authority"（自述），**没有 delete**。
* Web GUI 的会话右键菜单只有 `archiveSession` / `unarchiveSession` / `pinSession` / `fork` / `rename`——`menu.deleteSession` 这个 i18n key 根本不存在。
* CLI 也没有 `dsh session rm` 之类的命令。

也就是说"删除会话"在 DSH 里是**能力缺口**，不是配置问题。这个插件正是补这个缺口：文件层自己删，登记层走公开 API。

---

## 3. 结构

```
dsh-archive-cleanup/
├── package.json          # dsh.bundle.patch + dsh.client（platform: web）
├── cordis.patch.yml      # profile 里的插件行
├── lib/
│   ├── index.js          # host 半边：两条 loopback 路由 + 全部删除逻辑（零运行时依赖）
│   └── client.js         # 浏览器半边：footer 芯片 + 确认弹窗 + 结果横幅 + 设置页
└── test/
    ├── smoke.mjs         # 伪造 DSH home：scan / 拒绝 / 试运行 / 删除 / 幂等 / 幽灵释放 / 持有会话当场完结 / idle 补做 / 旧账本迁移
    ├── routes.mjs        # 真实 node:http 服务：守卫头、跨域拒绝、confirm、405、持有会话的端到端流程
    └── client.mjs        # 模拟 __ModuleLoader__ 握手：apply/inject、插槽注册、芯片计数、弹窗关闭
```

**没有运行时状态文件了。** 0.2.x 的 `$DSH_HOME/storages/archive-cleanup/pending.json` 只在迁移时被读一次，然后删除（§1.2）。

host 半边注册两条路由：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/dsh-archive-cleanup/scan` | 列出归档集合：id、标题、cwd、创建时间、占用字节、文件数、是否有日志 / 缓存、`live` / `busy` 两个状态位，外加 roots 与上限 |
| `POST` | `/dsh-archive-cleanup/purge` | `{ids:[...]}` 或 `{all:true}`，可带 `includeDescendants`、`dryRun`、`confirm` |

它还在 `sessionController` 可用时装一个**会话列表读口的过滤器**（§1.3）：两条路由都不经过它，它是"清完之后那一行不许再回来"的那一半。

---

## 4. 安全设计（这是破坏性插件，逐条都有测试覆盖）

1. **只能删归档集合里的 id。** 传一个未归档 / 已 pin / 只是"存在"的 id，返回 `refused: [id]`，一个字节都不动。测试 `smoke.mjs` 的 `refusal` 段覆盖。
2. **被持有的会话当场完结，存活的派生会话永远跳过。** 每一条都先问 `ctx.agents.get(id)` / `ctx.sessions.get(id)`。归档集合里的 id 命中即走 §1.2 的路径：`flush` → 删产物 → 释放登记 → 发 `api-session/removed`（报告里的 `freed`）；**非归档的派生会话**命中即 `skipped: {reason: 'live'}`，一个字节都不动。注意 live 不是"正在跑"而是"仍被本进程持有"：DSH Web 只要**打开过**一个会话就会在 host 里 `promote()` 出一个常驻 Agent，而 `archiveSession` 只写归档集合 + 停掉正在跑的工作，**没有任何卸载它的 API**；插件因此改为"持久层当场清干净 + 通知浏览器丢掉那一行"，进程内存里那份副本则留到进程结束。`busy: true`（回合还在跑）的行连文件都不动，登记也留着，由 `agent/status` 的 idle 边自动补做（报告里的 `queued`）。设置页与弹窗都会把这两种原因显式写给用户。
3. **无产物的归档登记照样释放。** 日志目录与投影缓存都不在了的归档 id（早先手动 `rm`、上一次清理中途失败、或从未落盘的会话）不再进 `skipped`，而是进 `released`：它没有文件可删，但那条登记本身还占着所有归档界面，清掉它就是全部工作。上游 `unarchiveSession` 的契约明确允许"会话已经不在"的 id（删一个 id 不可能引入未知会话），所以这条路径不碰磁盘、也不需要存在性检查。**非归档的派生会话即使没有产物也仍然跳过**（它本来就没有登记可释放）。测试 `ghost release` 段覆盖。
4. **路径包含性校验。** 删除前 `isInside(root, target)`，且会话目录的 basename 必须严格等于 id。伪造/越界的索引项会被拒并写进 `warnings`。
5. **POST 需要自定义守卫头。** `x-dsh-archive-cleanup: 1`。浏览器跨域请求加不了自定义头（会先发 preflight），而本服务从不返回宽松 CORS；再叠加 `Origin` 与 `Host` 一致性检查。测试 `routes.mjs` 覆盖 403 两条分支。
6. **必须显式确认。** 非 `dryRun` 请求必须带 `confirm: true`，否则 400。
7. **`dryRun` 先看后删。** 设置页的"预演"按钮就走这条路：只统计条数与字节，不碰文件系统，也不碰 registry，也不发任何帧（被持有的会话只预演成 `freed`）。
8. **一次请求有条数上限。** `maxSessions`（默认 1000），超了直接 400。
9. **幂等。** 档案空了之后再调用返回全零报告，不报错；重复清理一条已经释放过的会话不会再被当成归档 id（它已经不在归档集合里），会以 `refused` 收场，不会假装又干了一遍活；`api-session/removed` 的重复投递在浏览器端也只是把已经从快照里删掉的行再删一次。

### purge 报告的结果

```jsonc
{
  "deleted":  [ /* 文件已删 + 登记已释放 */ ],
  "released": [ /* 无产物：只释放了登记，removedDir/removedCache 均为 false */ ],
  "freed":    [ /* 被持有：文件已删 + 登记已释放 + 已通知浏览器（held/unarchived/announced 均为 true） */ ],
  "queued":   [ /* 被持有且回合在跑：文件与登记都原样保留，reason: "busy"，idle 时自动补做 */ ],
  "skipped":  [ { "reason": "live" } | { "reason": "no-artifacts" } | { "reason": "error" } ],
  "totals": { "count": 0, "deleted": 0, "released": 0, "freed": 0, "queued": 0, "bytes": 0 },
  "remaining": 0
}
```

`totals.count = deleted + released + freed + queued`。字节只统计真正删掉的文件，所以幽灵条目贡献 0 字节，`queued` 永远是 0 字节。`refused` / `warnings` 仍然按需出现。

`GET scan` 的每个会话行额外带两个布尔：`live`（仍被本进程持有）、`busy`（回合还在跑）。0.2.x 的 `pending` 字段与顶层账本已经取消。

---

## 5. 安装

```bash
# 从本地目录安装（开发中）
dsh plugin --profile web add /home/deng/.dsh/plugins/dsh-archive-cleanup

# 或者发到 npm 之后
dsh plugin --profile web add dsh-archive-cleanup
```

`dsh plugin add` 走的是 profile 自己的 pnpm：它把依赖写进 `$DSH_HOME/profiles/web/package.json`，再把包名追加到同一份 `dsh.profile.bundles` 列表里。**插件代码只在进程启动时加载**，所以装完 / 改完 host 半边仍需重启 DSH Web（浏览器硬刷新）：

```bash
dsh web
```

验证六点：

1. 侧边栏左下角出现 `🧹 N` 芯片（N = 当前归档条数；没有归档时芯片不显示）。
2. **右键归档一个会话，芯片随即出现**并显示 `1`（第二个变 `2`，取消归档回到 `0` 时消失）——不用刷新页面。
3. 设置页出现「归档清理」分区，列出每条归档会话的标题 / 目录 / 大小。
4. `GET http://127.0.0.1:<port>/dsh-archive-cleanup/scan` 返回 `{"ok":true,...}`。
5. **点「永久删除」立刻见到结果**：弹窗关闭，底部横幅报出结果，芯片计数**当场归零**，侧栏里那一行也**当场消失**——被持有的会话同样如此，不需要重启 `dsh web`（重启只影响进程内存里那份已无文件的会话副本，见 §8）。
6. **那一行不会回来**：刷新页面、重新连接、或点开侧栏的「上下文洞察」（`dsh-context`，它开面板时会 `sessions.refresh()` 重新拉一次 `session.list`），刚清掉的那条都不再出现（§1.3）。

### 卸载

```bash
dsh plugin --profile web remove dsh-archive-cleanup
```

---

## 6. 配置

`cordis.patch.yml` 里那行可以带 `config`，全部字段都有默认值：

```yaml
- insert:
    - id: archive-cleanup
      name: 'dsh-archive-cleanup'
      config:
        includeDescendants: true   # 默认 true：连带删掉子代理 / fork 出来的子会话
        maxSessions: 1000          # 单次请求最多删多少条
        announceToAgent: true      # 在系统提示里声明插件，让 agent 也能帮你清
        # sessionRoot: /custom/sessions          # 默认 $DSH_HOME/sessions
        # storageRoot: /custom/storages          # 默认 $DSH_HOME/storages
        # legacyPendingFile: .../archive-cleanup/pending.json   # 默认 $DSH_HOME/storages/archive-cleanup/pending.json（只读：0.2.x 遗留账本的一次性迁移）
```

`$DSH_HOME` 的解析顺序与 harness 一致：显式 `dshHome` > 非空 `DSH_HOME` 环境变量 > `~/.dsh`。

---

## 7. 开发与测试

```bash
cd dsh-archive-cleanup
npm test        # 三个测试文件，零依赖，纯 node:test 风格的断言脚本
```

三个测试都不需要 DSH 进程：

* `smoke.mjs` 造一个假的 `$DSH_HOME`（照着真实磁盘布局：一个 cwd 一个工程目录、一个会话一个目录、一个会话一份投影缓存文档），用假 ctx 驱动导出的 `scanArchive` / `purgeArchive` / `releaseAccounting` / `applyPending` / `deferBusyCleanups` / `hideRemovedSessions`，覆盖 scan、拒绝、预演、真删、幂等、幽灵登记释放、被持有会话的当场释放（`freed` + `api-session/removed` 帧 + 登记离开集合）、回合在跑时的 `queued` 与 idle 边自动补做、0.2.x 账本的一次性迁移（冷条目释放 / 被持有或已取消归档的条目原样放过 / 文件删除）、**列表过滤器**（清掉的 id 不再被 `list` 返回、无关行与返回值其余字段原样通过、卸载后读口恢复原状、没有可包装的服务时不报错），以及 registry 与 emit 失败时的降级路径。
* `routes.mjs` 把真实 handler 挂到真实 `node:http` 服务上，用真实 `fetch` 打，验证守卫，并跑一遍"路由清理被持有的会话 → 当次请求内登记消失、浏览器收到移除帧 → 之后每一次列表拉取都不再返回它"的端到端流程（假 `sessionController` 走的是 `apply` 真正装上的那个包装）。
* `client.mjs` 伪造 `window.__ModuleLoader__` 与 `react`，验证浏览器半边只 require `react`、只注册它声明的那三个插槽，并驱动「活归档集合」那条链路：假 `workspaces.list` 推一次归档，芯片就从 `null` 变成 `1`、再变 `2`，清空后回到 `null`；一次突发的多次通知只换来一次防抖后的 `GET scan`（`fetch` 被替换成计数器）；服务晚到（`ctx.get` 取不到）时走 `ctx.inject` 绑定同一个 store；以及 0.3.0 的交互契约——点「永久删除」后弹窗关闭、结果横幅给出摘要、归档集合一空芯片立刻消失，而请求失败时弹窗保留错误。

另外，host 半边在本机真实 `~/.dsh` 的**副本**上跑过完整流程（registry 用桩，不动真实 home）：

```
0.2.x（历史）：
scan before   : { count: 1, bytes: 718097, live: 1, pending: 0 }   log dir exists: true
purge         : freed 1（718097 字节，目录与投影缓存消失，flush 先跑过）
repeat purge  : { freed: 0, already: 1 }
scan after    : { count: 1, bytes: 0, pending: 1 }
下次启动       : applyPending 释放 1 条登记，pending.json 删除

0.3.0（同一条被持有的会话）：
purge         : freed 1（字节当场释放 + unarchive + detach + api-session/removed 已发出）
scan after    : { count: 0, bytes: 0 }         ← 同一次请求内，归档集合已经空
repeat purge  : refused 1（已不在归档集合）
下次启动       : 无遗留账本可迁移，pending.json 不再生成
```

0.1.1 的 `released` 路径来由（历史记录，留着解释"幽灵条目"）：

```
archivedSessionIds: [ session-e5f9ee57-…, session-93125401-… ]

scan: session-e5f9ee57-…   title=(空)  bytes=0       hasLog=false hasProjectionCache=false live=false
      session-93125401-…   title=…      bytes=767359  hasLog=true  hasProjectionCache=true  live=true
```

`session-e5f9ee57-…` 当时还有 `{"bytes":116985,"files":2}` 的目录和缓存——文件后来没了、归档登记却留着，正是这类"幽灵"条目逼出了 `released` 这条路径。

**0.3.0 还在一个隔离的 `DSH_HOME` 上真起过一次 `dsh web`**（临时 profile 只挂 `dsh-base` + `dsh-web-app` + 本插件，端口 3099，用真实日志文件播种了一条归档会话）：

```
GET  scan      : { count: 1, bytes: 923966, live: 0 }（顶层无 pending 字段）
POST purge     : deleted 1（923966 字节，removedDir: true, unarchived: true,
                 detached: ["7f8dd492-…"]）
GET  scan      : { count: 0, bytes: 0 }
磁盘            : 会话目录已消失；workspace.json 的 archivedSessionIds 已空、sessionIds 已 detach
POST purge 再来 : totals 全 0（幂等，不报错）
```

同一次启动里没有任何 "did not activate" 警告，也没有 `pending.json` 生成。

**0.4.0 又在同一个隔离方案里跑了一次「真·常驻会话」的端到端验证**（临时 profile 只挂 `dsh-base` + `dsh-web-app` + 本插件，`--patch` 加一个一次性驱动插件，端口 3099，`DSH_HOME` 指向 `/tmp` 下的临时 home，真实 home 只读）。驱动插件做的事就是浏览器的动作：用 `ctx.sessionController.create({cwd})` 建一条会话（这一步会 `resume` 出常驻 Agent）、用 `workspaceRegistry.archiveSession(id)` 归档、用真实 HTTP `POST /dsh-archive-cleanup/purge` 清理，然后**分别**用服务方法 `sessionController.list({})` 和浏览器真正走的 Typert 网关 `ctx.typertGateway.invoke({namespace:'session', method:'list', args:{_request:{}}})` 各拉一次列表：

```
ok: the archived session is live in the Host (session-0557f047-…)
ok: the Host list serves it before the purge            ← 服务方法
ok: the gateway serves it before the purge              ← RPC 同一条读口
ok: the archive set holds it
ok: the purge route answered 200 (got 200)
ok: the purge finished the session (bucket: freed)
purge totals: {"count":1,"deleted":0,"released":0,"freed":1,"queued":0,"bytes":4446}
ok: the Host still holds the session in memory (filter, not unload)   ← 证明这不是"卸载"
ok: the service list read no longer serves the removed row
ok: the gateway list read no longer serves the removed row
ok: an unrelated session is still served
ok: a repeat pull stays clean                           ← 「再点一次上下文洞察」
ok: the archive entry is gone as well
PASS
```

这条验证覆盖了单测覆盖不到的那一环：**网关每次调用都重新从服务实例上取方法**（`Reflect.get(callReceiver, implementation)`），所以包装在实例上的过滤器对浏览器那条 `session.list` 生效——不是只对插件自己的调用生效。

---

## 8. 已知边界

* **附件不回收。** DSH 的图片 / 上传附件放在 `$DSH_HOME/attachments`，由内容寻址、可跨会话复用。要安全回收得先扫描所有存活会话日志里引用过的 hash 再差集删除——那是 GC，不是本插件。所以删掉会话后 `attachments` 里的孤儿字节会留下。
* **被持有的会话：持久层当场清干净、列表不再列出它，进程内存里那份副本要等进程结束。** DSH 的 host 只要**看过**一个会话就把它 `promote()` 成常驻内存的 Agent，而且**没有任何卸载 API**（§2、§1.2），插件无法把这条会话从内存里摘掉。所以清理完成的状态是：日志目录与投影缓存已删、归档登记已撤、浏览器当前那一行已移除（`api-session/removed`）、**而且之后每一次列表拉取都不再返回它**（§1.3 的读口过滤器）——刷新、重连、点「上下文洞察」都不会把它拉回来。由此有三个可见的后续：
  * **进程内存里仍有一条无文件的会话对象**，直到进程退出；它不在任何列表里，也没有归档登记，所以不占"待清理"计数，也不会被 `GET scan` 看到。真要让它彻底消失，重启一次 `dsh web`（本条只影响内存占用，不影响已完成的清理）。
  * **别对已清理的会话继续发消息。** 内存里的 Agent 还在，但日志文件已经不在了；真要保留一个会话，请在清理前先取消归档。进程退出后这条会话就彻底消失（磁盘上没有任何痕迹）。
  * **同一个 id 被重新创建时也会被过滤器挡住。** 过滤器记的是"本进程清掉过的 id"，不区分后来是不是又有了一条同 id 的新会话。DSH 的会话 id 不会复用，所以这只是理论边界；真要复用，重启一次即可（过滤器不落盘）。
* **回合在跑的会话会等一会儿。** 插件不在写入过程中 unlink：那条会先以 `queued` 返回，等该 Agent 的 `agent/status` 变成非 `running` 时自动补做（通常几秒到几十秒）。进程若在补做前退出，它就只是"仍然归档、文件完好"，重新点一次即可。
* **`session_projcache` 的内存行不主动清。** 投影缓存被上游明确定义为"fold shortcut, never an authority"且写入 fail-soft；被删的归档会话是冷的，不会再触发写回，下次冷启动时该行自然消失。
* **只处理**归档集合**。** 没归档的会话插件拒绝删——这是刻意的，防手滑。想删普通会话，先在右键菜单里归档，再来点这里。
* **`web` profile only。** headless / TUI profile 没有 `workspaceRegistry`，`GET scan` 会返回 501 和一句解释；这类 profile 里 `sessionController` 通常也不在，列表过滤器装不上（只记一条诊断，不影响其余行为）。

---

## 9. 激活契约（实测踩到过的坑）

这两条不是风格问题，是**会让插件静默不激活**的硬约束，都在真实实例上验证过。

### host 半边：碰 `ctx.<service>` 必须先在 `inject` 里声明

第一版没导出 `inject`，结果启动时报：

```
dsh: warning: 1 entry did not activate
archive-cleanup (dsh-archive-cleanup): Error: cannot get property "systemPrompt" without inject
    at syncAnnounce (lib/index.js:742:20)
```

cordis 的响应式 ctx 会拒绝读取未声明服务的属性。修法是导出 `export const inject = ['systemPrompt']`（`dsh-balance-display` 也是这么写的）。

但**只对必需服务这么做**。其余服务（`workspaceRegistry`、`sessionPersistence`、`sessionQuery`、`agents`、`sessions`）全部走 `ctx.get(name)` —— 它不触发 inject 检查，所以某个 profile 缺其中一个时只会降级成一条诊断，而不是让整条 fiber 挂掉。

### 列表过滤器：`ctx.inject` 的等待式依赖 + 返回卸载闭包

§1.3 的过滤器要等 `sessionController` 就位（web profile 里它在 `dsh-web-app` 那层之后才 provide），所以它走 `ctx.inject(['sessionController'], (scope) => …)` 而不是 `ctx.get`：**`inject` 回调返回一个函数就等于登记一个 disposer**（cordis 的 fiber 会把 apply 的返回值 `collect` 进 `_disposables`），卸载 / 热重载时自动把包装摘掉，不会套娃。回调里任何异常都自己吞掉并记一条诊断——过滤器装不上只是回到 0.3.0 的行为，不该让 fiber 挂掉。

### 浏览器半边：只能 require boot graph 保证携带的模块

`dsh-client-modules` 在 factory 物化阶段对未知模块直接 throw，**不是警告**。所以这里只 `require('react')`；`slots` / `locale` 通过 cordis context 到达，包顺序由 `package.json` 的 `dsh.client.inject` 保证。弹窗、样式、表格全部手写，不碰 `@deepseek-ai/dsh-client-ui-primitives`。

### 客户端产物不是 `/plugins/<pkg>/client.js`

那个 URL 裸访问一定 404。真实形态是 **combo 路由 + 强制 `rev`**（`dsh-client-modules` 会校验 URL 是否与 `chunkUrl(id, file, rev)` 完全一致）：

```
plugins/??dsh-archive-cleanup/client.js&rev=70ae8fe4f0b4
```

要验证客户端半边有没有挂上，正确做法是取 `index.html`（带 `?token=` 登录换取 cookie），在里面 grep 包名。

---

## 10. 客户端契约备注（dsh >= 0.2.0）

浏览器半边遵守 0.2.0 的 client-graph 契约：

* 运行时**只** `require('react')`。`slots` 与 `locale` 通过 cordis context 到达，它们的包由 `package.json` 的 `dsh.client.inject` 排序。
* 任何 boot graph 不携带的模块被 require 都是**致命**的（`dsh-client-modules` 在 factory 物化阶段直接 throw），所以这里不碰 `@deepseek-ai/dsh-client-ui-primitives` 之类的包——弹窗、样式、表格全部手写。
* 归档集合来自 `ctx.get('workspaces')`（`@deepseek-ai/dsh-api-workspace-controller` 客户端服务，见 §1.1）：**不写进 `inject`**，因为声明成必需服务会让缺 Workspace 层的 profile 直接不激活；也不写进 `dsh.client.inject` 的包顺序，因为 `ctx.inject(['workspaces'], …)` 已经能等到它，多一条 boot-graph 依赖只会让上游加载失败时连累这个插件。订阅用 `ctx.effect(() => dispose)` 交给 cordis 管，插件重载/卸载时自动退订。
* 只往**已被别家声明过**的插槽注册：`sidebar.footer.action`（`dsh-client-ui-sidebar`，`kind: list`，props `{wide}`）、`shell.overlay`（`dsh-client-ui-layout`，`kind: list`，props `{}`）、`settings.section`（`dsh-client-ui-settings-general`）。
