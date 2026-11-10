// Fabric: the parts of the page and the sidebar chip that are not drawing. The status object
// itself is built by the host (src/host/fabric.js); this file formats it, decides what state
// it adds up to, and keeps one shared copy of it that the page and the chip both read, so
// neither asks the machines more often than it must.
import { dateLocale, t } from './i18n.js'

export const PAGE_POLL_MS = 30_000
export const CHIP_POLL_MS = 60_000

// ---- numbers ----------------------------------------------------------------------------

const format = (value, locale, options) => new Intl.NumberFormat(locale, options).format(value)

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
// 1.4 TB, 512 GB, 3.2 MB, 4 TB. One decimal below ten (dropped when it is a zero), none above; a
// value that would round up to 1024 moves to the next unit instead.
export function bytesText(value, locale = dateLocale()) {
  if (!Number.isFinite(value) || value < 0) return '–'
  let size = value
  let unit = 0
  while (size >= 1024 && unit < BYTE_UNITS.length - 1) { size /= 1024; unit += 1 }
  let digits = unit === 0 || size >= 10 ? 0 : 1
  if (unit < BYTE_UNITS.length - 1 && Number(size.toFixed(digits)) >= 1024) {
    size /= 1024
    unit += 1
    digits = 1
  }
  return `${format(size, locale, { maximumFractionDigits: digits })} ${BYTE_UNITS[unit]}`
}

// A fraction as a percent: 82%, 4.6%, <1%. Nothing is rounded up to 100% unless it is.
export function percentText(fraction, locale = dateLocale()) {
  if (!Number.isFinite(fraction)) return '–'
  const percent = Math.min(100, Math.max(0, fraction * 100))
  const whole = { style: 'percent', maximumFractionDigits: 0 }
  if (percent === 0) return format(0, locale, whole)
  if (percent < 1) return `<${format(0.01, locale, whole)}`
  if (percent < 10) return format(Math.round(percent * 10) / 1000, locale, { style: 'percent', maximumFractionDigits: 1 })
  // Short of 100 stays short of it: 99.6 reads 99%.
  return format((percent < 100 ? Math.min(99, Math.round(percent)) : 100) / 100, locale, whole)
}

export const countText = (value, locale = dateLocale()) => (Number.isFinite(value) ? format(Math.round(value), locale) : '–')

// The widest unit pair that fits: 3d 4h, 5h 12m, 42m, 30s.
export function durationText(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '–'
  const days = Math.floor(totalSeconds / 86_400)
  const hours = Math.floor(totalSeconds % 86_400 / 3_600)
  const minutes = Math.floor(totalSeconds % 3_600 / 60)
  if (days > 0) return hours > 0 ? t('{days}d {hours}h', { days, hours }) : t('{days}d', { days })
  if (hours > 0) return minutes > 0 ? t('{hours}h {minutes}m', { hours, minutes }) : t('{hours}h', { hours })
  if (minutes > 0) return t('{minutes}m', { minutes })
  return t('{seconds}s', { seconds: Math.floor(totalSeconds) })
}

