// Smoke test for the host half. Builds a throwaway DSH home that mirrors the
// real on-disk layout (one project directory per cwd, one directory per
// session, one projection-cache document per session) and drives the exported
// functions against a fake context, so the destructive path is exercised
// without a running harness.
//
//   node test/smoke.mjs
//
// Exits non-zero on the first failed assertion.

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  applyPending,
  deferBusyCleanups,
  hideRemovedSessions,
  purgeArchive,
  readPendingIds,
  releaseAccounting,
  resolveConfig,
  scanArchive,
} from '../lib/index.js'

const home = await mkdtemp(join(tmpdir(), 'dsh-archive-cleanup-'))
const sessionRoot = join(home, 'sessions')
const storageRoot = join(home, 'storages')
const project = join(sessionRoot, '--home-me-demo--')
const cacheDir = join(storageRoot, 'session_projcache', 'sessions')
const legacyJournal = join(storageRoot, 'archive-cleanup', 'pending.json')

const PARENT = 'session-aaaa1111-0000-0000-0000-000000000000'
const CHILD = 'session-bbbb2222-0000-0000-0000-000000000000'
const KEEP = 'session-cccc3333-0000-0000-0000-000000000000'

async function makeSession(id, { bytes, cwd = '/home/me/demo' }) {
  const dir = join(project, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), Buffer.alloc(bytes, 7))
  await writeFile(join(dir, 'session.lock'), '')
  await writeFile(
    join(cacheDir, `${id}.json`),
    JSON.stringify({
      version: 7,
      record: { identity: { cwd, createdAt: 1791427433009 }, rows: { title: { ver: 1, seq: 12, val: `title of ${id}` } } },
    }),
  )
  return dir
}

await mkdir(cacheDir, { recursive: true })
const parentDir = await makeSession(PARENT, { bytes: 4096 })
const childDir = await makeSession(CHILD, { bytes: 1024 })
const keepDir = await makeSession(KEEP, { bytes: 2048 })

/** Fake Workspace entity: records accounting releases without the storage domain. */
function fakeWorkspace(sessionIds) {
  return {
    id: 'ws-1',
    sessionIds,
    detached: [],
    async detachSession(id) {
      this.detached.push(id)
    },
  }
}

/** Everything the host-side release publishes, in order. */
const emitted = []
/** The registry's durable archive set, mutated the way the real one is. */
const archivedIds = [PARENT]
/** Sessions the fake host currently holds (promoted and never unloaded). */
const liveAgents = new Map()
/** Extra stored headers the persistence listing must expose (lineage links). */
const storedHeaders = []

const workspace = fakeWorkspace([PARENT, KEEP])
const registryCalls = { unarchived: [] }
/** Sessions whose live write handle a purge drained before unlinking. */
const flushed = []

/** Fake plugin context over the mutable state above. */
function makeCtx(workspaces = [workspace]) {
  /** Cordis-style event listeners, so a test can publish `agent/status`. */
  const listeners = new Map()
  return {
    logger: { info() {}, warn() {}, error() {} },
    emit(event, id) {
      emitted.push({ event, id })
    },
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {}
    },
    /** Publish one event synchronously, the way the Host does. */
    publish(event, payload) {
      for (const listener of listeners.get(event) ?? []) listener(payload)
    },
    get(name) {
      if (name === 'workspaceRegistry') {
        return {
          get archivedSessionIds() {
            return [...archivedIds]
          },
          list: () => workspaces,
          async unarchiveSession(id) {
            registryCalls.unarchived.push(id)
            const at = archivedIds.indexOf(id)
            if (at !== -1) archivedIds.splice(at, 1)
          },
        }
      }
      if (name === 'sessionPersistence') {
        return {
          async list() {
            return [
              { header: { id: PARENT, cwd: '/home/me/demo', createdAt: 1000 } },
              { header: { id: CHILD, cwd: '/home/me/demo', createdAt: 2000, origin: 'subagent', parentSession: PARENT } },
              { header: { id: KEEP, cwd: '/home/me/demo', createdAt: 3000 } },
              // Live-agent headers first, the explicit lineage headers last: the
              // id → header map keeps the final write, so a lineage link wins.
              ...[...liveAgents.keys()].map((id) => ({ header: { id, cwd: '/home/me/demo', createdAt: 6000 } })),
              ...storedHeaders,
            ]
          },
        }
      }
      if (name === 'sessions') {
        return {
          get: (id) => (liveAgents.has(id) ? { id } : undefined),
          async flush(session) {
            flushed.push(session?.id)
          },
        }
      }
      if (name === 'agents') return { get: (id) => liveAgents.get(id) }
      return undefined
    },
  }
}

