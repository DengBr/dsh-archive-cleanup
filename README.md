# dsh-archive-cleanup

One-click cleanup for **archived sessions** in DeepSeek Harness (DSH).

[中文](README.zh.md) | English

> **0.4.0 behaviour change**: a purged row no longer comes back. 0.3.0 dropped the row only from the browser's *current* list snapshot, but the Host recomputes that list on every pull — and DSH's list prefers a live in-memory session without checking whether its files still exist. So reloading the page, reconnecting, or opening **Context Insights** (which calls `sessions.refresh()`) brought the deleted row back. 0.4.0 has the Host half remember the ids it purged and filter them out of the Host's own session-list read (`sessionController.list`, §1.3), so **no later pull returns them**. The in-process session object stays until the process exits (DSH has no API to unload a resident Agent), but it no longer appears in any list.

> **0.3.0 behaviour change**: one click on **Delete permanently** finishes the job on the spot — artifacts removed, archive entry released, browser row gone, **no harness restart needed**. 0.1.x skipped sessions the process still held; 0.2.x released the disk immediately but wrote the registry bookkeeping into `pending.json` for the next start. The 0.2.x ledger is gone as a mechanism; only a one-time migration for a leftover file remains (§1.2).

DSH can **archive** a session (hiding it from every grouped surface) but has **no way to delete** one: the archive set, the JSONL log directory under `$DSH_HOME/sessions`, and the projection-cache record under `$DSH_HOME/storages/session_projcache` all stay on disk forever. This plugin adds a supported deletion path for archived sessions.

```
sidebar bottom-left  🧹 12   ← click → confirm dialog → it really deletes
Settings → Archive cleanup   ← full list: title / directory / time / size, tick rows
```

The counter follows the **live archive set**: archive a session from the sidebar's context menu and the chip appears with `1`; archive another and it reads `2`; unarchive (or clean up) back to `0` and the chip hides itself — no page reload, no rescan. See §1.1.

---

## 1. What it deletes

For every archived session confirmed for deletion:

| Target | Location | How |
| --- | --- | --- |
| Session log directory (`session.v4.jsonl.zstd`, `session.lock`, private artifacts) | `$DSH_HOME/sessions/<project-key>/<session-id>/` | `fs.rm(recursive)`, after a **root-containment check** and requiring the directory name to equal the session id |
| Projection-cache document | `$DSH_HOME/storages/session_projcache/sessions/<session-id>.json` | `fs.rm`, same containment check |
| Archive entry | `$DSH_HOME/storages/workspace.json` → `global.archivedSessionIds` | **never written directly**; calls `WorkspaceRegistry.unarchiveSession(id)` and finishes on the spot |
| Workspace entry | `workspace.json` → `tables.workspaces[*].sessionIds` | **never written directly**; calls `Workspace.detachSession(id)` |
| The browser's session row | the Session list of every connected Web GUI | the Host emits DSH's own `api-session/removed` frame (the edge `session/disposed` normally uses), so the sidebar drops the row without a reload (§1.2) |
| Every later list pull | the Host's session-list read, `sessionController.list` (sidebar, `sessions.refresh()`, Context Insights) | the Host half remembers the ids it purged in memory and wraps that read to filter them out (§1.3) |
| A "ghost" entry with no artifacts left (log directory and cache both gone) | same as *Archive entry* | nothing to remove, so `unarchiveSession(id)` is the whole job; reported as `released`, not `skipped` |

The last three rows are the core design decision: `workspace.json` is owned by `dsh-storage-json` + `dsh-storage-domain`, with an authoritative in-memory state and a write chain. Editing the file behind their back would fight that state, so the plugin goes through public API only (`Workspace.detachSession`, `WorkspaceRegistry.unarchiveSession`) and lets the storage domain persist and broadcast.

### 1.1 Why the chip updates the instant you archive

The chip's visibility and its number are **not** computed from a scan; they follow the browser-side Workspace Controller client's archive set:

```js
// ctx.workspaces.list (the dsh-api-workspace-controller client service)
const { phase, archivedSessionIds } = source.getSnapshot()
source.subscribe(sync)   // archive / unarchive / another tab archiving all push here
```

