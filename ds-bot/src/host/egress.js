// Optional host-governed egress admission, canonical ANVIL attribution, bounded
// delegation/child limits, and process-group termination. When neither an ANVIL
// bridge nor authority service is composed on the host, standalone DS Bot
// execution continues unchanged.

const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/
const DISALLOWED_TASK_TOKENS = new Set(['unknown', 'unbound', 'foreign', 'none', 'null', 'undefined', 'owner'])

export const OWNER_SECRET_EXACT = new Set([
  'ANVIL_OWNER_TOKEN',
  'ANVIL_TOKEN',
  'ANVIL_HUB_TOKEN',
  'ANVIL_AUTHORITY_TOKEN',
  'ANVIL_SECRET',
  'ANVIL_AGENTMAIL_TOKEN',
  'AGENTMAIL_API_KEY',
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_AUTH_TOKEN',
])

export const OWNER_ENV_PREFIXES = ['ANVIL_', 'SIEVE_']

export const ATTRIBUTION_KEYS = Object.freeze([
  'ANVIL_TASK_ID',
  'ANVIL_RUN_ID',
  'ANVIL_LEASE_REF',
  'ANVIL_LEASE_GENERATION',
  'ANVIL_AGENT',
])

export const DEFAULT_EGRESS_LIMITS = Object.freeze({
  maxDepth: 8,
  maxConcurrentChildren: 16,
  maxRetries: 3,
})

export class EgressDeniedError extends Error {
  constructor(message, code = 'ANVIL_DENIED') {
    super(message)
    this.name = 'EgressDeniedError'
    this.code = code
  }
}

export function readService(ctx, name) {
  if (!ctx) return undefined
  return typeof ctx.get === 'function' ? ctx.get(name) : ctx[name]
}

export function scrubOwnerTokens(extra = {}) {
  const clean = {}
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (OWNER_SECRET_EXACT.has(key) || value === undefined) continue
    clean[key] = value
  }
  return clean
}

export function envKeyOf(env) {
  if (!env || typeof env !== 'object') return ''
  return JSON.stringify(Object.entries(env).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)))
}

export function attributionEnv(lease, agentLabel) {
  return Object.freeze({
    ANVIL_TASK_ID: String(lease.task_id),
    ANVIL_RUN_ID: String(lease.run_id),
    ANVIL_LEASE_REF: String(lease.lease_ref),
    ANVIL_LEASE_GENERATION: String(lease.lease_generation),
    ANVIL_AGENT: String(agentLabel),
  })
}

export function killProcessGroup(child, { graceMs = 250, signal = 'SIGTERM' } = {}) {
  if (!child || typeof child.kill !== 'function') return
  const pid = Number(child.pid)
  const posixGroup = process.platform !== 'win32' && Number.isSafeInteger(pid) && pid > 0
  const send = (sig) => {
    if (posixGroup) {
      try { process.kill(-pid, sig) } catch { /* process group may already be gone */ }
    }
    try { child.kill(sig) } catch { /* process may already have exited */ }
  }
  send(signal)
  if (signal === 'SIGKILL' || !Number.isFinite(graceMs) || graceMs <= 0) {
    if (graceMs <= 0) send('SIGKILL')
    return
  }
  let exited = child.exitCode !== null || child.signalCode !== null
  const onExit = () => {
    exited = true
    clearTimeout(timer)
  }
  child.once?.('exit', onExit)
  const timer = setTimeout(() => {
    child.off?.('exit', onExit)
    if (!exited) send('SIGKILL')
  }, graceMs)
  timer.unref?.()
}

function validTaskId(taskId) {
  if (Number.isSafeInteger(taskId)) return taskId >= 1
  if (typeof taskId !== 'string') return false
  const trimmed = taskId.trim()
  return TOKEN_RE.test(trimmed) && !DISALLOWED_TASK_TOKENS.has(trimmed.toLowerCase())
}

