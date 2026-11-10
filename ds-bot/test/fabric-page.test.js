import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { healthy } from './fabric-fixture.js'

const PLUGIN = fileURLToPath(new URL('..', import.meta.url))
const bundle = await build({
  stdin: {
    contents: "export * from './src/client/fabric-page.js'\nexport { fabricFeed } from './src/client/fabric-data.js'",
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: fn => fn,
}
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, setTimeout, clearTimeout, setInterval, clearInterval, Intl, Date, require: name => (name === 'react' ? react : {}) })
const page = module.exports
const NOW = Date.parse('2026-11-10T06:00:30Z')

// The settings card the page is handed, reduced to what a test reads.
const Section = ({ title, className, children }) => react.createElement('section', { 'data-title': title, className }, children)

// Function components drawn, so what is left is plain elements.
// (Arrays are copied into this realm: the page ran in its own, and deepStrictEqual compares prototypes.)
const expand = (node) => {
  if (Array.isArray(node)) return Array.from(node, expand)
  if (node === null || typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type({ ...node.props, children: node.children }))
  return { ...node, children: Array.from(node.children, expand) }
}
const find = (node, pick) => (Array.isArray(node) ? Array.from(node).flatMap(one => find(one, pick))
  : node && typeof node === 'object' ? [...pick(node) ? [node] : [], ...find(node.children, pick)] : [])
const strings = node => (Array.isArray(node) ? Array.from(node).flatMap(strings) : typeof node === 'string' ? [node] : node && typeof node === 'object' ? strings(node.children) : [])
const textOf = node => strings(node).join(' ').replace(/\s+/g, ' ').trim()
const withClass = (tree, name) => find(tree, node => String(node.props?.className ?? '').split(' ').includes(name))
const sectionOf = (tree, title) => find(tree, node => node.props?.['data-title'] === title)[0]

const view = (value, extra = {}) => expand(page.FabricView({
  snapshot: { value, error: '', at: NOW - 12_000, loading: false, ...extra }, now: NOW, onRefresh: () => {}, Section,
}))

test('while nothing has been read the page is a skeleton that says it is reading', () => {
  const tree = view(null)
  assert.equal(tree.props.role, 'status')
  assert.equal(tree.props['aria-label'], 'Reading the fabric…')
  assert.equal(tree.props['aria-busy'], true)
  assert.equal(find(tree, node => node.type === 'i').length, 4)
})

test('when the first read fails the page says so and offers to try again', () => {
  let again = 0
  const tree = expand(page.FabricView({ snapshot: { value: null, error: 'Request failed', at: 0, loading: false }, now: NOW, onRefresh: () => { again += 1 }, Section }))
  assert.equal(tree.props.role, 'alert')
  assert.match(textOf(tree), /The Fabric status could not be read Request failed Try again/)
  const [button] = find(tree, node => node.type === 'button')
  assert.equal(button.props.disabled, false)
  button.props.onClick()
  assert.equal(again, 1)
})

test('a host with the view turned off gets a calm page with the setting to turn it on', () => {
  const tree = view({ enabled: false })
  assert.match(textOf(tree), /Fabric is not configured This host has the Fabric view turned off/)
  const [code] = find(tree, node => node.type === 'pre')
  assert.match(code.children[0], /fabric:\n {2}enabled: true/)
  // No bar, no sections, nothing alarming.
  assert.equal(find(tree, node => node.type === 'section').length, 0)
  assert.equal(withClass(tree, 'bt-fab-bar').length, 0)
})

test('a healthy status draws the status bar and the four sections, in order', () => {
  const tree = view(healthy())
  assert.deepEqual(find(tree, node => node.type === 'section').map(node => node.props['data-title']), ['Hosts', 'Services', 'ANVIL hub', 'SIEVE'])
  const [bar] = withClass(tree, 'bt-fab-bar')
  assert.match(textOf(bar), /All systems normal Updated 12 s ago Refresh/)
  assert.equal(withClass(tree, 'bt-fab-sub').length, 0)
  assert.match(textOf(withClass(tree, 'bt-fab-foot')), /Checked in 840 ms\. This page reads again every 30 seconds while it is open\./)
})