const ctx = makeCtx()
const cfg = resolveConfig({ dshHome: home })
/** Let the async deferred cleanup started by an event listener finish. */
const settle = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 5))
}

// ── scan ────────────────────────────────────────────────────────────────────
const scan = await scanArchive(ctx, cfg)
assert.equal(scan.totals.count, 1, 'one archived session')
assert.equal(scan.sessions[0].id, PARENT)
assert.equal(scan.sessions[0].title, `title of ${PARENT}`, 'title folded from the projection cache')
assert.equal(scan.sessions[0].hasLog, true)
assert.equal(scan.sessions[0].hasProjectionCache, true)
assert.equal(scan.sessions[0].live, false)
assert.equal(scan.pending, undefined, 'the retired journal is no longer part of the listing')
assert.equal(scan.totals.pending, undefined, 'and no longer counted')
assert.ok(scan.sessions[0].bytes >= 4096, 'log bytes measured')
console.log('scan            ok:', scan.totals.count, 'archived,', scan.sessions[0].bytes, 'bytes')

// ── a non-archived id is refused ────────────────────────────────────────────
const refused = await purgeArchive(ctx, cfg, { ids: [KEEP], confirm: true })
assert.equal(refused.deleted.length, 0)
assert.deepEqual(refused.refused, [KEEP])
assert.ok(existsSync(keepDir), 'a non-archived session is never touched')
console.log('refusal         ok: non-archived id left alone')

// ── dry run changes nothing ─────────────────────────────────────────────────
const preview = await purgeArchive(ctx, cfg, { all: true, dryRun: true, confirm: true })
assert.equal(preview.dryRun, true)
assert.equal(preview.totals.count, 2, 'dry run also counts the lineage child')
assert.ok(existsSync(parentDir) && existsSync(childDir), 'dry run deletes nothing')
assert.deepEqual(registryCalls.unarchived, [], 'dry run writes no accounting')
console.log('dry run         ok: 2 sessions would be removed,', preview.totals.bytes, 'bytes')

// ── the real purge ──────────────────────────────────────────────────────────
const report = await purgeArchive(ctx, cfg, { all: true, confirm: true })
assert.equal(report.totals.count, 2, 'parent + descendant deleted')
assert.deepEqual(
  report.deleted.map((row) => row.id).sort(),
  [PARENT, CHILD].sort(),
)
assert.equal(existsSync(parentDir), false, 'parent log directory removed')
assert.equal(existsSync(childDir), false, 'descendant log directory removed')
assert.equal(existsSync(keepDir), true, 'unrelated session survives')
await assert.rejects(stat(join(cacheDir, `${PARENT}.json`)), 'projection cache document removed')
assert.deepEqual(registryCalls.unarchived, [PARENT], 'archive set released through the registry')
assert.deepEqual(workspace.detached, [PARENT], 'workspace accounting detached')
assert.deepEqual(archivedIds, [], 'the archive entry leaves in the same request — no journal, no restart')
assert.ok(report.totals.bytes >= 5120, 'freed bytes reported')
console.log('purge           ok:', report.totals.count, 'deleted,', report.totals.bytes, 'bytes freed')

// ── the archive is empty afterwards ─────────────────────────────────────────
const after = await purgeArchive(ctx, cfg, { all: true, confirm: true })
assert.equal(after.totals.count, 0)
assert.equal(after.deleted.length, 0)
console.log('idempotence     ok: nothing left to clean')

