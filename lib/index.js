// dsh-archive-cleanup — host half.
//
// What this adds: DSH can archive a session (hide it from every grouping
// surface) but it has no way to *discard* one — the archive set, the JSONL
// log directory under $DSH_HOME/sessions, and the projection-cache record
// under $DSH_HOME/storages/session_projcache survive forever. This plugin
// gives the archive set a supported delete path:
//
//   1. `ctx.workspaceRegistry` (the authoritative archive set) is asked for
//      `archivedSessionIds`; `ctx.sessionPersistence.list()` supplies headers
//      (id, cwd, createdAt, lineage) without reading any event log.
//   2. Session artifacts are located by *matching directory basenames* under
//      the configured roots, so this half never re-implements the backend's
//      path encoding and keeps working if that encoding changes.
//   3. Deletion is `fs.rm` on the session directory plus the projection-cache
//      document — always containment-checked against the resolved roots.
//   4. Accounting is released through the PUBLIC registry API only
//      (`Workspace.detachSession`, `WorkspaceRegistry.unarchiveSession`);
//      `workspace.json` is never written directly, so there is no race with
//      the storage domain's in-memory state.
//   5. An archive-set entry whose artifacts are already gone is reported in
//      `released`, not skipped: the files were removed by an earlier pass, a
//      manual `rm`, or the session never materialized, and the registry entry
//      is all that keeps it on every archive surface. Releasing that entry is
//      the entire cleanup, and `unarchiveSession` is documented to accept an
//      id whose session is gone, so this is the one path that touches nothing
//      on disk and needs no existence check.
//   6. An ARCHIVED session the process still holds (a session the user opened,
//      which DSH promotes into a resident Agent for the life of the process) is
//      cleaned in ONE pass: the write handle is drained, the artifacts are
//      removed, and the archive entry is released through the public registry
//      API immediately — no journal, no second start. DSH exposes no way to
//      unload a resident Agent, so the host keeps that session in memory and
//      would serve it again on any later list pull; the release therefore emits
//      the Host's own `api-session/removed` frame (every connected browser
//      drops the row the moment the click lands) AND remembers the id, which
//      the Host's session-list read filters out for the rest of the process —
//      so a refresh, a reconnect, or a panel that pulls the list again cannot
//      bring the row back. See `releaseAccounting` and `hideRemovedSessions`.
//
// Safety contract, because this is a destructive plugin:
//   * Only ids present in the archive set can ever be purged. A caller that
//     names a live, pinned, or merely-known session gets `not-archived`.
//   * A live DESCENDANT (a subagent/fork child of a requested id) is skipped,
//     never deleted: it owns no archive entry, it is not hidden by archival,
//     and its process-resident Agent may still be driven.
//   * A held archived session is only ever unlinked while it is idle AND after
//     its write handle was flushed: archival gates every step (`agent/pre-step`
//     is rejected under an archived lineage) and the projection writes are
//     fail-soft, so nothing appends again and nothing can recreate the files.
//   * `POST` requires a custom `x-dsh-archive-cleanup: 1` header (a
//     cross-origin browser request cannot add one without a CORS preflight,
//     and no permissive CORS is ever answered) plus `confirm: true`.
//   * `dryRun: true` reports exactly what would be removed without touching
//     the filesystem or the registry, and is the shape the settings page
//     previews.
//
// Zero runtime dependencies: Node builtins only. Every DSH surface is
// feature-detected, so SDK drift degrades to a reported diagnostic instead of
// a crash.

import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

/** Loopback route names owned by this plugin. */
export const SCAN_PATH = '/dsh-archive-cleanup/scan'
export const PURGE_PATH = '/dsh-archive-cleanup/purge'

/** Body cap for the purge route; the request shape is a short id list. */
const MAX_BODY_BYTES = 64 * 1024
/** Default bound on ids one purge may name. */
const DEFAULT_MAX_SESSIONS = 1000
/** System-prompt section seat (just after the balance plugin's 210). */
const SECTION_ORDER = 215
/**
 * The Host's own list-surface removal frame. The browser session controller
 * listens for exactly this event and drops the row from its list snapshot, so
 * emitting it here is what makes a cleaned session leave the sidebar without a
 * page reload — the same edge DSH emits from `session/disposed`.
 */
const SESSION_REMOVED_EVENT = 'api-session/removed'
/** Model-facing announcement: presence plus how to drive the plugin. */
const AGENT_GUIDANCE =
  '本机已安装 dsh-archive-cleanup 插件（归档会话清理）：列出归档会话的接口是 GET /dsh-archive-cleanup/scan，永久清理接口是 POST /dsh-archive-cleanup/purge（需带 x-dsh-archive-cleanup: 1 头与 confirm: true）。当用户说「清理归档 / 删除归档会话 / 归档太多了」时，先 GET scan 告知条数与占用空间并给出会话标题，得到用户确认后再 POST purge；该操作不可恢复。点一次即完成，不需要重启 dsh web：磁盘产物当场删除、归档登记当场释放，并会通知所有已连接的浏览器立刻把该会话行从列表里移除。scan 里 live: true 表示该归档会话仍被 DSH Web 进程持有（打开过就会常驻内存）：插件同样当场删产物并释放登记，并把该 id 从 host 的会话列表读口过滤掉，所以刷新页面、重连、或打开上下文洞察（会重新拉一次会话列表）都不会再冒出这一行；进程内存里那条会话对象要到该进程退出才消失（它不在任何列表里，也不是归档状态、不占待清理计数）。busy: true（仍有正在进行的回合）时磁盘产物与登记会留到该回合结束的空闲时刻由后台自动补做，同样不需要重启。'

/**
 * Ids a purge deferred because their turn was still running. {@link apply}
 * installs the set its idle-edge listeners watch; a purge driven without an
 * active plugin (a direct API caller, a test) simply reports `queued` and
 * leaves the files alone, which is the safe end state.
 * @type {Set<string> | undefined}
 */
let deferredBusyIds