* **The number is `archivedSessionIds.length`** — the browser-side projection of the Host's `WorkspaceRegistry.archivedSessionIds`, the same set `GET scan` walks, so the two can never disagree. Cleanup removes the id from that set on the spot, so "the count hits zero when you click" needs no subtraction logic. The sidebar's own context menu goes through the same service (`ctx.workspaces.archiveSession`), so the subscription fires as soon as an archive lands.
* **The chip does not render at all when the count is 0** (`return null`) — that is why the corner is clean until the first archive and why the chip appears right after you archive one.
* **Byte counts still come from `GET scan`.** When the archive set changes, the plugin quietly rescans after a 250 ms debounce (one archive delivers a unary echo and a stream delta; the debounce merges them into one request). The chip's number does not wait for that scan; only the tooltip's size figures do. A purge refreshes the list itself, so that path does not queue another scan.
* **No baseline, no guessing.** The client snapshot starts as `archivedSessionIds: []` with `phase: 'pending'` until the follow stream installs a baseline; while `phase !== 'ready'` the plugin reads the set as unknown (`null`) and falls back to the scan result instead of showing "nothing archived" for "not loaded yet".

Services are fetched with `ctx.get('workspaces')` rather than declared in `inject`: declaring it would mean the whole plugin fails to activate in a profile without the Workspace layer (not even the settings page), while such a profile's `GET scan` would answer 501 anyway. When the service is not up yet the plugin waits for it with `ctx.inject(['workspaces'], …)` instead of polling; the tests cover both paths.

### 1.2 A session the process still holds: one click, finished on the spot

**The problem**: as soon as DSH has ever *opened* a session, the Host `promote()`s it into a resident in-memory Agent (`promote → agents.resume`), and `archiveSession` only writes the archive set and stops running work — there is **no API to unload it** (§2). So "the session I just looked at" is still `live` after archiving, and the log write handle is still in the Host's hand. Worse, the Host's session list `ApiSessionList.list()` **prefers live in-memory sessions** (`ctx.sessionQuery.listSessions()` includes live records and skips the `cwd` check on a live hit), so as long as the process lives, that session keeps being listed as a row.

**0.1.x skipped the whole row** (`skipped: {reason: "live"}`, telling the user to restart `dsh web` first). **0.2.x split it in two**: release the disk now, write the bookkeeping into `pending.json`, finish on the next start — the user did not have to click again, but "takes effect after a restart" was still the experience.

**0.3.0 does it in three layers, all inside that one request**:

```
click "Delete permanently"
  ├─ cold session                 → remove files + release bookkeeping (detach + unarchive, one step)
  ├─ archived session held by us  → flush the write handle → remove files → release bookkeeping
  │                                 → emit api-session/removed
  │                                 (the browser drops the row from the Session list immediately)
  └─ turn still running           → nothing yet (queued); finished automatically the moment
                                    that Agent goes idle
```

1. **Why the files can go now**: `ArchivedSessionGate` rejects every `agent/pre-step` of an archived lineage, so the session produces no further events; before deleting, the plugin runs `sessions.flush(session)` (`sessionPersistence.flush()` as a fallback) to drain buffered events from the write handle. That handle's `state.materialized` is already `true`, so later `append`s open the **old path** with `open(path, "a")` — ENOENT when the directory is gone, and the directory is **not** recreated. Only ids in the archive set are deleted; surviving **descendant sessions** (subagents, fork children) are always skipped.
2. **Why the bookkeeping can go now**: `unarchiveSession(id)` just removes the id from the archive set — the authoritative state — and the storage domain persists it and broadcasts `domain/changed`, so `WorkspaceFeed` pushes an `archived` frame and the sidebar's archive filter, `GET scan`, and the chip count all update together. The 0.2.x worry ("a row with a session but no files shows up") is what layer 3 solves.
3. **Why the Host emits `api-session/removed` itself**: the Host keeps listing this session because it is still in memory (above). The plugin cannot unload it, but it can emit **DSH's own list-removal edge** — `dsh-api-remotes` whitelists the forwarded `api-session/removed`, and the browser's `dsh-api-session-controller` removes the row from its list snapshot, which is exactly what `session/disposed` does in normal operation. So the sidebar row disappears the instant the click lands, with no reload. The emit is best-effort: without a remote bridge in the profile it degrades to "persistent layer released only". This frame only affects the snapshot the browser holds *right now*; making every later pull miss it too is §1.3's job.
4. **A row whose turn is still running**: the plugin does not unlink during a write, and keeps the bookkeeping too. It watches `agent/status` and reruns that entry as soon as the Agent is no longer `running` (`queued` → done), **without a restart**.

