import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import * as mcpClientPlugin from '@deepseek-ai/dsh-mcp-client'
import McpResourceRuntime from '@deepseek-ai/dsh-mcp-resources'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { install as installCapabilities, classifyCapabilityError } from '../src/host/capabilities.js'

const BRIDGE = fileURLToPath(new URL('./fixtures/unix-mcp-bridge.mjs', import.meta.url))

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitUntil(fn, { timeoutMs = 6_000, intervalMs = 20, message = 'condition timed out' } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await fn()
    if (last) return last
    await sleep(intervalMs)
  }
  throw new Error(`${message} (last=${JSON.stringify(last)})`)
}

function readPidLog(pidLogPath) {
  if (!existsSync(pidLogPath)) return { totalStarts: 0, maxConcurrent: 0, livePids: [] }
  const lines = readFileSync(pidLogPath, 'utf8').trim().split('\n').filter(Boolean)
  const live = new Set()
  let totalStarts = 0
  let maxConcurrent = 0
  for (const line of lines) {
    try {
      const entry = JSON.parse(line)
      if (entry.event === 'start') {
        totalStarts += 1
        live.add(entry.pid)
        if (live.size > maxConcurrent) maxConcurrent = live.size
      } else if (entry.event === 'exit') {
        live.delete(entry.pid)
      }
    } catch { /* partial flush */ }
  }
  return { totalStarts, maxConcurrent, livePids: [...live] }
}

function createMockUnixMcpServer(sockPath, initialTools) {
  let tools = initialTools
  let server = null
  const sockets = new Set()
  const handleMessage = (socket, msg) => {
    if (msg.id === undefined) return
    let result
    if (msg.method === 'initialize') {
      result = {
        protocolVersion: msg.params?.protocolVersion ?? '2025-03-26',
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'mock-cua-daemon', version: '1.0.0' },
      }
    } else if (msg.method === 'ping') {
      result = {}
    } else if (msg.method === 'tools/list') {
      result = {
        tools: tools.map(name => ({
          name,
          description: `Mock tool ${name}`,
          inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
        })),
      }
    } else if (msg.method === 'resources/list') {
      result = { resources: [] }
    } else if (msg.method === 'tools/call') {
      result = { content: [{ type: 'text', text: `ran:${msg.params?.name}` }] }
    } else {
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } })}\n`)
      return
    }
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`)
  }
  return {
    setTools(nextTools) { tools = nextTools },
    async start() {
      if (server) return
      if (process.platform !== 'win32') {
        try { unlinkSync(sockPath) } catch { /* not present */ }
      }
      server = createServer((socket) => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
        let buf = ''
        socket.setEncoding('utf8')
        socket.on('data', (chunk) => {
          buf += chunk
          let at
          while ((at = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, at).trim()
            buf = buf.slice(at + 1)
            if (!line) continue
            try { handleMessage(socket, JSON.parse(line)) } catch { /* ignore malformed */ }
          }
        })
      })
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(sockPath, resolve)
      })
    },
    async stop() {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      if (server) {
        const s = server
        server = null
        await new Promise(resolve => s.close(() => resolve()))
      }
      if (process.platform !== 'win32') {
        try { unlinkSync(sockPath) } catch { /* gone */ }
      }
    },
  }
}