/**
 * Ids this process has permanently removed (artifacts and/or accounting). The
 * Host's session-list read is wrapped with this set (see
 * {@link hideRemovedSessions}), because DSH keeps every session the user opened
 * resident for the life of the process and its list prefers that live
 * in-memory Session over persistence WITHOUT checking that the files still
 * exist — so the row a purge just removed would be served again by the next
 * pull (a page refresh, a reconnect, or the Context Insights page's
 * `sessions.refresh()`).
 *
 * Process-local on purpose: nothing has to survive a restart. A removed id has
 * no files left, so a later process sees neither a persisted header nor a live
 * Session for it and cannot list it at all.
 * @type {Set<string>}
 */
const purgedSessionIds = new Set()

/**
 * Expand `~`, `~/`, `~\` against the OS home. Mirrors the harness rule so a
 * configured path behaves the same here as in `dshHomePath`.
 * @param {string} path - configured path that may start with a tilde prefix.
 * @returns {string} the expanded path.
 */
export function expandHomePath(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Resolve the harness home with the harness precedence: an explicit configured
 * path first, then a non-blank `$DSH_HOME`, then `~/.dsh`.
 * @param {string} [configured] - explicit harness-home override.
 * @param {Record<string, string|undefined>} [env] - environment mapping.
 * @returns {string} absolute harness home.
 */
export function resolveDshHome(configured, env = process.env) {
  const explicit = typeof configured === 'string' && configured.trim() !== '' ? configured.trim() : undefined
  if (explicit !== undefined) return resolve(expandHomePath(explicit))
  const ambient = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== '' ? env.DSH_HOME.trim() : undefined
  if (ambient !== undefined) return resolve(expandHomePath(ambient))
  return join(homedir(), '.dsh')
}

/** Clamp an optional positive integer config value. */
function positiveInt(value, fallback) {
  const n = Number(value)
  return Number.isSafeInteger(n) && n > 0 ? n : fallback
}

/**
 * Resolve the plugin config with the same defaults a direct caller (a test, or
 * a context that bypassed loader schema validation) needs.
 * @param {object} [config] - plugin config.
 * @param {Record<string, string|undefined>} [env] - environment mapping.
 * @returns {object} the complete config.
 */
export function resolveConfig(config = {}, env = process.env) {
  const dshHome = resolveDshHome(config?.dshHome, env)
  const storageRoot = config?.storageRoot ?? join(dshHome, 'storages')
  return {
    dshHome,
    sessionRoot: config?.sessionRoot ?? join(dshHome, 'sessions'),
    storageRoot,
    projectionCacheDir: config?.projectionCacheDir ?? join(storageRoot, 'session_projcache', 'sessions'),
    legacyPendingFile: config?.legacyPendingFile ?? join(storageRoot, 'archive-cleanup', 'pending.json'),
    maxSessions: positiveInt(config?.maxSessions, DEFAULT_MAX_SESSIONS),
    includeDescendants: config?.includeDescendants !== false,
    announceToAgent: config?.announceToAgent !== false,
  }
}

/**
 * Read the RETIRED deferred-release journal (plugin 0.2.x).
 *
 * 0.2.x could not drop the archive entry of a session the host still held, so
 * it reclaimed the bytes and journaled the entry for the next start. 0.3.0
 * releases the entry in the same click, which turns that journal into a
 * one-time migration list: whatever it still holds is a file-less archive
 * entry from an older process, and consuming it on activation is what finishes
 * those cleanups without asking the user to click again. Nothing writes this
 * file any more.
 * @param {object} cfg - resolved config.
 * @returns {Promise<string[]>} the journaled ids (deduplicated, in order).
 */
export async function readPendingIds(cfg) {
  let text
  try {
    text = await readFile(cfg.legacyPendingFile, 'utf8')
  } catch {
    return []
  }
  try {
    const parsed = JSON.parse(text)
    if (!Array.isArray(parsed?.ids)) return []
    return [...new Set(parsed.ids.filter((id) => typeof id === 'string' && id !== ''))]
  } catch {
    /* a corrupt journal is treated as empty; there is nothing left to migrate */
    return []
  }
}

/**
 * Delete the retired journal. Only the migration path calls this, because the
 * release it described now happens in the purge request itself.
 * @param {object} cfg - resolved config.
 * @returns {Promise<void>}
 */
async function dropLegacyPendingIds(cfg) {
  try {
    await rm(cfg.legacyPendingFile, { force: true })
  } catch (error) {
    /* an undeletable journal only means the migration runs again next start */
  }
}

/**
 * Containment test used before every destructive path operation: the target
 * must be the root itself or live inside it. Both sides are resolved first, so
 * `..` segments cannot escape.
 * @param {string} root - the directory the target must not leave.
 * @param {string} target - the candidate path.
 * @returns {boolean} whether `target` is inside `root`.
 */
export function isInside(root, target) {
  const r = resolve(root)
  const t = resolve(target)
  if (t === r) return true
  return t.startsWith(r.endsWith(sep) ? r : r + sep)
}

/**
 * Index every session directory under the persistence root by its basename.
 * Basename matching is deliberate: it needs no knowledge of the backend's
 * project-key/session-id encoding, and a session directory is always named
 * after its own id.
 * @param {string} root - the session-persistence root.
 * @returns {Promise<Map<string, string>>} session id → absolute directory.
 */
export async function indexSessionDirs(root) {
  /** @type {Map<string, string>} */
  const index = new Map()
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return index
    throw error
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectDir = join(root, project.name)
    let entries
    try {
      entries = await readdir(projectDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (!index.has(entry.name)) index.set(entry.name, join(projectDir, entry.name))
    }
  }
  return index
}

/**
 * Index the per-record projection-cache documents by session id. The json
 * backend writes one `<id>.json` document per record, so the extension is
 * stripped for matching.
 * @param {string} dir - the projection-cache session directory.
 * @returns {Promise<Map<string, string>>} session id → absolute document path.
 */
export async function indexProjectionCache(dir) {
  /** @type {Map<string, string>} */
  const index = new Map()
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return index
    throw error
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const id = entry.name.endsWith('.json') ? entry.name.slice(0, -'.json'.length) : entry.name
    if (!index.has(id)) index.set(id, join(dir, entry.name))
  }
  return index
}

/**
 * Recursively total one directory's regular-file bytes and count.
 * @param {string} dir - directory to measure.
 * @returns {Promise<{bytes: number, files: number}>} the totals (unreadable
 *   entries are skipped, never fatal).
 */
