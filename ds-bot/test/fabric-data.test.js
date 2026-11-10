import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  agoText, bytesText, chipLabel, createFabricFeed, deriveState, durationText, errorText, harnessRows, hostMeters, hubGroups,
  isAbsent, latencyText, levelText, levelTone, metricLabel, metricValue, percentText, poll, savings, sinceText, unitState, usageTone,
} from '../src/client/fabric-data.js'
import { healthy } from './fabric-fixture.js'

const GB = 1024 ** 3

test('bytes read as 1.4 TB, 512 GB and 3.2 MB, and never as 1024 of a smaller unit', () => {
  assert.equal(bytesText(0, 'en-US'), '0 B')
  assert.equal(bytesText(512, 'en-US'), '512 B')
  assert.equal(bytesText(1536, 'en-US'), '1.5 KB')
  assert.equal(bytesText(3.2 * 1024 ** 2, 'en-US'), '3.2 MB')
  assert.equal(bytesText(512 * GB, 'en-US'), '512 GB')
  assert.equal(bytesText(1.4 * 1024 * GB, 'en-US'), '1.4 TB')
  assert.equal(bytesText(1023.96 * 1024, 'en-US'), '1 MB')
  assert.equal(bytesText(4096 * GB, 'en-US'), '4 TB')
  assert.equal(bytesText(8 * GB, 'en-US'), '8 GB')
  assert.equal(bytesText(12 * GB, 'en-US'), '12 GB')
  assert.equal(bytesText(Number.NaN, 'en-US'), '–')
  assert.equal(bytesText(-1, 'en-US'), '–')
  assert.equal(bytesText(4.5 * GB, 'de-DE'), '4,5 GB')
})

test('a percent keeps a decimal below ten, says <1% for a trace, and never rounds up to 100', () => {
  assert.equal(percentText(0, 'en-US'), '0%')
  assert.equal(percentText(0.004, 'en-US'), '<1%')
  assert.equal(percentText(0.046, 'en-US'), '4.6%')
  assert.equal(percentText(0.05, 'en-US'), '5%')
  assert.equal(percentText(0.82, 'en-US'), '82%')
  assert.equal(percentText(0.996, 'en-US'), '99%')
  assert.equal(percentText(1, 'en-US'), '100%')
  assert.equal(percentText(7, 'en-US'), '100%')
  assert.equal(percentText(-1, 'en-US'), '0%')
  assert.equal(percentText(Number.NaN, 'en-US'), '–')
})

test('durations show the two widest units, times ago read short, and a start time becomes how long it has run', () => {
  assert.equal(durationText(3 * 86_400 + 4 * 3_600 + 59), '3d 4h')
  assert.equal(durationText(86_400), '1d')
  assert.equal(durationText(5 * 3_600 + 12 * 60), '5h 12m')
  assert.equal(durationText(2 * 3_600), '2h')
  assert.equal(durationText(42 * 60 + 9), '42m')
  assert.equal(durationText(30.9), '30s')
  assert.equal(durationText(-1), '–')
  assert.equal(latencyText(42), '42 ms')
  assert.equal(latencyText(1234), '1.2 s')
  assert.equal(latencyText(null), '–')
  const now = Date.parse('2026-11-10T06:00:00Z')
  assert.equal(agoText(now - 1_000, now), 'just now')
  assert.equal(agoText(now - 12_000, now), '12 s ago')
  assert.equal(agoText(now - 3 * 60_000, now), '3 min ago')
  assert.equal(agoText(now - 2 * 3_600_000, now), '2 h ago')
  assert.equal(agoText(now - 3 * 86_400_000, now), '3 d ago')
  assert.equal(agoText(now + 5_000, now), 'just now')
  assert.equal(sinceText('2026-11-07T02:00:00.000Z', Date.parse('2026-11-10T06:00:00Z')), 'Running for 3d 4h')
  // systemd's own text for a time zone it cannot be read back from stays as printed.
  assert.equal(sinceText('Fri 2026-11-07 02:00:00 EST', now), 'Fri 2026-11-07 02:00:00 EST')
  assert.equal(sinceText(null, now), null)
})