`pending.json` is gone as a mechanism. What remains is a **one-time migration**: a 0.2.x process may have left the file behind, so on activation the plugin reads it, releases the ids that are archived and currently cold, then deletes the file. Ids still held by the process, or already unarchived by the user, are left alone (and the file is left in place). A profile without the Workspace layer keeps the file until the next start.

### 1.3 Why a reload, a reconnect, or Context Insights no longer brings the row back

**Symptom**: the archived session really did disappear from the sidebar after cleanup, but opening **Context Insights** (the first-level panel of `dsh-context`) made it show up again.

**Root cause**: `api-session/removed` only acts on the list snapshot the browser holds *at that moment*, and the list can be pulled again:

```
open "Context Insights"
  └─ dsh-context client refreshSessions()          // dsh-context/lib/client.js
       └─ ctx.sessions.refresh()                    // dsh-api-session-controller client
            └─ remote.session.list({})              // RPC
                 └─ host: SessionController.list()
                      └─ ApiSessionList.list()
                           └─ first checks ctx.sessions.get(id) for a live session   ← here
```

For every record, `ApiSessionList.list()` **prefers a live in-memory session** and returns `summaryFor(live)` straight away — it neither checks whether the files still exist nor consults the archive set (archiving only filters the UI, not this read). And DSH `promote()`s a session into a resident Agent as soon as it has ever been *opened* (§1.2, no unload API), so after the plugin has removed the files and released the bookkeeping the session **is still live**: the next pull returns it as a row again. Sidebar reload, browser reconnect, and `dsh-context`'s `sessions.refresh()` all read through that one path, which is why they behaved identically.

**The fix**: the Host half remembers the ids this process purged (an in-memory `purgedSessionIds`) and, on activation, wraps that read with a filter (`hideRemovedSessions`):

```js
controller.list = async (request, signal) => {
  const value = await inner(request, signal)
  const kept = value.items.filter((row) => !purgedSessionIds.has(String(row.sessionId)))
  return kept.length === items.length ? value : { ...value, items: kept }
}
```

A few deliberate choices:

* **It records ids, not "rows removed from a list".** All three outcomes `deleted` / `released` / `freed` enter the set (`queued` does not: its files and bookkeeping are still there). `dryRun` and `skipped` do not.
* **Nothing is written to disk.** Once an id is purged it has no files and should never be listed again; the next process can see neither a persistent record nor a live session for it, so no state file is needed — the same reason 0.3.0 deleted `pending.json`.
* **The filter lives at that one read.** `sessionQuery`'s semantics ("live-first full listing") are untouched, as are `session/disposed`, the archive set, and workspace accounting; only "the list the server is about to hand the browser" is filtered.
* **The wrap is instance-level and follows the plugin fiber.** `hideRemovedSessions` returns an unload closure that cordis calls when the plugin unloads or reloads (§9), so a repeated load never stacks wraps.
* **Missing read, degraded behaviour.** If `sessionController.list` is not a wrappable function (upstream renamed the service or the read), the plugin records one diagnostic and falls back to 0.3.0's "remove from the current snapshot".
* **The in-memory copy is still there.** This is not an unload and does not make DSH release it — DSH has no such capability (§2). A purged session stays in process memory until the process exits; it simply never appears in a list again and no longer occupies a "to clean up" count (it has left the archive set).

### Why it locates files by directory name

The Host half does **not** re-implement session-persistence-jsonl's path encoding (`projectKey(cwd)` + `encodeSegment(id)`):

```js
// index the basename of every directory under $DSH_HOME/sessions/*/
// → Map<sessionId, "/abs/path/to/session/dir">
```