export async function measureDir(dir) {
  let bytes = 0
  let files = 0
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(path)
        continue
      }
      if (!entry.isFile()) continue
      try {
        bytes += (await stat(path)).size
        files += 1
      } catch {
        /* a vanished or unreadable file contributes nothing */
      }
    }
  }
  return { bytes, files }
}

/**
 * Best-effort title read from a projection-cache document. The cache is a
 * fold shortcut, so a missing/foreign/older document simply yields no title.
 * @param {string|undefined} file - the cache document path.
 * @returns {Promise<string>} the title, or `''`.
 */
async function titleFromCache(file) {
  if (file === undefined) return ''
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    const value = parsed?.record?.rows?.title?.val
    return typeof value === 'string' ? value : ''
  } catch {
    return ''
  }
}

/**
 * Ask the session-query service for authoritative titles, falling back to the
 * projection cache. The batch call is one corpus observation, so it stays a
 * single pass even for many ids.
 * @param {object} ctx - plugin context.
 * @param {string[]} ids - session ids to title.
 * @param {Map<string, string>} cacheIndex - id → cache document path.
 * @returns {Promise<Map<string, string>>} id → title (absent when unknown).
 */
async function readTitles(ctx, ids, cacheIndex) {
  /** @type {Map<string, string>} */
  const titles = new Map()
  const sessionQuery = ctx.get?.('sessionQuery')
  if (ids.length > 0 && typeof sessionQuery?.readTitleSnapshots === 'function') {
    try {
      const results = await sessionQuery.readTitleSnapshots(ids)
      for (const row of results ?? []) {
        if (row?.status !== 'fulfilled') continue
        const snapshot = row.value?.title
        const text = snapshot?.title ?? snapshot?.value
        if (typeof text === 'string' && text !== '') titles.set(String(row.sessionId), text)
      }
    } catch {
      /* fall through to the projection cache for every id */
    }
  }
  for (const id of ids) {
    if (titles.has(id)) continue
    const cached = await titleFromCache(cacheIndex.get(id))
    if (cached !== '') titles.set(id, cached)
  }
  return titles
}

/** Whether the process currently holds this session live (never delete those). */
function isLive(ctx, id) {
  for (const key of ['agents', 'sessions']) {
    try {
      const service = ctx.get?.(key)
      if (service?.get?.(id) !== undefined && service?.get?.(id) !== null) return true
    } catch {
      /* an unavailable service is not a liveness signal */
    }
  }
  return false
}

/**
 * The live Agent for one id, when the registry has one. Only used to read the
 * status: a running Agent is still finishing a turn, so its artifacts are left
 * for the deferred pass instead of being unlinked under an in-flight write.
 * @param {object} ctx - plugin context.
 * @param {string} id - session id.
 * @returns {object|undefined} the agent, or `undefined`.
 */
function liveAgent(ctx, id) {
  try {
    return ctx.get?.('agents')?.get?.(id) ?? undefined
  } catch {
    return undefined
  }
}

/** Whether one live session still has an in-flight turn. */
function isBusy(agent) {
  return agent !== undefined && agent !== null && agent.status === 'running'
}

/**
 * Drain one session's buffered live events into durable storage before its
 * artifacts are removed. `sessions.flush` is the store-owned durability entry
 * point; the service-wide `sessionPersistence.flush` barrier is the fallback.
 * Both are best-effort: a failure is reported, never fatal, because an archived
 * idle session has nothing left to write.
 * @param {object} ctx - plugin context.
 * @param {string} id - session id.
 * @returns {Promise<string[]>} warnings.
 */
async function drainSession(ctx, id) {
  const warnings = []
  let sessions
  let session
  try {
    sessions = ctx.get?.('sessions')
    session = sessions?.get?.(id)
  } catch {
    session = undefined
  }
  if (session !== undefined && typeof sessions?.flush === 'function') {
    try {
      await sessions.flush(session)
      return warnings
    } catch (error) {
      warnings.push(`flush ${id}: ${String(error?.message ?? error)}`)
    }
  }
  try {
    await ctx.get?.('sessionPersistence')?.flush?.()
  } catch (error) {
    warnings.push(`flush ${id}: ${String(error?.message ?? error)}`)
  }
  return warnings
}

/**
 * Read the archive set plus the headers backing it.
 * @param {object} ctx - plugin context.
 * @returns {Promise<{ids: string[], headers: Map<string, object>}>}
 * @throws {Error} with code `NO_WORKSPACE_REGISTRY` when the profile has no
 *   workspace layer (a headless profile has no archive concept).
 */
async function readArchiveState(ctx) {
  const registry = ctx.get?.('workspaceRegistry')
  if (registry === undefined || registry === null) {
    const error = new Error(
      'workspaceRegistry is unavailable in this profile; archived sessions only exist in a profile with the Workspace layer (the shipped `web` profile)',
    )
    error.code = 'NO_WORKSPACE_REGISTRY'
    throw error
  }
  const ids = [...(registry.archivedSessionIds ?? [])].map(String)
  /** @type {Map<string, object>} */
  const headers = new Map()
  try {
    const snapshots = (await ctx.get?.('sessionPersistence')?.list?.()) ?? []
    for (const snapshot of snapshots) {
      const header = snapshot?.header
      if (header?.id !== undefined) headers.set(String(header.id), header)
    }
  } catch {
    /* headers only enrich the listing; ids alone are still actionable */
  }
  return { ids, headers }
}

/**
 * Build the archive listing the client renders.
 * @param {object} ctx - plugin context.
 * @param {object} cfg - resolved config.
 * @returns {Promise<object>} the scan payload.
 */