test('the host card shows the machine, its load, memory and each disk, with how full they are', () => {
  const tree = view(healthy())
  const hosts = sectionOf(tree, 'Hosts')
  assert.match(textOf(withClass(hosts, 'bt-fab-host-name')), /node-02/)
  assert.match(textOf(withClass(hosts, 'bt-fab-muted')), /linux · x64 · Up 3d 4h/)
  const meters = withClass(hosts, 'bt-fab-meter').map(textOf)
  assert.equal(meters.length, 4)
  assert.match(meters[0], /^Load 0\.42 · 0\.38 · 0\.31 1, 5 and 15 minutes on 8 cores$/)
  assert.match(meters[1], /^System memory 38% used 20 GB free of 32 GB$/)
  assert.match(meters[2], /^\/ 40% used 300 GB free of 500 GB$/)
  assert.match(meters[3], /^\/srv\/archive 71% used 1\.2 TB free of 4 TB$/)
  // Each bar is a meter with its own name and value for assistive technology.
  const [load] = find(hosts, node => node.props?.role === 'meter')
  assert.equal(load.props['aria-label'], 'Load')
  assert.equal(load.props['aria-valuenow'], 5)
  // The fill carries its share and its tone as data, not as a color of its own.
  const fills = withClass(hosts, 'bt-fab-fill')
  assert.deepEqual(fills.map(node => node.props['data-tone']), ['ok', 'ok', 'ok', 'ok'])
  assert.equal(fills[2].props.style['--fab-frac'], 0.4)
})

test('a disk nearly full turns its bar and the status bar over, with the reason', () => {
  const value = healthy()
  value.host.disks[1].usedPct = 94
  const tree = view(value)
  const hosts = sectionOf(tree, 'Hosts')
  assert.equal(withClass(hosts, 'bt-fab-fill').at(-1).props['data-tone'], 'bad')
  assert.match(textOf(withClass(tree, 'bt-fab-bar')), /Degraded \/srv\/archive is 94% full/)
})

test('a Mac\'s memory shows its size and says free memory is not measured, rather than a full bar', () => {
  const value = healthy()
  Object.assign(value.host, { platform: 'darwin', memory: { totalBytes: 8 * 1024 ** 3, availableBytes: 1024 ** 3 / 10 } })
  const meters = withClass(sectionOf(view(value), 'Hosts'), 'bt-fab-meter').map(textOf)
  assert.match(meters[1], /^System memory 8 GB Free memory is not measured on macOS$/)
})

test('a Mac that reports the kernel\'s memory pressure shows a real meter, labelled by what it measures', () => {
  const value = healthy()
  Object.assign(value.host, { platform: 'darwin', memory: { totalBytes: 8 * 1024 ** 3, availableBytes: Math.round(8 * 1024 ** 3 * 0.43), freePct: 43 } })
  const hosts = sectionOf(view(value), 'Hosts')
  const meters = withClass(hosts, 'bt-fab-meter').map(textOf)
  assert.match(meters[1], /^System memory 57% used 3\.4 GB available of 8 GB, by memory pressure$/)
  assert.equal(withClass(hosts, 'bt-fab-fill')[1].props['data-tone'], 'ok')
  // Under pressure the bar turns, like any other.
  Object.assign(value.host.memory, { availableBytes: Math.round(8 * 1024 ** 3 * 0.05), freePct: 5 })
  assert.equal(withClass(sectionOf(view(value), 'Hosts'), 'bt-fab-fill')[1].props['data-tone'], 'bad')
})

test('peers show whether they answer and how fast, or why they do not', () => {
  const value = healthy()
  value.peers = [{ name: 'Neo', ok: true, latencyMs: 42, detail: 'Darwin neo' }, { name: 'Lab', ok: false, error: 'exit 255: ssh: Could not resolve hostname lab' }]
  const tree = view(value)
  const rows = withClass(sectionOf(tree, 'Hosts'), 'bt-fab-row').map(textOf)
  assert.ok(rows.some(row => /^Neo Darwin neo Reachable 42 ms$/.test(row)), rows.join('|'))
  assert.ok(rows.some(row => /^Lab exit 255: ssh: Could not resolve hostname lab Unreachable$/.test(row)), rows.join('|'))
  assert.match(textOf(withClass(tree, 'bt-fab-bar')), /Degraded Lab is unreachable/)
  // The dots are decoration: the words carry the state.
  const dots = find(sectionOf(tree, 'Hosts'), node => node.props?.className === 'bt-fab-dot')
  assert.ok(dots.length >= 2)
  assert.ok(dots.every(node => node.props['aria-hidden'] === true))
})

