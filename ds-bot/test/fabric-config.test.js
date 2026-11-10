// The profile config that shapes the Bots: config.teamRules (the prompt) and config.capabilities
// (MCP servers seeded into the library).
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { parseConfiguredCapabilities } from '../src/host/capabilities.js'
import { STANDING_RULES_MAX, install as installPrompt, standingRules } from '../src/host/prompt.js'
import { fakeContext } from './fake-ctx.js'

// ---- config.teamRules ---------------------------------------------------------------------

const HEADING = '## Standing rules from the user\'s environment'

function startPrompt(config) {
  const ctx = fakeContext()
  const bots = new Map([
    ['main', { name: 'Chief' }],
    ['worker', { name: 'Dev', instructions: 'Check files.' }],
  ])
  installPrompt({
    ctx,
    ...(config === undefined ? {} : { config }),
    selfOf: id => id === 'group-worker' ? 'worker' : id,
    botOf: id => bots.get(id),
    roomOf: id => id === 'room' ? {} : undefined,
    isMain: id => id === 'main',
  })
  return id => ctx.sections.get('bot-identity').text({ agent: { id } })
}

test('without teamRules the prompt is what it always was', () => {
  const baseline = startPrompt(undefined)
  for (const config of [{}, { teamRules: '' }, { teamRules: '   \n\t ' }, { teamRules: 42 }, { teamRules: null }, { teamRules: ['a'] }]) {
    const prompt = startPrompt(config)
    for (const id of ['main', 'worker', 'group-worker', 'room', 'outside']) assert.equal(prompt(id), baseline(id), `${JSON.stringify(config)} ${id}`)
  }
  assert.doesNotMatch(baseline('main'), /Standing rules/)
  assert.match(baseline('worker'), /- Reply in the user's language\.$/)
})

test('teamRules is appended after the built-in team rules of every Bot, and nowhere else', () => {
  const baseline = startPrompt(undefined)
  const prompt = startPrompt({ teamRules: '  Prefer the self-hosted fleet.\nNever push to main.\n' })
  const tail = `\n\n${HEADING}\nPrefer the self-hosted fleet.\nNever push to main.`
  for (const id of ['main', 'worker']) {
    assert.equal(prompt(id), `${baseline(id)}${tail}`)
    assert.equal(prompt(id).split(HEADING).length - 1, 1)
  }
  // The Main rules come first, then the team rules, then the standing rules.
  assert.ok(prompt('main').indexOf('## You are the Main Bot') < prompt('main').indexOf('## How your Bot team works'))
  assert.ok(prompt('main').indexOf('## How your Bot team works') < prompt('main').indexOf(HEADING))
  assert.equal(prompt('group-worker'), prompt('worker'))
  // The group relay is not a Bot, and a Session outside the team has no section.
  assert.equal(prompt('room'), baseline('room'))
  assert.equal(prompt('outside'), '')
})

test('teamRules is capped at 4000 characters and never ends on half a character', () => {
  assert.equal(STANDING_RULES_MAX, 4000)
  assert.equal(standingRules('x'.repeat(5000)), `${HEADING}\n${'x'.repeat(4000)}`)
  assert.equal(standingRules('x'.repeat(4000)), `${HEADING}\n${'x'.repeat(4000)}`)
  const cutInsidePair = standingRules(`${'a'.repeat(3999)}\u{1F600}`)
  assert.equal(cutInsidePair, `${HEADING}\n${'a'.repeat(3999)}`)
  assert.doesNotMatch(cutInsidePair, /[\uD800-\uDBFF]/u)
  assert.equal(standingRules('  trimmed  '), `${HEADING}\ntrimmed`)
  assert.equal(standingRules(`${'y'.repeat(3990)}${' '.repeat(20)}tail`), `${HEADING}\n${'y'.repeat(3990)}`)
  assert.equal(standingRules(''), '')
})

test('the running plugin gives teamRules to its Bots', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-teamrules-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team()))
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false, teamRules: 'Answer in French.' })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  await rt.load()
  const prompt = id => ctx.sections.get('bot-identity').text({ agent: { id } })
  for (const id of ['chief', 'worker']) assert.match(prompt(id), new RegExp(`- Reply in the user's language\\.\\n\\n${HEADING}\\nAnswer in French\\.$`))
})