Because a session directory is always named after its own id, indexing by basename is both accurate and decoupled from the backend's encoding — if upstream ever changes `projectKey`'s escaping rules, this plugin does not need to change.

---

## 2. Why DSH needs this plugin (research findings)

Having read every `@deepseek-ai/*` package:

* `WorkspaceRegistry` offers only `archiveSession` / `unarchiveSession` / `pinSession` / `unpinSession` — **no delete**.
* `SessionPersistence` (the `dsh-session-persistence` abstract class) offers only `create` / `open` / `stat` / `list` / `flush` — **no delete**.
* `SessionProjectionCache` describes itself as "fold shortcut, never an authority" — **no delete**.
* The Web GUI's session context menu offers only `archiveSession` / `unarchiveSession` / `pinSession` / `fork` / `rename` — the i18n key `menu.deleteSession` does not exist.
* The CLI has no `dsh session rm` and the like.

Deleting a session is therefore a **capability gap** in DSH, not a configuration matter. This plugin fills it: the file layer is removed by the plugin, the bookkeeping layer goes through public API.

---

## 3. Layout

```
dsh-archive-cleanup/
├── package.json          # dsh.bundle.patch + dsh.client (platform: web)
├── cordis.patch.yml      # the plugin row in the profile
├── lib/
│   ├── index.js          # host half: two loopback routes + all deletion logic (zero runtime deps)
│   └── client.js         # browser half: footer chip + confirm dialog + result banner + settings page
└── test/
    ├── smoke.mjs         # fake DSH home: scan / refusal / dry run / delete / idempotence / ghost release /
    │                     # held-session finish-in-place / idle catch-up / legacy ledger migration
    ├── routes.mjs        # real node:http server: guard header, cross-origin refusal, confirm, 405, held-session flow
    └── client.mjs        # simulated __ModuleLoader__ handshake: apply/inject, slot registration, chip count, dialog
```

**There is no runtime state file any more.** The 0.2.x `$DSH_HOME/storages/archive-cleanup/pending.json` is read once during migration and then deleted (§1.2).

