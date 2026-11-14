import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { apply as applyShell, ROUTES as SHELL_ROUTES } from '../shell.js'
import {
  EgressDeniedError,
  OWNER_SECRET_EXACT,
  ATTRIBUTION_KEYS,
  createEgressController,
  scrubOwnerTokens,
  validateLeaseGrant,
  workDepthOf,
} from '../src/host/egress.js'
import { install as installCapabilities } from '../src/host/capabilities.js'
import { install as installFabric } from '../src/host/fabric.js'
import { install as installTools } from '../src/host/tools.js'
import { LocalAgentAdapter } from '../src/host/local-agents/adapter.js'
import { AcpEngine } from '../src/host/local-agents/acp.js'
import { ClaudeEngine } from '../src/host/local-agents/claude.js'
import { CodexEngine } from '../src/host/local-agents/codex.js'
import { cleanEnv } from '../src/host/local-agents/discover.js'
import { cliMode } from '../src/host/local-agents/engines.js'
import { LoopbackMcp } from '../src/host/local-agents/mcp.js'
import { fakeContext } from './fake-ctx.js'

const PROBE_CLI = fileURLToPath(new URL('./fixtures/egress-probe-cli.mjs', import.meta.url))
const FAKE_CODEX = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))
const ECHO_ENV = fileURLToPath(new URL('./fixtures/echo-argv-env.mjs', import.meta.url))

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitUntil(fn, { timeoutMs = 10_000, intervalMs = 20, message = 'condition timed out' } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const val = await fn()
    if (val) return val
    await sleep(intervalMs)
  }
  throw new Error(message)
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
}

async function collect(stream) {
  const out = { text: '', finish: undefined, calls: [] }
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') out.text += chunk.text
    else if (chunk.type === 'finish') out.finish = chunk.reason
    else if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') out.calls.push(chunk.block)
  }
  return out
}

const userMsg = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })

function validGrant(sessionRef, agentId, overrides = {}) {
  return {
    lease_state: 'current',
    session_ref: sessionRef,
    native_fingerprint: sessionRef,
    native_id: agentId,
    agent_id: agentId,
    task_id: 'task-42',
    run_id: 'run-42',
    lease_ref: 'lease-42',
    lease_generation: 1,
    lease_expires_at_ms: Date.now() + 30_000,
    agent: 'ds-bot-chief',
    ...overrides,
  }
}