// ---- config.capabilities ------------------------------------------------------------------

const team = () => ({
  version: 1,
  mainBotIds: ['chief'],
  bots: {
    chief: { id: 'chief', sessionId: 'chief', name: 'Chief', capabilities: [], createdAt: 1 },
    worker: { id: 'worker', sessionId: 'worker', name: 'Worker', capabilities: [], createdAt: 2 },
    helper: { id: 'helper', sessionId: 'helper', name: 'Helper', capabilities: [], createdAt: 3 },
  },
  rooms: {},
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  revision: 1,
})

const entries = () => [
  { name: 'files', kind: 'mcp', transport: 'stdio', command: 'node', args: ['server.js', 8080], env: { PORT: 8080, MODE: 'dev' }, description: 'Project files', bots: 'main' },
  { name: 'docs', kind: 'mcp', transport: 'http', url: 'https://docs.example.com/mcp', headers: { 'X-Team': 'anvil' }, bots: 'all' },
  { name: 'quiet', kind: 'mcp', transport: 'stdio', command: 'node' },
]

function agentFor(id, mounts) {
  return {
    id,
    session: { id },
    ctx: {
      effect(execute) { execute() },
      plugin(plugin, config) {
        const record = { plugin, config, sessionId: id, disposed: false }
        mounts.push(record)
        return { await: async () => {}, dispose: () => { record.disposed = true } }
      },
    },
  }
}

// Hosts stop before the folders they used are removed, whatever order a test made them in.
const registry = new WeakMap()
function track(t, env, folder) {
  let entry = registry.get(t)
  if (entry === undefined) {
    entry = { envs: [], folders: [] }
    registry.set(t, entry)
    t.after(async () => {
      for (const host of entry.envs) await host.stop()
      for (const path of entry.folders) rmSync(path, { recursive: true, force: true, maxRetries: 5 })
    })
  }
  entry.envs.push(env)
  if (folder !== undefined) entry.folders.push(folder)
}

// One host on `home` (made when none is given). Stopping keeps the folder, so a second setup on
// the same home is a restart.
async function setup(t, { home, state = team(), capabilities, beforeLoad } = {}) {
  const fresh = home === undefined
  home ??= mkdtempSync(join(tmpdir(), 'ds-bot-seed-'))
  if (fresh) writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  const mounts = []
  const mcpPlugin = { name: 'mcp-client', apply() {} }
  const loader = { import: async () => ({ default: mcpPlugin }), unwrapExports: exports => exports.default }
  const ctx = fakeContext({ services: { loader } })
  const rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false, ...(capabilities === undefined ? {} : { capabilities }) })
  ctx.sessionTitle = { rename: async () => {} }
  rt.resolveAgent = async sessionId => ({ session: { id: sessionId } })
  beforeLoad?.(rt)
  await rt.load()
  // The seeding the start made is written in the background: wait for that write.
  await rt.save()
  const env = {
    home,
    ctx,
    rt,
    mounts,
    items: () => rt.state.capabilities.items,
    bots: () => Object.fromEntries(Object.values(rt.state.bots).map(bot => [bot.id, bot.capabilities])),
    // The file holds what the plugin knows only after a write; this one is queued behind any in flight.
    async saved() {
      await rt.save()
      return JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
    },
    async stop() { await ctx.dispose() },
    agentCreated: id => ctx.listeners.get('agent/created').find(listener => listener.name === 'prepareCapabilities')({ agent: agentFor(id, mounts) }),
  }
  track(t, env, fresh ? home : undefined)
  return env
}

const quietConsole = t => t.mock.method(console, 'error', () => {})
const normal = ({ createdAt: _created, updatedAt: _updated, ...item }) => item