The host half registers two routes:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/dsh-archive-cleanup/scan` | List the archive set: id, title, cwd, creation time, bytes, file count, whether a log / cache exists, the `live` / `busy` flags, plus roots and limits |
| `POST` | `/dsh-archive-cleanup/purge` | `{ids:[...]}` or `{all:true}`, optionally with `includeDescendants`, `dryRun`, `confirm` |

When `sessionController` is available it also installs a **session-list read filter** (§1.3): neither route goes through it; it is the half that says "the row may not come back".

---

## 4. Safety design (this plugin is destructive; every point has test coverage)

1. **Only ids in the archive set can be deleted.** Passing an unarchived, pinned, or merely *existing* id returns `refused: [id]` and touches no byte. Covered by the `refusal` section of `smoke.mjs`.
2. **Held sessions finish in place; surviving descendants are always skipped.** Every entry first asks `ctx.agents.get(id)` / `ctx.sessions.get(id)`. An id in the archive set takes the §1.2 path: `flush` → remove artifacts → release bookkeeping → emit `api-session/removed` (reported as `freed`). A **non-archived descendant session** that is hit is `skipped: {reason: 'live'}` and no byte is touched. Note that live means "still held by this process", not "currently running": DSH Web `promote()`s a session into a resident Agent as soon as it has been *opened*, and `archiveSession` only writes the archive set and stops running work, with **no API to unload it**; the plugin therefore cleans the persistent layer in place and tells the browser to drop the row, leaving the in-process copy until the process ends. A row with `busy: true` (turn still running) is not touched at all, bookkeeping included, and is finished by the idle edge of `agent/status` (reported as `queued`). The settings page and the dialog both state these two reasons explicitly.
3. **An artifact-less archive entry is still released.** An archived id whose log directory and projection cache are both gone (removed by hand earlier, a previous cleanup that failed halfway, or a session that never hit disk) is no longer `skipped` but `released`: there are no files to remove, but that entry still occupies every archived surface, so clearing it is the entire job. Upstream's `unarchiveSession` contract explicitly allows ids for sessions that no longer exist (removing an id cannot introduce an unknown session), so this path touches no disk and needs no existence check. **A non-archived descendant is still skipped even with no artifacts** (it had no entry to release). Covered by the `ghost release` section of `smoke.mjs`.
4. **Path containment.** Before deleting, `isInside(root, target)` runs, and a session directory's basename must equal the id exactly. Forged or out-of-bounds index entries are refused and recorded in `warnings`.
5. **POST requires a custom guard header**: `x-dsh-archive-cleanup: 1`. A cross-origin browser request cannot set a custom header (it would preflight first), this service never returns permissive CORS, and an `Origin`/`Host` consistency check is layered on top. `routes.mjs` covers both 403 branches.
6. **Explicit confirmation is required.** Any non-`dryRun` request must carry `confirm: true`, otherwise 400.
7. **`dryRun` looks before it leaps.** The settings page's **Dry run** button takes this path: it counts entries and bytes only, touching neither the filesystem nor the registry and emitting no frame (a held session is only predicted as `freed`).
8. **A per-request entry cap.** `maxSessions` (default 1000); over it returns 400.
9. **Idempotence.** Calling it again on an empty archive returns an all-zero report instead of an error; re-cleaning a session that was already released is not treated as an archived id (it has left the set) and ends as `refused` rather than pretending to have done the work again; a duplicate `api-session/removed` delivery on the browser side simply deletes a row that is already gone from the snapshot.

### The purge report

```jsonc
{
  "deleted":  [ /* files removed + bookkeeping released */ ],
  "released": [ /* no artifacts: bookkeeping only, removedDir/removedCache both false */ ],
  "freed":    [ /* held: files removed + bookkeeping released + browser notified (held/unarchived/announced all true) */ ],
  "queued":   [ /* held with a running turn: files and bookkeeping untouched, reason: "busy", finished on idle */ ],
  "skipped":  [ { "reason": "live" } | { "reason": "no-artifacts" } | { "reason": "error" } ],
  "totals": { "count": 0, "deleted": 0, "released": 0, "freed": 0, "queued": 0, "bytes": 0 },
  "remaining": 0
}
```

`totals.count = deleted + released + freed + queued`. Bytes count only files actually removed, so ghost entries contribute 0 and `queued` is always 0 bytes. `refused` / `warnings` appear when applicable.

Each `GET scan` row carries two extra booleans: `live` (still held by this process) and `busy` (turn still running). The 0.2.x `pending` field and top-level ledger are gone.

---

## 5. Install

```bash
# from a local directory (development)
dsh plugin --profile web add /path/to/dsh-archive-cleanup

# or from npm
dsh plugin --profile web add dsh-archive-cleanup
```

`dsh plugin add` uses the profile's own pnpm: it writes the dependency into `$DSH_HOME/profiles/web/package.json` and appends the package name to the same file's `dsh.profile.bundles` list. **Plugin code loads only at process start**, so after installing or editing the host half, restart DSH Web (and hard-refresh the browser):

```bash
dsh web
```

Six checks:

1. A `🧹 N` chip appears at the sidebar's bottom-left (N = current archived count; hidden when there is none).
2. **Archive a session from the context menu and the chip appears immediately** with `1` (then `2`; it disappears when unarchiving brings it back to `0`) — no page reload.
3. An **Archive cleanup** section appears in Settings, listing each archived session's title / directory / size.
4. `GET http://127.0.0.1:<port>/dsh-archive-cleanup/scan` returns `{"ok":true,...}`.
5. **Clicking "Delete permanently" shows the result at once**: the dialog closes, a banner reports the outcome, the chip count drops to zero on the spot, and the sidebar row disappears on the spot — held sessions included, with no `dsh web` restart (a restart only affects the in-process copy of a session whose files are already gone, §8).
6. **The row does not come back**: after a page reload, a reconnect, or opening the sidebar's **Context Insights** (`dsh-context`, which calls `sessions.refresh()` when its panel opens), the purged session is no longer listed (§1.3).

### Uninstall

```bash
dsh plugin --profile web remove dsh-archive-cleanup
```