test('DSH ctx.tools.guard intercepts native tools while external ClaudeEngine/CodexEngine CLI tools bypass ctx.tools.guard', async (t) => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const agent = { id: 's1', session: { id: 's1' } }
  const owned = createScope(ctx, agent)
  agent.ctx = owned.ctx
  ctx.tools.guard(() => 'denied by DSH tools.guard')

  // Native DSH tool dispatch sees and enforces ctx.tools.guard.
  assert.equal(ctx.tools.checkGuards({ agent, toolName: 'bash' }), 'denied by DSH tools.guard')

  // External ClaudeEngine CLI runs its own native tools (`Read`, shell) in-process without touching ctx.tools.guard.
  const dir = mkdtempSync(join(tmpdir(), 'dsb-bypass-proof-'))
  const envOut = join(dir, 'cli-runs.jsonl')
  t.after(async () => {
    await owned.dispose()
    await ctx.fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
  const adapter = new LocalAgentAdapter({
    rt: { ctx, warn: () => {}, resolveAgent: async () => agent },
    customAgents: () => [],
    findExecutable: path => path,
    spawnEngine: (_kind, route, spec) => new ClaudeEngine(route, {
      ...spec,
      command: process.execPath,
      args: [PROBE_CLI, '--env-out', envOut],
    }, { findExecutable: path => path }),
    record: () => undefined,
    saveRecord: () => {},
    presetFor: () => 'workspace-write',
    cwdFor: async () => dir,
    probeCwd: () => dir,
    toolsFor: () => [],
  })
  t.after(() => adapter.dispose())

  const out = await collect(adapter.stream({
    provider: 'local-claude-code',
    model: 'default',
    sessionId: 's1',
    messages: [userMsg('m1', 'execute external tool')],
    tools: [],
    signal: AbortSignal.timeout(10_000),
  }))
  assert.equal(out.finish.kind, 'stop')
  assert.equal(existsSync(envOut), true, 'standalone external CLI ran without invoking DSH ctx.tools.guard')
})

test('governed host admission fails closed on unbound, expired, stale-generation, foreign-session, and non-current leases before spawn', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-gov-admit-'))
  const envOut = join(dir, 'spawned.jsonl')
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  let mode = 'unbound'
  const ctx = fakeContext({
    services: {
      agents: new Map([['s1', { id: 's1', session: { id: 's1' } }]]),
      anvilBridge: {
        status(agent) {
          if (mode === 'unbound') throw new Error('no current ANVIL observation')
          return { session_ref: `ns1_${agent.id}` }
        },
      },
      anvilAuthority: {
        async admit({ session_ref }) {
          if (mode === 'ok') return validGrant(session_ref, 's1', { lease_generation: 2 })
          if (mode === 'stale-gen') return validGrant(session_ref, 's1', { lease_generation: 1 })
          if (mode === 'expired') return validGrant(session_ref, 's1', { lease_expires_at_ms: Date.now() - 10 })
          if (mode === 'foreign-session') return validGrant('ns1_other', 's1')
          if (mode === 'wrong-agent') return validGrant(session_ref, 'other-agent')
          if (mode === 'revoked') return validGrant(session_ref, 's1', { lease_state: 'revoked' })
          if (mode === 'short-ttl') return validGrant(session_ref, 's1', { lease_generation: 3, lease_expires_at_ms: Date.now() + 180 })
          throw new Error('authority unavailable')
        },
      },
    },
  })
  const rt = { ctx, warn: () => {}, selfOf: () => 'chief', config: {}, state: { works: {} } }
  const egress = createEgressController(rt)
  const adapter = new LocalAgentAdapter({
    rt,
    egress,
    customAgents: () => [],
    findExecutable: path => path,
    spawnEngine: (_kind, route, spec) => new ClaudeEngine(route, {
      ...spec,
      command: process.execPath,
      args: [PROBE_CLI, '--env-out', envOut],
    }, { findExecutable: path => path }),
    record: () => undefined,
    saveRecord: () => {},
    presetFor: () => 'danger-full-access',
    cwdFor: async () => dir,
    probeCwd: () => dir,
    toolsFor: () => [],
  })
  t.after(async () => {
    await adapter.dispose()
    await egress.terminateAll('test end')
  })

  const streamOpts = () => ({
    provider: 'local-claude-code',
    model: 'default',
    sessionId: 's1',
    messages: [userMsg('m1', 'hello')],
    tools: [],
    signal: AbortSignal.timeout(10_000),
  })

  for (const bad of ['unbound', 'expired', 'foreign-session', 'wrong-agent', 'revoked']) {
    mode = bad
    await assert.rejects(() => collect(adapter.stream(streamOpts())), err => err instanceof EgressDeniedError || err.code === 'ANVIL_DENIED')
  }
  assert.equal(existsSync(envOut), false, 'failed admission must block before spawning any child CLI')

  // Valid grant admits and propagates ANVIL_* attribution without leaking owner tokens.
  const prevOwnerToken = process.env.ANVIL_OWNER_TOKEN
  const prevSieveSecret = process.env.SIEVE_API_KEY
  process.env.ANVIL_OWNER_TOKEN = 'owner-secret-must-not-leak'
  process.env.SIEVE_API_KEY = 'sieve-secret-must-not-leak'
  t.after(() => {
    if (prevOwnerToken === undefined) delete process.env.ANVIL_OWNER_TOKEN
    else process.env.ANVIL_OWNER_TOKEN = prevOwnerToken
    if (prevSieveSecret === undefined) delete process.env.SIEVE_API_KEY
    else process.env.SIEVE_API_KEY = prevSieveSecret
  })

  mode = 'ok'
  const okTurn = await collect(adapter.stream(streamOpts()))
  assert.equal(okTurn.finish.kind, 'stop')
  const parsed = JSON.parse(okTurn.text)
  assert.equal(parsed.ANVIL_TASK_ID, 'task-42')
  assert.equal(parsed.ANVIL_AGENT, 'ds-bot-chief')
  assert.equal(parsed.ANVIL_OWNER_TOKEN, null)
  assert.equal(parsed.mode, 'bypassPermissions')

  const recordedEnv = JSON.parse(readFileSync(envOut, 'utf8').trim()).env
  assert.equal(recordedEnv.ANVIL_TASK_ID, 'task-42')
  assert.equal(recordedEnv.ANVIL_RUN_ID, 'run-42')
  assert.equal(recordedEnv.ANVIL_LEASE_REF, 'lease-42')
  assert.equal(recordedEnv.ANVIL_LEASE_GENERATION, '2')
  assert.equal(recordedEnv.ANVIL_AGENT, 'ds-bot-chief')
  for (const secretKey of OWNER_SECRET_EXACT) assert.equal(recordedEnv[secretKey], undefined)
  assert.equal(recordedEnv.SIEVE_API_KEY, undefined)

  // Stale lease generation (< 2 fenced) must fail closed even on an already-warm session.
  mode = 'stale-gen'
  await assert.rejects(() => collect(adapter.stream(streamOpts())), /stale lease generation|ANVIL admission denied/)
})