export async function scanArchive(ctx, cfg) {
  const { ids, headers } = await readArchiveState(ctx)
  const [dirIndex, cacheIndex] = await Promise.all([
    indexSessionDirs(cfg.sessionRoot),
    indexProjectionCache(cfg.projectionCacheDir),
  ])
  const titles = await readTitles(ctx, ids, cacheIndex)

  const sessions = []
  for (const id of ids) {
    const dir = dirIndex.get(id)
    const cacheFile = cacheIndex.get(id)
    const header = headers.get(id)
    let bytes = 0
    let files = 0
    if (dir !== undefined) {
      const measured = await measureDir(dir)
      bytes += measured.bytes
      files += measured.files
    }
    if (cacheFile !== undefined) {
      try {
        bytes += (await stat(cacheFile)).size
        files += 1
      } catch {
        /* raced away */
      }
    }
    const agent = liveAgent(ctx, id)
    sessions.push({
      id,
      title: titles.get(id) ?? '',
      cwd: typeof header?.cwd === 'string' ? header.cwd : '',
      createdAt: typeof header?.createdAt === 'number' ? header.createdAt : undefined,
      origin: header?.origin === 'subagent' ? 'subagent' : 'user',
      parentSession: typeof header?.parentSession === 'string' ? header.parentSession : undefined,
      bytes,
      files,
      hasLog: dir !== undefined,
      hasProjectionCache: cacheFile !== undefined,
      live: isLive(ctx, id),
      busy: isBusy(agent),
    })
  }

  return {
    sessions,
    totals: {
      count: sessions.length,
      bytes: sessions.reduce((sum, row) => sum + row.bytes, 0),
      missing: sessions.filter((row) => !row.hasLog && !row.hasProjectionCache).length,
      live: sessions.filter((row) => row.live).length,
    },
    roots: { sessionRoot: cfg.sessionRoot, storageRoot: cfg.storageRoot },
    limits: { maxSessions: cfg.maxSessions, includeDescendants: cfg.includeDescendants },
  }
}

/**
 * Expand a set of session ids with every descendant session (subagent and
 * fork lineage) found in the stored headers. Deleting a parent without its
 * children would leave unreachable orphan logs behind.
 * @param {Set<string>} roots - the explicitly requested ids.
 * @param {Map<string, object>} headers - id → stored header.
 * @returns {Set<string>} roots plus all descendants, in discovery order.
 */
export function withDescendants(roots, headers) {
  /** @type {Map<string, string[]>} */
  const children = new Map()
  for (const [id, header] of headers) {
    const parent = header?.parentSession
    if (typeof parent !== 'string') continue
    const list = children.get(parent)
    if (list === undefined) children.set(parent, [id])
    else list.push(id)
  }
  const out = new Set(roots)
  const queue = [...roots]
  while (queue.length > 0) {
    const current = queue.shift()
    for (const child of children.get(current) ?? []) {
      if (out.has(child)) continue
      out.add(child)
      queue.push(child)
    }
  }
  return out
}

/**
 * Release a deleted session's durable accounting through the public registry
 * API: unarchive it (drop it from the registry-global archive set) and detach
 * it from every workspace account that still lists it. `workspace.json` is
 * never written by this plugin.
 *
 * This is the step that makes a cleanup take effect in the SAME click: the
 * archive set is what the sidebar's archived filter and the archive listing
 * read, so dropping the entry here removes the row everywhere at once — no
 * journal, no second host start.
 *
 * A session the host still holds in memory cannot be unloaded (DSH exposes no
 * per-session eviction; a resident Agent lives until its owning fiber, i.e.
 * the process, unloads), and the Host's session list keeps returning it as a
 * live row. So the release also emits the Host's own `api-session/removed`
 * frame — the exact edge DSH publishes from `session/disposed` — which makes
 * every connected browser drop that row from its list snapshot immediately.
 * The frame is best-effort: a profile without a remote bridge still gets the
 * durable release, which is the part that must not fail.
 *
 * @param {object} ctx - plugin context.
 * @param {string} id - the deleted session id.
 * @param {{unarchive?: boolean, live?: boolean}} [options] - `unarchive: false`
 *   marks a lineage descendant (not on the archive set; `unarchiveSession` is
 *   documented as a no-op for one, so skipping it keeps the report truthful and
 *   writes nothing) and `live: true` additionally announces the row removal.
 * @returns {Promise<{unarchived: boolean, detached: string[], announced: boolean, warnings: string[]}>}
 */
export async function releaseAccounting(ctx, id, options = {}) {
  const warnings = []
  const detached = []
  let unarchived = false
  let announced = false
  const registry = ctx.get?.('workspaceRegistry')
  if (registry === undefined || registry === null) return { unarchived, detached, announced, warnings }

  try {
    if (options.unarchive !== false && typeof registry.unarchiveSession === 'function') {
      await registry.unarchiveSession(id)
      unarchived = true
    }
  } catch (error) {
    warnings.push(`unarchive ${id}: ${String(error?.message ?? error)}`)
  }
  try {
    for (const workspace of registry.list?.() ?? []) {
      const owned = (workspace.sessionIds ?? []).some((candidate) => String(candidate) === id)
      if (!owned) continue
      await workspace.detachSession(id)
      detached.push(String(workspace.id))
    }
  } catch (error) {
    warnings.push(`detach ${id}: ${String(error?.message ?? error)}`)
  }
  if (options.live === true) {
    try {
      ctx.emit?.(SESSION_REMOVED_EVENT, id)
      announced = true
    } catch (error) {
      warnings.push(`announce ${id}: ${String(error?.message ?? error)}`)
    }
  }
  return { unarchived, detached, announced, warnings }
}

/**
 * Keep the sessions this process has removed out of the Host's session-list
 * read. This is the half of a cleanup that makes the removal STICK.
 *
 * `releaseAccounting` emits the Host's own `api-session/removed` frame, which
 * drops the row from the list snapshot a browser already holds. That snapshot
 * is not the only way the row can come back: the Host re-serves the whole list
 * on every pull, `ApiSessionList.list()` prefers a live in-memory Session over
 * persistence without checking that its files still exist, and DSH keeps every
 * session the user opened resident until the process exits (it exposes no
 * per-session unload). A page refresh, a reconnect, or any panel that calls
 * `sessions.refresh()` — the Context Insights page does exactly that when it
 * opens — therefore re-fetches the row that was just deleted.
 *
 * The wrap is deliberately narrow and reversible:
 *   * it is installed on the live `sessionController` service INSTANCE and only
 *     filters ids from {@link purgedSessionIds}, so unrelated rows and the
 *     service's own contract are untouched;
 *   * it is removed again together with the plugin fiber, so a reload cannot
 *     stack wrappers;
 *   * a profile whose Session controller cannot be wrapped keeps the
 *     frame-only behavior, which is what 0.3.0 shipped.
 *
 * @param {object} controller - the live `sessionController` service instance.
 * @param {Set<string>} [ids] - removed ids to filter out; defaults to this
 *   process's own set.
 * @returns {(() => void)|undefined} the uninstall closure, or `undefined` when
 *   there is no list read to wrap.
 */