---

## 6. Configuration

The row in `cordis.patch.yml` accepts `config`; every field has a default:

```yaml
- insert:
    - id: archive-cleanup
      name: 'dsh-archive-cleanup'
      config:
        includeDescendants: true   # default true: also delete subagent / fork child sessions
        maxSessions: 1000          # most entries a single request may delete
        announceToAgent: true      # declare the plugin in the system prompt so the agent can run it too
        # sessionRoot: /custom/sessions          # default $DSH_HOME/sessions
        # storageRoot: /custom/storages          # default $DSH_HOME/storages
        # legacyPendingFile: .../archive-cleanup/pending.json   # read-only: one-time migration of the 0.2.x ledger
```

`$DSH_HOME` resolves the way the harness resolves it: explicit `dshHome` > non-empty `DSH_HOME` environment variable > `~/.dsh`.

---

## 7. Development and tests

```bash
npm test        # three files, zero dependencies, plain node:assert scripts
```

None of the three needs a DSH process:

* `smoke.mjs` builds a fake `$DSH_HOME` (mirroring the real disk layout: one project directory per cwd, one directory per session, one projection-cache document per session) and drives the exported `scanArchive` / `purgeArchive` / `releaseAccounting` / `applyPending` / `deferBusyCleanups` / `hideRemovedSessions` through a fake ctx. It covers scan, refusal, dry run, real deletion, idempotence, ghost-entry release, finish-in-place for a held session (`freed` + an `api-session/removed` frame + the entry leaving the set), `queued` for a running turn plus automatic catch-up on the idle edge, the one-time 0.2.x ledger migration (cold entries released / held or unarchived entries left alone / file deleted), the **list filter** (purged ids never returned by `list`, unrelated rows and the rest of the return value passed through untouched, the read restored after unload, no error when there is no wrappable service), and the degraded paths when the registry or the emit fails.
* `routes.mjs` mounts the real handler on a real `node:http` server and hits it with real `fetch`: it verifies the guard and runs the end-to-end flow "route purges a held session → the entry is gone within that request, the browser received the removal frame → no later list pull returns it" (the fake `sessionController` is the wrapper `apply` actually installed).
* `client.mjs` fakes `window.__ModuleLoader__` and `react`, verifying that the browser half requires only `react` and registers only the three slots it declares, and drives the live-archive-set path: a fake `workspaces.list` pushes one archive and the chip goes `null` → `1` → `2`, back to `null` when cleared; a burst of notifications produces exactly one debounced `GET scan` (with `fetch` replaced by a counter); a late service (`ctx.get` misses) binds the same store through `ctx.inject`; and the 0.3.0 interaction contract — after **Delete permanently** the dialog closes, the banner summarises the result, the chip vanishes as soon as the archive set empties, and a failed request keeps the dialog with its error.

The host half has also been run end-to-end against a **copy** of a real `~/.dsh` on this machine (with the registry stubbed, never the real home):

```
0.2.x (historical):
scan before   : { count: 1, bytes: 718097, live: 1, pending: 0 }   log dir exists: true
purge         : freed 1 (718097 bytes, directory and projection cache gone, flush ran first)
repeat purge  : { freed: 0, already: 1 }
scan after    : { count: 1, bytes: 0, pending: 1 }
next start    : applyPending released 1 entry, pending.json deleted

0.3.0 (the same held session):
purge         : freed 1 (bytes released now + unarchive + detach + api-session/removed emitted)
scan after    : { count: 0, bytes: 0 }         ← the archive set is already empty in the same request
repeat purge  : refused 1 (no longer in the archive set)
next start    : no leftover ledger to migrate, no pending.json created
```

0.3.0 also ran a real `dsh web` on an isolated `DSH_HOME` (a temporary profile carrying only `dsh-base` + `dsh-web-app` + this plugin, port 3099, one archived session seeded with a real log file):

```
GET  scan      : { count: 1, bytes: 923966, live: 0 }   (no top-level pending field)
POST purge     : deleted 1 (923966 bytes, removedDir: true, unarchived: true, detached: ["7f8dd492-…"])
GET  scan      : { count: 0, bytes: 0 }
disk           : session directory gone; workspace.json's archivedSessionIds empty, sessionIds detached
POST purge again: totals all 0 (idempotent, no error)
```