test('unit states, errors and tones have words and colors', () => {
  assert.deepEqual(unitState('active'), { text: 'Running', tone: 'ok' })
  assert.deepEqual(unitState('failed'), { text: 'Failed', tone: 'bad' })
  assert.deepEqual(unitState('inactive'), { text: 'Stopped', tone: 'muted' })
  assert.equal(unitState('activating').tone, 'warn')
  assert.equal(unitState('maintenance').text, 'maintenance')
  assert.equal(errorText('not installed'), 'Not installed on this host')
  assert.equal(errorText('exit 1: no such table'), 'exit 1: no such table')
  // The host's own wording for a slow peer, an oversized or redirected answer, and an unfinished earlier run.
  assert.equal(errorText('timed out after 8 s'), 'Timed out after 8 s')
  assert.equal(errorText('timed out after 0.4 s'), 'Timed out after 0.4 s')
  assert.equal(errorText('HTTP 503'), 'HTTP error 503')
  assert.equal(errorText('answer too large'), 'Answer too large')
  assert.equal(errorText('redirected'), 'Redirected, which is not followed')
  assert.equal(errorText('an earlier run has not finished yet'), 'An earlier check has not finished yet')
  assert.equal(usageTone(0.5), 'ok')
  assert.equal(usageTone(0.85), 'warn')
  assert.equal(usageTone(0.95), 'bad')
  assert.equal(usageTone(Number.NaN), 'muted')
  assert.equal(isAbsent({ ok: false, error: 'not installed' }), true)
  assert.equal(isAbsent({ ok: false, error: 'timed out after 6 s' }), false)
  assert.equal(isAbsent({ ok: true }), false)
})

test('the host card turns the numbers into meters, and a Mac\'s memory is a size, not a warning', () => {
  const linux = hostMeters(healthy().host)
  assert.equal(linux.cpus, 8)
  assert.equal(linux.load.tone, 'ok')
  assert.ok(Math.abs(linux.load.fraction - 0.42 / 8) < 1e-9)
  assert.equal(linux.memory.used, 12 * GB)
  assert.equal(linux.memory.tone, 'ok')
  assert.deepEqual(linux.disks.map(disk => [disk.mount, disk.tone, Math.round(disk.fraction * 100)]), [['/', 'ok', 40], ['/srv/archive', 'ok', 71]])
  const mac = hostMeters({ ...healthy().host, platform: 'darwin', memory: { totalBytes: 8 * GB, availableBytes: 0.1 * GB } })
  assert.equal(mac.memory.mac, true)
  assert.equal(mac.memory.tone, 'muted')
  // With the kernel's percentage a Mac's memory is a measurement again: it has a tone, and no `mac` note.
  const pressure = hostMeters({ ...healthy().host, platform: 'darwin', memory: { totalBytes: 8 * GB, availableBytes: 8 * GB * 0.43, freePct: 43 } })
  assert.deepEqual([pressure.memory.mac, pressure.memory.pressure, pressure.memory.tone], [false, true, 'ok'])
  assert.ok(Math.abs(pressure.memory.fraction - 0.57) < 1e-9)
  assert.equal(hostMeters({ ...healthy().host, platform: 'darwin', memory: { totalBytes: 8 * GB, availableBytes: 8 * GB * 0.15, freePct: 15 } }).memory.tone, 'warn')
  // A Mac whose availability could not be read still shows its size.
  const unread = hostMeters({ ...healthy().host, platform: 'darwin', memory: { totalBytes: 8 * GB, availableBytes: null } })
  assert.deepEqual([unread.memory.mac, unread.memory.total, unread.memory.fraction, unread.memory.tone], [true, 8 * GB, null, 'muted'])
  assert.equal(hostMeters({ ...healthy().host, memory: { totalBytes: 8 * GB, availableBytes: null } }).memory, null)
  const busy = hostMeters({ ...healthy().host, load: [20, 10, 5], disks: [{ mount: '/', sizeBytes: 100, availBytes: 3, usedPct: 97 }] })
  assert.equal(busy.load.tone, 'bad')
  assert.equal(busy.load.fraction, 1)
  assert.equal(busy.disks[0].tone, 'bad')
  assert.equal(hostMeters({ ok: false, error: 'x' }), null)
  assert.equal(hostMeters(undefined), null)
})