export function hideRemovedSessions(controller, ids = purgedSessionIds) {
  if (controller === undefined || controller === null) return undefined
  const inner = controller.list
  if (typeof inner !== 'function') return undefined
  const wrapped = async function list(request, signal) {
    const value = await Reflect.apply(inner, controller, [request, signal])
    const items = value?.items
    if (ids.size === 0 || !Array.isArray(items)) return value
    const kept = items.filter((row) => !ids.has(String(row?.sessionId)))
    // Hand back the Host's own value untouched when nothing was filtered, so an
    // unrelated pull is byte-for-byte the read it would have been.
    return kept.length === items.length ? value : { ...value, items: kept }
  }
  controller.list = wrapped
  return () => {
    if (controller.list === wrapped) controller.list = inner
  }
}

/**
 * Delete one session's artifacts. Every path is containment-checked and the
 * directory basename must equal the id, so a malformed index can never widen
 * the blast radius.
 * @param {object} cfg - resolved config.
 * @param {{id: string, dir?: string, cacheFile?: string}} target - the located artifacts.
 * @returns {Promise<{removedDir: boolean, removedCache: boolean, bytesFreed: number, files: number, warnings: string[]}>}
 */
async function removeArtifacts(cfg, target) {
  const warnings = []
  let bytesFreed = 0
  let files = 0
  let removedDir = false
  let removedCache = false

  if (target.dir !== undefined) {
    if (!isInside(cfg.sessionRoot, target.dir) || target.dir.split(sep).pop() !== target.id) {
      warnings.push(`refused session directory outside the session root: ${target.dir}`)
    } else {
      const measured = await measureDir(target.dir)
      bytesFreed += measured.bytes
      files += measured.files
      await rm(target.dir, { recursive: true, force: true })
      removedDir = true
    }
  }
  if (target.cacheFile !== undefined) {
    if (!isInside(cfg.storageRoot, target.cacheFile)) {
      warnings.push(`refused projection cache outside the storage root: ${target.cacheFile}`)
    } else {
      try {
        bytesFreed += (await stat(target.cacheFile)).size
        files += 1
      } catch {
        /* already gone */
      }
      await rm(target.cacheFile, { force: true })
      removedCache = true
    }
  }
  return { removedDir, removedCache, bytesFreed, files, warnings }
}

/**
 * Perform (or preview) one purge request.
 *
 * A request may only name ids that are currently archived; anything else is
 * reported as `not-archived` and left alone. Live descendants are skipped.
 *
 * The outcomes are reported separately, because they are different amounts of
 * work — and every one of them except the busy deferral is finished by THIS
 * request, with no restart in between:
 *   * `deleted`  — cold session: artifacts removed and accounting released.
 *   * `released` — archived id with no artifacts left, so dropping its registry
 *                  entry IS the whole cleanup.
 *   * `freed`    — archived id the process still holds: artifacts removed and
 *                  accounting released now, plus the browser row-removal frame;
 *                  only the host's in-memory copy lives on until it exits.
 *   * `queued`   — a held archived session with a turn in flight: nothing is
 *                  unlinked under a write, so it waits for the idle edge the
 *                  plugin observes.
 * `skipped` covers everything left alone (live descendants, nothing to do, or
 * a failure). `totals.count` covers the first four.
 * @param {object} ctx - plugin context.
 * @param {object} cfg - resolved config.
 * @param {{ids?: string[], all?: boolean, includeDescendants?: boolean, dryRun?: boolean}} request - the caller's choice.
 * @returns {Promise<object>} the purge report.
 * @throws {Error} with code `INVALID_REQUEST` / `TOO_MANY_SESSIONS`.
 */