export function validateLeaseGrant(grant, { expectedSessionRef, expectedAgentId, minGeneration = 1, nowMs = Date.now() } = {}) {
  if (!grant || typeof grant !== 'object') {
    throw new EgressDeniedError('ANVIL admission denied: missing lease grant')
  }
  if (grant.lease_state !== 'current') {
    throw new EgressDeniedError(`ANVIL admission denied: lease state is ${String(grant.lease_state ?? 'unknown')}`)
  }
  if (expectedSessionRef !== undefined) {
    if (grant.session_ref !== expectedSessionRef || (grant.native_fingerprint !== undefined && grant.native_fingerprint !== expectedSessionRef)) {
      throw new EgressDeniedError('ANVIL admission denied: foreign or mismatched session fingerprint')
    }
  }
  if (grant.native_id !== undefined && expectedAgentId !== undefined && grant.native_id !== expectedAgentId) {
    throw new EgressDeniedError('ANVIL admission denied: foreign native_id in lease')
  }
  if (grant.agent_id !== undefined && expectedAgentId !== undefined && grant.agent_id !== expectedAgentId) {
    throw new EgressDeniedError('ANVIL admission denied: foreign agent identity in lease')
  }
  if (!validTaskId(grant.task_id)) {
    throw new EgressDeniedError('ANVIL admission denied: invalid or missing task_id')
  }
  if (typeof grant.run_id !== 'string' || !TOKEN_RE.test(grant.run_id)) {
    throw new EgressDeniedError('ANVIL admission denied: invalid or missing run_id')
  }
  if (typeof grant.lease_ref !== 'string' || !TOKEN_RE.test(grant.lease_ref)) {
    throw new EgressDeniedError('ANVIL admission denied: invalid or missing lease_ref')
  }
  if (!Number.isSafeInteger(grant.lease_generation) || grant.lease_generation < 1) {
    throw new EgressDeniedError('ANVIL admission denied: invalid lease_generation')
  }
  if (grant.lease_generation < minGeneration) {
    throw new EgressDeniedError(`ANVIL admission denied: stale lease generation ${grant.lease_generation} (< ${minGeneration})`)
  }
  if (!Number.isSafeInteger(grant.lease_expires_at_ms) || grant.lease_expires_at_ms <= nowMs) {
    throw new EgressDeniedError('ANVIL admission denied: lease expired or missing expiry')
  }
  return grant
}

export function workDepthOf(works, workIds = []) {
  if (!works || !Array.isArray(workIds) || workIds.length === 0) return 0
  let max = 0
  for (const startId of workIds) {
    if (typeof startId !== 'string' || works[startId] === undefined) continue
    const visited = new Set()
    let depth = 0
    let current = startId
    while (typeof current === 'string' && works[current] !== undefined) {
      if (visited.has(current)) throw new EgressDeniedError('Delegation loop detected in work chain', 'DEPTH_EXCEEDED')
      visited.add(current)
      const parent = works[current]?.parent
      if (typeof parent !== 'string' || works[parent] === undefined) break
      depth += 1
      current = parent
    }
    if (depth > max) max = depth
  }
  return max
}