test('the volumes ANVIL OS names show whether each is mounted', () => {
  const value = healthy()
  value.os.disks = [{ name: 'Archive', path: '/srv/archive', total: 4096 * 1024 ** 3, free: 1200 * 1024 ** 3, present: true }, { name: 'Scratch', path: '/mnt/scratch', total: 0, free: 0, present: false }]
  const rows = withClass(sectionOf(view(value), 'Hosts'), 'bt-fab-row').map(textOf)
  assert.ok(rows.some(row => /^Archive \/srv\/archive 1\.2 TB free of 4 TB$/.test(row)), rows.join('|'))
  assert.ok(rows.some(row => /^Scratch \/mnt\/scratch Not present$/.test(row)), rows.join('|'))
})

test('services show the fabric unit with how long it has run, and ANVIL OS\'s units with what each is doing', () => {
  const value = healthy()
  value.os.services.push({ name: 'Backup', unit: 'backup.service', state: 'failed' }, { name: 'Timer', unit: 'timer.service', state: 'inactive' })
  const services = sectionOf(view(value), 'Services')
  const rows = withClass(services, 'bt-fab-row').map(textOf)
  assert.match(rows[0], /^anvil-dsh-fabric\.service Running for 3d 4h · 412 MB Running$/)
  assert.match(textOf(withClass(services, 'bt-fab-os-head')), /ANVIL OS 2 of 4 running · 1 min ago/)
  const items = find(services, node => node.type === 'li').map(textOf)
  assert.deepEqual(items, ['Hub', 'Ingress', 'Backup Failed', 'Timer Stopped'])
})

test('the hub shows its headline numbers as tiles and the rest as a list, formatted', () => {
  const hub = sectionOf(view(healthy()), 'ANVIL hub')
  const tiles = withClass(hub, 'bt-fab-tile').map(textOf)
  assert.deepEqual(tiles, ['Open blockers 62', 'Active agents 6', 'Tasks 408'])
  const pairs = find(hub, node => node.type === 'dl')[0].children.map(textOf)
  assert.deepEqual(pairs, ['Receipt unique bytes 88 MB', 'Receipt backup coverage No'])
  // Only a long list gets a Show all button.
  assert.equal(find(hub, node => node.type === 'button').length, 0)
  const long = healthy()
  long.hub.metrics = Array.from({ length: 20 }, (_, index) => ({ metric: `m_${index}`, value: String(index) }))
  const longHub = sectionOf(view(long), 'ANVIL hub')
  assert.equal(find(longHub, node => node.type === 'dl')[0].children.length, 12)
  const [more] = find(longHub, node => node.type === 'button')
  assert.equal(textOf(more), 'Show all 20')
  assert.equal(more.props['aria-expanded'], false)
})

test('SIEVE shows what reached the model against what went in, today and over all time, with each harness and the ingress', () => {
  const sieve = sectionOf(view(healthy()), 'SIEVE')
  const [today, all] = withClass(sieve, 'bt-fab-save').map(textOf)
  assert.match(today, /^Today 85% saved 12 MB reached the model, of 80 MB · 120 calls$/)
  assert.match(all, /^All time 85% saved 600 MB reached the model, of 4 GB/)
  const [bar] = find(sieve, node => node.props?.role === 'meter')
  assert.equal(bar.props['aria-valuenow'], 85)
  assert.equal(bar.props['aria-label'], 'Saved')
  const harness = withClass(sieve, 'bt-fab-harness').map(textOf)
  assert.match(harness[0], /^codex 90 calls · 87% saved$/)
  assert.match(harness[1], /^claude 30 calls · 80% saved$/)
  const rows = withClass(sieve, 'bt-fab-row').map(textOf)
  assert.ok(rows.some(row => /^Last tool call 2 min ago$/.test(row)), rows.join('|'))
  assert.ok(rows.some(row => /^Fabric ingress 127\.0\.0\.1:8899 · Up 3d · 120 requests today Healthy$/.test(row)), rows.join('|'))
})

test('SIEVE with no calls yet says so, and a partial log says the counts are partial', () => {
  const value = healthy()
  value.sieve.output.today = { calls: 0, inBytes: 0, outBytes: 0 }
  value.sieve.output.partial = true
  const sieve = sectionOf(view(value), 'SIEVE')
  assert.match(textOf(withClass(sieve, 'bt-fab-save')[0]), /^Today No tool calls yet$/)
  assert.ok(withClass(sieve, 'bt-fab-row').map(textOf).some(row => /Counts cover the recent part of the log only\./.test(row)))
})

