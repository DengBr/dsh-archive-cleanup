// dsh-archive-cleanup — browser half (served at /plugins/dsh-archive-cleanup/client.js).
//
// This file is static code only. It renders counts and titles it fetched from
// the loopback host routes and issues the destructive request the user
// explicitly confirmed. It never receives a filesystem path it can act on
// directly, and it holds no credentials.
//
// Surfaces:
//   * `sidebar.footer.action` — a chip showing how many archived sessions (and
//     how much disk) are waiting to be reclaimed. Clicking it opens the
//     confirm dialog. No props beyond the slot's own `wide`. The chip is
//     driven by the live archive set (see below), so archiving a session in
//     the sidebar makes it appear with the new count immediately, and a
//     completed cleanup drops it again in the same request — no reload and no
//     harness restart.
//   * `shell.overlay`        — the confirm dialog: what will be deleted, how
//     much space comes back, and one button that does it. The dialog closes as
//     soon as the host answered and a short-lived result banner carries the
//     report, so a completed cleanup is unmistakable.
//   * `settings.section`     — the full page: every archived session with its
//     title, directory, age and size, row selection, a dry-run preview and the
//     roots the plugin is operating on.
//
// Client-graph note (dsh >= 0.2.0): only `react` is required at runtime. The
// `slots` and `locale` services arrive through the cordis context, and their
// packages are ordered by `dsh.client.inject` in package.json. Requiring any
// other module the boot graph does not carry is FATAL (client-modules throws
// during factory materialization), so this half stays on the baseline.
//
// Live archive set: the Workspace Controller's client service (`ctx.workspaces`,
// resolved through `ctx.get` so a profile without it degrades instead of
// parking this plugin) publishes the Host-confirmed `archivedSessionIds` set and
// fires on every archive/unarchive — including the ones started from the
// sidebar's own context menu. Following it is what keeps the footer count
// truthful without polling: the set decides *whether* the chip shows and its
// count, and any change schedules one debounced listing refresh for sizes.

