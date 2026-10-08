// Client-half contract test: loads lib/client.js the way the harness does
// (through `window.__ModuleLoader__`), then asserts the browser half exports
// the cordis entrypoints and claims exactly the three slots it documents —
// without a browser, jsdom, or React.
//
//   node test/client.mjs
//
// Exits non-zero on the first failed assertion.

import assert from 'node:assert/strict'

/** Captured factory from the module loader handshake. */
let factory
const registrations = []

globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory: fn }) {
      assert.equal(id, 'dsh-archive-cleanup', 'module id matches the package name')
      factory = fn
    },
  },
}

/** Minimal React stand-in: createElement builds inert trees, hooks are no-ops. */
const React = {
  Fragment: Symbol('Fragment'),
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}

await import('../lib/client.js')
assert.equal(typeof factory, 'function', 'the loader handshake ran')

const client = factory((name) => {
  assert.equal(name, 'react', `the client half must require only react, got ${name}`)
  return React
})

assert.deepEqual(client.inject, ['slots', 'locale'], 'declares its cordis service dependencies')
assert.equal(typeof client.apply, 'function')
assert.equal(typeof client._internals.formatBytes, 'function')
assert.equal(client._internals.formatBytes(0), '0 B')
assert.equal(client._internals.formatBytes(2048), '2.0 KB')
console.log('module contract   ok: inject =', client.inject.join(' + '))

