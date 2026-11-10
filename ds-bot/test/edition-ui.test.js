import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { createSource } from '../src/client/sources.js'
import { teamActions } from '../src/client/team-actions.js'
import { DICTIONARY } from '../src/client/i18n.js'

const PLUGIN = fileURLToPath(new URL('..', import.meta.url))

// The client modules the edition touches, bundled with a React that only builds element objects.
const bundle = await build({
  stdin: {
    contents: `export { CapabilityRow } from './src/client/capability-settings.js'
export { workPhrase } from './src/client/cells.js'
export { SETTINGS_PAGES } from './src/client/settings.js'`,
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const react = new Proxy({
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {}, useLayoutEffect: () => {}, useRef: current => ({ current }), useMemo: make => make(), useCallback: fn => fn,
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  memo: fn => fn, forwardRef: fn => fn,
}, { get: (target, key) => (key in target ? target[key] : () => ({ Provider: () => null, Consumer: () => null })) })
const stub = new Proxy({}, { get: () => () => null })
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, setTimeout, clearTimeout, setInterval, clearInterval, console, require: name => (name === 'react' ? react : stub) })
const { CapabilityRow, workPhrase, SETTINGS_PAGES } = module.exports

const find = (node, pick) => (Array.isArray(node) ? Array.from(node).flatMap(one => find(one, pick))
  : node && typeof node === 'object' ? [...pick(node) ? [node] : [], ...find(node.children, pick)] : [])
const textOf = node => (Array.isArray(node) ? Array.from(node).map(textOf).join('') : typeof node === 'string' ? node : node?.children ? textOf(node.children) : '')

test('Fabric is a Settings page, right after Usage and before the pinned pages, with a Chinese name', () => {
  const keys = Array.from(SETTINGS_PAGES, ([key]) => key)
  assert.equal(keys[keys.indexOf('usage') + 1], 'fabric')
  assert.ok(keys.indexOf('fabric') < keys.indexOf('feedback'))
  assert.ok(keys.indexOf('fabric') < keys.indexOf('about'))
  assert.equal(new Set(keys).size, keys.length)
  assert.deepEqual(Array.from(SETTINGS_PAGES.find(([key]) => key === 'fabric')), ['fabric', 'Fabric'])
  assert.equal(DICTIONARY.zh.Fabric, 'Fabric')
})

test('the four fabric tools read as short phrases in the activity row', () => {
  assert.equal(workPhrase('fabric_status'), 'Checking the fabric')
  assert.equal(workPhrase('anvil_findings'), 'Searching ANVIL findings')
  assert.equal(workPhrase('anvil_log'), 'Reading the ANVIL log')
  assert.equal(workPhrase('anvil_decision'), 'Recording a decision')
  assert.equal(workPhrase({ tool: 'anvil_log', target: 'last 15' }), 'Reading the ANVIL log · last 15')
})

test('a capability that came from the host\'s configuration says so, until it has been saved in Settings', () => {
  const row = item => CapabilityRow({ item, onEdit() {}, onDelete() {}, onApprove() {}, confirming: false })
  const seeded = row({ name: 'github', kind: 'mcp', transport: 'stdio', approved: true, source: 'config', description: 'GitHub' })
  const [tag] = find(seeded, node => node.props?.className === 'bt-tag bt-config-tag')
  assert.equal(textOf(tag), 'From configuration')
  assert.match(tag.props.title, /configuration; saving a change makes it yours/)
  // A saved one drops `source`, and no tag shows.
  const saved = row({ name: 'github', kind: 'mcp', transport: 'stdio', approved: true, description: 'GitHub' })
  assert.equal(find(saved, node => String(node.props?.className).includes('bt-config-tag')).length, 0)
})

// The requests the actions send.
test('the Fabric page reads the status through one request, forcing a fresh read only when asked', async () => {
  const sent = []
  const call = async (name, body) => { sent.push([name, body]); return { enabled: true } }
  let pulls = 0
  const after = (promise) => { pulls += 1; return promise }
  const actions = teamActions({ call, after, partFor: id => id, roster: createSource({}), ui: createSource({ settings: null }) })
  await actions.fabricStatus()
  await actions.fabricStatus({})
  await actions.fabricStatus({ fresh: true })
  await actions.fabricStatus({ fresh: false })
  assert.deepEqual(sent, [['fabric-status', undefined], ['fabric-status', undefined], ['fabric-status', { fresh: true }], ['fabric-status', undefined]])
  // A read: the team is not read again afterwards.
  assert.equal(pulls, 0)
})