test('governed process group termination kills CLI and orphaned grandchildren on abort, lease expiry, and disposal', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX PGID test')
  const dir = mkdtempSync(join(tmpdir(), 'dsb-pgid-kill-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  let expireMs = 30_000
  const ctx = fakeContext({
    services: {
      agents: new Map([['s1', { id: 's1', session: { id: 's1' } }]]),
      anvilBridge: { status: agent => ({ session_ref: `ns1_${agent.id}` }) },
      anvilAuthority: { async admit({ session_ref }) { return validGrant(session_ref, 's1', { lease_expires_at_ms: Date.now() + expireMs }) } },
    },
  })
  const rt = { ctx, warn: () => {}, selfOf: () => 'chief', config: {}, state: { works: {} } }
  const egress = createEgressController(rt)

  const makeHeldAdapter = (pidFile, { hold = true } = {}) => new LocalAgentAdapter({
    rt,
    egress,
    customAgents: () => [],
    findExecutable: path => path,
    spawnEngine: (_kind, route, spec) => new ClaudeEngine(route, {
      ...spec,
      command: process.execPath,
      args: [PROBE_CLI, '--spawn-orphan', ...(hold ? ['--hold'] : []), '--pid-out', pidFile],
    }, { findExecutable: path => path }),
    record: () => undefined,
    saveRecord: () => {},
    presetFor: () => 'workspace-write',
    cwdFor: async () => dir,
    probeCwd: () => dir,
    toolsFor: () => [],
  })

  // 1) Explicit abort kills parent + orphan grandchild.
  const pidFile1 = join(dir, 'pids-abort.json')
  const adapter1 = makeHeldAdapter(pidFile1)
  t.after(() => adapter1.dispose())
  const ac1 = new AbortController()
  const turn1 = collect(adapter1.stream({
    provider: 'local-claude-code',
    model: 'default',
    sessionId: 's1',
    messages: [userMsg('m1', 'hang')],
    tools: [],
    signal: ac1.signal,
  }))
  const pids1 = await waitUntil(() => (existsSync(pidFile1) ? JSON.parse(readFileSync(pidFile1, 'utf8')) : null), { message: 'pids1 missing' })
  assert.equal(isPidAlive(pids1.orphanPid), true)
  ac1.abort()
  const res1 = await turn1
  assert.equal(res1.finish.kind, 'aborted')
  await waitUntil(() => !isPidAlive(pids1.parentPid) && !isPidAlive(pids1.orphanPid), { message: 'abort failed to kill PGID orphan' })

  // 2) Lease expiry watchdog terminates PGID automatically when lease_expires_at_ms elapses mid-turn.
  // Warm up the persistent CLI + orphan grandchild under a long lease first so cold process spawn
  // never races the mid-turn expiry timer under heavy parallel suite load.
  const pidFile2 = join(dir, 'pids-expiry.json')
  expireMs = 30_000
  const adapter2 = makeHeldAdapter(pidFile2, { hold: false })
  t.after(() => adapter2.dispose())
  const warm2 = await collect(adapter2.stream({
    provider: 'local-claude-code',
    model: 'default',
    sessionId: 's1',
    messages: [userMsg('m2a', 'warm-up')],
    tools: [],
    signal: AbortSignal.timeout(15_000),
  }))
  assert.equal(warm2.finish.kind, 'stop')
  const pids2 = await waitUntil(() => (existsSync(pidFile2) ? JSON.parse(readFileSync(pidFile2, 'utf8')) : null), { message: 'pids2 missing' })
  assert.equal(isPidAlive(pids2.parentPid), true)
  assert.equal(isPidAlive(pids2.orphanPid), true)
  expireMs = 800
  const turn2 = collect(adapter2.stream({
    provider: 'local-claude-code',
    model: 'default',
    sessionId: 's1',
    messages: [userMsg('m2a', 'warm-up'), userMsg('m2b', 'hold-now')],
    tools: [],
    signal: AbortSignal.timeout(15_000),
  }))
  const turn2Result = turn2.then(value => ({ ok: true, value }), error => ({ ok: false, error }))
  const turn2Outcome = await turn2Result
  assert.equal(turn2Outcome.ok, false)
  assert.equal(turn2Outcome.error?.code, 'ANVIL_DENIED')
  assert.match(turn2Outcome.error?.message ?? '', /ANVIL lease expired/)
  await waitUntil(() => !isPidAlive(pids2.parentPid) && !isPidAlive(pids2.orphanPid), { message: 'lease expiry watchdog failed to kill PGID orphan' })

  // 3) egress.terminateAll (plugin disposal) kills active governed PGIDs cleanly and fails closed.
  const pidFile3 = join(dir, 'pids-dispose.json')
  expireMs = 30_000
  const adapter3 = makeHeldAdapter(pidFile3)
  t.after(() => adapter3.dispose())
  const turn3 = collect(adapter3.stream({
    provider: 'local-claude-code',
    model: 'default',
    sessionId: 's1',
    messages: [userMsg('m3', 'hang until dispose')],
    tools: [],
    signal: AbortSignal.timeout(15_000),
  }))
  const turn3Result = turn3.then(value => ({ ok: true, value }), error => ({ ok: false, error }))
  const pids3 = await waitUntil(() => (existsSync(pidFile3) ? JSON.parse(readFileSync(pidFile3, 'utf8')) : null), { message: 'pids3 missing' })
  await egress.terminateAll('plugin disposed')
  const turn3Outcome = await turn3Result
  assert.equal(turn3Outcome.ok, false)
  assert.equal(turn3Outcome.error?.code, 'ANVIL_DENIED')
  assert.match(turn3Outcome.error?.message ?? '', /plugin disposed/)
  await waitUntil(() => !isPidAlive(pids3.parentPid) && !isPidAlive(pids3.orphanPid), { message: 'dispose failed to kill PGID orphan' })
})

test('bounded recursion depth, concurrency limit, retry budget, and LoopbackMcp expiry admission', async (t) => {
  // Depth & loop detection.
  assert.throws(() => workDepthOf({ a: { parent: 'b' }, b: { parent: 'a' } }, ['a']), err => err.code === 'DEPTH_EXCEEDED')
  const chain = {}
  for (let i = 0; i < 10; i += 1) chain[`w${i}`] = i === 0 ? {} : { parent: `w${i - 1}` }
  assert.equal(workDepthOf(chain, ['w8']), 8)

  const ctx = fakeContext({
    services: {
      agents: new Map([
        ['s1', { id: 's1', session: { id: 's1' } }],
        ['s2', { id: 's2', session: { id: 's2' } }],
      ]),
      anvilBridge: { status: agent => ({ session_ref: `ns1_${agent.id}` }) },
      anvilAuthority: { async admit({ session_ref }) { return validGrant(session_ref, session_ref.slice(4)) } },
    },
  })
  const rt = {
    ctx,
    warn: () => {},
    selfOf: id => id,
    config: {},
    egressLimits: { maxDepth: 2, maxConcurrentChildren: 1, maxRetries: 2 },
    state: { works: chain },
  }
  const egress = createEgressController(rt)
  assert.throws(() => egress.assertDepth(['w2']), err => err.code === 'DEPTH_EXCEEDED')

  // Max concurrency slot enforcement.
  const release1 = egress.acquireChildSlot('s1')
  assert.throws(() => egress.acquireChildSlot('s2'), err => err.code === 'CONCURRENCY_LIMIT')
  release1()
  const release2 = egress.acquireChildSlot('s2')
  release2()

  // Retry budget cap and reset.
  assert.equal(egress.checkRetryBudget('k1'), 1)
  assert.equal(egress.checkRetryBudget('k1'), 2)
  assert.throws(() => egress.checkRetryBudget('k1'), err => err.code === 'RETRY_LIMIT')
  egress.resetRetryBudget('k1')
  assert.equal(egress.checkRetryBudget('k1'), 1)

  // LoopbackMcp per-call admission check enforces fresh lease even on open loopback HTTP server.
  let denyMcp = true
  const mcp = new LoopbackMcp(
    [{ name: 'message_bot', description: 'Send', parameters: { type: 'object', properties: {} } }],
    async () => {
      if (denyMcp) throw new EgressDeniedError('ANVIL admission denied: lease expired')
      return { text: 'ok', isError: false }
    },
  )
  await mcp.listen()
  t.after(() => mcp.close())
  const res = await fetch(mcp.url, {
    method: 'POST',
    headers: { authorization: `Bearer ${mcp.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'message_bot', arguments: {} } }),
  })
  const text = await res.text()
  assert.match(text, /ANVIL admission denied/)
})

test('team delegation tools (message_bot DM + room, create_bot, post_to_group), capabilities, and fabric tools enforce governed admission and standalone fallback', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-tools-gov-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  let allowAdmit = false
  const agentsMap = new Map([
    ['chief', { id: 'chief', session: { id: 'chief' } }],
    ['worker', { id: 'worker', session: { id: 'worker' } }],
  ])
  const ctx = fakeContext({
    services: {
      agents: agentsMap,
      anvilBridge: { status: agent => ({ session_ref: `ns1_${agent.id}` }) },
      anvilAuthority: {
        async admit({ session_ref }) {
          if (!allowAdmit) throw new Error('lease revoked')
          return validGrant(session_ref, session_ref.slice(4))
        },
      },
    },
  })
  const state = {
    version: 1,
    prefs: {},
    mainBotIds: ['chief'],
    bots: {
      chief: { id: 'chief', sessionId: 'chief', name: 'Chief', capabilities: [], createdAt: 1 },
      worker: { id: 'worker', sessionId: 'worker', name: 'Worker', capabilities: [], createdAt: 2 },
    },
    rooms: {
      r1: { id: 'r1', name: 'Room 1', members: ['chief', 'worker'], sessions: { chief: 'rc', worker: 'rw' }, admin: 'chief', mode: 'everyone' },
    },
    works: {},
    capabilities: { items: {} },
  }
  let delivered = 0
  let roomPosted = 0
  let createdBots = 0
  const rt = {
    ctx,
    home: dir,
    state,
    teamTools: [],
    config: { fabric: { enabled: true, statusCommand: ['/bin/echo', 'ok'], findingsCommand: ['/bin/echo', 'ok'], logCommand: ['/bin/echo', 'ok'], decisionCommand: ['/bin/echo', 'ok'] } },
    load: async () => state,
    save: async () => {},
    loadSecrets: async () => {},
    canUseSecret: () => true,
    secretValue: () => undefined,
    redactSecrets: text => text,
    readOnly: () => undefined,
    warn: () => {},
    isMain: id => id === 'chief',
    botOf: id => state.bots[id],
    findBot: ref => Object.values(state.bots).find(b => b.id === ref || b.name === ref),
    roomOf: id => state.rooms[id],
    findRooms: ref => Object.values(state.rooms).filter(r => r.id === ref || r.name === ref),
    isAdminOf: (r, id) => r?.admin === id,
    isBotSession: id => Boolean(state.bots[id]),
    selfOf: id => (id === 'chief' || id === 'rc' ? 'chief' : id === 'worker' || id === 'rw' ? 'worker' : undefined),
    chatOf: id => id,
    groupSessionsOf: () => [],
    resolveAgent: async id => agentsMap.get(id),
    groupOwners: new Map([['rc', { roomId: 'r1', botId: 'chief' }]]),
    live: new Map(),
    statusOf: () => 'idle',
    requestIdentity: () => undefined,
    upstreamOf: () => new Set(),
    sameWork: () => false,
    attachLong: async text => ({ text, files: [] }),
    workOf: () => undefined,
    ownsWork: () => false,
    openWork: () => {},
    dropWork: () => {},
    approveFolder: async () => {},
    cleanWorkDir: async v => v,
    deliver: async () => { delivered += 1 },
    postToRoom: async () => { roomPosted += 1 },
    createBot: async () => { createdBots += 1; return { bot: { id: 'b3', name: 'NewBot', role: 'Helper', model: 'm' }, welcomeFailed: false } },
    rosterLimit: () => undefined,
    defaultRef: () => 'm',
    catalog: async () => [],
    isValidModelRef: async () => true,
    resolveRoom: () => undefined,
    isLocalAgentRef: () => false,
    supportsImages: async () => false,
  }
  rt.egress = createEgressController(rt)
  installTools(rt)
  installCapabilities(rt)
  installFabric(rt)

  const tool = name => rt.teamTools.find(t => t.name === name)
  const chiefExec = { agent: agentsMap.get('chief'), name: 'exec' }

  // 1) Denied when governed authority rejects.
  await assert.rejects(() => tool('message_bot').execute({ to: 'Worker', message: 'hi' }, chiefExec), /ANVIL admission denied|lease revoked/)
  await assert.rejects(() => tool('create_bot').execute({ name: 'B3', role: 'R', instructions: 'Assist carefully.' }, chiefExec), /ANVIL admission denied|lease revoked/)
  await assert.rejects(() => tool('post_to_group').execute({ group: 'Room 1', message: 'hi' }, chiefExec), /ANVIL admission denied|lease revoked/)
  await assert.rejects(() => tool('fabric_status').execute({}, chiefExec), /ANVIL admission denied|lease revoked/)
  await assert.rejects(() => tool('anvil_findings').execute({ query: 'test' }, chiefExec), /ANVIL admission denied|lease revoked/)
  await assert.rejects(() => tool('anvil_log').execute({}, chiefExec), /ANVIL admission denied|lease revoked/)
  await assert.rejects(() => tool('anvil_decision').execute({ text: 'A valid decision statement.' }, chiefExec), /ANVIL admission denied|lease revoked/)
  assert.equal(delivered + roomPosted + createdBots, 0)

  // Message_bot in a room context (`rc` -> `r1`) must STILL enforce admission before early return.
  agentsMap.set('rc', { id: 'rc', session: { id: 'rc' } })
  await assert.rejects(() => tool('message_bot').execute({ to: 'Worker', message: 'hi in room' }, { agent: agentsMap.get('rc') }), /ANVIL admission denied|lease revoked/)

  // Capability stdio mount also fails closed while admission fails.
  await rt.capabilitySave({ name: 'echo', kind: 'mcp', description: '', transport: 'stdio', command: process.execPath, args: [ECHO_ENV], env: {} }, { botId: 'chief' })
  await rt.capabilityEndpoint('capability-approve', { name: 'echo' })
  await rt.changeCapabilityAttachment('attach', { name: 'echo' }, 'chief')
  ctx.emit('agent/created', { agent: { ...agentsMap.get('chief'), ctx: fakeContext() } })
  await rt.scheduleCapabilitiesReconcile()
  assert.equal(rt.capabilityStatusesView().chief.echo.state, 'error')
  assert.match(rt.capabilityStatusesView().chief.echo.error, /lease revoked|ANVIL/)

  // 2) Allowed once authority grants current lease.
  allowAdmit = true
  await tool('message_bot').execute({ to: 'Worker', message: 'hi' }, chiefExec)
  await tool('post_to_group').execute({ group: 'Room 1', message: 'hi' }, chiefExec)
  await tool('create_bot').execute({ name: 'B3', role: 'R', instructions: 'Assist carefully.' }, chiefExec)
  assert.deepEqual([delivered, roomPosted, createdBots], [1, 1, 1])

  // 3) Standalone mode (bridge & authority absent) allows normal DS Bot operation seamlessly.
  delete ctx.get('anvilBridge') // fakeContext reads services map via closure; test via clean rt without bridge/authority.
  const standaloneRt = { ...rt, ctx: fakeContext(), egress: undefined }
  standaloneRt.egress = createEgressController(standaloneRt)
  assert.equal(standaloneRt.egress.isGoverned(), false)
  const standaloneAdmit = await standaloneRt.egress.admit({ sessionId: 'chief', purpose: 'team-delegation' })
  assert.equal(standaloneAdmit.governed, false)
})

test('permission presets preserve exact workspace-write, danger-full-access, bypassPermissions, and never mappings, and shell.js introduces zero egress', async (t) => {
  // Permission mappings never silently alter configured choices.
  assert.equal(cliMode('claude', 'workspace-write'), 'acceptEdits')
  assert.equal(cliMode('claude', 'danger-full-access'), 'bypassPermissions')
  assert.equal(cliMode('codex', 'workspace-write'), 'workspace-write')
  assert.equal(cliMode('codex', 'danger-full-access'), 'danger-full-access')

  const dir = mkdtempSync(join(tmpdir(), 'dsb-perms-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const makeCodexAdapter = preset => new LocalAgentAdapter({
    rt: { warn: () => {} },
    customAgents: () => [],
    findExecutable: path => path,
    spawnEngine: (_kind, route, spec) => new CodexEngine(route, { ...spec, command: process.execPath, args: [FAKE_CODEX] }, { findExecutable: path => path }),
    record: () => undefined,
    saveRecord: () => {},
    presetFor: () => preset,
    cwdFor: async () => dir,
    probeCwd: () => dir,
    toolsFor: () => [],
  })

  const wsAdapter = makeCodexAdapter('workspace-write')
  t.after(() => wsAdapter.dispose())
  const wsOut = await collect(wsAdapter.stream({ provider: 'local-codex-cli', model: 'default', sessionId: 'w1', messages: [userMsg('m1', 'show-thread')], tools: [], signal: AbortSignal.timeout(10_000) }))
  const wsParams = JSON.parse(wsOut.text)
  assert.deepEqual([wsParams.sandbox, wsParams.approvalPolicy], ['workspace-write', 'on-request'])

  const chiefAdapter = makeCodexAdapter('danger-full-access')
  t.after(() => chiefAdapter.dispose())
  const chiefOut = await collect(chiefAdapter.stream({ provider: 'local-codex-cli', model: 'default', sessionId: 'c1', messages: [userMsg('m1', 'show-thread')], tools: [], signal: AbortSignal.timeout(10_000) }))
  const chiefParams = JSON.parse(chiefOut.text)
  assert.deepEqual([chiefParams.sandbox, chiefParams.approvalPolicy], ['danger-full-access', 'never'])

  // Secret scrubbing drops ambient owner/anvil/sieve tokens from child environments.
  const scrubbed = scrubOwnerTokens({ ANVIL_OWNER_TOKEN: 'bad', ANVIL_TASK_ID: 'task-1', SAFE_VAR: 'keep' })
  assert.deepEqual(scrubbed, { ANVIL_TASK_ID: 'task-1', SAFE_VAR: 'keep' })
  const childEnv = cleanEnv({ ANVIL_TASK_ID: 'task-1' })
  assert.equal(childEnv.ANVIL_TASK_ID, 'task-1')
  assert.equal(ATTRIBUTION_KEYS.includes('ANVIL_LEASE_GENERATION'), true)
  validateLeaseGrant(validGrant('ns1_s1', 's1'))

  // ds-bot/shell.js registers only static webServer routes + index tap (zero child processes, zero outbound network).
  const registeredRoutes = []
  let indexTapped = false
  applyShell({
    webServer: {
      tapIndex: () => { indexTapped = true; return () => {} },
      register: route => { registeredRoutes.push(route.path); return () => {} },
    },
    effect: fn => fn(),
  })
  assert.equal(indexTapped, true)
  assert.deepEqual(registeredRoutes, SHELL_ROUTES.map(r => r.path))
})

test('suspended tool-calls turn denial tears down CLI PGID, LoopbackMcp server, concurrency slot, and live session', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-suspend-revoke-'))
  const pidFile = join(dir, 'pids.json')
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  let allowResume = true
  const ctx = fakeContext({
    services: {
      agents: new Map([['s1', { id: 's1', session: { id: 's1' } }]]),
      anvilBridge: { status: agent => ({ session_ref: `ns1_${agent.id}` }) },
      anvilAuthority: {
        async admit({ session_ref }) {
          return allowResume ? validGrant(session_ref, 's1') : validGrant(session_ref, 's1', { lease_state: 'revoked' })
        },
      },
    },
  })
  const rt = { ctx, warn: () => {}, selfOf: () => 'chief', config: {}, state: { works: {} } }
  const egress = createEgressController(rt)

  const adapter = new LocalAgentAdapter({
    rt,
    egress,
    customAgents: () => [{ id: 'probe', name: 'Probe ACP', command: process.execPath, args: [PROBE_CLI, '--spawn-orphan', '--pid-out', pidFile] }],
    findExecutable: path => path,
    spawnEngine: (_kind, route, spec) => new AcpEngine(route, spec, { findExecutable: path => path }),
    record: () => undefined,
    saveRecord: () => {},
    presetFor: () => 'workspace-write',
    cwdFor: async () => dir,
    probeCwd: () => dir,
    toolsFor: () => [{ name: 'list_bots', description: 'List bots', parameters: {} }],
  })
  t.after(() => adapter.dispose())

  const turn1 = await collect(adapter.stream({
    provider: 'local-acp-probe',
    model: 'default',
    sessionId: 's1',
    messages: [userMsg('m1', 'call-tool')],
    tools: [{ name: 'list_bots', description: 'List bots', parameters: {} }],
    signal: AbortSignal.timeout(10_000),
  }))
  assert.equal(turn1.finish?.kind, 'tool-calls')
  assert.equal(turn1.calls.length, 1)

  const pids = await waitUntil(() => (existsSync(pidFile) ? JSON.parse(readFileSync(pidFile, 'utf8')) : null), { message: 'suspended pids missing' })
  assert.equal(isPidAlive(pids.parentPid), true)
  assert.equal(isPidAlive(pids.orphanPid), true)
  assert.equal(adapter.live.size, 1)
  assert.equal(egress.activeChildCount(), 1)
  const mcpServer = adapter.live.get('s1')?.mcp?.server
  assert.equal(mcpServer?.listening, true)

  // Revoke lease before resuming the suspended tool-call turn: must fail closed and tear down everything.
  allowResume = false
  await assert.rejects(
    () => collect(adapter.stream({
      provider: 'local-acp-probe',
      model: 'default',
      sessionId: 's1',
      messages: [
        userMsg('m1', 'call-tool'),
        { id: 'a1', role: 'assistant', content: [{ type: 'tool-call', id: turn1.calls[0].id, name: 'list_bots', input: {} }] },
        { id: 't1', role: 'tool', toolCallId: turn1.calls[0].id, content: [{ type: 'text', text: '[]' }], isError: false },
      ],
      tools: [{ name: 'list_bots', description: 'List bots', parameters: {} }],
      signal: AbortSignal.timeout(10_000),
    })),
    err => err?.code === 'ANVIL_DENIED',
  )

  assert.equal(adapter.live.size, 0, 'suspended live session must be deleted on resume denial')
  assert.equal(egress.activeChildCount(), 0, 'concurrency slot must be released on resume denial')
  assert.equal(mcpServer?.listening, false, 'LoopbackMcp server must be closed on resume denial')
  await waitUntil(() => !isPidAlive(pids.parentPid), { message: 'suspended CLI parent survived resume denial' })
  if (process.platform !== 'win32') {
    await waitUntil(() => !isPidAlive(pids.orphanPid), { message: 'suspended CLI PGID survived resume denial' })
  } else {
    try { process.kill(pids.orphanPid, 'SIGKILL') } catch { /* already gone */ }
  }
})

test('governed fabric tools fail closed without exec.agent and fabric_status propagates canonical ANVIL_* env into probe subprocesses', async () => {
  const chiefAgent = { id: 'chief', session: { id: 'chief' } }
  const ctx = fakeContext({
    services: {
      agents: new Map([['chief', chiefAgent]]),
      anvilBridge: { status: agent => ({ session_ref: `ns1_${agent.id}` }) },
      anvilAuthority: { async admit({ session_ref }) { return validGrant(session_ref, 'chief') } },
    },
  })
  const rt = {
    ctx,
    warn: () => {},
    selfOf: id => (id === 'chief' ? 'chief' : undefined),
    isMain: id => id === 'chief',
    botOf: id => ({ id, name: 'Chief' }),
    load: async () => {},
    teamTools: [],
    config: {
      fabric: {
        enabled: true,
        peers: [],
        sieveMetrics: null,
        sieveStats: [],
        osCommand: ['probe-os'],
        hubCommand: ['probe-hub'],
        findingsCommand: ['probe-find'],
        logCommand: ['probe-log'],
        decisionCommand: ['probe-dec'],
        cacheMs: 0,
      },
    },
    state: { works: {} },
  }
  rt.egress = createEgressController(rt)
  installFabric(rt)

  const execCalls = []
  rt.fabric.deps.os = {
    hostname: () => 'dell',
    platform: () => 'linux',
    arch: () => 'x64',
    uptime: () => 120,
    loadavg: () => [0.1, 0.1, 0.1],
    cpus: () => [{}, {}],
    totalmem: () => 8 * 1024 ** 3,
    freemem: () => 4 * 1024 ** 3,
    homedir: () => '/home/anvil',
  }
  rt.fabric.deps.exec = async (file, args, options) => {
    execCalls.push({ file, args, env: options.env })
    if (file === 'probe-hub') return { stdout: JSON.stringify({ ok: true, data: { metrics: [] } }), stderr: '' }
    if (file === 'probe-os') return { stdout: JSON.stringify({ schema: 'anvil.os.snapshot.v1', services: [], disks: [], load: '0.1' }), stderr: '' }
    return { stdout: '', stderr: '' }
  }

  const toolByName = Object.fromEntries(rt.teamTools.map(tool => [tool.name, tool]))

  // Governed calls missing exec.agent must fail closed without invoking any child command.
  await assert.rejects(() => toolByName.fabric_status.execute({}, {}), err => err?.code === 'ANVIL_DENIED')
  await assert.rejects(() => toolByName.fabric_status.execute({}, undefined), err => err?.code === 'ANVIL_DENIED')
  await assert.rejects(() => toolByName.anvil_findings.execute({ query: 'x' }, {}), err => err?.code === 'ANVIL_DENIED')
  await assert.rejects(() => toolByName.anvil_log.execute({ count: 5 }, {}), err => err?.code === 'ANVIL_DENIED')
  await assert.rejects(() => toolByName.anvil_decision.execute({ text: 'A valid decision statement.' }, {}), err => err?.code === 'ANVIL_DENIED')
  assert.equal(execCalls.length, 0)

  // Authorized fabric_status passes canonical ANVIL_* attribution env to spawned probes.
  const rendered = await toolByName.fabric_status.execute({}, { agent: chiefAgent })
  assert.match(rendered, /^ANVIL fabric at /)
  const hubCall = execCalls.find(c => c.file === 'probe-hub')
  const osCall = execCalls.find(c => c.file === 'probe-os')
  assert.ok(hubCall && osCall, 'expected hub and os probe executions')
  for (const call of [hubCall, osCall]) {
    assert.equal(call.env.ANVIL_TASK_ID, 'task-42')
    assert.equal(call.env.ANVIL_RUN_ID, 'run-42')
    assert.equal(call.env.ANVIL_LEASE_REF, 'lease-42')
    assert.equal(call.env.ANVIL_LEASE_GENERATION, '1')
    assert.equal(call.env.ANVIL_AGENT, 'ds-bot-chief')
  }
})

test('authority-only mode rejects foreign ns1_ grants and AcpEngine/CodexEngine preserve attribution env across child respawn', async (t) => {
  // 1) Authority-only (no bridge, no agent.session_ref) rejects foreign ns1_FOREIGN_SESSION grants even without native_id/agent_id.
  let grantedRef = 'ns1_FOREIGN_SESSION'
  const ctx = fakeContext({
    services: {
      agents: new Map([['s1', { id: 's1', session: { id: 's1' } }]]),
      anvilAuthority: {
        async admit() {
          const g = validGrant(grantedRef, 's1')
          delete g.native_id
          delete g.agent_id
          delete g.native_fingerprint
          return g
        },
      },
    },
  })
  const egress = createEgressController({ ctx, selfOf: () => 'chief', config: {}, state: { works: {} } })
  await assert.rejects(() => egress.admit({ sessionId: 's1', purpose: 'local-agent-turn' }), /foreign or mismatched session fingerprint/)
  grantedRef = 's1'
  const okAdmit = await egress.admit({ sessionId: 's1', purpose: 'local-agent-turn' })
  assert.equal(okAdmit.sessionRef, 's1')

  // 2) AcpEngine and CodexEngine preserve attribution env and scrub owner secrets when child exits and respawns before prompt().
  const dir = mkdtempSync(join(tmpdir(), 'dsb-respawn-env-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const acpLog = join(dir, 'acp-env.jsonl')
  const acpEngine = new AcpEngine('local-acp-probe', { name: 'Probe ACP', kind: 'acp', command: process.execPath, args: [PROBE_CLI, '--env-out', acpLog] }, { findExecutable: path => path })
  t.after(() => acpEngine.close({ force: true }))
  const acpEnv = { ANVIL_TASK_ID: 'task-acp', ANVIL_RUN_ID: 'run-acp', ANVIL_LEASE_REF: 'lease-acp', ANVIL_LEASE_GENERATION: '7', ANVIL_AGENT: 'dsh:chief', ANVIL_OWNER_TOKEN: 'leaked-owner' }
  const acpSession = await acpEngine.open('s1', { cwd: dir, env: acpEnv })
  acpEngine.child.kill('SIGKILL')
  await waitUntil(() => acpEngine.child === undefined, { message: 'acp child did not exit' })
  await acpEngine.prompt(acpSession, [{ type: 'text', text: 'after crash' }], { signal: AbortSignal.timeout(5_000) })
  const acpSpawns = readFileSync(acpLog, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.equal(acpSpawns.length, 2)
  assert.notEqual(acpSpawns[0].pid, acpSpawns[1].pid)
  assert.equal(acpSpawns[1].env.ANVIL_TASK_ID, 'task-acp')
  assert.equal(acpSpawns[1].env.ANVIL_AGENT, 'dsh:chief')
  assert.equal(acpSpawns[1].env.ANVIL_OWNER_TOKEN, undefined)

  const codexLog = join(dir, 'codex-env.jsonl')
  const codexEngine = new CodexEngine('local-codex-cli', { name: 'Probe Codex', kind: 'codex', command: process.execPath, args: [PROBE_CLI, '--codex', '--env-out', codexLog] }, { findExecutable: path => path })
  t.after(() => codexEngine.close({ force: true }))
  const codexEnv = { ANVIL_TASK_ID: 'task-codex', ANVIL_RUN_ID: 'run-codex', ANVIL_LEASE_REF: 'lease-codex', ANVIL_LEASE_GENERATION: '9', ANVIL_AGENT: 'dsh:chief', ANVIL_OWNER_TOKEN: 'leaked-owner' }
  const codexThread = await codexEngine.open('s1', { cwd: dir, env: codexEnv })
  codexEngine.child.kill('SIGKILL')
  await waitUntil(() => codexEngine.child === undefined, { message: 'codex child did not exit' })
  await codexEngine.prompt(codexThread, [{ type: 'text', text: 'after crash' }], { signal: AbortSignal.timeout(5_000) })
  const codexSpawns = readFileSync(codexLog, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.equal(codexSpawns.length, 2)
  assert.notEqual(codexSpawns[0].pid, codexSpawns[1].pid)
  assert.equal(codexSpawns[1].env.ANVIL_TASK_ID, 'task-codex')
  assert.equal(codexSpawns[1].env.ANVIL_AGENT, 'dsh:chief')
  assert.equal(codexSpawns[1].env.ANVIL_OWNER_TOKEN, undefined)
})

test('host pre-step blocked turn/end and agent/disposed tear down suspended tool-calls CLI PGID, LoopbackMcp, and slot without calling stream()', async (t) => {
  const { install: installLocalAgents } = await import('../src/host/local-agents/index.js')
  const dir = mkdtempSync(join(tmpdir(), 'dsb-prestep-blocked-'))
  const pidFile = join(dir, 'pids.json')
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  let registeredAdapter
  const ctx = fakeContext({
    services: {
      agents: new Map([['s-prestep', { id: 's-prestep', session: { id: 's-prestep', header: { cwd: dir } } }]]),
      anvilBridge: { status: agent => ({ session_ref: `ns1_${agent.id}` }) },
      anvilAuthority: { async admit({ session_ref }) { return validGrant(session_ref, 's-prestep') } },
    },
  })
  ctx.llm = {
    registerAdapter(_routes, adapter) {
      registeredAdapter = adapter
      return Object.assign(() => {}, { replace: () => {} })
    },
  }
  ctx.agents = ctx.get('agents')
  const rt = {
    ctx,
    warn: () => {},
    save: async () => {},
    load: async () => {},
    selfOf: id => id,
    botOf: id => ({ id, name: 'AcpBot', permission: 'workspace-write' }),
    roomOf: () => undefined,
    groupOwners: new Map(),
    resolveAgent: async id => ctx.agents.get(id),
    teamFolder: () => dir,
    teamTools: [{ name: 'list_bots' }],
    config: {},
    state: {
      bots: { 's-prestep': { id: 's-prestep', name: 'AcpBot', model: 'local-acp-probe/default', permission: 'workspace-write' } },
      works: {},
      localAgents: {
        custom: [{ id: 'probe', name: 'Probe ACP', command: process.execPath, args: [PROBE_CLI, '--spawn-orphan', '--pid-out', pidFile] }],
        sessions: {},
      },
    },
  }
  rt.egress = createEgressController(rt)
  installLocalAgents(rt)
  assert.ok(registeredAdapter, 'expected local-agents adapter to register')
  t.after(() => registeredAdapter.dispose())

  const turn1 = await collect(registeredAdapter.stream({
    provider: 'local-acp-probe',
    model: 'default',
    sessionId: 's-prestep',
    messages: [userMsg('m1', 'call-tool')],
    tools: [{ name: 'list_bots', description: 'List bots', parameters: {} }],
    signal: AbortSignal.timeout(10_000),
  }))
  assert.equal(turn1.finish?.kind, 'tool-calls')

  const pids = await waitUntil(() => (existsSync(pidFile) ? JSON.parse(readFileSync(pidFile, 'utf8')) : null), { message: 'prestep pids missing' })
  assert.equal(isPidAlive(pids.parentPid), true)
  assert.equal(isPidAlive(pids.orphanPid), true)
  const mcpServer = registeredAdapter.live.get('s-prestep')?.mcp?.server
  assert.equal(mcpServer?.listening, true)
  assert.equal(rt.egress.activeChildCount(), 1)

  // Simulate dsh-anvil-bridge rejecting Step 2 at agent/pre-step -> dsh-agent-loop emits turn/end { reason: { kind: 'blocked' } } without calling stream().
  for (const fn of ctx.listeners.get('session/event') ?? []) {
    fn({ id: 's-prestep' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'blocked' } } })
  }

  await waitUntil(() => registeredAdapter.live.size === 0, { message: 'suspended live session survived blocked turn/end' })
  assert.equal(rt.egress.activeChildCount(), 0, 'concurrency slot survived blocked turn/end')
  assert.equal(mcpServer?.listening, false, 'LoopbackMcp survived blocked turn/end')
  await waitUntil(() => !isPidAlive(pids.parentPid), { message: 'CLI parent survived blocked turn/end' })
  if (process.platform !== 'win32') {
    await waitUntil(() => !isPidAlive(pids.orphanPid), { message: 'CLI PGID survived blocked turn/end' })
  } else {
    try { process.kill(pids.orphanPid, 'SIGKILL') } catch { /* already gone */ }
  }
})