export async function purgeArchive(ctx, cfg, request = {}) {
  const { ids: archivedIds, headers } = await readArchiveState(ctx)
  const archived = new Set(archivedIds)
  const includeDescendants = request.includeDescendants ?? cfg.includeDescendants
  const dryRun = request.dryRun === true

  let requested
  if (request.all === true) {
    requested = archivedIds
  } else if (Array.isArray(request.ids)) {
    requested = [...new Set(request.ids.map(String))]
  } else {
    const error = new Error('expected {"all": true} or {"ids": [...]}')
    error.code = 'INVALID_REQUEST'
    throw error
  }

  const refused = requested.filter((id) => !archived.has(id))
  const allowed = requested.filter((id) => archived.has(id))
  if (allowed.length === 0 && refused.length === 0) {
    return {
      dryRun,
      deleted: [],
      released: [],
      freed: [],
      queued: [],
      skipped: [],
      refused: [],
      warnings: [],
      totals: { count: 0, deleted: 0, released: 0, freed: 0, queued: 0, bytes: 0 },
      remaining: archived.size,
    }
  }

  const candidates = includeDescendants ? [...withDescendants(new Set(allowed), headers)] : allowed
  if (candidates.length > cfg.maxSessions) {
    const error = new Error(
      `refusing to clean ${candidates.length} sessions in one request; maxSessions is ${cfg.maxSessions}`,
    )
    error.code = 'TOO_MANY_SESSIONS'
    throw error
  }

  const [dirIndex, cacheIndex] = await Promise.all([
    indexSessionDirs(cfg.sessionRoot),
    indexProjectionCache(cfg.projectionCacheDir),
  ])
  const titles = await readTitles(ctx, candidates, cacheIndex)

  const deleted = []
  const released = []
  const freed = []
  const queued = []
  const skipped = []
  const warnings = []
  let bytes = 0

  for (const id of candidates) {
    const dir = dirIndex.get(id)
    const cacheFile = cacheIndex.get(id)
    const isArchived = archived.has(id)
    const measured = async () => {
      let total = 0
      let files = 0
      if (dir !== undefined) {
        const size = await measureDir(dir)
        total += size.bytes
        files += size.files
      }
      if (cacheFile !== undefined) {
        try {
          total += (await stat(cacheFile)).size
          files += 1
        } catch {
          /* raced away */
        }
      }
      return { bytes: total, files }
    }

    // Sessions the process still holds. Only an ARCHIVED one is actionable
    // here: DSH keeps every session the user opened resident for the life of
    // the process (archiving stops its work but does not unload it) and exposes
    // no per-session unload, so the HOST's list keeps returning it. That does
    // not stop the cleanup: archival gates every step, the write handle is
    // drained first so nothing recreates the files, the registry entry is
    // released in this same request, and the browser gets the row-removal frame
    // — the sidebar drops the row instead of waiting for a page reload.
    // A live DESCENDANT owns no archive entry and is not hidden by archival, so
    // it is skipped outright.
    if (isLive(ctx, id)) {
      if (!isArchived) {
        skipped.push({ id, reason: 'live' })
        continue
      }
      if (isBusy(liveAgent(ctx, id))) {
        // A turn is still winding down: never unlink under a write. The row is
        // deferred to the idle moment the plugin observes (see `deferUntilIdle`
        // in `apply`) rather than to a restart.
        if (dryRun) {
          const size = await measured()
          queued.push({
            id,
            title: titles.get(id) ?? '',
            bytes: size.bytes,
            files: size.files,
            held: true,
            reason: 'busy',
            dryRun: true,
          })
          continue
        }
        queued.push({
          id,
          title: titles.get(id) ?? '',
          bytes: 0,
          files: 0,
          removedDir: false,
          removedCache: false,
          held: true,
          reason: 'busy',
        })
        deferredBusyIds?.add(id)
        continue
      }
      if (dryRun) {
        const size = await measured()
        bytes += size.bytes
        freed.push({
          id,
          title: titles.get(id) ?? '',
          bytes: size.bytes,
          files: size.files,
          held: true,
          dryRun: true,
        })
        continue
      }
      try {
        warnings.push(...(await drainSession(ctx, id)))
        const removal = await removeArtifacts(cfg, { id, dir, cacheFile })
        warnings.push(...removal.warnings)
        bytes += removal.bytesFreed
        const accounting = await releaseAccounting(ctx, id, { unarchive: true, live: true })
        warnings.push(...accounting.warnings)
        freed.push({
          id,
          title: titles.get(id) ?? '',
          bytes: removal.bytesFreed,
          files: removal.files,
          removedDir: removal.removedDir,
          removedCache: removal.removedCache,
          held: true,
          unarchived: accounting.unarchived,
          detached: accounting.detached,
          announced: accounting.announced,
        })
      } catch (error) {
        skipped.push({ id, reason: 'error', message: String(error?.message ?? error) })
      }
      continue
    }

    if (dir === undefined && cacheFile === undefined) {
      // Nothing on disk to remove. For an archived id that is still the whole
      // job: the registry entry is what keeps a ghost row on every archive
      // surface, and dropping it cannot introduce an unknown session. A
      // lineage descendant with no artifacts owns no archive entry, so there
      // is genuinely nothing to do for it.
      if (!isArchived) {
        skipped.push({ id, reason: 'no-artifacts' })
        continue
      }
      if (dryRun) {
        released.push({ id, title: titles.get(id) ?? '', bytes: 0, files: 0, dryRun: true })
        continue
      }
      try {
        const accounting = await releaseAccounting(ctx, id, { unarchive: true })
        warnings.push(...accounting.warnings)
        released.push({
          id,
          title: titles.get(id) ?? '',
          bytes: 0,
          files: 0,
          removedDir: false,
          removedCache: false,
          unarchived: accounting.unarchived,
          detached: accounting.detached,
        })
      } catch (error) {
        skipped.push({ id, reason: 'error', message: String(error?.message ?? error) })
      }
      continue
    }
    if (dryRun) {
      const size = await measured()
      bytes += size.bytes
      deleted.push({
        id,
        title: titles.get(id) ?? '',
        bytes: size.bytes,
        files: size.files,
        dryRun: true,
      })
      continue
    }
    try {
      const removal = await removeArtifacts(cfg, { id, dir, cacheFile })
      warnings.push(...removal.warnings)
      bytes += removal.bytesFreed
      const accounting = await releaseAccounting(ctx, id, { unarchive: isArchived })
      warnings.push(...accounting.warnings)
      deleted.push({
        id,
        title: titles.get(id) ?? '',
        bytes: removal.bytesFreed,
        files: removal.files,
        removedDir: removal.removedDir,
        removedCache: removal.removedCache,
        unarchived: accounting.unarchived,
        detached: accounting.detached,
      })
    } catch (error) {
      skipped.push({ id, reason: 'error', message: String(error?.message ?? error) })
    }
  }

  // Remember everything this request finished. The accounting release and the
  // removal frame only fix the list a browser holds right now; this set is what
  // keeps the row out of every LATER list pull, which is the only way a session
  // the Host still holds can stop reappearing (see `hideRemovedSessions`). A
  // `queued` row keeps its files and its entry, so it is not remembered here.
  for (const row of [...deleted, ...released, ...freed]) purgedSessionIds.add(String(row.id))

  return {
    dryRun,
    deleted,
    released,
    freed,
    queued,
    skipped,
    refused,
    warnings,
    totals: {
      count: deleted.length + released.length + freed.length + queued.length,
      deleted: deleted.length,
      released: released.length,
      freed: freed.length,
      queued: queued.length,
      bytes,
    },
    remaining: Math.max(
      0,
      archived.size -
        deleted.filter((row) => archived.has(row.id)).length -
        released.filter((row) => archived.has(row.id)).length -
        freed.filter((row) => archived.has(row.id)).length,
    ),
  }
}

/**
 * Finish the cleanups an older (0.2.x) process left journaled.
 *
 * 0.2.x reclaimed the bytes of a held archived session but could not drop its
 * registry entry, so it wrote the entry into `pending.json` for the next start.
 * 0.3.0 releases the entry in the same click, which leaves that file as a
 * one-time migration: every id in it is a file-less archive entry (the bytes
 * are already gone), and this pass drops those entries so the user never has to
 * click again after upgrading. The journal is retired either way — it is read
 * once and deleted.
 *
 * Conservative on purpose: an id the user re-claimed (unarchived since) and an
 * id some other process still holds are both dropped WITHOUT touching disk, and
 * a profile with no Workspace layer keeps the file for a later start.
 * @param {object} ctx - plugin context.
 * @param {object} cfg - resolved config.
 * @returns {Promise<{applied: object[], dropped: string[], warnings: string[], ran: boolean}>}
 */