test('configured servers are added to the library once, in its own data shape, approved and marked', async (t) => {
  const env = await setup(t, { capabilities: entries() })
  const items = env.items()
  assert.deepEqual(Object.keys(items).sort(), ['docs', 'files', 'quiet'])
  assert.deepEqual(normal(items.files), {
    name: 'files',
    kind: 'mcp',
    description: 'Project files',
    createdBy: null,
    transport: 'stdio',
    command: 'node',
    args: ['server.js', '8080'],
    env: { PORT: '8080', MODE: 'dev' },
    approved: true,
    source: 'config',
  })
  assert.deepEqual(normal(items.docs), {
    name: 'docs',
    kind: 'mcp',
    description: '',
    createdBy: null,
    transport: 'streamable-http',
    url: 'https://docs.example.com/mcp',
    headers: { 'X-Team': 'anvil' },
    approved: true,
    source: 'config',
  })
  assert.equal(typeof items.files.createdAt, 'number')
  // `bots` decides who has it: Main Bots, every Bot, or nobody (the default).
  assert.deepEqual(env.bots(), { chief: ['files', 'docs'], worker: ['docs'], helper: ['docs'] })
  // The client's library view carries the mark.
  assert.equal(env.rt.capabilityLibraryView().find(item => item.name === 'files').source, 'config')

  const saved = await env.saved()
  assert.deepEqual(Object.keys(saved.capabilities.seeded).sort(), ['docs', 'files', 'quiet'])
  assert.deepEqual(saved.capabilities.seeded.files.bots, ['chief'])
  assert.deepEqual(saved.capabilities.seeded.docs.bots.sort(), ['chief', 'helper', 'worker'])
  assert.deepEqual(saved.capabilities.seeded.quiet.bots, [])

  // Loading again changes nothing.
  const before = JSON.stringify(env.items())
  await env.rt.scheduleCapabilitiesReconcile()
  await env.rt.load()
  assert.equal(JSON.stringify(env.items()), before)
  assert.deepEqual(env.bots(), { chief: ['files', 'docs'], worker: ['docs'], helper: ['docs'] })
})

test('a team without config.capabilities keeps its library exactly as it was', async (t) => {
  const env = await setup(t)
  assert.deepEqual(env.rt.state.capabilities, { items: {} })
  const saved = await env.saved()
  assert.equal('seeded' in saved.capabilities, false)
})

test('a configured stdio server mounts without waiting for approval; a Bot-made one still does', async (t) => {
  const env = await setup(t, { capabilities: entries() })
  const { rt } = env
  await env.agentCreated('chief')
  assert.deepEqual(env.mounts.map(mount => mount.config.serverName).sort(), ['docs', 'files'])
  const files = env.mounts.find(mount => mount.config.serverName === 'files').config
  assert.deepEqual(files, { transport: 'stdio', serverName: 'files', command: 'node', args: ['server.js', '8080'], env: { PORT: '8080', MODE: 'dev' }, failOnStartupError: true })
  assert.deepEqual(rt.capabilityStatusesView().chief, { files: { state: 'ready' }, docs: { state: 'ready' } })

  // The same command added by a Bot is not the user's: it waits.
  const made = await rt.capabilitySave({ name: 'bot-made', kind: 'mcp', transport: 'stdio', command: 'node', args: ['x.js'] }, { botId: 'worker' })
  assert.equal(made.approved, false)
  await rt.capabilityEndpoint('bot-capability', { botId: 'chief', name: 'bot-made', attached: true })
  await rt.scheduleCapabilitiesReconcile()
  assert.deepEqual(rt.capabilityStatusesView().chief['bot-made'], { state: 'needs-approval' })
  assert.deepEqual(rt.capabilityStatusesView().chief.files, { state: 'ready' })
})

test('a server the user removed, a Bot they detached it from, or an item they edited is never re-added or overwritten', async (t) => {
  const first = await setup(t, { capabilities: entries() })
  const { rt } = first
  await rt.capabilityDelete('files', { ui: true })
  assert.equal(first.items().files, undefined)
  await rt.capabilityEndpoint('bot-capability', { botId: 'worker', name: 'docs', attached: false })
  await rt.capabilitySave({ name: 'quiet', kind: 'mcp', transport: 'stdio', command: 'node', args: ['--edited'], description: 'mine' }, { ui: true })
  assert.equal(first.items().quiet.source, undefined, 'an edit in Settings is no longer the config\'s')
  // Within the same run, a reconcile puts nothing back.
  await rt.scheduleCapabilitiesReconcile()
  assert.equal(first.items().files, undefined)
  assert.deepEqual(first.bots().worker, [])
  await first.saved()
  await first.stop()

  // After a restart, with the same entries and a changed definition for the edited one.
  const changed = entries()
  changed[2].command = 'node-new'
  const second = await setup(t, { home: first.home, capabilities: changed })
  await second.rt.scheduleCapabilitiesReconcile()
  assert.equal(second.items().files, undefined, 'removed stays removed')
  assert.deepEqual(second.bots(), { chief: ['docs'], worker: [], helper: ['docs'] }, 'a detached Bot stays detached')
  assert.equal(second.items().quiet.command, 'node')
  assert.deepEqual(second.items().quiet.args, ['--edited'])
  assert.equal(second.items().quiet.description, 'mine')
  assert.equal(second.items().quiet.source, undefined)
})