test('a section that failed stays on the page with the reason, and the rest still shows', () => {
  const value = healthy()
  value.hub = { ok: false, error: 'timed out after 10 s' }
  value.sieve = { ok: false, error: 'no SIEVE data', output: { ok: false, error: 'could not be read' }, ingress: [{ url: 'http://127.0.0.1:8899/sieve/stats', ok: false, error: 'unreachable' }] }
  const tree = view(value)
  assert.deepEqual(find(tree, node => node.type === 'section').map(node => node.props['data-title']), ['Hosts', 'Services', 'ANVIL hub', 'SIEVE'])
  // The host writes "timed out after 10 s" in English; the page translates it like the other reasons.
  assert.match(textOf(sectionOf(tree, 'ANVIL hub')), /Truth board Could not be read: Timed out after 10 s/)
  const sieve = textOf(sectionOf(tree, 'SIEVE'))
  assert.match(sieve, /Tool output Could not be read: could not be read/)
  assert.match(sieve, /Fabric ingress 127\.0\.0\.1:8899 · Unreachable Down/)
  assert.match(textOf(sectionOf(tree, 'Hosts')), /node-02/)
  assert.match(textOf(withClass(tree, 'bt-fab-bar')), /Degraded The ANVIL hub could not be read · SIEVE could not be read/)
})

test('a section whose tool is not on this machine says so quietly, in muted words, not as a failure', () => {
  const value = healthy()
  value.service = { ok: false, error: 'not available on this platform' }
  value.os = { ok: false, error: 'not installed' }
  const tree = view(value)
  const services = sectionOf(tree, 'Services')
  const problems = withClass(services, 'bt-fab-problem')
  assert.equal(problems.length, 2)
  assert.ok(problems.every(node => node.props['data-absent'] === true))
  assert.deepEqual(problems.map(textOf), ['Fabric service Not available on this platform', 'ANVIL OS Not installed on this host'])
  assert.match(textOf(withClass(tree, 'bt-fab-bar')), /^All systems normal/)
})

test('a status the host could not build at all shows one problem instead of empty sections', () => {
  const tree = view({ enabled: true, generatedAt: '2026-11-10T06:00:00.000Z', tookMs: 0, error: 'boom' })
  assert.deepEqual(find(tree, node => node.type === 'section').map(node => node.props['data-title']), ['Fabric'])
  assert.match(textOf(withClass(tree, 'bt-fab-bar')), /Down The status could not be read/)
  assert.match(textOf(find(tree, node => node.type === 'section')), /Fabric Could not be read: boom/)
})

test('a failed refresh keeps the last status on the page and says it is out of date', () => {
  const tree = view(healthy(), { error: 'Request failed' })
  assert.match(textOf(withClass(tree, 'bt-fab-bar')), /Degraded The last refresh failed/)
  assert.equal(find(tree, node => node.type === 'section').length, 4)
})

test('Refresh asks again, and is disabled and says so while a read is out', () => {
  let asked = 0
  const idle = expand(page.FabricView({ snapshot: { value: healthy(), error: '', at: NOW, loading: false }, now: NOW, onRefresh: () => { asked += 1 }, Section }))
  const [button] = find(idle, node => node.type === 'button' && /Refresh/.test(textOf(node)))
  assert.equal(button.props.disabled, false)
  button.props.onClick()
  assert.equal(asked, 1)
  const busy = expand(page.FabricView({ snapshot: { value: healthy(), error: '', at: NOW, loading: true }, now: NOW, onRefresh: () => {}, Section }))
  const [loading] = find(busy, node => node.type === 'button' && /Refreshing/.test(textOf(node)))
  assert.equal(loading.props.disabled, true)
  assert.equal(loading.props['aria-busy'], true)
  assert.equal(find(busy, node => node.props?.className === 'bt-fab-spin')[0].props['data-on'], true)
})

// The chip reads the shared copy; a test seeds it.
const chipFor = async (value, { rail = false, opened = [] } = {}) => {
  page.fabricFeed.reset()
  if (value !== undefined) await page.fabricFeed.refresh(() => Promise.resolve(value), { fresh: true })
  return expand(page.FabricChip({ actions: { fabricStatus: () => Promise.resolve(value), openSettings: (...args) => opened.push(args) }, rail }))
}