window.__ModuleLoader__.load({
  id: 'dsh-archive-cleanup',
  factory: (require) => {
    'use strict'

    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const { useState, useEffect, useSyncExternalStore } = React

    /** Routes owned by the host half of this plugin. */
    const SCAN_ROUTE = '/dsh-archive-cleanup/scan'
    const PURGE_ROUTE = '/dsh-archive-cleanup/purge'
    /** The custom header the host's cross-origin guard requires on POST. */
    const GUARD_HEADER = 'x-dsh-archive-cleanup'
    /** Client Workspace service name; carries the live archive set. */
    const WORKSPACES_SERVICE = 'workspaces'
    /** Coalescing window for the listing refresh an archive-set change schedules. */
    const REFRESH_DEBOUNCE_MS = 250
    /** How long the post-purge result banner stays on screen. */
    const OUTCOME_TTL_MS = 9000

    /** Required client services: slots (UI) + locale (i18n). */
    const inject = ['slots', 'locale']

    // ------------------------------------------------------------------
    // i18n (zh/en, following the DSH locale service)
    // ------------------------------------------------------------------
    const zh = {
      chipLabel: '清理归档',
      settingsTitle: '归档清理',
      settingsDesc: '永久删除已归档的会话：会话日志目录、投影缓存记录，以及归档与工作区登记。此操作不可恢复。',
      count: '{n} 条归档会话',
      size: '占用 {size}',
      empty: '没有已归档的会话。',
      refresh: '刷新',
      selectAll: '全选',
      selectNone: '取消全选',
      purgeAll: '清理全部',
      purgeSelected: '清理选中（{n}）',
      preview: '预演（不删除）',
      dialogTitle: '清理已归档会话？',
      dialogBody: '将永久删除 {n} 条归档会话，释放约 {size}。此操作不可恢复。',
      dialogList: '即将删除：',
      dialogMore: '以及另外 {n} 条',
      includeDescendants: '同时清理它们的子代理 / 派生会话',
      includeDescendantsHint: '删除父会话时留下孤立的子会话日志没有意义；存活中的会话始终会跳过。',
      cancel: '取消',
      close: '关闭',
      confirm: '永久删除',
      working: '正在清理…',
      loading: '读取中…',
      done: '已删除 {n} 条，释放 {size}',
      freedHeld: '其中 {n} 条被进程持有的归档会话已当场释放磁盘（{size}）并撤掉归档登记；浏览器里那一行也当场移除，之后任何一次列表刷新都不会再把它列出来（进程内存里的副本要到下次启动 dsh web 才消失）',
      queuedHeld: '{n} 条仍有回合在跑，未删除也未撤登记；回合结束的空闲时刻会自动补做（无需重启）',
      releasedStale: '清除 {n} 条无产物的归档登记',
      skippedLive: '跳过 {n} 条仍被持有的派生会话',
      skippedOther: '跳过 {n} 条（无产物或出错）',
      refused: '拒绝 {n} 条（不在归档集合中）',
      warnings: '{n} 条告警，详见日志',
      dryRunResult: '预演：将删除 {n} 条，约 {size}',
      roots: '会话日志根目录：{sessionRoot} · 存储根目录：{storageRoot}',
      live: '已持有',
      liveHint: '{n} 条已归档会话仍被 DSH Web 进程持有（打开过就会常驻内存，归档不会卸载它）。清理会当场删除它们的磁盘产物并撤掉归档登记，已连接的浏览器立刻移除这些行，之后刷新 / 重连 / 打开「上下文洞察」（会重新拉一次会话列表）都不会再列出它们；只有进程内存里那份副本会一直留到下次启动。',
      busy: '回合进行中',
      busyHint: '这条归档会话仍有正在进行的回合：插件不会在写入过程中删除文件，会在该回合结束、Agent 转入空闲的那一刻自动补做删除与撤登记，不需要重启，也不需要再点一次。',
      noArtifacts: '无产物',
      noArtifactsHint: '磁盘上已无日志与投影缓存，只剩归档登记；勾选清理会清掉这条登记，不删除任何文件。',
      subagent: '子代理',
      unknownTitle: '（无标题）',
      errorPrefix: '操作失败：',
      tableSession: '会话',
      tableCreated: '创建时间',
      tableSize: '占用',
      select: '选择',
      needSelection: '请先选择要清理的会话',
      previewHint: '预演只做统计，不会删除任何文件。',
    }
    const en = {
      chipLabel: 'Clean archive',
      settingsTitle: 'Archive cleanup',
      settingsDesc: 'Permanently deletes archived sessions: the session log directory, the projection-cache record, and the archive/workspace accounting. This cannot be undone.',
      count: '{n} archived sessions',
      size: '{size} on disk',
      empty: 'No archived sessions.',
      refresh: 'Refresh',
      selectAll: 'Select all',
      selectNone: 'Clear selection',
      purgeAll: 'Clean all',
      purgeSelected: 'Clean selected ({n})',
      preview: 'Preview (no delete)',
      dialogTitle: 'Clean archived sessions?',
      dialogBody: 'This permanently deletes {n} archived sessions and frees about {size}. It cannot be undone.',
      dialogList: 'About to delete:',
      dialogMore: 'and {n} more',
      includeDescendants: 'Also clean their subagent / forked sessions',
      includeDescendantsHint: 'Deleting a parent while leaving orphan child logs behind helps nobody. Live sessions are always skipped.',
      cancel: 'Cancel',
      close: 'Close',
      confirm: 'Delete permanently',
      working: 'Cleaning…',
      loading: 'Loading…',
      done: 'Deleted {n} sessions, freed {size}',
      freedHeld: 'of those, {n} held archived session(s) had their files reclaimed and their archive entry dropped right now ({size}); the browser row is gone too and no later list pull brings it back — only the in-process copy lives until the next dsh web start',
      queuedHeld: '{n} still had a turn running: nothing was deleted and no entry was dropped; the idle moment after that turn finishes the job (no restart needed)',
      releasedStale: 'cleared {n} artifact-less archive entries',
      skippedLive: 'Skipped {n} held descendant session(s)',
      skippedOther: 'Skipped {n} (no artifacts or failed)',
      refused: 'Refused {n} (not in the archive set)',
      warnings: '{n} warning(s), see the log',
      dryRunResult: 'Preview: would delete {n} sessions, about {size}',
      roots: 'Session log root: {sessionRoot} · storage root: {storageRoot}',
      live: 'held',
      liveHint: '{n} archived session(s) are still held by the dsh web process (opening a session keeps it in memory; archiving does not unload it). Cleaning reclaims their files AND drops their archive entry right now, the connected browsers remove the row, and no later list pull brings it back — refreshes, reconnects, and the Context Insights page included; only the in-process copy survives until the next dsh web start.',
      busy: 'turn running',
      busyHint: 'This archived session still has a turn in flight, so nothing is unlinked under a write: the cleanup runs automatically at the idle moment after that turn — no restart, no second click.',
      noArtifacts: 'no artifacts',
      noArtifactsHint: 'No log and no projection cache remain on disk, only the archive entry; cleaning such a row drops that entry and deletes no files.',
      subagent: 'subagent',
      unknownTitle: '(untitled)',
      errorPrefix: 'Failed: ',
      tableSession: 'Session',
      tableCreated: 'Created',
      tableSize: 'Size',
      select: 'Select',
      needSelection: 'Select at least one session first',
      previewHint: 'A preview only counts; it deletes nothing.',
    }

    let localeService
    function attachLocale(service) {
      localeService = service
    }
    function activeLocale() {
      return localeService?.getSnapshot()?.active ?? (typeof navigator !== 'undefined' ? navigator.language : '') ?? 'en'
    }
    function t(key, params) {
      const dict = activeLocale().toLowerCase().startsWith('zh') ? zh : en
      let text = dict[key] ?? key
      if (params !== void 0) {
        for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, String(value))
      }
      return text
    }
    function useLocale() {
      return useSyncExternalStore(
        (cb) => (localeService ? localeService.subscribe(cb) : () => {}),
        () => activeLocale(),
        () => 'en',
      )
    }

    // ------------------------------------------------------------------
    // formatting
    // ------------------------------------------------------------------
    function formatBytes(bytes) {
      const n = Number(bytes) || 0
      if (n < 1024) return `${n} B`
      const units = ['KB', 'MB', 'GB', 'TB']
      let value = n / 1024
      let unit = 0
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024
        unit += 1
      }
      return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
    }
    function formatTime(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—'
      try {
        return new Date(ms).toLocaleString()
      } catch {
        return '—'
      }
    }
    function titleOf(session) {
      const title = (session?.title ?? '').trim()
      return title === '' ? t('unknownTitle') : title
    }

    // ------------------------------------------------------------------
    // host transport
    // ------------------------------------------------------------------
    async function fetchScan() {
      const response = await fetch(SCAN_ROUTE, { headers: { accept: 'application/json' } })
      const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }))
      if (!payload?.ok) throw new Error(String(payload?.error ?? `HTTP ${response.status}`))
      return payload.data
    }

    async function fetchPurge(body) {
      const response = await fetch(PURGE_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [GUARD_HEADER]: '1' },
        body: JSON.stringify(body),
      })
      const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }))
      if (!payload?.ok) throw new Error(String(payload?.error ?? `HTTP ${response.status}`))
      return payload.data
    }

    // ------------------------------------------------------------------
    // shared store: one scan, one dialog, one in-flight purge, one outcome.
    // Every surface (chip / dialog / settings page) reads this same snapshot,
    // so a purge started anywhere updates everywhere.
    // ------------------------------------------------------------------
    const listeners = new Set()
    let snapshot = {
      status: 'idle', // idle | loading | ready | error
      data: null,
      error: null,
      busy: false,
      dialog: null, // null | { mode: 'all' | 'ids', ids?: string[] }
      outcome: null, // { kind: 'deleted' | 'preview', report } | { kind: 'error', message }
      archiveIds: null, // string[] once the client Workspace set has a baseline
    }
    function setSnapshot(patch) {
      snapshot = { ...snapshot, ...patch }
      for (const listener of [...listeners]) listener()
    }
    function subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
    function getSnapshot() {
      return snapshot
    }
    function useStore() {
      return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
    }

    // ------------------------------------------------------------------
    // live archive set (the reason the chip is truthful without a reload)
    // ------------------------------------------------------------------
    /**
     * Read the Host-confirmed archive set out of the client Workspace service.
     *
     * The snapshot's `archivedSessionIds` starts empty and only becomes
     * authoritative once the follow stream installed a baseline (`phase:
     * 'ready'`), so an unbaselined snapshot reports `null` — "unknown" — and
     * the listing stays the fallback. A missing/foreign snapshot shape is
     * unknown too, never `[]`.
     * @param {object} source - the service's `list` observable.
     * @returns {string[]|null} archived session ids, or `null` when unknown.
     */
    function readArchiveIds(source) {
      try {
        const current = source?.getSnapshot?.()
        if (current === null || current === undefined) return null
        if (current.phase !== undefined && current.phase !== 'ready') return null
        const ids = current.archivedSessionIds
        return Array.isArray(ids) ? ids.map(String) : null
      } catch {
        return null
      }
    }

    /** Whether two id lists are the same set in the same Host order. */
    function sameIds(a, b) {
      return a.length === b.length && a.every((id, index) => id === b[index])
    }

    /** Timer for the debounced listing refresh (one timers seat, many changes). */
    let refreshHandle

    /** Run `fn` after `ms`, preferring the browser timer seat. */
    function later(fn, ms) {
      const seat = typeof window !== 'undefined' && typeof window.setTimeout === 'function' ? window : globalThis
      return seat.setTimeout(fn, ms)
    }

    /** Drop a scheduled refresh (a full scan supersedes it). */
    function cancelScanRefresh() {
      if (refreshHandle === undefined) return
      const seat = typeof window !== 'undefined' && typeof window.clearTimeout === 'function' ? window : globalThis
      seat.clearTimeout(refreshHandle)
      refreshHandle = undefined
    }

    /**
     * Refresh the listing shortly after the archive set changed.
     *
     * One archive request reaches this store twice (the unary echo and the
     * follow increment), so the refresh is coalesced: the chip's count never
     * waits for it, only its byte total does.
     */
    function scheduleScanRefresh() {
      if (refreshHandle !== undefined) return
      refreshHandle = later(() => {
        refreshHandle = undefined
        // A purge refreshes the listing itself; only an idle store needs it.
        if (getSnapshot().busy) return
        void loadScan()
      }, REFRESH_DEBOUNCE_MS)
    }

    /**
     * Install the archive set observed from the client Workspace service.
     * @param {string[]|null} ids - the archive set, or `null` when unknown.
     * @param {{initial?: boolean}} [options] - `initial` seeds the store without
     *   scheduling a refresh (mount already loads the listing).
     */
    function applyArchiveIds(ids, options = {}) {
      if (ids === null) return
      const current = snapshot.archiveIds
      if (current !== null && sameIds(current, ids)) return
      setSnapshot({ archiveIds: ids })
      if (options.initial !== true) scheduleScanRefresh()
    }

    /**
     * Follow the live archive set for as long as this plugin is applied.
     *
     * `ctx.get` is deliberate: declaring `workspaces` as a required service
     * would park the whole plugin (no chip, no settings page) in a profile
     * without the Workspace layer, where the host scan route answers 501
     * anyway. When the service is not up yet the subscription waits for it
     * through `ctx.inject` instead of polling for it.
     * @param {object} ctx - client plugin context.
     */
    function bindArchiveSet(ctx) {
      const attach = (scope) => {
        let source
        try {
          source = scope.get?.(WORKSPACES_SERVICE)?.list
        } catch {
          source = undefined
        }
        if (typeof source?.getSnapshot !== 'function' || typeof source?.subscribe !== 'function') return false
        applyArchiveIds(readArchiveIds(source), { initial: true })
        const sync = () => applyArchiveIds(readArchiveIds(source))
        const dispose = source.subscribe(sync)
        if (typeof scope.effect === 'function') scope.effect(() => dispose, 'archive-cleanup.client.archive-set')
        return true
      }
      if (attach(ctx)) return
      try {
        ctx.inject?.([WORKSPACES_SERVICE], (scope) => {
          attach(scope)
        })
      } catch {
        /* no Workspace service in this profile: the listing drives the chip */
      }
    }

    async function loadScan() {
      cancelScanRefresh()
      setSnapshot({ status: 'loading', error: null })
      try {
        const data = await fetchScan()
        setSnapshot({ status: 'ready', data, error: null })
        return data
      } catch (error) {
        setSnapshot({ status: 'error', error: String(error?.message ?? error) })
        return null
      }
    }

    function openDialog(dialog) {
      setSnapshot({ dialog, outcome: null })
    }
    function closeDialog() {
      setSnapshot({ dialog: null })
    }

    /**
     * Run one confirmed purge and refresh the listing. Shared by the dialog,
     * the chip and the settings page.
     * @param {object} request - purge body (host validates `confirm`).
     */
    async function runPurge(request) {
      setSnapshot({ busy: true, outcome: null })
      try {
        const report = await fetchPurge(request)
        setSnapshot({ outcome: { kind: report.dryRun ? 'preview' : 'deleted', report } })
        await loadScan()
        return report
      } catch (error) {
        setSnapshot({ outcome: { kind: 'error', message: String(error?.message ?? error) } })
        return null
      } finally {
        setSnapshot({ busy: false })
      }
    }

    /** Human summary line for one purge report. */
    function summarise(report) {
      if (report === undefined || report === null) return ''
      // `released` is the artifact-less subset (host >= 0.1.1); tolerate an
      // older payload by falling back to the aggregate count.
      const released = Array.isArray(report.released) ? report.released.length : 0
      const deleted = Array.isArray(report.deleted)
        ? report.deleted.length
        : Math.max(0, (report.totals?.count ?? 0) - released)
      const freed = Array.isArray(report.freed) ? report.freed : []
      const queued = Array.isArray(report.queued) ? report.queued : []
      const heldBytes = freed.reduce((sum, row) => sum + (row.bytes ?? 0), 0)
      const parts = [
        report.dryRun
          ? t('dryRunResult', { n: report.totals.count, size: formatBytes(report.totals.bytes) })
          : t('done', { n: deleted, size: formatBytes(report.totals.bytes) }),
      ]
      if (freed.length > 0) parts.push(t('freedHeld', { n: freed.length, size: formatBytes(heldBytes) }))
      if (queued.length > 0) parts.push(t('queuedHeld', { n: queued.length }))
      if (released > 0) parts.push(t('releasedStale', { n: released }))
      const skipped = Array.isArray(report.skipped) ? report.skipped : []
      const live = skipped.filter((row) => row.reason === 'live').length
      const other = skipped.length - live
      if (live > 0) parts.push(t('skippedLive', { n: live }))
      if (other > 0) parts.push(t('skippedOther', { n: other }))
      const refused = Array.isArray(report.refused) ? report.refused : []
      if (refused.length > 0) parts.push(t('refused', { n: refused.length }))
      const warnings = Array.isArray(report.warnings) ? report.warnings.length : 0
      if (warnings > 0) parts.push(t('warnings', { n: warnings }))
      return parts.join(' · ')
    }

    // ------------------------------------------------------------------
    // styles (theme-aware; hand-rolled so this half needs no UI package)
    // ------------------------------------------------------------------
    const STYLE_ID = 'dsh-archive-cleanup-styles'
    const CSS = `
.dsh-ac-chip { display:inline-flex; align-items:center; gap:6px; border:none; background:transparent;
  color:var(--dsw-alias-label-secondary, inherit); font:12px/1.6 var(--dsw-font-family, system-ui, sans-serif);
  padding:2px 6px; border-radius:var(--dsw-radius-md, 8px); cursor:pointer; max-width:100%; }
.dsh-ac-chip:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14));
  color:var(--dsw-alias-label-primary, inherit); }
.dsh-ac-chip:disabled { opacity:.55; cursor:default; }
.dsh-ac-chip-text { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsh-ac-chip-count { font-variant-numeric:tabular-nums; color:var(--dsw-alias-state-business-primary, #4176e6); }
.dsh-ac-chip.dsh-ac-busy .dsh-ac-chip-count { color:var(--dsw-alias-label-tertiary, inherit); }
.dsh-ac-overlay { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
  background:rgba(0,0,0,.32); }
.dsh-ac-modal { width:min(520px, calc(100vw - 48px)); max-height:min(70vh, 560px); overflow:auto;
  background:var(--dsw-alias-bg-layer-1, #fff); color:var(--dsw-alias-label-primary, inherit);
  border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3));
  border-radius:var(--dsw-radius-lg, 12px); padding:16px 18px; box-shadow:0 12px 40px rgba(0,0,0,.28);
  font:13px/1.6 var(--dsw-font-family, system-ui, sans-serif); display:flex; flex-direction:column; gap:12px; }
.dsh-ac-modal h3 { margin:0; font-size:15px; font-weight:600; }
.dsh-ac-modal p { margin:0; color:var(--dsw-alias-label-secondary, inherit); }
.dsh-ac-list { margin:0; padding:0 0 0 18px; max-height:180px; overflow:auto;
  color:var(--dsw-alias-label-secondary, inherit); }
.dsh-ac-list li { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsh-ac-option { display:flex; align-items:flex-start; gap:8px; }
.dsh-ac-option input { margin-top:3px; flex:none; }
.dsh-ac-hint { color:var(--dsw-alias-label-tertiary, inherit); font-size:12px; }
.dsh-ac-actions { display:flex; justify-content:flex-end; gap:8px; }
.dsh-ac-toast-seat { position:absolute; inset:auto 0 24px 0; display:flex; justify-content:center; pointer-events:none; }
.dsh-ac-toast { pointer-events:auto; display:flex; align-items:center; gap:10px; max-width:min(680px, calc(100vw - 48px));
  background:var(--dsw-alias-bg-layer-1, #fff); color:var(--dsw-alias-label-primary, inherit);
  border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3));
  border-radius:var(--dsw-radius-lg, 12px); padding:8px 12px; box-shadow:0 12px 40px rgba(0,0,0,.28);
  font:13px/1.6 var(--dsw-font-family, system-ui, sans-serif); }
.dsh-ac-toast-text { flex:1; }
.dsh-ac-toast .dsh-ac-btn { flex:none; }
.dsh-ac-btn { border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35)); background:transparent;
  color:var(--dsw-alias-label-primary, inherit); border-radius:var(--dsw-radius-md, 8px);
  padding:5px 12px; font:13px/1.5 var(--dsw-font-family, system-ui, sans-serif); cursor:pointer; }
.dsh-ac-btn:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14)); }
.dsh-ac-btn:disabled { opacity:.5; cursor:default; }
.dsh-ac-btn-danger { border-color:transparent; background:var(--dsw-alias-state-error-primary, #d64545); color:#fff; }
.dsh-ac-btn-danger:hover:not(:disabled) { filter:brightness(1.08); }
.dsh-ac-section { display:flex; flex-direction:column; gap:12px; max-width:860px;
  font:13px/1.6 var(--dsw-font-family, system-ui, sans-serif); color:var(--dsw-alias-label-primary, inherit); }
.dsh-ac-section h4 { margin:0; font-size:14px; font-weight:600; }
.dsh-ac-toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
.dsh-ac-toolbar .dsh-ac-spacer { flex:1; }
.dsh-ac-table { width:100%; border-collapse:collapse; }
.dsh-ac-table th, .dsh-ac-table td { text-align:left; padding:5px 8px; vertical-align:middle;
  border-bottom:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.22)); }
.dsh-ac-table th { font-weight:500; color:var(--dsw-alias-label-tertiary, inherit); font-size:12px; }
.dsh-ac-table td.dsh-ac-num { font-variant-numeric:tabular-nums; white-space:nowrap; }
.dsh-ac-cell-title { max-width:340px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsh-ac-cell-cwd { max-width:320px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  color:var(--dsw-alias-label-tertiary, inherit); font-size:12px; }
.dsh-ac-tag { display:inline-block; margin-inline-start:6px; padding:0 6px; border-radius:999px; font-size:11px;
  background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.16));
  color:var(--dsw-alias-label-secondary, inherit); }
.dsh-ac-error { color:var(--dsw-alias-state-error-primary, #d64545); }
.dsh-ac-ok { color:var(--dsw-alias-state-business-primary, #4176e6); }
`
    function ensureStyles() {
      const doc = typeof document !== 'undefined' ? document : undefined
      if (doc === undefined) return
      if (doc.getElementById(STYLE_ID) !== null) return
      const style = doc.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      doc.head.appendChild(style)
    }

    // ------------------------------------------------------------------
    // sidebar footer chip
    // ------------------------------------------------------------------
    function Chip(props) {
      useLocale()
      const state = useStore()
      const wide = Boolean(props?.wide)

      useEffect(() => {
        if (getSnapshot().status === 'idle') loadScan()
      }, [])

      const liveCount = state.archiveIds === null ? null : state.archiveIds.length
      const totals = state.status === 'ready' ? state.data?.totals : undefined
      // The count IS the archive set. A cleanup now releases the entry in the
      // same request, so the Host-confirmed archive set drops the id as soon as
      // the purge answers and the chip follows on the very next push — nothing
      // to subtract, nothing waiting for a harness restart. The archive set
      // decides *whether* there is anything to clean; the listing only adds
      // bytes and is the fallback when the Workspace service is absent. Either
      // way a count of zero renders nothing: the chip appears when a session
      // has been archived and disappears when the archive is empty again.
      const count = liveCount === null ? Math.max(0, totals?.count ?? 0) : Math.max(0, liveCount)
      if (count === 0) return null

      const label =
        totals === undefined
          ? t('count', { n: count })
          : `${t('count', { n: count })} · ${t('size', { size: formatBytes(totals.bytes) })}`

      return React.createElement(
        'button',
        {
          type: 'button',
          className: 'dsh-ac-chip' + (state.busy ? ' dsh-ac-busy' : ''),
          disabled: state.busy,
          title: label,
          'aria-label': `${t('chipLabel')}: ${label}`,
          onClick: () => {
            // Refresh first so the dialog lists what is archived right now.
            loadScan().then(() => openDialog({ mode: 'all' }))
          },
        },
        React.createElement('span', { className: 'dsh-ac-chip-text' }, wide ? t('chipLabel') : '🧹'),
        React.createElement('span', { className: 'dsh-ac-chip-count' }, state.busy ? '…' : String(count)),
      )
    }

    // ------------------------------------------------------------------
    // confirm dialog + result banner (shell.overlay)
    // ------------------------------------------------------------------
    /**
     * The overlay seat renders exactly one thing: the confirm dialog while one
     * is open, otherwise the short-lived result banner of the last cleanup. The
     * dialog closes the moment the host answered, so "永久删除" always has a
     * visible outcome instead of leaving a stale modal on screen.
     */
    function Overlay() {
      useLocale()
      const state = useStore()
      const outcome = state.outcome
      const [hidden, setHidden] = useState(false)
      const showResult = outcome !== null && outcome.kind === 'deleted'
      useEffect(() => {
        if (!showResult) return undefined
        setHidden(false)
        const seat = typeof window !== 'undefined' && typeof window.setTimeout === 'function' ? window : globalThis
        const handle = seat.setTimeout(() => setHidden(true), OUTCOME_TTL_MS)
        return () => seat.clearTimeout(handle)
      }, [outcome])

      if (state.dialog !== null) return React.createElement(Dialog, null)
      if (!showResult || hidden) return null
      return React.createElement(
        'div',
        { className: 'dsh-ac-toast-seat', role: 'presentation' },
        React.createElement(
          'div',
          { className: 'dsh-ac-toast', role: 'status', 'aria-live': 'polite' },
          React.createElement('span', { className: 'dsh-ac-toast-text' }, summarise(outcome.report)),
          React.createElement(
            'button',
            { type: 'button', className: 'dsh-ac-btn', onClick: () => setHidden(true) },
            t('close'),
          ),
        ),
      )
    }

    function Dialog() {
      useLocale()
      const state = useStore()
      const [includeDescendants, setIncludeDescendants] = useState(true)
      const dialog = state.dialog
      if (dialog === null) return null

      const sessions = state.data?.sessions ?? []
      const selected =
        dialog.mode === 'all'
          ? sessions
          : sessions.filter((row) => (dialog.ids ?? []).includes(row.id))
      const bytes = selected.reduce((sum, row) => sum + (row.bytes ?? 0), 0)
      const preview = selected.slice(0, 8)
      const liveCount = sessions.filter((row) => row.live).length

      return React.createElement(
        'div',
        {
          className: 'dsh-ac-overlay',
          role: 'presentation',
          onClick: (event) => {
            if (event.target === event.currentTarget && !state.busy) closeDialog()
          },
        },
        React.createElement(
          'div',
          { className: 'dsh-ac-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('dialogTitle') },
          React.createElement('h3', null, t('dialogTitle')),
          React.createElement('p', null, t('dialogBody', { n: selected.length, size: formatBytes(bytes) })),
          preview.length > 0
            ? React.createElement(
                React.Fragment,
                null,
                React.createElement('p', { className: 'dsh-ac-hint' }, t('dialogList')),
                React.createElement(
                  'ul',
                  { className: 'dsh-ac-list' },
                  preview.map((row) =>
                    React.createElement('li', { key: row.id, title: row.cwd || row.id }, titleOf(row)),
                  ),
                ),
                selected.length > preview.length
                  ? React.createElement('p', { className: 'dsh-ac-hint' }, t('dialogMore', { n: selected.length - preview.length }))
                  : null,
              )
            : null,
          React.createElement(
            'div',
            null,
            React.createElement(
              'label',
              { className: 'dsh-ac-option' },
              React.createElement('input', {
                type: 'checkbox',
                checked: includeDescendants,
                disabled: state.busy,
                onChange: (event) => setIncludeDescendants(event.target.checked),
              }),
              React.createElement(
                'span',
                null,
                t('includeDescendants'),
                React.createElement('div', { className: 'dsh-ac-hint' }, t('includeDescendantsHint')),
              ),
            ),
          ),
          liveCount > 0
            ? React.createElement('p', { className: 'dsh-ac-hint' }, t('liveHint', { n: liveCount }))
            : null,
          state.outcome?.kind === 'error'
            ? React.createElement('p', { className: 'dsh-ac-error' }, t('errorPrefix') + state.outcome.message)
            : null,
          React.createElement(
            'div',
            { className: 'dsh-ac-actions' },
            React.createElement(
              'button',
              {
                type: 'button',
                className: 'dsh-ac-btn',
                disabled: state.busy,
                onClick: closeDialog,
              },
              t('cancel'),
            ),
            React.createElement(
              'button',
              {
                type: 'button',
                className: 'dsh-ac-btn dsh-ac-btn-danger',
                disabled: state.busy || selected.length === 0,
                onClick: async () => {
                  const report = await runPurge({
                    ...(dialog.mode === 'all' ? { all: true } : { ids: dialog.ids }),
                    includeDescendants,
                    confirm: true,
                  })
                  // Close on an answer from the host; only a failed request
                  // keeps the dialog so its error stays readable.
                  if (report !== null) closeDialog()
                },
              },
              state.busy ? t('working') : t('confirm'),
            ),
          ),
        ),
      )
    }

    // ------------------------------------------------------------------
    // settings page (settings.section)
    // ------------------------------------------------------------------
    function SettingsSection() {
      useLocale()
      const state = useStore()
      const [selected, setSelected] = useState([])

      useEffect(() => {
        loadScan()
      }, [])

      const sessions = state.data?.sessions ?? []
      const selectedSet = new Set(selected)
      const liveCount = sessions.filter((row) => row.live).length
      const busyCount = sessions.filter((row) => row.busy).length
      // Only genuinely actionable rows are selectable: a turn in flight is
      // deferred by the host instead of unlinked, so it needs no checkbox.
      const selectable = sessions.filter((row) => row.busy !== true)
      const toggle = (id) =>
        setSelected((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]))
      const toggleAll = () =>
        setSelected((current) => (current.length === selectable.length ? [] : selectable.map((row) => row.id)))

      return React.createElement(
        'div',
        { className: 'dsh-ac-section' },
        React.createElement('h4', null, t('settingsTitle')),
        React.createElement('p', { className: 'dsh-ac-hint' }, t('settingsDesc')),
        state.data?.roots !== undefined
          ? React.createElement(
              'p',
              { className: 'dsh-ac-hint' },
              t('roots', { sessionRoot: state.data.roots.sessionRoot, storageRoot: state.data.roots.storageRoot }),
            )
          : null,
        React.createElement(
          'div',
          { className: 'dsh-ac-toolbar' },
          React.createElement(
            'span',
            null,
            `${t('count', { n: sessions.length })} · ${t('size', {
              size: formatBytes(state.data?.totals?.bytes ?? 0),
            })}`,
          ),
          React.createElement('span', { className: 'dsh-ac-spacer' }),
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'dsh-ac-btn',
              disabled: state.busy,
              onClick: () => loadScan(),
            },
            t('refresh'),
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'dsh-ac-btn',
              disabled: state.busy || selectable.length === 0,
              onClick: toggleAll,
            },
            selected.length === selectable.length && selectable.length > 0 ? t('selectNone') : t('selectAll'),
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'dsh-ac-btn',
              disabled: state.busy || sessions.length === 0,
              onClick: async () => {
                const report = await runPurge({ all: true, confirm: true, dryRun: true, includeDescendants: true })
                if (report !== null) setSnapshot({ outcome: { kind: 'preview', report } })
              },
              title: t('previewHint'),
            },
            t('preview'),
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'dsh-ac-btn dsh-ac-btn-danger',
              disabled: state.busy || selected.length === 0,
              onClick: () => openDialog({ mode: 'ids', ids: selected }),
            },
            t('purgeSelected', { n: selected.length }),
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'dsh-ac-btn dsh-ac-btn-danger',
              disabled: state.busy || sessions.length === 0,
              onClick: () => openDialog({ mode: 'all' }),
            },
            t('purgeAll'),
          ),
        ),
        liveCount > 0
          ? React.createElement('p', { className: 'dsh-ac-hint' }, t('liveHint', { n: liveCount }))
          : null,
        busyCount > 0 ? React.createElement('p', { className: 'dsh-ac-hint' }, t('busyHint')) : null,
        state.outcome?.kind === 'error'
          ? React.createElement('p', { className: 'dsh-ac-error' }, t('errorPrefix') + state.outcome.message)
          : null,
        state.outcome?.kind === 'deleted' || state.outcome?.kind === 'preview'
          ? React.createElement('p', { className: 'dsh-ac-ok' }, summarise(state.outcome.report))
          : null,
        state.status === 'error' ? React.createElement('p', { className: 'dsh-ac-error' }, t('errorPrefix') + state.error) : null,
        sessions.length === 0
          ? React.createElement('p', { className: 'dsh-ac-hint' }, state.status === 'loading' ? t('loading') : t('empty'))
          : React.createElement(
              'table',
              { className: 'dsh-ac-table' },
              React.createElement(
                'thead',
                null,
                React.createElement(
                  'tr',
                  null,
                  React.createElement('th', { style: { width: 28 } }, t('select')),
                  React.createElement('th', null, t('tableSession')),
                  React.createElement('th', null, t('tableCreated')),
                  React.createElement('th', { style: { width: 90 } }, t('tableSize')),
                ),
              ),
              React.createElement(
                'tbody',
                null,
                sessions.map((row) =>
                  React.createElement(
                    'tr',
                    { key: row.id },
                    React.createElement(
                      'td',
                      null,
                      React.createElement('input', {
                        type: 'checkbox',
                        checked: selectedSet.has(row.id),
                        // A turn in flight is the one row the host defers: it is
                        // cleaned at the idle edge instead, so it is not
                        // selectable here.
                        disabled: state.busy || row.busy === true,
                        'aria-label': `${t('select')} ${titleOf(row)}`,
                        onChange: () => toggle(row.id),
                      }),
                    ),
                    React.createElement(
                      'td',
                      null,
                      React.createElement('div', { className: 'dsh-ac-cell-title', title: row.id }, titleOf(row)),
                      React.createElement(
                        'div',
                        { className: 'dsh-ac-cell-cwd', title: row.cwd },
                        row.cwd === '' ? row.id : row.cwd,
                        row.origin === 'subagent' ? React.createElement('span', { className: 'dsh-ac-tag' }, t('subagent')) : null,
                        row.live
                          ? React.createElement('span', { className: 'dsh-ac-tag', title: t('liveHint', { n: 1 }) }, t('live'))
                          : null,
                        row.busy === true
                          ? React.createElement('span', { className: 'dsh-ac-tag', title: t('busyHint') }, t('busy'))
                          : null,
                        row.hasLog === false && row.hasProjectionCache === false
                          ? React.createElement('span', { className: 'dsh-ac-tag', title: t('noArtifactsHint') }, t('noArtifacts'))
                          : null,
                      ),
                    ),
                    React.createElement('td', { className: 'dsh-ac-num' }, formatTime(row.createdAt)),
                    React.createElement('td', { className: 'dsh-ac-num' }, formatBytes(row.bytes)),
                  ),
                ),
              ),
            ),
      )
    }

    /**
     * @param {object} ctx - client plugin context (slots + locale).
     */
    function apply(ctx) {
      if (typeof ctx.slots?.inject !== 'function') return
      if (ctx.locale) attachLocale(ctx.locale)
      ensureStyles()
      // Follow the archive set before the first scan resolves, so the footer
      // count is already live when the listing arrives.
      bindArchiveSet(ctx)
      // Footer chip: the one-click entry point, bottom-left in the sidebar.
      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register(
          {
            name: 'sidebar.footer.action',
            id: 'dsh-archive-cleanup',
            order: 40,
            label: () => t('chipLabel'),
          },
          Chip,
        ),
      )
      // The confirm dialog and the result banner share the shell's overlay seat.
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'dsh-archive-cleanup-dialog',
            order: 40,
          },
          Overlay,
        ),
      )
      // The management page.
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'dsh-archive-cleanup',
            order: 65,
            label: () => t('settingsTitle'),
          },
          SettingsSection,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    // Pure helpers exposed for tests only; the loader contract ignores them.
    exports._internals = {
      formatBytes,
      formatTime,
      summarise,
      fetchScan,
      fetchPurge,
      readArchiveIds,
      applyArchiveIds,
      getSnapshot,
      loadScan,
      openDialog,
      closeDialog,
      runPurge,
    }

    return module.exports
  },
})