test('a server the user made before the config named it is left alone', async (t) => {
  const state = team()
  state.capabilities = { items: { files: { name: 'files', kind: 'mcp', description: 'Mine', createdBy: null, createdAt: 1, updatedAt: 1, transport: 'stdio', command: 'my-files', args: [], env: {}, approved: true } } }
  const env = await setup(t, { state, capabilities: entries() })
  assert.equal(env.items().files.command, 'my-files')
  assert.equal(env.items().files.source, undefined)
  assert.deepEqual(env.bots().chief, ['docs'], 'it is not switched on for the Bots either')
})

test('an item still from the config follows the config when its definition changes', async (t) => {
  const first = await setup(t, { capabilities: entries() })
  const created = first.items().docs.createdAt
  await first.saved()
  await first.stop()
  const changed = entries()
  changed[1].url = 'https://docs.example.com/v2/mcp'
  const second = await setup(t, { home: first.home, capabilities: changed })
  assert.equal(second.items().docs.url, 'https://docs.example.com/v2/mcp')
  assert.equal(second.items().docs.source, 'config')
  assert.equal(second.items().docs.createdAt, created)
  assert.deepEqual(second.bots().worker, ['docs'])
})

test('a Bot that joins later gets the servers that are for every Bot, and a Main Bot those for Main Bots', async (t) => {
  const env = await setup(t, { capabilities: entries() })
  const { rt } = env
  rt.state.bots.newbie = { id: 'newbie', sessionId: 'newbie', name: 'Newbie', capabilities: [], createdAt: 9 }
  await rt.save()
  await rt.scheduleCapabilitiesReconcile()
  assert.deepEqual(rt.state.bots.newbie.capabilities, ['docs'])
  rt.state.mainBotIds.push('newbie')
  await rt.save()
  await rt.scheduleCapabilitiesReconcile()
  assert.deepEqual(rt.state.bots.newbie.capabilities, ['docs', 'files'])
  // A detach is remembered even though the Bot is still eligible.
  await rt.capabilityEndpoint('bot-capability', { botId: 'newbie', name: 'docs', attached: false })
  await rt.scheduleCapabilitiesReconcile()
  assert.deepEqual(rt.state.bots.newbie.capabilities, ['files'])
})

test('invalid entries are skipped with a warning in the diagnostics log, never a crash', async (t) => {
  quietConsole(t)
  const env = await setup(t, {
    capabilities: [
      'not a mapping',
      { name: 'Bad_Name', command: 'x' },
      { name: 'skilly', kind: 'skill', content: 'x' },
      { name: 'nocmd', transport: 'stdio' },
      { name: 'badurl', transport: 'http', url: 'ftp://example.com' },
      { name: 'badbots', command: 'x', bots: 'everyone' },
      { name: 'badargs', command: 'x', args: [{ a: 1 }] },
      { name: 'github', command: 'x' },
      { name: 'badtransport', transport: 'carrier-pigeon', command: 'x' },
      { name: 'ok', kind: 'mcp', command: 'node', bots: 'main' },
      { name: 'ok', kind: 'mcp', command: 'node-again' },
    ],
  })
  assert.deepEqual(Object.keys(env.items()), ['ok'])
  assert.equal(env.items().ok.command, 'node')
  assert.deepEqual(env.bots().chief, ['ok'])
  const warnings = (await env.rt.diagnostics.entries()).filter(entry => entry.level === 'warn' && /configured capability/.test(entry.text))
  assert.equal(warnings.length, 10)
  for (const label of ['entry 1', 'Bad_Name', 'skilly', 'nocmd', 'badurl', 'badbots', 'badargs', 'github', 'badtransport']) {
    assert.ok(warnings.some(entry => entry.text.includes(` ${label} skipped`)), label)
  }
  assert.ok(warnings.some(entry => /the name is listed twice/.test(entry.text)))
})