// ── a HELD archived session: files AND entry released in the same click ─────
// DSH promotes every session the user opens into a resident Agent that lives as
// long as the process and exposes no per-session unload, so the HOST keeps
// listing it. That must not turn into "clean, then restart": the artifacts go,
// the registry entry goes, and the browser is told to drop the row.
const LIVE = 'session-ffff6666-0000-0000-0000-000000000000'
const LIVE_CHILD = 'session-ffff7777-0000-0000-0000-000000000000'
const liveDir = await makeSession(LIVE, { bytes: 4096 })
const liveChildDir = await makeSession(LIVE_CHILD, { bytes: 512 })
liveAgents.set(LIVE, { id: LIVE, status: 'idle' })
liveAgents.set(LIVE_CHILD, { id: LIVE_CHILD, status: 'idle' })
archivedIds.push(LIVE)
// A live child of the archived session: it owns no archive entry, but the
// lineage walk must still reach it (and skip it) when a parent is purged.
storedHeaders.push({
  header: { id: LIVE_CHILD, cwd: '/home/me/demo', createdAt: 6000, origin: 'subagent', parentSession: LIVE },
})
flushed.length = 0

const liveReport = await purgeArchive(ctx, cfg, { all: true, confirm: true })
assert.equal(liveReport.totals.freed, 1, 'the held archived session is reported as freed')
assert.equal(liveReport.totals.count, 1)
assert.deepEqual(
  liveReport.freed.map((row) => row.id),
  [LIVE],
)
assert.equal(liveReport.freed[0].unarchived, true, 'its entry is released in this request')
assert.equal(liveReport.freed[0].announced, true, 'and the browser is told to drop the row')
assert.deepEqual(liveReport.skipped, [{ id: LIVE_CHILD, reason: 'live' }], 'a live descendant is skipped outright')
assert.deepEqual(flushed, [LIVE], 'the held write handle is drained before the artifacts are unlinked')
assert.equal(existsSync(liveDir), false, 'a held archived session loses its artifacts')
assert.equal(existsSync(liveChildDir), true, 'the live descendant keeps its log')
assert.equal(archivedIds.includes(LIVE), false, 'a held session drops its archive entry immediately')
assert.deepEqual(
  emitted.map((row) => `${row.event}:${row.id}`),
  [`api-session/removed:${LIVE}`],
  "the Host's own list-removal frame makes every browser drop the row",
)
console.log('held session    ok: files + entry released now, browser row removed')

// The released id left the archive set, so the next listing has nothing to
// offer: the only thing a follow-up request can still see is the live child.
const repeatScan = await scanArchive(ctx, cfg)
assert.deepEqual(repeatScan.sessions, [], 'the released session is gone from the archive listing')
assert.equal(repeatScan.totals.count, 0)
console.log('repeat purge    ok: nothing left to reclaim')

// ── a HELD session mid-turn is deferred to the idle edge, not to a restart ──
const BUSY = 'session-ffff8888-0000-0000-0000-000000000000'
const busyDir = await makeSession(BUSY, { bytes: 2048 })
archivedIds.push(BUSY)
liveAgents.set(BUSY, { id: BUSY, status: 'running' })
flushed.length = 0

const deferCtx = makeCtx()
deferBusyCleanups(deferCtx, cfg)
const busyReport = await purgeArchive(deferCtx, cfg, { all: true, confirm: true })
assert.deepEqual(
  busyReport.queued.map((row) => row.id),
  [BUSY],
)
assert.ok(existsSync(busyDir), 'a running session is never unlinked')
assert.equal(flushed.includes(BUSY), false, 'a running session is not flushed either')
assert.ok(archivedIds.includes(BUSY), 'and keeps its entry until the turn ends')

// The turn ends: the deferral's own listener finishes the job.
liveAgents.set(BUSY, { id: BUSY, status: 'idle' })
deferCtx.publish('agent/status', { agent: { id: BUSY }, status: 'idle' })
await settle()
assert.equal(existsSync(busyDir), false, 'the deferred cleanup runs the moment the Agent is idle')
assert.equal(archivedIds.includes(BUSY), false, 'and releases the entry then, still without a restart')
console.log('busy session    ok: deferred to the idle edge, finished automatically')

