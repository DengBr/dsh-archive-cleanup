// Route-level smoke test for the host half: mounts the real handlers on a real
// node:http server (via a minimal `webServer.register` stand-in) and drives
// them with real requests, so the destructive route's guards are exercised the
// way a browser would hit them.
//
//   node test/routes.mjs
//
// Exits non-zero on the first failed assertion.

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PURGE_PATH, SCAN_PATH, apply } from '../lib/index.js'

const home = await mkdtemp(join(tmpdir(), 'dsh-archive-cleanup-routes-'))
const sessionRoot = join(home, 'sessions')
const storageRoot = join(home, 'storages')
const cacheDir = join(storageRoot, 'session_projcache', 'sessions')
const SESSION = 'session-9999aaaa-0000-0000-0000-000000000000'
/** An archive entry whose log directory and cache document are already gone. */
const GHOST = 'session-8888bbbb-0000-0000-0000-000000000000'
/** A session the fake host holds live (promoted and never unloaded). */
const HELD = 'session-7777cccc-0000-0000-0000-000000000000'
/** A session nobody touches: it must survive every filter. */
const KEEP = 'session-6666dddd-0000-0000-0000-000000000000'

const sessionDir = join(sessionRoot, '--tmp-demo--', SESSION)
await mkdir(sessionDir, { recursive: true })
await mkdir(cacheDir, { recursive: true })
await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), Buffer.alloc(2048))
await writeFile(
  join(cacheDir, `${SESSION}.json`),
  JSON.stringify({ version: 7, record: { rows: { title: { val: 'route test session' } } } }),
)

const routes = new Map()
const webServer = {
  register(route) {
    routes.set(route.path, route.handler)
    return () => routes.delete(route.path)
  },
}

/**
 * The Host's session-list read, as the Session controller serves it: the rows a
 * browser receives on every pull. A session the Host still holds live is
 * included even after its files are gone, which is the row a refresh — or the
 * Context Insights page's `sessions.refresh()` — used to bring back.
 */
const listedRows = [{ sessionId: SESSION }, { sessionId: GHOST }, { sessionId: HELD }, { sessionId: KEEP }]
const sessionController = {
  async list() {
    return { items: listedRows.map((row) => ({ ...row })), revision: 3 }
  },
}

/** Mutable archive set: a stand-in for the registry's durable state. */
const archived = [SESSION]
/** Sessions the fake host currently holds (promoted and never unloaded). */
const liveIds = new Set()
/** Frames the host published to connected browsers, in order. */
const forwarded = []

let injected = false
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  emit(event, id) {
    forwarded.push(`${event}:${id}`)
  },
  on() {
    return () => {}
  },
  inject(services, callback) {
    const scope = {}
    if (services.includes('webServer')) {
      injected = true
      scope.webServer = webServer
    }
    if (services.includes('sessionController')) scope.sessionController = sessionController
    callback(scope)
  },
  get(name) {
    if (name === 'workspaceRegistry') {
      return {
        archivedSessionIds: archived,
        list: () => [],
        async unarchiveSession(id) {
          const at = archived.indexOf(id)
          if (at !== -1) archived.splice(at, 1)
        },
      }
    }
    if (name === 'sessionPersistence') {
      return { async list() { return [{ header: { id: SESSION, cwd: '/tmp/demo', createdAt: 1000 } }] } }
    }
    if (name === 'sessions') {
      return {
        get: (id) => (liveIds.has(id) ? { id } : undefined),
        async flush() {},
      }
    }
    if (name === 'agents') return { get: (id) => (liveIds.has(id) ? { id, status: 'idle' } : undefined) }
    return undefined
  },
}

apply(ctx, { dshHome: home })
assert.equal(injected, true, 'apply wires the web server scope')
assert.ok(routes.has(SCAN_PATH) && routes.has(PURGE_PATH), 'both routes registered')