export async function applyPending(ctx, cfg) {
  const ids = await readPendingIds(cfg)
  const result = { applied: [], dropped: [], warnings: [], ran: false }
  if (ids.length === 0) return result

  let archived
  try {
    const state = await readArchiveState(ctx)
    archived = new Set(state.ids)
  } catch (error) {
    // No Workspace layer (or no registry yet): the entry cannot be released, so
    // the journal stays for a later start instead of being thrown away.
    result.warnings.push(String(error?.message ?? error))
    return result
  }
  result.ran = true

  const [dirIndex, cacheIndex] = await Promise.all([
    indexSessionDirs(cfg.sessionRoot),
    indexProjectionCache(cfg.projectionCacheDir),
  ])
  const titles = await readTitles(ctx, ids, cacheIndex)

  for (const id of ids) {
    if (!archived.has(id) || isLive(ctx, id)) {
      // Unarchived since (wanted again) or still resident here: leave whatever
      // files remain alone and forget the queued release.
      result.dropped.push(id)
      continue
    }
    try {
      const dir = dirIndex.get(id)
      const cacheFile = cacheIndex.get(id)
      if (dir !== undefined || cacheFile !== undefined) {
        const removal = await removeArtifacts(cfg, { id, dir, cacheFile })
        result.warnings.push(...removal.warnings)
      }
      const accounting = await releaseAccounting(ctx, id, { unarchive: true })
      result.warnings.push(...accounting.warnings)
      result.applied.push({
        id,
        title: titles.get(id) ?? '',
        unarchived: accounting.unarchived,
        detached: accounting.detached,
      })
    } catch (error) {
      result.dropped.push(id)
      result.warnings.push(`legacy pending ${id}: ${String(error?.message ?? error)}`)
    }
  }

  // Uniform bookkeeping with `purgeArchive`: an id this process removed is not
  // served back by the Host's list read either. A migrated entry is cold and
  // artifact-less (the live case is dropped above), so this is belt-and-braces
  // rather than a fix — the set stays truthful about what was removed.
  for (const row of result.applied) purgedSessionIds.add(String(row.id))

  await dropLegacyPendingIds(cfg)
  if (result.applied.length > 0) {
    ctx.logger?.info?.(
      '[dsh-archive-cleanup] released %d legacy archive entr%s',
      result.applied.length,
      result.applied.length === 1 ? 'y' : 'ies',
    )
  }
  for (const warning of result.warnings) ctx.logger?.warn?.('[dsh-archive-cleanup] %s', warning)
  return result
}

/** JSON response helper. */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/**
 * Read a bounded JSON request body.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {Promise<object>} the parsed object (an empty body is `{}`).
 */
async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) {
      const error = new Error('request body too large')
      error.code = 'BODY_TOO_LARGE'
      throw error
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  const parsed = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    const error = new Error('expected a JSON object')
    error.code = 'INVALID_REQUEST'
    throw error
  }
  return parsed
}

/**
 * Cross-origin guard for the destructive route. A browser cannot attach a
 * custom request header cross-origin without a preflight, and this server
 * never answers a permissive preflight; the Origin check covers the rest.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {string|undefined} a refusal reason, or `undefined` when allowed.
 */
function crossOriginRefusal(req) {
  if (req.headers['x-dsh-archive-cleanup'] !== '1') {
    return 'missing x-dsh-archive-cleanup: 1 request header'
  }
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
    let host
    try {
      host = new URL(origin).host
    } catch {
      return 'malformed Origin header'
    }
    if (host !== req.headers.host) return 'cross-origin request refused'
  }
  return undefined
}

/**
 * Register both loopback routes on the scoped context's web server.
 * @param {object} scope - scoped context carrying `webServer`.
 * @param {object} ctx - plugin context (registry, persistence, session query).
 * @param {object} cfg - resolved config.
 */