// ── the Host's LATER list pulls no longer serve the removed rows ────────────
// The removal frame drops the row from the list a browser already holds, but
// the Host re-serves the whole list on every pull and prefers a live in-memory
// Session over persistence without checking that its files still exist. That is
// how a cleaned session came back on a page refresh, a reconnect, or the
// Context Insights page's `sessions.refresh()`. The plugin wraps that read with
// the ids it removed, and only those.
const servedRows = () => [{ sessionId: LIVE }, { sessionId: KEEP }, { sessionId: BUSY }]
const controller = {
  async list() {
    return { items: servedRows(), revision: 7 }
  },
}
const uninstall = hideRemovedSessions(controller)
assert.equal(typeof uninstall, 'function', 'the Host list read is wrapped')
const relisted = await controller.list({}, undefined)
assert.deepEqual(
  relisted.items.map((row) => row.sessionId),
  [KEEP],
  'the sessions this process removed are never served again, live or not',
)
assert.equal(relisted.revision, 7, 'the rest of the Host value is passed through')
assert.equal((await controller.list()).items.length, 1, 'the wrapper keeps working without a signal')
uninstall()
assert.deepEqual(
  (await controller.list()).items.map((row) => row.sessionId),
  [LIVE, KEEP, BUSY],
  'uninstalling restores the Host read exactly',
)
assert.equal(hideRemovedSessions({}), undefined, 'a service without a list read is left alone')
assert.equal(hideRemovedSessions(undefined), undefined, 'and so is a missing service')
console.log('list filter     ok: removed ids never come back on a later list pull')

// ── a ghost archive entry (no artifacts) is released, not skipped ───────────
const GHOST = 'session-dddd4444-0000-0000-0000-000000000000'
const GHOST_CHILD = 'session-eeee5555-0000-0000-0000-000000000000'
const ghostCalls = { unarchived: [] }
const ghostWorkspace = {
  id: 'ws-1',
  sessionIds: [GHOST],
  detached: [],
  async detachSession(id) {
    this.detached.push(id)
  },
}
const ghostCtx = {
  ...makeCtx([ghostWorkspace]),
  get(name) {
    if (name === 'workspaceRegistry') {
      return {
        archivedSessionIds: [GHOST],
        list: () => [ghostWorkspace],
        async unarchiveSession(id) {
          ghostCalls.unarchived.push(id)
        },
      }
    }
    if (name === 'sessionPersistence') {
      return {
        async list() {
          return [
            { header: { id: GHOST, cwd: '/home/me/demo', createdAt: 4000 } },
            {
              header: { id: GHOST_CHILD, cwd: '/home/me/demo', createdAt: 5000, origin: 'subagent', parentSession: GHOST },
            },
          ]
        },
      }
    }
    return undefined
  },
}

const ghostPreview = await purgeArchive(ghostCtx, cfg, { all: true, dryRun: true, confirm: true })
assert.equal(ghostPreview.totals.released, 1, 'dry run previews the artifact-less entry')
assert.equal(ghostPreview.totals.count, 1)
assert.deepEqual(ghostCalls.unarchived, [], 'dry run writes no accounting')

const ghostReport = await purgeArchive(ghostCtx, cfg, { all: true, confirm: true })
assert.deepEqual(ghostReport.deleted, [], 'nothing on disk to delete')
assert.deepEqual(
  ghostReport.released.map((row) => row.id),
  [GHOST],
)
assert.deepEqual(
  ghostReport.skipped,
  [{ id: GHOST_CHILD, reason: 'no-artifacts' }],
  'a non-archived descendant with no artifacts is still skipped',
)
assert.deepEqual(ghostCalls.unarchived, [GHOST], 'the stale archive entry is released')
assert.deepEqual(ghostWorkspace.detached, [GHOST], 'its workspace accounting is detached')
assert.equal(ghostReport.totals.count, 1)
assert.equal(ghostReport.remaining, 0, 'the released entry no longer counts as remaining')
console.log('ghost release   ok: artifact-less archive entry released')