test('a healthy status is ok, and each kind of trouble moves it the right way', () => {
  assert.deepEqual(deriveState(healthy()), { level: 'ok', reasons: [] })
  const reasons = value => deriveState(value).reasons
  // A peer that does not answer.
  const peerDown = { ...healthy(), peers: [{ name: 'Neo', ok: false, error: 'exit 255: no route' }] }
  assert.deepEqual(deriveState(peerDown), { level: 'degraded', reasons: ['Neo is unreachable'] })
  // The fabric's own unit stopped or failed: down. Starting or reloading: only a pause.
  assert.equal(deriveState({ ...healthy(), service: { ok: false, unit: 'anvil-dsh-fabric.service', state: 'failed' } }).level, 'down')
  assert.deepEqual(reasons({ ...healthy(), service: { ok: false, unit: 'anvil-dsh-fabric.service', state: 'failed' } }), ['anvil-dsh-fabric.service is failed'])
  assert.equal(deriveState({ ...healthy(), service: { ok: false, unit: 'u', state: 'inactive' } }).level, 'down')
  assert.equal(deriveState({ ...healthy(), service: { ok: false, unit: 'u', state: 'activating' } }).level, 'degraded')
  // A probe that failed on its own.
  assert.deepEqual(deriveState({ ...healthy(), hub: { ok: false, error: 'timed out after 10 s' } }), { level: 'degraded', reasons: ['The ANVIL hub could not be read'] })
  assert.deepEqual(reasons({ ...healthy(), os: { ok: false, error: 'exit 1' } }), ['ANVIL OS could not be read'])
  assert.deepEqual(reasons({ ...healthy(), sieve: { ok: false, error: 'no SIEVE data', output: { ok: false }, ingress: [] } }), ['SIEVE could not be read'])
  assert.deepEqual(reasons({ ...healthy(), host: { ok: false, error: 'boom' } }), ['This host could not be read'])
  assert.deepEqual(reasons({ ...healthy(), service: { ok: false, error: 'timed out after 6 s' } }), ['The Fabric service could not be checked'])
  // A disk nearly full, and a failed ANVIL OS unit.
  const full = healthy()
  full.host.disks[1].usedPct = 94
  assert.deepEqual(deriveState(full), { level: 'degraded', reasons: ['/srv/archive is 94% full'] })
  const failedUnit = healthy()
  failedUnit.os.services[1].state = 'failed'
  assert.deepEqual(reasons(failedUnit), ['1 ANVIL OS services have failed'])
  // An inactive ANVIL OS unit is not a fault by itself.
  const idle = healthy()
  idle.os.services[1].state = 'inactive'
  assert.equal(deriveState(idle).level, 'ok')
  // Worse trouble first.
  const both = { ...peerDown, service: { ok: false, unit: 'u', state: 'failed' } }
  assert.deepEqual(deriveState(both), { level: 'down', reasons: ['u is failed', 'Neo is unreachable'] })
})

test('a section that is simply not on this machine never turns the state yellow', () => {
  // A Mac with none of the Linux fabric on it.
  const mac = {
    ...healthy(),
    service: { ok: false, error: 'not available on this platform' },
    os: { ok: false, error: 'not installed' },
    sieve: { ok: false, error: 'not installed', output: { ok: false, error: 'not installed' }, ingress: [] },
    hub: { ok: false, error: 'not installed' },
  }
  assert.deepEqual(deriveState(mac), { level: 'ok', reasons: [] })
  // But every section failing for a real reason is the machines being out of reach.
  const dark = {
    ...healthy(), host: { ok: false, error: 'a' }, hub: { ok: false, error: 'b' }, os: { ok: false, error: 'c' },
    sieve: { ok: false, error: 'd', output: { ok: false }, ingress: [] },
  }
  assert.equal(deriveState(dark).level, 'down')
  assert.ok(deriveState(dark).reasons.includes('Nothing could be read'))
})