test('the sidebar chip is a dot and "Fabric", named by the state and what is wrong, and opens Settings → Fabric', async () => {
  const opened = []
  const ok = await chipFor(healthy(), { opened })
  assert.equal(ok.type, 'button')
  assert.equal(ok.props['aria-label'], 'Fabric: all systems normal')
  assert.equal(ok.props.title, 'Fabric: all systems normal')
  assert.equal(ok.props['data-level'], 'ok')
  assert.equal(textOf(ok), 'Fabric')
  assert.equal(find(ok, node => node.props?.className === 'bt-fab-dot')[0].props['data-tone'], 'ok')
  ok.props.onClick()
  assert.deepEqual(opened, [['fabric']])

  const value = healthy()
  value.peers = [{ name: 'Neo', ok: false, error: 'x' }]
  const degraded = await chipFor(value)
  assert.equal(degraded.props['aria-label'], 'Fabric: degraded. Neo is unreachable')
  assert.equal(degraded.props['data-level'], 'degraded')
  assert.equal(find(degraded, node => node.props?.className === 'bt-fab-dot')[0].props['data-tone'], 'warn')

  const down = await chipFor({ ...healthy(), service: { ok: false, unit: 'anvil-dsh-fabric.service', state: 'failed' } })
  assert.equal(down.props['data-level'], 'down')
  assert.equal(find(down, node => node.props?.className === 'bt-fab-dot')[0].props['data-tone'], 'bad')
})

test('before the first read the chip is a hollow dot named as checking, and on the rail it is the dot alone', async () => {
  const waiting = await chipFor(undefined)
  assert.equal(waiting.props['aria-label'], 'Fabric: checking…')
  assert.equal(waiting.props['data-level'], 'unknown')
  assert.equal(find(waiting, node => node.props?.className === 'bt-fab-dot')[0].props['data-tone'], 'muted')
  const rail = await chipFor(healthy(), { rail: true })
  assert.equal(rail.props['data-rail'], true)
  assert.equal(textOf(rail), '')
  assert.equal(rail.props['aria-label'], 'Fabric: all systems normal')
  assert.equal(withClass(rail, 'bt-fab-chip-label').length, 0)
})

test('the chip is absent when the status says the view is off', async () => {
  assert.equal(await chipFor({ enabled: false }), null)
})

test('the "Updated" clock stands still while the tab is hidden and catches up when it is shown', async () => {
  const settle = () => new Promise(resolve => setImmediate(resolve))
  const sets = []
  const effects = []
  const timers = []
  const listeners = {}
  const document = { hidden: true, addEventListener: (name, fn) => { listeners[name] = fn }, removeEventListener() {} }
  const stub = { ...react, useState: initial => [typeof initial === 'function' ? initial() : initial, value => sets.push(value)], useEffect: (run) => { effects.push(run) } }
  const sandbox = { module: { exports: {} }, document, Intl, Date, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length }, clearTimeout() {}, require: name => (name === 'react' ? stub : {}) }
  sandbox.exports = sandbox.module.exports
  runInNewContext(bundle.outputFiles[0].text, sandbox)
  sandbox.module.exports.useNow(5_000)
  effects[0]()
  await settle()
  assert.deepEqual(sets, [], 'hidden from the start: no tick draws the page')
  assert.equal(timers.at(-1).ms, 5_000)
  timers.at(-1).fn()
  timers.at(-1).fn()
  await settle()
  assert.deepEqual(sets, [], 'and none follows while it stays hidden')
  document.hidden = false
  listeners.visibilitychange()
  await settle()
  assert.equal(sets.length, 1, 'shown again: the clock is set at once')
  timers.at(-1).fn()
  await settle()
  assert.equal(sets.length, 2, 'and keeps ticking')
})

test('an ingress row shows a title for its role, with host:port small and never the stats path', () => {
  const value = healthy()
  value.sieve.ingress = [
    { url: 'http://127.0.0.1:8898/sieve/stats', ok: true, uptimeMs: 3_600_000, requestsToday: 7 },
    { url: 'http://10.0.0.5:9000/sieve/stats', ok: true },
  ]
  const sieve = sectionOf(view(value), 'SIEVE')
  const rows = withClass(sieve, 'bt-fab-row').map(textOf)
  assert.ok(rows.some(row => /^Optimizer ingress 127\.0\.0\.1:8898 · Up 1h · 7 requests today Healthy$/.test(row)), rows.join('|'))
  assert.ok(rows.some(row => /^10\.0\.0\.5:9000 Healthy$/.test(row)), rows.join('|'))
  assert.ok(!rows.some(row => row.includes('/sieve/stats')))
  const mono = withClass(sieve, 'bt-fab-mono').map(textOf)
  assert.ok(mono.includes('127.0.0.1:8898'))
})

test('a saturated host keeps the state but the headline stops saying normal and says why', () => {
  const value = healthy()
  value.host = { ...value.host, cpus: 16, load: [30, 28, 20], memory: { totalBytes: 100 * 1024 ** 3, availableBytes: 7 * 1024 ** 3 } }
  const [bar] = withClass(view(value), 'bt-fab-bar')
  assert.match(textOf(bar), /^All systems reachable node-02 is under heavy load · Memory is nearly full Updated/)
})