// ── the retired 0.2.x journal is consumed once, without another click ───────
// 0.2.x wrote `pending.json` for the "next start"; 0.3.0 releases in the click.
// An upgrade in flight therefore still finds that file, and the migration must
// finish those entries — but never touch files a re-claimed session still owns.
const LEGACY_COLD = 'session-1111aaaa-0000-0000-0000-000000000000'
const LEGACY_HELD = 'session-2222bbbb-0000-0000-0000-000000000000'
const LEGACY_WANTED = 'session-3333cccc-0000-0000-0000-000000000000'
const legacyCalls = { unarchived: [] }
const legacyWorkspace = fakeWorkspace([LEGACY_WANTED])
const legacyCtx = {
  ...makeCtx([legacyWorkspace]),
  get(name) {
    if (name === 'workspaceRegistry') {
      return {
        get archivedSessionIds() {
          return [LEGACY_COLD, LEGACY_HELD]
        },
        list: () => [legacyWorkspace],
        async unarchiveSession(id) {
          legacyCalls.unarchived.push(id)
        },
      }
    }
    if (name === 'sessionPersistence') {
      return {
        async list() {
          return [
            { header: { id: LEGACY_COLD, cwd: '/home/me/demo', createdAt: 7000 } },
            { header: { id: LEGACY_HELD, cwd: '/home/me/demo', createdAt: 7000 } },
            { header: { id: LEGACY_WANTED, cwd: '/home/me/demo', createdAt: 7000 } },
          ]
        },
      }
    }
    if (name === 'sessions') {
      return {
        get: (id) => (id === LEGACY_HELD ? { id } : undefined),
        async flush() {},
      }
    }
    if (name === 'agents') return { get: (id) => (id === LEGACY_HELD ? { id, status: 'idle' } : undefined) }
    return undefined
  },
}
await mkdir(join(storageRoot, 'archive-cleanup'), { recursive: true })
await writeFile(
  legacyJournal,
  JSON.stringify({ version: 1, updatedAt: Date.now(), ids: [LEGACY_COLD, LEGACY_HELD, LEGACY_WANTED] }),
)
assert.deepEqual(await readPendingIds(cfg), [LEGACY_COLD, LEGACY_HELD, LEGACY_WANTED], 'the legacy journal is read')

const migrated = await applyPending(legacyCtx, cfg)
assert.deepEqual(migrated.applied.map((row) => row.id), [LEGACY_COLD], 'the cold legacy entry is released')
assert.deepEqual(migrated.dropped.sort(), [LEGACY_HELD, LEGACY_WANTED].sort(), 'a held or re-claimed id is left alone')
assert.deepEqual(legacyCalls.unarchived, [LEGACY_COLD], 'only the actionable entry is released')
assert.equal(existsSync(legacyJournal), false, 'the retired journal is deleted — there is nothing left to migrate')
assert.deepEqual(await readPendingIds(cfg), [], 'so a second pass has no work')
assert.deepEqual((await applyPending(legacyCtx, cfg)).applied, [], 'the migration is idempotent')
console.log('legacy journal  ok: 0.2.x entries finished once and the file retired')

// ── a release with no registry, and with a failing registry, stays safe ─────
const bare = await releaseAccounting({ get: () => undefined }, PARENT)
assert.deepEqual(bare, { unarchived: false, detached: [], announced: false, warnings: [] }, 'no registry: no-op')
const broken = await releaseAccounting(
  {
    get: () => ({
      archivedSessionIds: [],
      list: () => [
        {
          async detachSession() {
            throw new Error('detach failed')
          },
          sessionIds: [PARENT],
        },
      ],
      async unarchiveSession() {
        throw new Error('unarchive failed')
      },
    }),
    emit() {
      throw new Error('emit failed')
    },
  },
  PARENT,
  { live: true },
)
assert.equal(broken.unarchived, false)
assert.equal(broken.announced, false)
assert.equal(broken.warnings.length, 3, 'every failure is reported instead of thrown')
console.log('release safety  ok: registry and announce failures are contained')

console.log('\nsmoke: all assertions passed (', home, ')')
await rm(home, { recursive: true, force: true })