That run produced no "did not activate" warning and created no `pending.json`.

0.4.0 repeated the exercise in the same isolated setup with a **genuinely resident session** (temporary profile with `dsh-base` + `dsh-web-app` + this plugin, a one-shot driver plugin added with `--patch`, port 3099, `DSH_HOME` pointing at a temporary home under `/tmp`, the real home opened read-only). The driver did what a browser does: create a session with `ctx.sessionController.create({cwd})` (this is what `resume`s a resident Agent), archive it with `workspaceRegistry.archiveSession(id)`, purge it over real HTTP with `POST /dsh-archive-cleanup/purge`, then pull the list **twice** — once through the service method `sessionController.list({})` and once through the Typert gateway the browser actually uses, `ctx.typertGateway.invoke({namespace:'session', method:'list', args:{_request:{}}})`:

```
ok: the archived session is live in the Host (session-0557f047-…)
ok: the Host list serves it before the purge            ← service method
ok: the gateway serves it before the purge              ← the same read over RPC
ok: the archive set holds it
ok: the purge route answered 200 (got 200)
ok: the purge finished the session (bucket: freed)
purge totals: {"count":1,"deleted":0,"released":0,"freed":1,"queued":0,"bytes":4446}
ok: the Host still holds the session in memory (filter, not unload)   ← proof this is not an unload
ok: the service list read no longer serves the removed row
ok: the gateway list read no longer serves the removed row
ok: an unrelated session is still served
ok: a repeat pull stays clean                           ← "open Context Insights again"
ok: the archive entry is gone as well
PASS
```

This covers the one link unit tests cannot: **the gateway re-reads the method from the service instance on every call** (`Reflect.get(callReceiver, implementation)`), so the wrapper installed on the instance applies to the browser's `session.list` — not just to the plugin's own calls.

---

## 8. Known limits

* **Attachments are not reclaimed.** DSH keeps images and uploads in `$DSH_HOME/attachments`, content-addressed and shareable across sessions. Reclaiming them safely would mean scanning every surviving session log for referenced hashes and deleting the difference — that is garbage collection, not this plugin. Orphaned bytes in `attachments` stay after a session is deleted.
* **A held session: the persistent layer is cleaned in place and it is no longer listed, but the in-process copy lives until the process ends.** The Host `promote()`s a session into a resident in-memory Agent as soon as it has *seen* it, and there is **no unload API** (§2, §1.2), so the plugin cannot remove it from memory. The state after cleanup is: log directory and projection cache deleted, archive entry released, the browser's current row removed (`api-session/removed`), and **no later list pull returns it** (§1.3's read filter) — a reload, a reconnect, or Context Insights will not bring it back. Three visible consequences:
  * **A session object with no files remains in process memory** until the process exits. It is in no list and has no archive entry, so it occupies no "to clean up" count and `GET scan` never sees it. To make it disappear entirely, restart `dsh web` once (this affects memory footprint only, not the completed cleanup).
  * **Do not keep messaging a purged session.** The in-memory Agent is still there but its log file is gone; if you want to keep a session, unarchive it before cleaning up. Once the process exits, that session is gone for good (no trace on disk).
  * **An id recreated later is also filtered.** The filter records "ids this process purged" and cannot tell whether a new session with the same id appeared afterwards. DSH does not reuse session ids, so this is a theoretical edge; if it ever happens, restart once (the filter is not persisted).
* **A session with a running turn waits a while.** The plugin does not unlink mid-write: that entry returns as `queued` and is finished when that Agent's `agent/status` becomes non-`running` (usually seconds to tens of seconds). If the process exits before the catch-up, the session is simply "still archived, files intact" and one more click finishes it.
* **`session_projcache`'s in-memory row is not cleared proactively.** Upstream defines the projection cache as "fold shortcut, never an authority" with fail-soft writes; a deleted archived session is cold and triggers no write-back, so the row disappears naturally on the next cold start.
* **It handles the archive set only.** Unarchived sessions are refused — deliberately, to prevent slips. To delete an ordinary session, archive it from the context menu first.
* **`web` profile only.** A headless / TUI profile has no `workspaceRegistry`; `GET scan` returns 501 with an explanation. Such profiles usually have no `sessionController` either, so the list filter is not installed (one diagnostic is recorded; nothing else changes).