test('a setting that is not a list is reported and ignored', async (t) => {
  quietConsole(t)
  const env = await setup(t, { capabilities: 'oops' })
  assert.deepEqual(env.items(), {})
  assert.ok((await env.rt.diagnostics.entries()).some(entry => /config\.capabilities skipped: the setting must be a list/.test(entry.text)))
  assert.deepEqual(parseConfiguredCapabilities(undefined), [])
  assert.deepEqual(parseConfiguredCapabilities(null), [])
  const reasons = []
  assert.deepEqual(parseConfiguredCapabilities({ name: 'x' }, (label, reason) => reasons.push([label, reason])), [])
  assert.deepEqual(reasons, [['config.capabilities', 'the setting must be a list']])
})

test('a host that cannot change the team seeds nothing, and does once it can', async (t) => {
  const env = await setup(t, { capabilities: entries(), beforeLoad: (rt) => { rt.readOnly = () => 'The Bot team is open in another dsh.' } })
  assert.deepEqual(env.items(), {})
  assert.equal('seeded' in env.rt.state.capabilities, false)
  env.rt.readOnly = () => undefined
  await env.rt.scheduleCapabilitiesReconcile()
  assert.deepEqual(Object.keys(env.items()).sort(), ['docs', 'files', 'quiet'])
})

test('entries are checked the way the library checks them', () => {
  const parsed = parseConfiguredCapabilities([
    { name: 'a', command: ' node ', args: ['x', 1, true], env: { N: 2, B: false } },
    { name: 'b', url: 'http://localhost:9000/mcp' },
    { name: 'c', transport: 'streamable-http', url: 'https://c.example/mcp', description: `  ${'d'.repeat(3000)}  ` },
  ])
  assert.deepEqual(parsed.map(entry => [entry.name, entry.transport, entry.bots]), [['a', 'stdio', 'none'], ['b', 'streamable-http', 'none'], ['c', 'streamable-http', 'none']])
  assert.equal(parsed[0].command, 'node')
  assert.deepEqual(parsed[0].args, ['x', '1', 'true'])
  assert.deepEqual(parsed[0].env, { N: '2', B: 'false' })
  assert.equal(parsed[2].description.length, 2000)
  assert.match(parsed[0].hash, /^[0-9a-f]{16}$/)
  assert.notEqual(parsed[0].hash, parsed[1].hash)
})

// ---- the config is the trust root --------------------------------------------------------------

test('a server whose entry left the config is withdrawn: out of the library, every Bot, every pack and the seed record', async (t) => {
  quietConsole(t)
  const first = await setup(t, { capabilities: entries() })
  await first.rt.capabilitySave({ name: 'bundle', kind: 'pack', items: ['files', 'docs'] }, { ui: true })
  // Also kept by a Bot on its own: the worker has docs; the chief has both.
  assert.deepEqual(first.bots(), { chief: ['files', 'docs'], worker: ['docs'], helper: ['docs'] })
  await first.saved()
  await first.stop()

  // The user removes `files` from the profile (it is compromised): after the restart nothing of it is left.
  const kept = entries().filter(entry => entry.name !== 'files')
  const second = await setup(t, { home: first.home, capabilities: kept })
  assert.deepEqual(Object.keys(second.items()).sort(), ['bundle', 'docs', 'quiet'])
  assert.deepEqual(second.items().bundle.items, ['docs'])
  assert.deepEqual(second.bots(), { chief: ['docs'], worker: ['docs'], helper: ['docs'] })
  const saved = await second.saved()
  assert.deepEqual(Object.keys(saved.capabilities.seeded).sort(), ['docs', 'quiet'])
  assert.ok((await second.rt.diagnostics.entries()).some(entry => entry.level === 'warn' && /configured capability files is no longer in the configuration/.test(entry.text)))
  // It no longer mounts for anyone.
  await second.agentCreated('chief')
  assert.deepEqual(second.mounts.map(mount => mount.config.serverName), ['docs'])
  await second.stop()

  // Adding the entry again seeds it afresh.
  const third = await setup(t, { home: first.home, capabilities: entries() })
  assert.equal(third.items().files.source, 'config')
  assert.deepEqual(third.bots().chief, ['docs', 'files'])
})