// A round trip: 42 ms, 1.2 s.
export function latencyText(ms, locale = dateLocale()) {
  if (!Number.isFinite(ms) || ms < 0) return '–'
  if (ms < 1000) return t('{ms} ms', { ms: format(Math.round(ms), locale) })
  return t('{seconds} s', { seconds: format(ms / 1000, locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })
}

// How long ago, for the "Updated …" line and the times the machines report.
export function agoText(then, now = Date.now()) {
  if (!Number.isFinite(then)) return '–'
  const seconds = Math.max(0, Math.round((now - then) / 1000))
  if (seconds < 5) return t('just now')
  if (seconds < 60) return t('{count} s ago', { count: seconds })
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return t('{count} min ago', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('{count} h ago', { count: hours })
  return t('{count} d ago', { count: Math.floor(hours / 24) })
}

// systemd reports a start time as text; a UTC one the host has already turned into ISO. Anything
// else stays as it was printed.
export function sinceText(since, now = Date.now()) {
  if (typeof since !== 'string' || since === '') return null
  const time = /^\d{4}-\d{2}-\d{2}T/.test(since) ? Date.parse(since) : Number.NaN
  return Number.isFinite(time) ? t('Running for {time}', { time: durationText((now - time) / 1000) }) : since
}

// ---- meters -----------------------------------------------------------------------------

// ok below 80% used, warn up to 92%, then crit: a disk or a memory bar's color.
export const usageTone = (fraction) => {
  if (!Number.isFinite(fraction)) return 'muted'
  return fraction >= 0.92 ? 'bad' : fraction >= 0.8 ? 'warn' : 'ok'
}

// Load against the number of cores: a machine at one runnable task per core is busy, not broken.
export const loadTone = (ratio) => {
  if (!Number.isFinite(ratio)) return 'muted'
  return ratio >= 1.5 ? 'bad' : ratio >= 0.8 ? 'warn' : 'ok'
}

const clamp01 = value => Math.min(1, Math.max(0, value))

// What the host card shows, ready to draw. A Mac's own memory figure is the kernel's free
// percentage (`freePct`, the number behind memory pressure), which is a measurement like any
// other. A host that sends none on a Mac counted only never-used pages as free, which is nearly
// always close to zero, so there the bar is a size (`mac`) and not a warning.
export function hostMeters(host) {
  if (host?.ok !== true) return null
  const cpus = Number.isFinite(host.cpus) && host.cpus > 0 ? host.cpus : 1
  const [one, five, fifteen] = Array.isArray(host.load) ? host.load : []
  const total = host.memory?.totalBytes
  const available = Number.isFinite(host.memory?.availableBytes) ? host.memory.availableBytes : null
  const used = Number.isFinite(total) && available !== null ? Math.max(0, total - available) : null
  const memory = used === null || !(total > 0) ? null : used / total
  const darwin = host.platform === 'darwin'
  const pressure = darwin && Number.isFinite(host.memory?.freePct) && memory !== null
  const mac = darwin && !pressure
  return {
    cpus,
    load: Number.isFinite(one) ? { one, five, fifteen, ratio: one / cpus, fraction: clamp01(one / cpus), tone: loadTone(one / cpus) } : null,
    memory: Number.isFinite(total) && total > 0 && (memory !== null || mac)
      ? { used, total, available, mac, pressure, fraction: memory === null ? null : clamp01(memory), tone: mac ? 'muted' : usageTone(memory) }
      : null,
    disks: (host.disks ?? []).map(disk => ({
      mount: disk.mount,
      size: disk.sizeBytes,
      free: disk.availBytes,
      fraction: clamp01((Number.isFinite(disk.usedPct) ? disk.usedPct : 0) / 100),
      tone: usageTone((Number.isFinite(disk.usedPct) ? disk.usedPct : 0) / 100),
    })),
  }
}

// What a busy host adds to the headline without changing the state: load above one task
// per core, memory at 90% used or more, or a disk at 92% or more. Each note is
// {kind, text}; the service, peer and section checks alone decide ok, degraded or down.
export const PRESSURE = { memory: 0.9, disk: 92 }
export function pressureNotes(host) {
  if (host?.ok !== true) return []
  const meters = hostMeters(host)
  const notes = []
  if (meters?.load && meters.load.one > meters.cpus) notes.push({ kind: 'load', text: t('{host} is under heavy load', { host: host.hostname || t('This host') }) })
  if (meters?.memory && !meters.memory.mac && meters.memory.fraction !== null && meters.memory.fraction >= PRESSURE.memory) notes.push({ kind: 'memory', text: t('Memory is nearly full') })
  for (const disk of host.disks ?? []) {
    if (Number.isFinite(disk.usedPct) && disk.usedPct >= PRESSURE.disk) notes.push({ kind: 'disk', text: t('Disk {mount} is nearly full', { mount: disk.mount }) })
  }
  return notes
}

// ---- states -----------------------------------------------------------------------------

// What a section says when its tool is simply not on this machine. That is a fact about the
// machine, not a fault, so it never turns the chip yellow.
const ABSENT = new Set(['not installed', 'not available on this platform', 'not configured'])
export const isAbsent = section => section?.ok === false && ABSENT.has(String(section.error ?? ''))

// The words for a probe's error. The host writes them in English; the common ones are known.
export function errorText(error) {
  switch (String(error ?? '')) {
    case 'not installed': return t('Not installed on this host')
    case 'not available on this platform': return t('Not available on this platform')
    case 'not configured': return t('Not configured')
    case 'unreachable': return t('Unreachable')
    case 'not executable': return t('Cannot be run')
    case 'not readable': return t('Cannot be read')
    case 'unexpected output': return t('Unexpected output')
    case 'unreadable output': return t('Unreadable output')
    case 'unexpected snapshot schema': return t('Unexpected snapshot format')
    case 'the hub reported an error': return t('The hub reported an error')
    case 'reports a problem': return t('Reports a problem')
    case 'answer too large': return t('Answer too large')
    case 'redirected': return t('Redirected, which is not followed')
    case 'an earlier run has not finished yet': return t('An earlier check has not finished yet')
    case '': return t('No details')
    default: {
      // The host counts the seconds in English; the number is what matters.
      const timeout = /^timed out after ([\d.]+) s$/u.exec(String(error))
      if (timeout) return t('Timed out after {seconds} s', { seconds: timeout[1] })
      const status = /^HTTP (\d{3})$/u.exec(String(error))
      if (status) return t('HTTP error {status}', { status: status[1] })
      return String(error)
    }
  }
}

// How a systemd unit state reads, and what color it takes.
export function unitState(state) {
  switch (state) {
    case 'active': return { text: t('Running'), tone: 'ok' }
    case 'activating': return { text: t('Starting'), tone: 'warn' }
    case 'reloading': return { text: t('Reloading'), tone: 'warn' }
    case 'deactivating': return { text: t('Stopping'), tone: 'warn' }
    case 'failed': return { text: t('Failed'), tone: 'bad' }
    case 'inactive': return { text: t('Stopped'), tone: 'muted' }
    default: return { text: state ? String(state) : t('Unknown state'), tone: 'muted' }
  }
}

// Whether the fabric as a whole is well, from a status value. `failed` says the last attempt
// to read it did not work. The levels:
//   off      the view is turned off in this host's configuration
//   unknown  nothing has been read yet
//   ok       every section that exists answers and nothing is wrong
//   degraded something is wrong or unreadable: a peer, a section, a service, a full disk
//   down     the fabric's own service is not running, or nothing could be read at all
export function deriveState(value, { failed = false } = {}) {
  if (value === null || value === undefined) return { level: 'unknown', reasons: failed ? [t('The status could not be read')] : [], advisory: [] }
  if (value.enabled === false) return { level: 'off', reasons: [], advisory: [] }
  const down = []
  const warn = []
  if (typeof value.error === 'string' && value.error !== '') down.push(t('The status could not be read'))
  const service = value.service
  if (service !== undefined && service !== null && service.ok !== true) {
    if (typeof service.state === 'string') {
      const state = unitState(service.state)
      const line = t('{unit} is {state}', { unit: service.unit ?? t('The Fabric service'), state: state.text.toLowerCase() })
      // Starting or reloading is a pause; stopped or failed is the service being gone.
      if (state.tone === 'warn') warn.push(line)
      else down.push(line)
    } else if (!isAbsent(service)) {
      warn.push(t('The Fabric service could not be checked'))
    }
  }
  const host = value.host
  if (host?.ok === false && !isAbsent(host)) warn.push(t('This host could not be read'))
  for (const disk of host?.ok === true ? host.disks ?? [] : []) {
    if (Number.isFinite(disk.usedPct) && disk.usedPct >= 90) warn.push(t('{mount} is {percent} full', { mount: disk.mount, percent: `${Math.round(disk.usedPct)}%` }))
  }
  for (const peer of Array.isArray(value.peers) ? value.peers : []) {
    if (peer?.ok !== true) warn.push(t('{name} is unreachable', { name: peer?.name ?? '?' }))
  }
  if (value.hub?.ok === false && !isAbsent(value.hub)) warn.push(t('The ANVIL hub could not be read'))
  const os = value.os
  if (os?.ok === false && !isAbsent(os)) warn.push(t('ANVIL OS could not be read'))
  if (os?.ok === true) {
    const failedUnits = (os.services ?? []).filter(item => item.state === 'failed').length
    if (failedUnits > 0) warn.push(t('{count} ANVIL OS services have failed', { count: failedUnits }))
  }
  if (value.sieve?.ok === false && !isAbsent(value.sieve)) warn.push(t('SIEVE could not be read'))
  // Every section that could answer did not: the machines are out of reach, not just quiet.
  const sections = [value.host, value.hub, value.os, value.sieve].filter(section => section !== undefined)
  if (sections.length > 0 && sections.every(section => section?.ok === false) && !sections.every(isAbsent)) down.push(t('Nothing could be read'))
  if (failed) warn.push(t('The last refresh failed'))
  const level = down.length > 0 ? 'down' : warn.length > 0 ? 'degraded' : 'ok'
  // A disk at 92% already reads as a reason above (90% and up), so it is not said twice.
  const advisory = pressureNotes(host).filter(note => note.kind !== 'disk' || level === 'ok').map(note => note.text).slice(0, 2)
  return { level, reasons: [...down, ...warn], advisory }
}

export const levelTone = level => (level === 'ok' ? 'ok' : level === 'degraded' ? 'warn' : level === 'down' ? 'bad' : 'muted')

// `strained`: the level is ok but the host is busy, so "normal" would overstate it.
export function levelText(level, { strained = false } = {}) {
  switch (level) {
    case 'ok': return strained ? t('All systems reachable') : t('All systems normal')
    case 'degraded': return t('Degraded')
    case 'down': return t('Down')
    case 'off': return t('Turned off')
    default: return t('Checking…')
  }
}

// The chip's accessible name: the state, then up to three reasons.
export function chipLabel({ level, reasons, advisory = [] }) {
  const head = t('Fabric: {state}', { state: levelText(level, { strained: advisory.length > 0 }).toLowerCase() })
  return [head, ...reasons.slice(0, 3)].join('. ')
}

// ---- SIEVE ------------------------------------------------------------------------------

// An ingress row's title from its stats URL: the two known ingress ports by role, any other
// by host:port. `ingressAddress` is the URL's host and port, never its path.
export function ingressAddress(url) {
  const text = String(url ?? '')
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(text)?.[1]
  const host = authority?.slice(authority.lastIndexOf('@') + 1)
  return host ? host : text
}
export function ingressTitle(url) {
  const port = /:(\d+)$/.exec(ingressAddress(url))?.[1]
  if (port === '8898') return t('Optimizer ingress')
  if (port === '8899') return t('Fabric ingress')
  return ingressAddress(url)
}

// How much of the tool output SIEVE kept out of the model's context: bytes in, bytes out, the
// share saved. `fraction` is null when nothing went in.
export function savings(row) {
  const inBytes = Number.isFinite(row?.inBytes) ? row.inBytes : 0
  const outBytes = Number.isFinite(row?.outBytes) ? row.outBytes : 0
  const saved = Math.max(0, inBytes - outBytes)
  return {
    calls: Number.isFinite(row?.calls) ? row.calls : 0,
    inBytes,
    outBytes,
    savedBytes: saved,
    fraction: inBytes > 0 ? clamp01(saved / inBytes) : null,
    kept: inBytes > 0 ? clamp01(outBytes / inBytes) : 0,
  }
}

// The harnesses SIEVE served, the busiest first, and how many did not fit.
export function harnessRows(byHarness, limit = 8) {
  const rows = Object.entries(byHarness ?? {})
    .map(([name, row]) => ({ name, ...savings(row) }))
    .sort((a, b) => b.inBytes - a.inBytes || b.calls - a.calls || a.name.localeCompare(b.name))
  return { rows: rows.slice(0, limit), more: Math.max(0, rows.length - limit) }
}

// ---- the hub ----------------------------------------------------------------------------

// The truth board's headline numbers, in this order, when the hub reports them.
const FEATURED = ['open_blockers', 'active_agents', 'real_tasks', 'real_memories', 'op_events', 'last_real_write']

export function metricLabel(id) {
  switch (id) {
    case 'open_blockers': return t('Open blockers')
    case 'active_agents': return t('Active agents')
    case 'real_tasks': return t('Tasks')
    case 'real_memories': return t('Memories')
    case 'op_events': return t('Events')
    case 'last_real_write': return t('Last write')
    default: {
      const words = String(id ?? '').replace(/[_.-]+/g, ' ').trim()
      return words === '' ? '?' : words[0].toUpperCase() + words.slice(1)
    }
  }
}

// A metric's value as the hub sent it (numbers often arrive as text): counts get digit
// grouping, byte counts a unit, booleans a word.
export function metricValue(id, value, locale = dateLocale()) {
  if (typeof value === 'boolean') return value ? t('Yes') : t('No')
  const text = String(value ?? '')
  if (text === 'true') return t('Yes')
  if (text === 'false') return t('No')
  if (text === 'none') return t('None')
  if (/^\d+$/.test(text) && text.length <= 15) {
    return /(?:^|_)bytes$/.test(String(id)) ? bytesText(Number(text), locale) : countText(Number(text), locale)
  }
  return text
}

// The metrics split into the headline tiles and the rest.
export function hubGroups(metrics) {
  const list = Array.isArray(metrics) ? metrics : []
  const featured = FEATURED.map(id => list.find(entry => entry.metric === id)).filter(Boolean)
  const shown = new Set(featured.map(entry => entry.metric))
  return { featured, rest: list.filter(entry => !shown.has(entry.metric)) }
}

// ---- the shared copy --------------------------------------------------------------------

const message = error => (typeof error?.message === 'string' && error.message !== '' ? error.message : String(error ?? 'failed'))

// One shared copy of the status. `refresh` reads it again (skipping the read when the copy is
// younger than `maxAge`, so a page and a chip that both poll do not both ask); requests made
// while one is out share it, and `fresh` waits for it and asks again, so a forced read is never
// answered by one that was already under way.
export function createFabricFeed({ now = () => Date.now() } = {}) {
  let snapshot = { value: null, error: '', at: 0, loading: false }
  const listeners = new Set()
  let inflight = null
  let inflightFresh = false
  const set = (patch) => {
    snapshot = { ...snapshot, ...patch }
    for (const listener of listeners) listener(snapshot)
  }
  function start(read, fresh) {
    inflightFresh = fresh
    set({ loading: true })
    // `read` is called now, so the request is on its way before this returns.
    const work = new Promise(resolve => resolve(read({ fresh })))
      .then(value => set({ value, error: '', at: now(), loading: false }), error => set({ error: message(error), loading: false }))
      .finally(() => { if (inflight === work) { inflight = null; inflightFresh = false } })
    inflight = work
    return work
  }
  async function refresh(read, { fresh = false, maxAge = 0 } = {}) {
    while (inflight !== null) {
      const joined = !fresh || inflightFresh
      await inflight
      if (joined) return snapshot
    }
    if (!fresh && snapshot.value !== null && snapshot.error === '' && now() - snapshot.at < maxAge) return snapshot
    await start(read, fresh)
    return snapshot
  }
  return {
    get: () => snapshot,
    refresh,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    reset() {
      snapshot = { value: null, error: '', at: 0, loading: false }
      inflight = null
      inflightFresh = false
    },
  }
}

// The one the page and the chip share.
export const fabricFeed = createFabricFeed()

// Runs `run` now and every `every` ms, but not while the tab is hidden; coming back to the tab
// runs it at once. Returns the stop function. The timer functions and the visibility hooks are
// parameters so a test can drive it.
export function poll({ run, every, isHidden = () => false, onVisible = () => () => {}, schedule = setTimeout, cancel = clearTimeout }) {
  let stopped = false
  let timer
  const tick = () => {
    cancel(timer)
    if (stopped) return
    if (!isHidden()) void Promise.resolve().then(run).catch(() => {})
    timer = schedule(tick, every)
  }
  const off = onVisible(() => { if (!isHidden()) tick() })
  tick()
  return () => {
    stopped = true
    cancel(timer)
    off()
  }
}

// `document` as the poller needs it; outside a browser the tab is never hidden.
export const browserVisibility = {
  isHidden: () => globalThis.document?.hidden === true,
  onVisible(fn) {
    const doc = globalThis.document
    if (!doc?.addEventListener) return () => {}
    doc.addEventListener('visibilitychange', fn)
    return () => doc.removeEventListener('visibilitychange', fn)
  },
}