export function createEgressController(rt) {
  const { ctx } = rt
  const fences = new Map()      // sessionKey -> { taskId, generation }
  const activeSlots = new Map() // slotKey -> cleanup callback
  const retryCounts = new Map() // key -> count
  let disposed = false

  const now = () => (typeof rt.now === 'function' ? rt.now() : Date.now())
  const limits = () => ({
    ...DEFAULT_EGRESS_LIMITS,
    ...rt.config?.egress,
    ...rt.egressLimits,
  })
  const isGoverned = () => Boolean(
    readService(ctx, 'anvilAuthority')
    || readService(ctx, 'anvilBridge')
    || typeof rt.anvilAdmission === 'function',
  )

  async function resolveAgentFor(agent, sessionId) {
    if (agent && typeof agent === 'object') return agent
    if (sessionId === undefined) return undefined
    const agents = readService(ctx, 'agents')
    const live = agents?.get?.(sessionId)
    if (live) return live
    if (typeof rt.resolveAgent === 'function') {
      try { return await rt.resolveAgent(sessionId) } catch { return undefined }
    }
    return undefined
  }

  async function bridgeStatus(bridge, agent, waitForBirth) {
    if (typeof bridge?.status !== 'function') return undefined
    try {
      return bridge.status(agent)
    } catch (error) {
      if (waitForBirth && /no current ANVIL observation/i.test(String(error?.message ?? error))) {
        await Promise.resolve()
        try { return bridge.status(agent) } catch (retryError) {
          const message = retryError?.message ?? 'ANVIL session observation unavailable'
          const transient = retryError?.transient === true || /no current ANVIL observation|session observation unavailable|temporarily unavailable/i.test(String(message))
          throw Object.assign(new EgressDeniedError(message), transient ? { transient: true } : {})
        }
      }
      const message = error?.message ?? 'ANVIL session observation unavailable'
      const transient = error?.transient === true || /no current ANVIL observation|session observation unavailable|temporarily unavailable/i.test(String(message))
      throw Object.assign(new EgressDeniedError(message), transient ? { transient: true } : {})
    }
  }

  async function admit({ agent, sessionId, purpose, detail = {}, signal, waitForBirth = false } = {}) {
    if (!isGoverned()) {
      return { governed: false, lease: null, env: {}, agentLabel: undefined, scopeKey: undefined }
    }
    if (disposed || signal?.aborted) {
      throw new EgressDeniedError('ANVIL admission cancelled or runtime disposed')
    }
    const targetSessionId = sessionId ?? agent?.session?.id ?? agent?.id
    const resolvedAgent = await resolveAgentFor(agent, targetSessionId)
    if (!resolvedAgent || typeof resolvedAgent !== 'object') {
      throw new EgressDeniedError('ANVIL admission denied: missing live DSH agent')
    }
    const resolvedId = resolvedAgent.id ?? resolvedAgent.session?.id
    if (targetSessionId !== undefined && resolvedId !== targetSessionId) {
      throw new EgressDeniedError('ANVIL admission denied: agent/session identity mismatch')
    }
    const bridge = readService(ctx, 'anvilBridge')
    const authority = readService(ctx, 'anvilAuthority')
    const status = await bridgeStatus(bridge, resolvedAgent, waitForBirth)
    if (bridge && (typeof status?.session_ref !== 'string' || status.session_ref === '')) {
      throw new EgressDeniedError('ANVIL admission denied: bridge returned no attested session fingerprint')
    }
    const expectedSessionRef = status?.session_ref
    let grant
    if (typeof rt.anvilAdmission === 'function') {
      grant = await rt.anvilAdmission({ agent: resolvedAgent, sessionId: resolvedId, session_ref: expectedSessionRef, purpose, detail, signal })
    } else if (typeof bridge?.admit === 'function') {
      grant = await bridge.admit(resolvedAgent, purpose, signal, detail)
    } else if (typeof authority?.admit === 'function') {
      const ref = expectedSessionRef ?? resolvedAgent.session_ref ?? resolvedId
      grant = await authority.admit({ session_ref: ref, purpose, ...detail }, { signal })
    } else {
      grant = status?.binding
    }
    if (disposed || signal?.aborted) {
      throw new EgressDeniedError('ANVIL admission cancelled or runtime disposed')
    }
    const boundRef = expectedSessionRef ?? resolvedAgent.session_ref ?? (resolvedId !== undefined ? String(resolvedId) : undefined)
    if (boundRef === undefined) {
      throw new EgressDeniedError('ANVIL admission denied: missing agent or session identity')
    }
    const fenceKey = boundRef
    const taskFenceKey = `${fenceKey}\u0000${String(grant?.task_id ?? '')}`
    const minGeneration = fences.get(taskFenceKey) ?? 1
    validateLeaseGrant(grant, {
      expectedSessionRef: boundRef,
      expectedAgentId: resolvedId,
      minGeneration,
      nowMs: now(),
    })
    fences.set(taskFenceKey, Math.max(minGeneration, grant.lease_generation))
    const botId = rt.selfOf?.(resolvedId)
    const agentLabel = typeof grant.agent === 'string' && grant.agent.trim() !== '' && grant.agent !== 'owner'
      ? grant.agent
      : (botId ? `dsh:${botId}` : `dsh:${resolvedId}`)
    const sessionRef = grant.session_ref ?? boundRef
    return {
      governed: true,
      agent: resolvedAgent,
      sessionRef,
      lease: grant,
      agentLabel,
      env: attributionEnv(grant, agentLabel),
      scopeKey: `${sessionRef}:${grant.task_id}:${grant.run_id}:${grant.lease_ref}:${grant.lease_generation}`,
    }
  }

  function assertDepth(workIds = []) {
    const { maxDepth } = limits()
    const depth = workDepthOf(rt.state?.works, workIds)
    if (depth >= maxDepth) {
      throw new EgressDeniedError(`Maximum delegation depth (${maxDepth}) exceeded`, 'DEPTH_EXCEEDED')
    }
    return depth
  }

  function acquireChildSlot(slotKey, onTerminate) {
    if (disposed) throw new EgressDeniedError('Runtime disposed')
    const existing = activeSlots.get(slotKey)
    if (existing) {
      if (onTerminate) existing.onTerminate = onTerminate
      return existing.release
    }
    const { maxConcurrentChildren } = limits()
    if (activeSlots.size >= maxConcurrentChildren) {
      throw new EgressDeniedError(`Maximum simultaneous child limit (${maxConcurrentChildren}) reached`, 'CONCURRENCY_LIMIT')
    }
    let released = false
    const entry = {
      onTerminate,
      release: () => {
        if (released) return
        released = true
        if (activeSlots.get(slotKey) === entry) activeSlots.delete(slotKey)
      },
    }
    activeSlots.set(slotKey, entry)
    return entry.release
  }

  function checkRetryBudget(key, maxOverride) {
    const { maxRetries } = limits()
    const limit = maxOverride ?? maxRetries
    const next = (retryCounts.get(key) ?? 0) + 1
    retryCounts.set(key, next)
    if (next > limit) {
      throw new EgressDeniedError(`Maximum retry budget (${limit}) exhausted`, 'RETRY_LIMIT')
    }
    return next
  }

  const resetRetryBudget = (key) => { retryCounts.delete(key) }

  async function terminateAll(reason = 'runtime disposed') {
    disposed = true
    const entries = [...activeSlots.values()]
    activeSlots.clear()
    fences.clear()
    retryCounts.clear()
    for (const entry of entries) {
      try { await entry.onTerminate?.(reason) } catch { /* best-effort teardown */ }
    }
  }

  return {
    isGoverned,
    limits,
    admit,
    assertDepth,
    acquireChildSlot,
    activeChildCount: () => activeSlots.size,
    checkRetryBudget,
    resetRetryBudget,
    terminateAll,
  }
}

export function install(rt) {
  const controller = createEgressController(rt)
  rt.egress = controller
  rt.admitEgress = options => controller.admit(options)
  rt.ctx?.effect?.(() => () => { void controller.terminateAll('ds-bot egress disposed') }, 'ds-bot: egress')
}