test('removing the whole setting withdraws what it seeded; a setting that cannot be read, an invalid entry, or an edited server withdraws nothing', async (t) => {
  quietConsole(t)
  const first = await setup(t, { capabilities: entries() })
  // The user made `quiet` their own in Settings before.
  await first.rt.capabilitySave({ name: 'quiet', kind: 'mcp', transport: 'stdio', command: 'node', args: ['--mine'] }, { ui: true })
  await first.saved()
  await first.stop()

  // A setting that is not a list says nothing about what is wanted.
  const typo = await setup(t, { home: first.home, capabilities: 'oops' })
  assert.deepEqual(Object.keys(typo.items()).sort(), ['docs', 'files', 'quiet'])
  await typo.saved()
  await typo.stop()
  // An entry that is listed but invalid keeps its server and its approval.
  const broken = await setup(t, { home: first.home, capabilities: [{ name: 'files', kind: 'mcp', transport: 'stdio' }, { name: 'docs', kind: 'mcp', transport: 'http', url: 'https://docs.example.com/mcp' }] })
  assert.equal(broken.items().files.command, 'node')
  assert.equal(broken.items().files.approved, true)
  await broken.saved()
  await broken.stop()

  // No setting at all: both seeded servers go, and the one the user rewrote stays.
  const gone = await setup(t, { home: first.home })
  assert.deepEqual(Object.keys(gone.items()), ['quiet'])
  assert.deepEqual(gone.items().quiet.args, ['--mine'])
  assert.deepEqual(gone.bots(), { chief: [], worker: [], helper: [] })
  assert.deepEqual((await gone.saved()).capabilities.seeded, {})
})

test('bots: main is a limit: a Bot that is not a Main Bot cannot attach or mount the server, however it asks', async (t) => {
  const env = await setup(t, { capabilities: entries() })
  const { rt } = env
  const attach = (name, callerId, bot) => rt.changeCapabilityAttachment('attach', { name, ...(bot === undefined ? {} : { bot }) }, callerId)
  await assert.rejects(attach('files', 'worker'), /files is limited to Main Bots by this host's configuration \(bots: main\); Worker is not one/)
  await assert.rejects(attach('files', 'chief', 'Worker'), /limited to Main Bots/)
  // Through a pack it is the same server.
  await rt.capabilitySave({ name: 'bundle', kind: 'pack', items: ['files'] }, { botId: 'chief' })
  await assert.rejects(attach('bundle', 'worker'), /files is limited to Main Bots/)
  assert.deepEqual(env.bots().worker, ['docs'])
  // The others are free to attach, and a Main Bot may attach the limited one to itself.
  await attach('quiet', 'worker')
  assert.deepEqual(env.bots().worker, ['docs', 'quiet'])
  assert.deepEqual(await attach('bundle', 'chief'), { bot: 'Chief', attached: true })

  // Settings can still put it on a Bot, and a Bot's own edit of a pack can too, but it never mounts there.
  await rt.capabilityEndpoint('bot-capability', { botId: 'worker', name: 'files', attached: true })
  await env.agentCreated('worker')
  assert.deepEqual(env.mounts.filter(mount => mount.sessionId === 'worker').map(mount => mount.config.serverName).sort(), ['docs', 'quiet'])
  assert.deepEqual(rt.capabilityStatusesView().worker.files, { state: 'error', error: 'Limited to Main Bots by the configuration (bots: main)' })
  assert.deepEqual(rt.capabilityStatusesView().worker.docs, { state: 'ready' })

  // Once the Bot is a Main Bot the server mounts for it.
  rt.state.mainBotIds.push('worker')
  await rt.save()
  await rt.scheduleCapabilitiesReconcile()
  assert.deepEqual(env.mounts.filter(mount => mount.sessionId === 'worker' && !mount.disposed).map(mount => mount.config.serverName).sort(), ['docs', 'files', 'quiet'])

  // A server the user rewrote in Settings is theirs: the limit followed the config's own entry.
  await rt.capabilitySave({ name: 'files', kind: 'mcp', transport: 'stdio', command: 'node', args: ['mine.js'] }, { ui: true })
  rt.state.mainBotIds.pop()
  await rt.save()
  assert.deepEqual(await attach('files', 'helper'), { bot: 'Helper', attached: true })
})