---

## 9. Activation contract (pitfalls met in practice)

These two are not style questions; both silently stop the plugin from activating, and both were confirmed on a real instance.

### Host half: touching `ctx.<service>` requires declaring it in `inject`

The first version did not export `inject`, and startup reported:

```
dsh: warning: 1 entry did not activate
archive-cleanup (dsh-archive-cleanup): Error: cannot get property "systemPrompt" without inject
    at syncAnnounce (lib/index.js:742:20)
```

cordis's reactive ctx refuses to read a service that was not declared. The fix is to export `export const inject = ['systemPrompt']` (the same thing `dsh-balance-display` does).

But do this **only for required services**. Everything else (`workspaceRegistry`, `sessionPersistence`, `sessionQuery`, `agents`, `sessions`) goes through `ctx.get(name)`, which does not trigger the inject check — so a profile missing one of them degrades to a diagnostic rather than killing the fiber.

### List filter: `ctx.inject`'s waiting dependency + a returned unload closure

The §1.3 filter has to wait for `sessionController` (in the web profile it is provided after the `dsh-web-app` layer), so it uses `ctx.inject(['sessionController'], (scope) => …)` rather than `ctx.get`: **returning a function from an `inject` callback registers a disposer** (cordis's fiber `collect`s the apply return value into `_disposables`), so unloading or hot-reloading removes the wrapper instead of stacking it. Any exception in the callback is swallowed into a diagnostic — a filter that cannot be installed merely falls back to 0.3.0 behaviour and must not kill the fiber.

### Browser half: only require modules the boot graph guarantees

`dsh-client-modules` **throws** (not warns) on an unknown module at factory materialisation time. So the browser half requires only `react`; `slots` and `locale` arrive through the cordis context, with package order guaranteed by `package.json`'s `dsh.client.inject`. The dialog, styles, and table are hand-written; `@deepseek-ai/dsh-client-ui-primitives` is not touched.

### The client artifact is not `/plugins/<pkg>/client.js`

That URL always 404s when opened bare. The real form is a **combo route with a forced `rev`** (`dsh-client-modules` checks that the URL exactly matches `chunkUrl(id, file, rev)`):

```
plugins/??dsh-archive-cleanup/client.js&rev=70ae8fe4f0b4
```

To verify the browser half is mounted, fetch `index.html` (logging in with `?token=` to trade for a cookie) and grep it for the package name.

---

## 10. Client contract notes (dsh >= 0.2.0)

The browser half follows the 0.2.0 client-graph contract:

* At runtime it requires **only** `react`. `slots` and `locale` arrive through the cordis context, and their package order comes from `package.json`'s `dsh.client.inject`.
* Requiring any module the boot graph does not carry is **fatal** (`dsh-client-modules` throws during factory materialisation), so packages such as `@deepseek-ai/dsh-client-ui-primitives` are not touched — the dialog, styles, and table are hand-written.
* The archive set comes from `ctx.get('workspaces')` (the `@deepseek-ai/dsh-api-workspace-controller` client service, §1.1): it is **not** declared in `inject`, because declaring it a required service would stop the plugin from activating in a profile without the Workspace layer; nor is it added to `dsh.client.inject`'s package order, because `ctx.inject(['workspaces'], …)` can already wait for it and one more boot-graph dependency would only drag this plugin down when upstream fails to load. The subscription is handed to cordis with `ctx.effect(() => dispose)`, so it unsubscribes automatically on reload or unload.
* It registers only into slots **already declared by someone else**: `sidebar.footer.action` (`dsh-client-ui-sidebar`, `kind: list`, props `{wide}`), `shell.overlay` (`dsh-client-ui-layout`, `kind: list`, props `{}`), and `settings.section` (`dsh-client-ui-settings-general`).

---

## License

MIT