test('no status yet is unknown, a turned-off view is off, a status that failed to build is down, a failed refresh adds a reason', () => {
  assert.deepEqual(deriveState(null), { level: 'unknown', reasons: [] })
  assert.deepEqual(deriveState(null, { failed: true }), { level: 'unknown', reasons: ['The status could not be read'] })
  assert.deepEqual(deriveState({ enabled: false }), { level: 'off', reasons: [] })
  assert.deepEqual(deriveState({ enabled: true, error: 'boom' }), { level: 'down', reasons: ['The status could not be read'] })
  assert.deepEqual(deriveState(healthy(), { failed: true }), { level: 'degraded', reasons: ['The last refresh failed'] })
})

test('the chip\'s name says the state, then up to three reasons', () => {
  assert.equal(chipLabel(deriveState(healthy())), 'Fabric: all systems normal')
  assert.equal(chipLabel({ level: 'unknown', reasons: [] }), 'Fabric: checking…')
  assert.equal(chipLabel({ level: 'degraded', reasons: ['Neo is unreachable'] }), 'Fabric: degraded. Neo is unreachable')
  assert.equal(chipLabel({ level: 'down', reasons: ['a', 'b', 'c', 'd'] }), 'Fabric: down. a. b. c')
  assert.deepEqual(['ok', 'degraded', 'down', 'unknown', 'off'].map(levelTone), ['ok', 'warn', 'bad', 'muted', 'muted'])
  assert.equal(levelText('off'), 'Turned off')
})

test('SIEVE\'s share saved is what never reached the model, and nothing in is no share at all', () => {
  const sum = savings({ calls: 3, inBytes: 1000, outBytes: 250 })
  assert.deepEqual([sum.calls, sum.savedBytes, sum.fraction, sum.kept], [3, 750, 0.75, 0.25])
  assert.equal(savings({ calls: 0, inBytes: 0, outBytes: 0 }).fraction, null)
  // More out than in (a wrapper that added text) saves nothing; it is not a negative share.
  assert.equal(savings({ calls: 1, inBytes: 100, outBytes: 300 }).fraction, 0)
  assert.equal(savings(undefined).calls, 0)
  const rows = harnessRows({
    small: { calls: 1, inBytes: 10, outBytes: 5 }, big: { calls: 9, inBytes: 1000, outBytes: 100 }, tie: { calls: 2, inBytes: 10, outBytes: 1 },
  }, 2)
  assert.deepEqual(rows.rows.map(row => row.name), ['big', 'tie'])
  assert.equal(rows.more, 1)
  assert.deepEqual(harnessRows(undefined), { rows: [], more: 0 })
})

test('the hub\'s truth board keeps its headline numbers first and formats what the hub sent as text', () => {
  const { featured, rest } = hubGroups(healthy().hub.metrics)
  assert.deepEqual(featured.map(entry => entry.metric), ['open_blockers', 'active_agents', 'real_tasks'])
  assert.deepEqual(rest.map(entry => entry.metric), ['receipt_unique_bytes', 'receipt_backup_coverage'])
  assert.deepEqual(hubGroups(undefined), { featured: [], rest: [] })
  assert.equal(metricLabel('open_blockers'), 'Open blockers')
  assert.equal(metricLabel('receipt_oldest_spool_age'), 'Receipt oldest spool age')
  assert.equal(metricValue('real_tasks', '7305', 'en-US'), '7,305')
  assert.equal(metricValue('receipt_unique_bytes', '92618298', 'en-US'), '88 MB')
  assert.equal(metricValue('receipt_backup_coverage', 'false'), 'No')
  assert.equal(metricValue('x', true), 'Yes')
  assert.equal(metricValue('receipt_oldest_spool_age', 'none'), 'None')
  assert.equal(metricValue('last_real_write', '2026-11-10 01:19'), '2026-11-10 01:19')
  assert.equal(metricValue('big', '99999999999999999999999'), '99999999999999999999999')
})