// The purge report summary keeps artifact-less releases out of the deletion
// headline, says plainly that a held session was cleaned in this request, and
// never tells the user to restart dsh web and clean again.
const summary = client._internals.summarise({
  dryRun: false,
  deleted: [{ id: 'session-aaaa' }],
  released: [{ id: 'session-bbbb' }],
  freed: [{ id: 'session-eeee', bytes: 701440 }],
  queued: [{ id: 'session-ffff' }],
  skipped: [{ id: 'session-cccc', reason: 'live' }],
  refused: [],
  totals: { count: 4, deleted: 1, released: 1, freed: 1, queued: 1, bytes: 1024 },
})
assert.match(summary, /Deleted 1 sessions/, 'only artifact deletions are counted as deleted')
assert.match(summary, /artifact-less archive entries/, 'released entries get their own clause')
assert.match(summary, /archive entry dropped right now/, 'a held reclaim is reported as complete, not queued')
assert.match(summary, /685 KB/, 'the reclaimed bytes are carried in the clause')
assert.match(summary, /no restart needed/, 'a busy deferral points at the idle edge, not a restart')
assert.doesNotMatch(summary, /next dsh web start'?s release is left/, 'nothing is left for the next start')
assert.doesNotMatch(summary, /Restart dsh web and clean again/, 'no more "restart and clean again" advice')

// Host-side warnings (a refused path, a failed flush) are surfaced instead of
// being swallowed by a green summary.
const warned = client._internals.summarise({
  dryRun: false,
  deleted: [{ id: 'session-aaaa' }],
  released: [],
  freed: [],
  queued: [],
  skipped: [],
  refused: [],
  warnings: ['refused session directory outside the session root: /etc'],
  totals: { count: 1, deleted: 1, released: 0, freed: 0, queued: 0, bytes: 1 },
})
assert.match(warned, /1 warning\(s\), see the log/, 'warnings are reported, not hidden')
console.log('report summary    ok:', summary)

const fakeCtx = {
  slots: {
    inject(name, register) {
      registrations.push(name)
      register()
    },
    register(options) {
      registrations.push(`${name0(options)}#${options.id}`)
      // Labelled list entries (the footer chip and the settings page) need a
      // resolver; an overlay entry does not.
      if (options.name !== 'shell.overlay') {
        assert.equal(typeof options.label, 'function', `${options.name} needs a label resolver`)
      }
      return () => {}
    },
  },
  locale: undefined,
}
function name0(options) {
  return options.name
}

client.apply(fakeCtx)
assert.deepEqual(registrations, [
  'sidebar.footer.action',
  'sidebar.footer.action#dsh-archive-cleanup',
  'shell.overlay',
  'shell.overlay#dsh-archive-cleanup-dialog',
  'settings.section',
  'settings.section#dsh-archive-cleanup',
])
console.log('slot registration ok:', registrations.filter((row) => row.includes('#')).join(', '))

// A context without the slots service must degrade to a no-op, not throw.
client.apply({})
console.log('degradation       ok: a context without slots is a silent no-op')

// ---------------------------------------------------------------------------
// Live archive set: the footer chip must follow archive actions, not a reload.
// ---------------------------------------------------------------------------
/** Fake client Workspace service: one mutable archive set with subscribers. */
const archived = { ids: [], listeners: new Set() }
const workspaceList = {
  getSnapshot: () => ({ phase: 'ready', archivedSessionIds: [...archived.ids] }),
  subscribe: (listener) => {
    archived.listeners.add(listener)
    return () => archived.listeners.delete(listener)
  },
}
/** Publish a new Host-confirmed archive set, the way the service does. */
function publishArchived(ids) {
  archived.ids = ids
  for (const listener of [...archived.listeners]) listener()
}

/** Components captured from the slot registrations of the live context. */
const components = new Map()
let effects = 0
const liveCtx = {
  get: (name) => (name === 'workspaces' ? { list: workspaceList } : undefined),
  effect: (body) => {
    effects += 1
    body()
  },
  slots: {
    inject: (_name, register) => register(),
    register: (options, component) => {
      // Keyed by slot name: the chip and the settings page share an entry id.
      components.set(options.name, component)
      return () => {}
    },
  },
  locale: undefined,
}

client.apply(liveCtx)
const chip = components.get('sidebar.footer.action')
assert.equal(typeof chip, 'function', 'the footer chip is registered')
assert.equal(effects, 1, 'the archive-set subscription is owned by a cordis effect')
assert.equal(chip({ wide: true }), null, 'nothing archived: the chip renders nothing')

publishArchived(['session-aaaa'])
const one = chip({ wide: true })
assert.equal(one.type, 'button', 'archiving a session makes the chip appear')
assert.equal(one.children[1].children[0], '1', 'the count is the live archive-set size')
assert.match(one.props.title, /1 archived session/, 'the title carries the live count')
assert.equal(one.props.disabled, false, 'a visible chip is clickable')

publishArchived(['session-aaaa', 'session-bbbb'])
assert.equal(chip({ wide: true }).children[1].children[0], '2', 'the count follows every archive')

// A snapshot without a baseline is unknown, never an empty archive set.
assert.equal(
  client._internals.readArchiveIds({ getSnapshot: () => ({ phase: 'pending', archivedSessionIds: [] }) }),
  null,
  'an unbaselined archive set is unknown',
)
assert.deepEqual(
  client._internals.readArchiveIds({ getSnapshot: () => ({ phase: 'ready', archivedSessionIds: ['a'] }) }),
  ['a'],
  'a baselined archive set is read in Host order',
)

// One archive reaches the store twice (unary echo + follow increment); the
// listing refresh it schedules must coalesce into a single scan request.
const realFetch = globalThis.fetch
const scanCalls = []
globalThis.fetch = async (url) => {
  scanCalls.push(String(url))
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, data: { sessions: [], totals: { count: 0, bytes: 0 }, roots: {} } }),
  }
}
publishArchived(['session-aaaa', 'session-bbbb', 'session-cccc'])
publishArchived(['session-aaaa', 'session-bbbb', 'session-cccc'])
const deadline = Date.now() + 2000
while (scanCalls.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
assert.deepEqual(scanCalls, ['/dsh-archive-cleanup/scan'], 'a burst of archive changes coalesces into one scan')
await new Promise((resolve) => setTimeout(resolve, 400))
assert.equal(scanCalls.length, 1, 'the debounced refresh does not repeat')

publishArchived([])
assert.equal(chip({ wide: true }), null, 'emptying the archive takes the chip away again')
await new Promise((resolve) => setTimeout(resolve, 400))
console.log('live archive set  ok: chip appears/hides and rescans with the archive set')

// ---------------------------------------------------------------------------
// A completed cleanup must be visible immediately: the archive set the host
// confirms drops the id in the same request, so the chip follows without a
// reload, and the dialog closes with a result banner.
// ---------------------------------------------------------------------------
const reclaimScanPayload = {
  sessions: [{ id: 'session-aaaa', title: 'held', cwd: '/tmp', bytes: 0, live: true, busy: false }],
  totals: { count: 1, bytes: 0, live: 1 },
  roots: {},
}
/** The real release path: the archive set loses the id as the purge answers. */
const releasedPurgePayload = {
  dryRun: false,
  deleted: [],
  released: [],
  freed: [{ id: 'session-aaaa', bytes: 701440, unarchived: true, detached: [], announced: true }],
  queued: [],
  skipped: [],
  refused: [],
  warnings: [],
  totals: { count: 1, deleted: 0, released: 0, freed: 1, queued: 0, bytes: 701440 },
  remaining: 0,
}
globalThis.fetch = async (url) => ({
  ok: true,
  status: 200,
  json: async () => {
    if (String(url).includes('/purge')) {
      // The host released the entry before it answered: publish that.
      publishArchived([])
      return { ok: true, data: releasedPurgePayload }
    }
    return { ok: true, data: reclaimScanPayload }
  },
})

publishArchived(['session-aaaa'])
await client._internals.loadScan()
assert.equal(chip({ wide: true }).children[1].children[0], '1', 'an outstanding archived session still counts')

client._internals.openDialog({ mode: 'all' })
const overlay = components.get('shell.overlay')
assert.equal(typeof overlay, 'function', 'the overlay seat is registered')
const openElement = overlay()
assert.equal(openElement.type.name, 'Dialog', 'an open dialog takes over the overlay seat')
const dialogTree = openElement.type()
assert.equal(dialogTree.props.className, 'dsh-ac-overlay', 'a dialog renders while it is open')

/** Depth-first search for the destructive confirm button. */
function findButton(node) {
  if (node === null || typeof node !== 'object') return undefined
  if (node.type === 'button' && String(node.props?.className ?? '').includes('dsh-ac-btn-danger')) return node
  for (const child of node.children ?? []) {
    const found = findButton(child)
    if (found !== undefined) return found
  }
  return undefined
}
const confirm = findButton(dialogTree)
assert.ok(confirm !== undefined, 'the dialog has a destructive confirm button')
await confirm.props.onClick()
assert.equal(client._internals.getSnapshot().dialog, null, 'confirming closes the dialog')
assert.equal(client._internals.getSnapshot().outcome.kind, 'deleted', 'the report is kept for the banner')
assert.equal(
  client._internals.getSnapshot().archiveIds.length,
  0,
  'the confirmed archive set is what the client follows — no subtraction, no restart',
)

await client._internals.loadScan()
const toastTree = overlay()
assert.equal(toastTree.props.className, 'dsh-ac-toast-seat', 'the result banner replaces the dialog')
assert.match(toastTree.children[0].children[0].children[0], /archive entry dropped right now/, 'it carries the summary')
assert.equal(chip({ wide: true }), null, 'a released archive leaves the chip with nothing to show')

// A failed request keeps the dialog open so its error stays readable.
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ ok: false, error: 'boom' }),
})
client._internals.openDialog({ mode: 'all' })
await findButton(overlay().type()).props.onClick()
const failed = client._internals.getSnapshot()
assert.notEqual(failed.dialog, null, 'a failed purge keeps the dialog open')
assert.equal(failed.outcome.kind, 'error', 'and surfaces the error inside it')
assert.equal(overlay().type().props.className, 'dsh-ac-overlay', 'the dialog is still rendered')
client._internals.closeDialog()
publishArchived([])
globalThis.fetch = realFetch
console.log('cleanup feedback  ok: dialog closes on success, banner reports, count drops')

// A Workspace service that arrives late is awaited through ctx.inject.
let lateInject
const lateCtx = {
  get: () => undefined,
  inject: (services, callback) => {
    assert.deepEqual(services, ['workspaces'], 'the binding waits for the Workspace service')
    lateInject = callback
  },
  slots: {
    inject: (_name, register) => register(),
    register: () => () => {},
  },
}
client.apply(lateCtx)
assert.equal(typeof lateInject, 'function', 'a missing service parks the binding instead of throwing')
lateInject({
  get: (name) => (name === 'workspaces' ? { list: workspaceList } : undefined),
  effect: () => {},
})
publishArchived(['session-dddd'])
assert.equal(client._internals.getSnapshot().archiveIds.length, 1, 'the late service feeds the same store')
client._internals.applyArchiveIds([], { initial: true })
console.log('late service      ok: ctx.inject binds the archive set once it is provided')

console.log('\nclient: all assertions passed')