let pipeSeq = 0
async function createRealHarness({ retryPolicy, healthProbeMs } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-cua-rec-'))
  pipeSeq += 1
  const sockPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\dsb-cua-rec-${process.pid}-${Date.now()}-${pipeSeq}`
    : join(dir, 'cua-driver.sock')
  const pidLogPath = join(dir, 'bridge-pids.jsonl')
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(McpResourceRuntime)
  ctx.provide('loader', {
    import: async (id) => {
      if (id === '@deepseek-ai/dsh-mcp-client') return mcpClientPlugin
      throw new Error(`Unexpected loader import: ${id}`)
    },
    unwrapExports: exports => exports?.default ?? exports,
  })
  // Silence expected logger warnings during intentional outage assertions.
  ctx.logger.levels = { default: 0 }

  const state = {
    version: 1,
    mainBotIds: ['chief'],
    bots: {
      chief: { id: 'chief', sessionId: 'chief', name: 'Chief', capabilities: [], createdAt: 1 },
    },
    rooms: {},
    agents: {},
    capabilities: { items: {} },
    exchanges: [],
    exchangeTurns: {},
    works: {},
    questions: {},
    prefs: {},
    revision: 1,
  }
  const agents = new Map()
  const warnings = []
  const rt = {
    ctx,
    home: dir,
    state,
    teamTools: [],
    config: {},
    capabilityRetryPolicy: retryPolicy ?? { initialDelayMs: 60, maxDelayMs: 240, maxAttempts: 20, jitterRatio: 0 },
    capabilityHealthProbeMs: healthProbeMs ?? 0,
    load: async () => state,
    save: async () => { writeFileSync(join(dir, 'state.json'), JSON.stringify(state)) },
    loadSecrets: async () => {},
    canUseSecret: () => true,
    secretValue: () => undefined,
    redactSecrets: text => text,
    readOnly: () => undefined,
    isMain: id => id === 'chief',
    botOf: id => state.bots[id],
    findBot: ref => Object.values(state.bots).find(bot => bot.id === ref || bot.name === ref),
    isBotSession: id => id === 'chief',
    selfOf: id => (id === 'chief' ? 'chief' : undefined),
    chatOf: id => id,
    groupSessionsOf: () => [],
    resolveAgent: async id => agents.get(id),
    warn: (...args) => warnings.push(args.map(String).join(' ')),
  }
  const capPlugin = { name: 'ds-bot-caps', apply(capCtx) { rt.ctx = capCtx; installCapabilities(rt) } }
  const capFiber = ctx.plugin(capPlugin)
  await capFiber.await()

  const mountAgent = (sessionId = 'chief') => {
    const agent = { id: sessionId, session: { id: sessionId } }
    const owned = createScope(ctx, agent)
    agent.ctx = owned.ctx
    agents.set(sessionId, agent)
    ctx.emit('agent/created', { agent, source: 'startup' })
    return {
      agent,
      dispose: () => {
        agents.delete(sessionId)
        return owned.dispose()
      },
    }
  }

  const toolNames = agent => ctx.tools.schemas(agent).map(def => def.name).filter(name => name.startsWith('mcp__cua__')).sort()

  return {
    dir,
    sockPath,
    pidLogPath,
    ctx,
    capFiber,
    rt,
    warnings,
    mountAgent,
    toolNames,
    async dispose() {
      for (const agent of agents.values()) await Promise.resolve(agent.ctx?.fiber?.dispose?.()).catch(() => {})
      agents.clear()
      await Promise.resolve(capFiber.dispose()).catch(() => {})
      await Promise.resolve(ctx.fiber.dispose()).catch(() => {})
      await sleep(50)
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    },
  }
}

test('classifyCapabilityError separates transient socket/connect failures from permanent errors', () => {
  assert.deepEqual(
    classifyCapabilityError(new Error('connect /home/user/.cache/cua-driver/cua-driver.sock ENOENT'), { command: 'cua-driver-anvil-serve' }),
    { permanent: false, kind: 'transient' },
  )
  assert.deepEqual(
    classifyCapabilityError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }), { command: 'node' }),
    { permanent: false, kind: 'transient' },
  )
  assert.deepEqual(
    classifyCapabilityError(new Error('cua: connection lost and reconnect is disabled')),
    { permanent: false, kind: 'transient' },
  )
  assert.deepEqual(
    classifyCapabilityError(Object.assign(new Error('spawn /no/such/mcp-bin ENOENT'), { code: 'ENOENT', syscall: 'spawn /no/such/mcp-bin' }), { command: '/no/such/mcp-bin' }),
    { permanent: true, kind: 'missing-binary' },
  )
  assert.deepEqual(
    classifyCapabilityError(new Error('HTTP 401 Unauthorized: invalid token')),
    { permanent: true, kind: 'auth' },
  )
  assert.deepEqual(
    classifyCapabilityError(new Error('JSON-RPC -32601 Method not found: Unsupported protocol')),
    { permanent: true, kind: 'protocol' },
  )
  assert.deepEqual(
    classifyCapabilityError(Object.assign(new Error('ANVIL admission denied: lease expired'), { code: 'ANVIL_DENIED' })),
    { permanent: true, kind: 'authority' },
  )
  assert.deepEqual(
    classifyCapabilityError(new Error('no current ANVIL observation')),
    { permanent: false, kind: 'transient' },
  )
  assert.deepEqual(
    classifyCapabilityError(Object.assign(new Error('ANVIL session observation unavailable'), { code: 'ANVIL_DENIED', transient: true })),
    { permanent: false, kind: 'transient' },
  )
})

test('start-order inversion stays error truthfully, recovers on late socket, unregisters stale tools on daemon kill, and re-discovers changed tools across repeated reconnects', async (t) => {
  const h = await createRealHarness({ retryPolicy: { initialDelayMs: 60, maxDelayMs: 120, maxAttempts: 30, jitterRatio: 0 } })
  const daemon = createMockUnixMcpServer(h.sockPath, ['screenshot', 'click'])
  t.after(async () => {
    await daemon.stop()
    await h.dispose()
  })

  await h.rt.capabilitySave({
    name: 'cua',
    kind: 'mcp',
    description: 'CUA mock driver',
    transport: 'stdio',
    command: process.execPath,
    args: [BRIDGE, h.sockPath, h.pidLogPath],
    env: {},
  }, { botId: 'chief' })
  await h.rt.capabilityEndpoint('capability-approve', { name: 'cua' })
  await h.rt.changeCapabilityAttachment('attach', { name: 'cua' }, 'chief')

  // Layer 2 start-order inversion: socket does not exist yet.
  const { agent } = h.mountAgent('chief')
  await h.rt.scheduleCapabilitiesReconcile()
  const initialStatus = h.rt.capabilityStatusesView().chief.cua
  assert.equal(initialStatus.state, 'error', 'failOnStartupError must keep missing socket in error state, never fake ready')
  assert.deepEqual(h.toolNames(agent), [])

  // Concurrent reconcile calls must not spawn duplicate concurrent bridge children.
  await Promise.all([
    h.rt.scheduleCapabilitiesReconcile(),
    h.rt.ensureCapabilities('chief'),
  ])
  assert.ok(readPidLog(h.pidLogPath).maxConcurrent <= 1, 'no duplicate concurrent bridge child processes')

  // Late socket appearance: CUA daemon comes up after DSH booted.
  await daemon.start()
  await waitUntil(() => h.rt.capabilityStatusesView().chief.cua?.state === 'ready', { message: 'cua never recovered after late socket start' })
  assert.deepEqual(h.toolNames(agent), ['mcp__cua__click', 'mcp__cua__screenshot'])
  const probe1 = await h.ctx.mcpResources.request('cua', { method: 'resources/list' }, { agent })
  assert.deepEqual(probe1, { resources: [] })

  // Abrupt CUA daemon kill: must immediately drop out of ready and unregister stale mcp__cua__* tools.
  await daemon.stop()
  await waitUntil(() => h.rt.capabilityStatusesView().chief.cua?.state === 'error' && h.toolNames(agent).length === 0, {
    message: 'abrupt daemon kill did not drop ready state and clear stale tools',
  })
  assert.throws(() => h.ctx.mcpResources.request('cua', { method: 'resources/list' }, { agent }), /unavailable|disconnected/)

  // Driver returns with a changed tool inventory: atomic replacement removes screenshot & old click, exposes click_v2 & scroll.
  daemon.setTools(['click_v2', 'scroll'])
  await daemon.start()
  await waitUntil(() => {
    const tools = h.toolNames(agent)
    return h.rt.capabilityStatusesView().chief.cua?.state === 'ready'
      && tools.includes('mcp__cua__click_v2')
      && tools.includes('mcp__cua__scroll')
  }, { message: 'driver return did not re-discover changed tools' })
  assert.deepEqual(h.toolNames(agent), ['mcp__cua__click_v2', 'mcp__cua__scroll'])

  // Second abrupt kill & recovery cycle verifies repeated reconnects without leaking generations.
  await daemon.stop()
  await waitUntil(() => h.rt.capabilityStatusesView().chief.cua?.state === 'error' && h.toolNames(agent).length === 0, {
    message: 'second daemon kill did not clear tools',
  })
  daemon.setTools(['type_text'])
  await daemon.start()
  await waitUntil(() => h.rt.capabilityStatusesView().chief.cua?.state === 'ready' && h.toolNames(agent).includes('mcp__cua__type_text'), {
    message: 'second reconnect cycle failed',
  })
  assert.deepEqual(h.toolNames(agent), ['mcp__cua__type_text'])
  assert.equal(readPidLog(h.pidLogPath).maxConcurrent, 1, 'never overlapped two live bridge children')
})

test('permanent capability failures fail fast without scheduling retry loops', async (t) => {
  const h = await createRealHarness({ retryPolicy: { initialDelayMs: 30, maxDelayMs: 60, maxAttempts: 5, jitterRatio: 0 } })
  t.after(() => h.dispose())

  await h.rt.capabilitySave({
    name: 'missing-bin',
    kind: 'mcp',
    description: 'Missing binary',
    transport: 'stdio',
    command: '/nonexistent/cua-binary-never-installed',
    args: [],
    env: {},
  }, { botId: 'chief' })
  await h.rt.capabilitySave({
    name: 'auth-fail',
    kind: 'mcp',
    description: 'Auth failure',
    transport: 'stdio',
    command: process.execPath,
    args: [BRIDGE, h.sockPath, h.pidLogPath, 'auth-fail'],
    env: {},
  }, { botId: 'chief' })
  await h.rt.capabilitySave({
    name: 'bad-proto',
    kind: 'mcp',
    description: 'Protocol mismatch',
    transport: 'stdio',
    command: process.execPath,
    args: [BRIDGE, h.sockPath, h.pidLogPath, 'bad-proto'],
    env: {},
  }, { botId: 'chief' })
  await h.rt.capabilityEndpoint('capability-approve', { name: 'missing-bin' })
  await h.rt.capabilityEndpoint('capability-approve', { name: 'auth-fail' })
  await h.rt.capabilityEndpoint('capability-approve', { name: 'bad-proto' })
  await h.rt.changeCapabilityAttachment('attach', { name: 'missing-bin' }, 'chief')
  await h.rt.changeCapabilityAttachment('attach', { name: 'auth-fail' }, 'chief')
  await h.rt.changeCapabilityAttachment('attach', { name: 'bad-proto' }, 'chief')

  let mountCalls = 0
  const mounted = h.mountAgent('chief')
  const origPlugin = mounted.agent.ctx.plugin.bind(mounted.agent.ctx)
  mounted.agent.ctx.plugin = (...args) => {
    if (args[1]?.serverName !== undefined) mountCalls += 1
    return origPlugin(...args)
  }
  await h.rt.scheduleCapabilitiesReconcile()
  assert.equal(h.rt.capabilityStatusesView().chief['missing-bin'].state, 'error')
  assert.equal(h.rt.capabilityStatusesView().chief['auth-fail'].state, 'error')
  assert.equal(h.rt.capabilityStatusesView().chief['bad-proto'].state, 'error')
  assert.equal(mountCalls, 3, 'missing-bin, auth-fail, and bad-proto each mounted once only')
  const startsAfterInitial = readPidLog(h.pidLogPath).totalStarts
  await sleep(160)
  await h.rt.scheduleCapabilitiesReconcile()
  assert.equal(mountCalls, 3, 'permanent failures must never re-mount on retry timers or subsequent reconciles')
  assert.equal(readPidLog(h.pidLogPath).totalStarts, startsAfterInitial, 'permanent failures must not schedule retries')
})

test('connect cancellation, agent disposal, and HMR plugin reload leave zero orphaned children or tools', async (t) => {
  const h = await createRealHarness({ retryPolicy: { initialDelayMs: 50, maxDelayMs: 100, maxAttempts: 5, jitterRatio: 0 } })
  t.after(() => h.dispose())

  await h.rt.capabilitySave({
    name: 'slow-cua',
    kind: 'mcp',
    description: 'Hanging startup probe',
    transport: 'stdio',
    command: process.execPath,
    args: [BRIDGE, h.sockPath, h.pidLogPath, 'hang'],
    env: {},
  }, { botId: 'chief' })
  await h.rt.capabilityEndpoint('capability-approve', { name: 'slow-cua' })
  await h.rt.changeCapabilityAttachment('attach', { name: 'slow-cua' }, 'chief')

  const mounted = h.mountAgent('chief')
  const pendingReconcile = h.rt.scheduleCapabilitiesReconcile()
  await waitUntil(() => readPidLog(h.pidLogPath).livePids.length === 1, { message: 'hanging bridge did not spawn' })

  // Cancel connect mid-flight by detaching and reloading (HMR disposal of the plugin fiber).
  await h.rt.changeCapabilityAttachment('detach', { name: 'slow-cua' }, 'chief')
  await mounted.dispose()
  await h.capFiber.dispose()
  await pendingReconcile.catch(() => {})

  await waitUntil(() => readPidLog(h.pidLogPath).livePids.length === 0, { message: 'orphaned bridge process survived cancellation/HMR disposal' })
  assert.deepEqual(h.toolNames(mounted.agent), [])
})

test('ensureCapabilities resets exhausted retries and governed mountOne recovers from transient admission failure and lease generation rotation', async (t) => {
  const h = await createRealHarness({ retryPolicy: { initialDelayMs: 25, maxDelayMs: 40, maxAttempts: 2, jitterRatio: 0 } })
  const daemon = createMockUnixMcpServer(h.sockPath, ['screenshot'])
  t.after(async () => {
    await daemon.stop()
    await h.dispose()
  })

  await h.rt.capabilitySave({
    name: 'cua',
    kind: 'mcp',
    description: 'CUA mock driver',
    transport: 'stdio',
    command: process.execPath,
    args: [BRIDGE, h.sockPath, h.pidLogPath],
    env: {},
  }, { botId: 'chief' })
  await h.rt.capabilityEndpoint('capability-approve', { name: 'cua' })
  await h.rt.changeCapabilityAttachment('attach', { name: 'cua' }, 'chief')

  // Phase A: exhaust maxAttempts while daemon is down, then verify ensureCapabilities resets attempts.
  h.mountAgent('chief')
  await h.rt.scheduleCapabilitiesReconcile()
  await waitUntil(() => h.warnings.some(w => w.includes('exceeded max retries')), { message: 'did not exhaust retries' })
  const startsAtExhaustion = readPidLog(h.pidLogPath).totalStarts

  // Call ensureCapabilities before daemon comes back online; reset attempts must re-arm scheduled retries.
  await h.rt.ensureCapabilities('chief')
  await sleep(15)
  await daemon.start()
  await waitUntil(() => h.rt.capabilityStatusesView().chief.cua?.state === 'ready', { message: 'ensureCapabilities failed to re-arm retries after exhaustion' })
  assert.ok(readPidLog(h.pidLogPath).totalStarts > startsAtExhaustion)

  // Phase B: enable governed egress admission on the harness runtime and simulate transient outage -> gen 1 -> permanent deny -> gen 2 -> gen 3 rotation.
  let admitMode = 'transient'
  h.rt.anvilAdmission = async () => {
    if (admitMode === 'transient') throw Object.assign(new Error('connect authority.sock ECONNREFUSED'), { code: 'ECONNREFUSED' })
    if (admitMode === 'denied') {
      throw Object.assign(new Error('ANVIL admission denied: lease expired'), { code: 'ANVIL_DENIED' })
    }
    const generation = admitMode === 'gen3' ? 3 : admitMode === 'gen2' ? 2 : 1
    return {
      lease_state: 'current',
      session_ref: 'chief',
      native_fingerprint: 'chief',
      native_id: 'chief',
      agent_id: 'chief',
      task_id: 'task-cua',
      run_id: 'run-cua',
      lease_ref: 'lease-cua',
      lease_generation: generation,
      lease_expires_at_ms: Date.now() + 30_000,
      agent: 'dsh:chief',
    }
  }

  // Trigger transient admission outage -> drops ready, retries automatically once authority recovers to gen 1.
  await h.rt.scheduleCapabilitiesReconcile()
  await waitUntil(() => h.rt.capabilityStatusesView().chief.cua?.state === 'error', { message: 'transient admit failure did not surface error state' })
  admitMode = 'gen1'
  await waitUntil(() => h.rt.capabilityStatusesView().chief.cua?.state === 'ready', { message: 'capability did not auto-recover from transient admit failure' })

  // Permanent denial drops mount without locking out subsequent explicit reconcile once lease renews (gen 2).
  admitMode = 'denied'
  await h.rt.scheduleCapabilitiesReconcile()
  await waitUntil(() => h.rt.capabilityStatusesView().chief.cua?.state === 'error', { message: 'denied admission did not drop mount' })
  const startsBeforeGen2 = readPidLog(h.pidLogPath).totalStarts
  admitMode = 'gen2'
  await h.rt.scheduleCapabilitiesReconcile()
  await waitUntil(() => h.rt.capabilityStatusesView().chief.cua?.state === 'ready', { message: 'explicit reconcile failed to recover after previous ANVIL_DENIED' })
  const startsAtGen2 = readPidLog(h.pidLogPath).totalStarts
  assert.ok(startsAtGen2 > startsBeforeGen2, 'gen2 must remount capability cleanly')

  // Lease generation rotation (gen 2 -> gen 3) updates scopeKey and triggers clean remount with new PID.
  admitMode = 'gen3'
  await h.rt.scheduleCapabilitiesReconcile()
  await waitUntil(() => readPidLog(h.pidLogPath).totalStarts > startsAtGen2 && h.rt.capabilityStatusesView().chief.cua?.state === 'ready', {
    message: 'lease generation bump did not trigger remount',
  })
})