test('the shared copy of the status shares one read, skips a young one, and keeps the old value when a read fails', async () => {
  let clock = 1000
  const feed = createFabricFeed({ now: () => clock })
  const seen = []
  feed.subscribe(snapshot => seen.push([snapshot.loading, snapshot.value?.n ?? null, snapshot.error]))
  let reads = 0
  let release
  const read = ({ fresh }) => { reads += 1; return new Promise((resolve) => { release = () => resolve({ n: reads, fresh }) }) }
  const first = feed.refresh(read)
  const second = feed.refresh(read)
  assert.equal(feed.get().loading, true)
  release()
  await Promise.all([first, second])
  assert.equal(reads, 1)
  assert.deepEqual(feed.get().value, { n: 1, fresh: false })
  assert.equal(feed.get().at, 1000)
  assert.equal(feed.get().loading, false)
  // Younger than maxAge: nothing is asked.
  clock = 1500
  await feed.refresh(read, { maxAge: 1000 })
  assert.equal(reads, 1)
  // Older: asked again.
  clock = 2500
  const third = feed.refresh(read, { maxAge: 1000 })
  release()
  await third
  assert.equal(reads, 2)
  // A forced read waits for the one in flight and then asks again, so it is never answered by an older one.
  const background = feed.refresh(read, { fresh: false, maxAge: 0 })
  const forced = feed.refresh(read, { fresh: true })
  assert.equal(reads, 3)
  release()
  await background
  await Promise.resolve()
  assert.equal(reads, 4)
  release()
  await forced
  assert.deepEqual(feed.get().value, { n: 4, fresh: true })
  // A failed read keeps what was known and says why; the next good one clears it.
  clock = 9000
  await feed.refresh(() => Promise.reject(new Error('host unreachable')), { fresh: true })
  assert.deepEqual([feed.get().value.n, feed.get().error, feed.get().loading], [4, 'host unreachable', false])
  await feed.refresh(() => Promise.resolve({ n: 5 }), { fresh: true })
  assert.deepEqual([feed.get().value.n, feed.get().error], [5, ''])
  assert.ok(seen.length > 6)
  feed.reset()
  assert.deepEqual(feed.get(), { value: null, error: '', at: 0, loading: false })
})

test('a listener that unsubscribes hears nothing more', async () => {
  const feed = createFabricFeed()
  const heard = []
  const off = feed.subscribe(snapshot => heard.push(snapshot.loading))
  await feed.refresh(() => Promise.resolve({ n: 1 }))
  const count = heard.length
  off()
  await feed.refresh(() => Promise.resolve({ n: 2 }), { fresh: true })
  assert.equal(heard.length, count)
})

// A scheduler a test drives by hand.
function clock() {
  const timers = new Map()
  let next = 1
  return {
    schedule: (fn, ms) => { timers.set(next, { fn, ms }); return next++ },
    cancel: (id) => { timers.delete(id) },
    pending: () => [...timers.values()].map(timer => timer.ms),
    fire() {
      const [[id, timer]] = [...timers]
      timers.delete(id)
      timer.fn()
    },
  }
}
const tick = () => new Promise(resolve => setImmediate(resolve))

test('the poller runs at once and every interval, skips a hidden tab, and runs again when the tab returns', async () => {
  const c = clock()
  let hidden = false
  let wake
  let runs = 0
  const stop = poll({
    run: () => { runs += 1 }, every: 30_000, schedule: c.schedule, cancel: c.cancel,
    isHidden: () => hidden, onVisible: (fn) => { wake = fn; return () => { wake = undefined } },
  })
  await tick()
  assert.equal(runs, 1)
  assert.deepEqual(c.pending(), [30_000])
  c.fire()
  await tick()
  assert.equal(runs, 2)
  // Hidden: the timer keeps running but asks nothing.
  hidden = true
  c.fire()
  await tick()
  assert.equal(runs, 2)
  wake()
  await tick()
  assert.equal(runs, 2)
  // Back on the tab: it asks now, and only one timer is left.
  hidden = false
  wake()
  await tick()
  assert.equal(runs, 3)
  assert.equal(c.pending().length, 1)
  stop()
  assert.deepEqual(c.pending(), [])
  assert.equal(wake, undefined)
  // A stopped poller never schedules again.
  await tick()
  assert.equal(runs, 3)
})

test('a poll whose run rejects does not stop the polling', async () => {
  const c = clock()
  let runs = 0
  poll({ run: () => { runs += 1; return Promise.reject(new Error('no')) }, every: 10, schedule: c.schedule, cancel: c.cancel })
  await tick()
  c.fire()
  await tick()
  assert.equal(runs, 2)
  assert.equal(c.pending().length, 1)
})