const server = createServer((req, res) => {
  const handler = routes.get(new URL(req.url, 'http://localhost').pathname)
  if (handler === undefined) {
    res.writeHead(404).end()
    return
  }
  Promise.resolve(handler(req, res)).catch(() => res.writeHead(500).end())
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

const post = (body, headers = {}) =>
  fetch(base + PURGE_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-archive-cleanup': '1', ...headers },
    body: JSON.stringify(body),
  })

try {
  // ── scan ──────────────────────────────────────────────────────────────────
  const scan = await (await fetch(base + SCAN_PATH)).json()
  assert.equal(scan.ok, true)
  assert.equal(scan.data.totals.count, 1)
  assert.equal(scan.data.sessions[0].title, 'route test session')
  console.log('GET  scan                 ok: 1 archived session listed')

  // ── the destructive route refuses an unguarded caller ─────────────────────
  const noHeader = await post({ all: true, confirm: true }, { 'x-dsh-archive-cleanup': '' })
  assert.equal(noHeader.status, 403)
  console.log('POST purge (no guard)     ok: 403', (await noHeader.json()).error)

  const foreignOrigin = await post({ all: true, confirm: true }, { origin: 'https://evil.example' })
  assert.equal(foreignOrigin.status, 403)
  console.log('POST purge (cross-origin) ok: 403', (await foreignOrigin.json()).error)

  // ── and refuses an unconfirmed one ────────────────────────────────────────
  const noConfirm = await post({ all: true })
  assert.equal(noConfirm.status, 400)
  console.log('POST purge (no confirm)   ok: 400', (await noConfirm.json()).error)

  // ── GET is not accepted on the destructive route ──────────────────────────
  assert.equal((await fetch(base + PURGE_PATH)).status, 405)
  console.log('GET  purge                ok: 405')

  // ── dry run reports without deleting ──────────────────────────────────────
  const preview = await (await post({ all: true, dryRun: true })).json()
  assert.equal(preview.ok, true)
  assert.equal(preview.data.totals.count, 1)
  assert.equal(preview.data.dryRun, true)
  assert.equal((await fetch(base + SCAN_PATH)).ok, true)
  const stillThere = await (await fetch(base + SCAN_PATH)).json()
  assert.equal(stillThere.data.sessions.length, 1, 'dry run kept the session')
  console.log('POST purge (dryRun)       ok: reported', preview.data.totals.bytes, 'bytes, deleted nothing')

  // ── a confirmed purge ─────────────────────────────────────────────────────
  const purged = await (await post({ all: true, confirm: true })).json()
  assert.equal(purged.ok, true)
  assert.equal(purged.data.totals.count, 1)
  const after = await (await fetch(base + SCAN_PATH)).json()
  assert.equal(after.data.totals.count, 0, 'archive set released')
  console.log('POST purge (confirmed)    ok: deleted and released')

  // ── an artifact-less archive entry is released through the route too ──────
  // An id the registry still holds while both its log directory and its cache
  // document are gone: nothing to delete, but the entry must still leave.
  archived.push(GHOST)
  const ghost = await (await post({ all: true, confirm: true })).json()
  assert.equal(ghost.ok, true)
  assert.equal(ghost.data.totals.released, 1, 'the ghost is reported as released')
  assert.equal(ghost.data.totals.deleted, 0)
  assert.deepEqual(
    ghost.data.released.map((row) => row.id),
    [GHOST],
  )
  assert.deepEqual(ghost.data.skipped, [], 'an artifact-less archive entry is no longer skipped')
  const cleared = await (await fetch(base + SCAN_PATH)).json()
  assert.equal(cleared.data.totals.count, 0, 'the ghost left the archive set')
  console.log('POST purge (ghost)        ok: artifact-less entry released')

  // ── a session the host still holds is released in this very request ───────
  // "Open once, resident forever" must not turn a click into "clean, then
  // restart": the artifacts go, the archive entry goes, and the Host's own
  // list-removal frame tells every connected browser to drop the row, and the
  // Host's own list read stops serving it for the rest of the process.
  const heldDir = join(sessionRoot, '--tmp-demo--', HELD)
  await mkdir(heldDir, { recursive: true })
  await writeFile(join(heldDir, 'session.v4.jsonl.zstd'), Buffer.alloc(4096))
  archived.push(HELD)
  liveIds.add(HELD)

  const held = await (await post({ all: true, confirm: true })).json()
  assert.equal(held.ok, true)
  assert.equal(held.data.totals.freed, 1)
  assert.deepEqual(
    held.data.freed.map((row) => row.id),
    [HELD],
  )
  assert.deepEqual(held.data.skipped, [])
  assert.ok(held.data.totals.bytes >= 4096)
  assert.equal(existsSync(heldDir), false, 'the held artifacts are gone')
  assert.deepEqual(archived, [], 'the held entry left the archive set in the same request')
  assert.deepEqual(forwarded, [`api-session/removed:${HELD}`], 'the browser is told to drop the row')
  const heldScan = await (await fetch(base + SCAN_PATH)).json()
  assert.equal(heldScan.data.totals.count, 0, 'the held session is no longer archived')
  assert.equal(heldScan.data.pending, undefined, 'and nothing is left "pending a restart"')
  console.log('POST purge (held)         ok: bytes + entry released now, row removed')

  // ── and every LATER list pull is filtered, so nothing pops back ───────────
  // The removal frame only fixes the snapshot a browser already holds. The Host
  // re-serves the whole list on every pull — a page refresh, a reconnect, or
  // the Context Insights page's `sessions.refresh()` — and prefers a live
  // in-memory Session without checking that its files still exist, so all three
  // removed ids must be filtered out of that read for the rest of the process.
  const relisted = await sessionController.list({}, undefined)
  assert.deepEqual(
    relisted.items.map((row) => row.sessionId),
    [KEEP],
    'the list read serves none of the removed sessions (cold, ghost, or held)',
  )
  assert.equal(relisted.revision, 3, 'the rest of the Host value is untouched')
  console.log('session/list filtered     ok: removed rows never come back on a pull')

  // A subsequent listing and purge have nothing left to offer, and a direct
  // caller naming the released id is refused instead of being reported as work.
  const repeat = await (await post({ ids: [HELD], confirm: true })).json()
  assert.equal(repeat.data.totals.count, 0)
  assert.deepEqual(repeat.data.refused, [HELD], 'a released id is not archived any more')
  console.log('repeat purge              ok: nothing left to reclaim')

  console.log('\nroutes: all assertions passed (', base, ')')
} finally {
  await new Promise((resolve) => server.close(resolve))
  await rm(home, { recursive: true, force: true })
}