function registerRoutes(scope, ctx, cfg) {
  const webServer = scope.webServer
  if (typeof webServer?.register !== 'function') {
    ctx.logger?.warn?.('[dsh-archive-cleanup] webServer.register unavailable; routes skipped')
    return
  }

  webServer.register({
    kind: 'exact',
    path: SCAN_PATH,
    handler: async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      try {
        sendJson(res, 200, { ok: true, data: await scanArchive(ctx, cfg) })
      } catch (error) {
        const code = error?.code === 'NO_WORKSPACE_REGISTRY' ? 501 : 500
        sendJson(res, code, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  webServer.register({
    kind: 'exact',
    path: PURGE_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      const refusal = crossOriginRefusal(req)
      if (refusal !== undefined) return sendJson(res, 403, { ok: false, error: refusal })
      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        const code = error?.code === 'BODY_TOO_LARGE' ? 413 : 400
        return sendJson(res, code, { ok: false, error: String(error?.message ?? error) })
      }
      if (body.dryRun !== true && body.confirm !== true) {
        return sendJson(res, 400, { ok: false, error: 'refusing to delete without confirm: true (or ask for dryRun: true)' })
      }
      try {
        const report = await purgeArchive(ctx, cfg, body)
        sendJson(res, 200, { ok: true, data: report })
      } catch (error) {
        const code = error?.code === 'INVALID_REQUEST' || error?.code === 'TOO_MANY_SESSIONS' ? 400 : 500
        sendJson(res, code, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })
}

/**
 * Required at apply time: the system-prompt section seat. Cordis refuses a
 * `ctx.<service>` read on a context that did not declare the service, so this
 * declaration is load-bearing — without it activation fails with
 * `cannot get property "systemPrompt" without inject`.
 *
 * Every other DSH service this half touches is read through `ctx.get(name)`,
 * which needs no declaration, so a profile missing one of them degrades to a
 * reported diagnostic instead of a failed fiber.
 */
export const inject = ['systemPrompt']

/**
 * Plugin entrypoint: announce the capability to the model and, in a profile
 * with a web server, register the loopback routes.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} [config] - resolved plugin config.
 */
export function apply(ctx, config = {}) {
  const cfg = resolveConfig(config)
  let announce = cfg.announceToAgent
  let disposeAnnounce
  const syncAnnounce = () => {
    try {
      if (disposeAnnounce !== undefined) {
        disposeAnnounce()
        disposeAnnounce = undefined
      }
      if (!announce) return
      if (typeof ctx.systemPrompt?.section !== 'function') return
      disposeAnnounce = ctx.systemPrompt.section({
        name: 'plugin:archive-cleanup',
        order: SECTION_ORDER,
        text: AGENT_GUIDANCE,
      })
    } catch (error) {
      // The announcement is a convenience; never let it fail the fiber.
      ctx.logger?.warn?.('[dsh-archive-cleanup] system-prompt section failed: %s', String(error?.message ?? error))
    }
  }
  syncAnnounce()

  // Retire whatever an older (0.2.x) process journaled for "the next start".
  // 0.3.0 releases entries in the same click, so that file is now a one-time
  // migration list; consuming it means an in-flight upgrade never leaves a
  // file-less archive entry behind.
  migrateLegacyJournal(ctx, cfg)

  // A held archived session whose turn is still running is deferred, not
  // dropped: retry it the moment its Agent goes idle, so the user's click ends
  // up complete without a restart.
  deferBusyCleanups(ctx, cfg)

  // A session the Host still holds would be served again by the next list pull
  // (page refresh, reconnect, or the Context Insights page's own
  // `sessions.refresh()`). Filter this process's removed ids out of that read;
  // a profile without a Session controller simply keeps the frame-only
  // behavior, and one without inject support has no service to wrap at all.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['sessionController'], (scope) => installListFilter(scope, ctx))
  }

  // Headless/TUI profiles have no web server; the scoped inject never runs.
  if (typeof ctx.inject !== 'function') return

  ctx.inject(['webServer'], (scope) => {
    try {
      registerRoutes(scope, ctx, cfg)
      ctx.logger?.info?.(
        '[dsh-archive-cleanup] ready: sessionRoot=%s storageRoot=%s',
        cfg.sessionRoot,
        cfg.storageRoot,
      )
    } catch (error) {
      ctx.logger?.error?.('[dsh-archive-cleanup] route registration failed: %s', String(error?.message ?? error))
    }
  })
}

/**
 * Install — and own — the Host's session-list filter for the ids this process
 * removed. It runs in its own `sessionController`-scoped fiber, so the wrapper
 * is uninstalled with the plugin; a failure is reported as a diagnostic instead
 * of failing the fiber.
 * @param {object} scope - context carrying `sessionController`.
 * @param {object} ctx - plugin context (logging only).
 * @returns {(() => void)|undefined} the uninstall closure Cordis collects.
 */
function installListFilter(scope, ctx) {
  try {
    const uninstall = hideRemovedSessions(scope?.sessionController)
    if (uninstall === undefined) {
      ctx.logger?.warn?.(
        '[dsh-archive-cleanup] sessionController.list is not wrappable; a removed session the Host still holds can be listed again until the process exits',
      )
    }
    return uninstall
  } catch (error) {
    ctx.logger?.warn?.('[dsh-archive-cleanup] session-list filter failed: %s', String(error?.message ?? error))
    return undefined
  }
}

/**
 * Consume the retired 0.2.x journal once, after the Workspace registry exists.
 *
 * No timers and no polling: the pass runs when the registry service is
 * available (or immediately when this profile has no inject seat, where
 * `applyPending` keeps the file on its own).
 * @param {object} ctx - plugin context.
 * @param {object} cfg - resolved config.
 */
function migrateLegacyJournal(ctx, cfg) {
  const run = async () => {
    try {
      await applyPending(ctx, cfg)
    } catch (error) {
      ctx.logger?.warn?.('[dsh-archive-cleanup] legacy journal migration failed: %s', String(error?.message ?? error))
    }
  }
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['workspaceRegistry'], () => void run())
      return
    }
  } catch {
    /* fall through to the immediate attempt */
  }
  void run()
}

/**
 * Retry the archived sessions a purge had to skip because a turn was running.
 *
 * Only the busy case is deferred, and it is deferred to the idle edge the host
 * already publishes (`agent/status`), never to a restart: `purgeArchive` is
 * re-run for exactly those ids as soon as none of them is busy any more. The
 * deferred set is process-local; anything still pending when the process exits
 * is simply still archived with its files intact, so nothing is half-deleted.
 * @param {object} ctx - plugin context.
 * @param {object} cfg - resolved config.
 */
export function deferBusyCleanups(ctx, cfg) {
  /** @type {Set<string>} */
  const waiting = new Set()
  let running = false

  const retry = async () => {
    if (running || waiting.size === 0) return
    running = true
    try {
      const idle = []
      for (const id of waiting) if (!isBusy(liveAgent(ctx, id))) idle.push(id)
      if (idle.length === 0) return
      const report = await purgeArchive(ctx, cfg, { ids: idle, includeDescendants: false, confirm: true })
      const done = new Set([
        ...report.deleted.map((row) => String(row.id)),
        ...report.released.map((row) => String(row.id)),
        ...report.freed.map((row) => String(row.id)),
      ])
      for (const id of done) waiting.delete(id)
      // A refused id is no longer archived (someone unarchived it): forget it.
      for (const id of report.refused ?? []) waiting.delete(String(id))
      if (done.size > 0) {
        ctx.logger?.info?.(
          '[dsh-archive-cleanup] finished %d deferred cleanup(s) once their turn ended',
          done.size,
        )
      }
    } catch (error) {
      ctx.logger?.warn?.('[dsh-archive-cleanup] deferred cleanup failed: %s', String(error?.message ?? error))
    } finally {
      running = false
    }
  }

  // The purge route hands its deferred ids over through this module-level set
  // (there is exactly one plugin instance per host), so it is installed before
  // the first request can arrive.
  deferredBusyIds = waiting

  try {
    ctx.on?.('agent/status', ({ agent, status } = {}) => {
      if (agent?.id === undefined || status === 'running') return
      if (!waiting.has(String(agent.id))) return
      void retry()
    })
    ctx.on?.('agent/disposed', ({ agent } = {}) => {
      if (agent?.id === undefined) return
      if (!waiting.has(String(agent.id))) return
      void retry()
    })
  } catch {
    /* events unavailable: a busy row stays archived with its files, safely */
  }
}

export default apply
