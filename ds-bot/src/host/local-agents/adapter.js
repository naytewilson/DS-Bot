// The LlmAdapter that serves every local-agent route. A DS Bot Bot whose model
// is one of these routes answers through a local agent CLI instead of a model
// API: the loop, Sessions, tools and approvals are the ordinary ones; this
// adapter turns each request into a prompt for the CLI session the Session is
// mapped to, and the CLI's output back into stream chunks.
import { createHash, randomUUID } from 'node:crypto'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import { textOf } from '../text.js'
import { createEgressController, EgressDeniedError } from '../egress.js'
import { engineOf, cliMode } from './engines.js'
import { LoopbackMcp } from './mcp.js'

export const DEFAULT_CONTEXT_WINDOW = 200_000
// The replay window when a CLI session is new or its resume failed.
const REPLAY_MESSAGES = 12
const REPLAY_BYTES = 24 * 1024
const IDLE_CLOSE_MS = 10 * 60_000
const APPROVE_TOOL = 'approve_agent_action'

// A title request never reaches the CLI.
function titleChunk(text) {
  const title = text.slice(0, 60)
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: title },
    { type: 'block-end', index: 0, block: { type: 'text', text: title } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

// A compaction request neither: a deterministic digest of the messages.
function digestChunks(messages) {
  const lines = []
  let used = 0
  for (const message of messages ?? []) {
    const text = textOf(message.content).replace(/\s+/g, ' ').trim()
    if (text === '') continue
    const line = `${message.role}: ${text.slice(0, 300)}`
    if (used + line.length > 8 * 1024) break
    lines.push(line)
    used += line.length
  }
  const text = `[Earlier conversation, condensed]\n${lines.join('\n')}`
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

// Marks the one retry of a turn whose saved Claude conversation was gone, and retry budget keys.
const RESUME_RETRIED = Symbol('resume retried')
const RETRY_KEY = Symbol('retry key')

export class LocalAgentAdapter extends LlmAdapter {
  // deps: {rt, egress, findExecutable, spawnEngine(kind,route,engine), record(sessionId),
  //        saveRecord, dropRecord, presetFor(sessionId), toolsFor(options), signInHint(route),
  //        usedModels(route)}
  constructor(deps) {
    super()
    this.deps = deps
    this.egress = deps.egress ?? (deps.rt?.ctx ? createEgressController(deps.rt) : undefined)
    this.engines = new Map()   // route[\0scopeKey] -> engine driver
    this.live = new Map()      // sessionId -> live session
    this.modelCache = new Map()
    this.probes = new Map()    // route -> the probe under way
    this.disposed = false
  }

  providerInfo(route) {
    const engine = engineOf(route, this.deps.customAgents())
    return { id: route, name: engine?.name ?? route }
  }
  providerRetryPolicy() { return undefined }
  imageRequestPricing() { return undefined }

  engine(route, scopeKey) {
    const key = scopeKey ? `${route}\u0000${scopeKey}` : route
    let driver = this.engines.get(key)
    if (driver === undefined) {
      const spec = engineOf(route, this.deps.customAgents())
      if (spec === undefined) throw new LlmError(`Unknown local agent ${route}`, 'NO_ADAPTER')
      driver = this.deps.spawnEngine(spec.kind, route, spec)
      this.engines.set(key, driver)
    }
    return driver
  }

  // What DS Bot knows of a route without starting its CLI: the CLI's default, what a
  // probe found, and what a Bot runs on. DSH and the catalog ask this for every route.
  async listModels(route) {
    if (engineOf(route, this.deps.customAgents()) === undefined) return []
    const listed = [{ provider: route, id: 'default', name: 'CLI default' }, ...(this.modelCache.get(route) ?? [])]
    const used = (this.deps.usedModels?.(route) ?? []).filter(id => !listed.some(model => model.id === id))
    return [...listed, ...used.map(id => ({ provider: route, id, name: id }))]
  }

  // Asks one CLI what it serves, once. A failure is not kept, so the next look tries
  // again. The process it took leaves unless a Session runs on it.
  async probeModels(route) {
    if (this.modelCache.has(route)) return this.listModels(route)
    if (engineOf(route, this.deps.customAgents()) === undefined) return []
    let probe = this.probes.get(route)
    if (probe === undefined) {
      probe = this.askModels(route).finally(() => this.probes.delete(route))
      this.probes.set(route, probe)
    }
    await probe
    return this.listModels(route)
  }

  async askModels(route) {
    const engine = this.engine(route)
    try {
      const models = await engine.listModels({ cwd: this.deps.probeCwd(), mcp: undefined })
      this.modelCache.set(route, (models ?? []).filter(model => model.id !== 'default')
        .map(model => ({ provider: route, id: model.id, name: model.name ?? model.id, ...(model.reasoning ? { reasoning: model.reasoning } : {}) })))
    } catch { /* the menu still has the CLI's default */ }
    if (![...this.live.values()].some(other => other.engine === engine && !other.dead)) await engine.close?.().catch(() => {})
  }

  dropModelCache(route) {
    if (route === undefined) this.modelCache.clear()
    else this.modelCache.delete(route)
  }

  async resolveModel(route, model) {
    const spec = engineOf(route, this.deps.customAgents())
    const listed = (await this.listModels(route).catch(() => [])).find(entry => entry.id === model)
    return {
      provider: route,
      id: model,
      name: listed?.name ?? model,
      inputModalities: ['text', 'image'],
      context: { contextWindow: spec?.contextWindow ?? DEFAULT_CONTEXT_WINDOW },
      // The thinking levels the engine advertises for this model, if any.
      ...(listed?.reasoning ? { reasoning: listed.reasoning } : {}),
    }
  }

  // ---------------------------------------------------------------------------
  // The live bridge for one DS Bot Session.
  async liveFor(options, admission) {
    const sessionId = String(options.sessionId)
    let live = this.live.get(sessionId)
    const record = this.deps.record(sessionId)
    const route = options.provider
    const governed = Boolean(admission?.governed)
    const scopeKey = governed ? admission.scopeKey : undefined
    if (live !== undefined && !live.dead && live.route === route && Boolean(live.governed) === governed && (!governed || live.scopeKey === scopeKey)) {
      // An agent CLI can exit between the spawn and its first message (a failed
      // sign-in, for one): the cached bridge is dead, so the next call starts a
      // new process instead of writing into the one that is gone.
      if (live.engineSession?.dead === true) {
        this.rollbackUnread(live, sessionId)
        live.engineSession = undefined
        live.pumpToken = {}
        // The queue belongs to the process that is gone: the retry starts clean
        // instead of reading its exit as the new turn's failure.
        live.events.length = 0
      }
      live.lease = admission?.lease ?? null
      live.attributionEnv = admission?.env
      // A CLI takes its model when its session opens. Another model reopens the same
      // CLI session as soon as no turn runs in it.
      if (live.model === options.model || live.state !== 'idle') return live
      await this.closeLive(live, { idle: true })
    } else if (live !== undefined) {
      if (live.state !== 'idle') this.stopTurn(live, 'local agent session replaced', { forceKill: true, close: false })
      await this.closeLive(live)
    }
    const spec = engineOf(route, this.deps.customAgents())
    if (spec === undefined) throw new LlmError(`Unknown local agent ${route}`, 'LOCAL_AGENT_MISSING')
    const engine = this.engine(route, scopeKey)
    live = {
      sessionId, route, spec, engine, dead: false,
      governed, scopeKey,
      lease: admission?.lease ?? null,
      attributionEnv: admission?.env,
      releaseSlot: undefined,
      expiryTimer: undefined,
      activeSignal: undefined,
      record,
      cliSessionId: record?.cliSessionId,
      handed: record?.handedId,
      promptHash: record?.promptHash,
      engineSession: undefined,
      mcp: undefined,
      events: [],
      waiters: [],
      pending: new Map(),   // dshCallId -> {name, mcpCallId?, reply?}
      started: false,
      // 'idle': no CLI turn. 'running': a prompt is in flight. 'suspended': the
      // turn waits on a bridged tool call or a permission answer.
      state: 'idle',
      // Prompts queued while a turn runs (ACP speaks one prompt at a time);
      // the drain sends the next one when the turn ends.
      queue: [],
      idle: undefined,
      cwd: record?.cwd,
      model: options.model,
    }
    live.push = (event) => {
      clearTimeout(live.idle)
      live.idle = setTimeout(() => void this.closeLive(live, { idle: true }), IDLE_CLOSE_MS)
      live.idle.unref?.()
      const waiter = live.waiters.shift()
      if (waiter !== undefined) waiter(event)
      else live.events.push(event)
    }
    live.next = () => (live.events.length > 0 ? Promise.resolve(live.events.shift()) : new Promise(resolve => live.waiters.push(resolve)))
    this.live.set(sessionId, live)
    return live
  }

  async closeLive(live, { idle = false, error } = {}) {
    if (live.dead) return
    live.dead = true
    clearTimeout(live.idle)
    clearTimeout(live.expiryTimer)
    live.expiryTimer = undefined
    live.releaseSlot?.()
    live.releaseSlot = undefined
    this.live.delete(live.sessionId)
    live.engine.forget?.(live.sessionId)
    live.mcp?.close()
    if (idle) {
      // The CLI session survives on the agent side; the process leaves and the
      // next prompt resumes it.
      live.engineSession = undefined
      live.started = false
    }
    const terminal = error === undefined ? { type: 'done', reason: 'stop' } : { type: 'error', error }
    if (live.waiters.length > 0) {
      for (const waiter of live.waiters.splice(0)) waiter(terminal)
    } else if (error !== undefined) {
      live.events.push(terminal)
    }
    const stillUsed = [...this.live.values()].some(other => other.engine === live.engine && !other.dead)
    if (!stillUsed) {
      await live.engine.close?.({ force: !idle || live.governed }).catch(() => {})
      if (live.governed) {
        for (const [key, engine] of this.engines) {
          if (engine === live.engine) this.engines.delete(key)
        }
      }
    }
  }

  // The turn under way ends: the CLI stops, and a call it waits on gets an answer.
  stopTurn(live, reason, { forceKill = false, close = false, error } = {}) {
    live.state = 'idle'
    live.queue.length = 0
    clearTimeout(live.expiryTimer)
    live.expiryTimer = undefined
    live.releaseSlot?.()
    live.releaseSlot = undefined
    if (live.engineSession !== undefined) live.engine.cancel?.(live.engineSession, { force: forceKill })
    live.mcp?.failAll(new Error(reason))
    for (const pending of live.pending.values()) pending.resolve({ text: reason, isError: true })
    live.pending.clear()
    if (close) void this.closeLive(live, { error })
  }

  // The Session left this CLI: its part moved on. Its process leaves; the CLI session
  // and its record stay, so opening that part again resumes it.
  async closeSession(sessionId, reason = 'the conversation moved on') {
    const live = this.live.get(String(sessionId))
    if (live === undefined) return
    this.stopTurn(live, reason)
    await this.closeLive(live, { idle: true })
  }

  // Host-level turn rejection (e.g. dsh-anvil-bridge blocking agent/pre-step on
  // Step 2 before stream() is called), user abort between tool-calls steps, or
  // agent disposal must immediately tear down any suspended or governed CLI
  // process group, LoopbackMcp listener, and concurrency slot.
  async terminateSession(sessionId, reason = 'the turn was stopped', { forceKill = false } = {}) {
    const live = this.live.get(String(sessionId))
    if (live === undefined) return
    const kill = forceKill || live.governed
    this.stopTurn(live, reason, { forceKill: kill, close: false })
    await this.closeLive(live, { idle: !kill, ...(kill ? { error: new LlmError(reason, 'ANVIL_DENIED') } : {}) })
  }

  // A Claude CLI that died before `system/init` never read the prompt it was
  // handed: roll the marker back in the live state and in the saved record, so a
  // host that restarts before the next call still replays the input. ACP and
  // Codex create their session before the prompt, so theirs was read.
  // A resume that found its conversation gone also drops the id: the next start
  // opens a new conversation and replays the history, instead of failing every
  // turn on the same id.
  rollbackUnread(live, sessionId) {
    if (live.spec.kind !== 'claude') return
    const session = live.engineSession
    if (session?.dead !== true || session.cliSessionId !== undefined || session.rolledBack === true) return
    session.rolledBack = true
    if (session.resumeMissing === true) {
      live.cliSessionId = undefined
      live.handed = undefined
      live.resumeLost = true
    } else live.handed = live.handedBefore
    this.deps.saveRecord(sessionId, { route: live.route, cliSessionId: live.cliSessionId, cwd: live.cwd, handedId: live.handed, promptHash: live.promptHash, model: live.model })
  }

  // The loopback MCP server for one live session; tools/call lands in its event queue.
  // `tools` lists the current turn's tools; the server outlives the turn that
  // started it, so tools/list reads the latest one.
  async ensureMcp(live, tools) {
    live.tools = tools
    if (live.mcp !== undefined) return live.mcp
    const mcp = new LoopbackMcp(() => live.tools(), async ({ name, arguments: args, callId }) => {
      if (live.governed && this.egress) {
        try {
          await this.egress.admit({
            sessionId: live.sessionId,
            purpose: 'local-agent-mcp-call',
            detail: { tool: name },
            signal: live.activeSignal,
          })
        } catch (error) {
          const denied = toLlmError(error, live)
          this.stopTurn(live, denied.message, { forceKill: true, close: true, error: denied })
          throw denied
        }
      }
      const dshCallId = `dsbot-${callId}`
      return new Promise((resolve) => {
        live.pending.set(dshCallId, { name, mcpCallId: callId, resolve })
        live.push({ type: 'call', name, args, dshCallId })
      })
    })
    await mcp.listen()
    live.mcp = mcp
    return mcp
  }

  // ---------------------------------------------------------------------------
  async *stream(options) {
    if (this.disposed) throw new LlmError('the local agents adapter is disposed', 'NO_ADAPTER')
    if (options.purpose === 'session-title') {
      const first = (options.messages ?? []).find(message => message.role === 'user')
      const title = (textOf(first?.content).split('\n').find(line => line.trim() !== '') ?? 'Chat').trim()
      yield* titleChunk(title === '' ? 'Chat' : title)
      return
    }
    if (options.purpose === 'compaction') {
      yield* digestChunks(options.messages)
      return
    }
    const sessionId = options.sessionId
    if (sessionId === undefined) throw new LlmError('a local agent request needs a session', 'INVALID_REQUEST')
    let admission = { governed: false, lease: null, env: {}, scopeKey: undefined }
    if (this.egress) {
      try {
        const turnInfo = this.deps.rt?.live?.get?.(sessionId)?.info
        const workIds = [this.deps.rt?.workOf?.(turnInfo), ...(options.workIds ?? [])].filter(Boolean)
        this.egress.assertDepth(workIds)
        admission = await this.egress.admit({
          sessionId,
          purpose: 'local-agent-turn',
          detail: { route: options.provider, model: options.model },
          signal: options.signal,
        })
      } catch (error) {
        const denied = toLlmError(error)
        const existingLive = this.live.get(String(sessionId))
        if (existingLive !== undefined) {
          this.stopTurn(existingLive, denied.message, { forceKill: true, close: false })
          await this.closeLive(existingLive, { error: denied })
        }
        throw denied
      }
    }
    const retryKey = options[RETRY_KEY] ?? `turn:${sessionId}:${randomUUID()}`
    const live = await this.liveFor(options, admission)
    if (live.releaseSlot === undefined && this.egress) {
      try {
        live.releaseSlot = this.egress.acquireChildSlot(`local-agent:${sessionId}`, (why) => {
          this.stopTurn(live, why, { forceKill: true, close: true, error: new LlmError(why, 'ANVIL_DENIED') })
        })
      } catch (error) {
        const denied = toLlmError(error, live)
        this.stopTurn(live, denied.message, { forceKill: true, close: false })
        await this.closeLive(live, { error: denied })
        throw denied
      }
    }

    // What the request carries past the last handed message. When the marker is
    // gone the CLI session is stale or new: it gets a replay instead of a delta.
    const messages = options.messages ?? []
    const at = live.handed === undefined ? -1 : messages.findIndex(message => message.id === live.handed)
    const fresh = live.handed === undefined || at === -1
    const delta = fresh ? [] : messages.slice(at + 1)

    // Results of the calls the last step emitted answer the suspended CLI calls.
    // A user message never resolves an approve_agent_action pending: only that
    // tool's own result may. User text may answer a pending bridged MCP call
    // whose DSH tool concluded the turn (a question-type card).
    for (const message of delta) {
      if (message.role !== 'tool') continue
      const pending = live.pending.get(message.toolCallId)
      if (pending === undefined) continue
      live.pending.delete(message.toolCallId)
      pending.resolve({ text: textOf(message.content) || (message.isError ? 'the call failed' : ''), isError: message.isError === true })
    }
    // The loop's runtime-context user messages are context, not input: they
    // fold into the next prompt or steer, never start a prompt on their own.
    const contextText = delta
      .filter(message => message.role === 'user' && message.source?.kind === 'runtime-context')
      .map(message => textOf(message.content)).filter(text => text !== '').join('\n')
    const users = delta.filter(message => message.role === 'user' && message.source?.kind !== 'runtime-context')
    // The first open bridged call that is not an approval may take the user's
    // next message as its answer; the rest of the input is new.
    const openCall = [...live.pending.entries()].find(([, entry]) => entry.name !== APPROVE_TOOL)
    const remaining = []
    let answered = openCall === undefined
    for (const message of users) {
      if (!answered && openCall !== undefined) {
        const [id, pending] = openCall
        live.pending.delete(id)
        pending.resolve({ text: textOf(message.content) })
        answered = true
      } else {
        remaining.push(message)
      }
    }

    const system = messages.filter(message => message.role === 'system').map(message => textOf(message.content)).join('\n').trim()
    const promptHash = system === '' ? undefined : createHash('sha256').update(system).digest('hex')
    const mcp = await this.ensureMcp(live, () => this.deps.toolsFor(options))
    const cwd = live.cwd ?? await this.deps.cwdFor(sessionId)
    live.cwd = cwd

    const preset = this.deps.presetFor(sessionId)
    const mode = cliMode(live.spec.kind, preset)
    const instructions = system === '' ? undefined : system

    const freshCli = live.cliSessionId === undefined
    if (live.engineSession === undefined) {
      const openArgs = {
        cwd,
        mcp,
        resumeId: live.cliSessionId,
        mode,
        preset,
        model: options.model,
        env: live.attributionEnv,
        // Codex carries the team instructions as developer config on a new
        // thread; Claude gets them appended at spawn; ACP reads them in the
        // first prompt below.
        instructions: live.spec.kind === 'codex' && freshCli ? instructions : undefined,
        system: live.spec.kind === 'claude' ? instructions : undefined,
      }
      live.engineSession = await live.engine.open(sessionId, openArgs)
        .catch((error) => {
          live.releaseSlot?.()
          live.releaseSlot = undefined
          throw toLlmError(error, live)
        })
      // A resumed CLI reports its id only with `system/init`: keep the saved one
      // in the meantime, or a resume that fails would erase it.
      const reportedId = live.engineSession.acpSessionId ?? live.engineSession.threadId ?? live.engineSession.cliSessionId
      if (reportedId !== undefined) live.cliSessionId = reportedId
      live.started = true
      // The session's events feed this Session's queue: a call from any engine
      // kind reaches drain() through live.next().
      const session = live.engineSession
      const token = live.pumpToken = {}
      void (async () => {
        while (live.pumpToken === token && !live.dead) {
          const event = await session.next()
          if (live.pumpToken === token && !live.dead) live.push(event)
        }
      })()
      if (live.spec.kind !== 'acp' && instructions !== undefined) live.promptHash = promptHash
      this.deps.saveRecord(sessionId, { route: live.route, cliSessionId: live.cliSessionId, cwd, handedId: live.handed, promptHash: live.promptHash ?? promptHash, model: options.model })
      // Claude reports its session id with `system/init`, after start() resolved:
      // the record above has no id yet, so persist it when it lands or the next
      // host has nothing to resume and the conversation starts over.
      const pendingId = session.whenSessionId?.()
      if (pendingId !== undefined) {
        void pendingId.then((id) => {
          if (id === undefined || live.dead) return
          live.cliSessionId = id
          this.deps.saveRecord(sessionId, { route: live.route, cliSessionId: id, cwd, handedId: live.handed, promptHash: live.promptHash ?? promptHash, model: options.model })
        })
      }
    }

    let promptText = fresh ? renderReplay(messages, system)
      : [contextText, ...remaining.map(message => textOf(message.content))].filter(text => text !== '').join('\n\n')
    let sentInstructions = live.spec.kind !== 'acp' && freshCli && instructions !== undefined
    // A new CLI session gets its instructions in the open args or the replay;
    // the "updated" line is only for a session that saw older ones.
    if (instructions !== undefined && !freshCli && live.promptHash !== promptHash) {
      const updated = `Updated team instructions (replace earlier ones):\n\n${instructions}`
      if (live.spec.kind === 'codex') {
        await live.engine.instruct?.(live.engineSession, updated)
        sentInstructions = true
      } else if (promptText !== '' || live.spec.kind === 'acp' || live.spec.kind === 'claude') {
        promptText = `${updated}\n\n${promptText}`
        sentInstructions = true
      }
    }
    if (promptText !== '') {
      this.sendInput(live, promptText, options.signal, options.reasoningEffort)
      if (sentInstructions) live.promptHash = promptHash
      // ACP only counts instructions once they reach the agent with a prompt.
      if (live.spec.kind === 'acp' && (freshCli || sentInstructions)) live.promptHash = promptHash
    }
    if (live.spec.kind === 'acp' && freshCli && promptText === '' && instructions !== undefined) {
      this.sendInput(live, `Follow these instructions from the user's team for everything you do here. They sit on top of your own; when they conflict, these win.\n\n${instructions}`, options.signal, options.reasoningEffort)
      live.promptHash = promptHash
    }

    // The last DSH message is handed now; a later call sends only what follows.
    // The marker before it is kept: a start that fails before the CLI reads
    // anything must not count that message as delivered.
    const last = messages.at(-1)
    if (last !== undefined) {
      live.handedBefore = live.handed
      live.handed = last.id
      this.deps.saveRecord(sessionId, { route: live.route, cliSessionId: live.cliSessionId, cwd, handedId: live.handed, promptHash: live.promptHash ?? promptHash, model: options.model })
    }

    try {
      yield* this.drain(live, options)
      if (live.state === 'idle') this.egress?.resetRetryBudget?.(retryKey)
    } catch (error) {
      live.releaseSlot?.()
      live.releaseSlot = undefined
      // The caller sees the failure now: a start that died before reading its
      // prompt must not count as delivered, in case the host restarts next.
      this.rollbackUnread(live, sessionId)
      // The saved conversation is gone: start over in a new one with the
      // history, once, so the user sees the answer instead of this failure.
      if (live.resumeLost === true && options[RESUME_RETRIED] !== true) {
        live.resumeLost = false
        try { this.egress?.checkRetryBudget?.(retryKey) } catch (budgetError) { throw toLlmError(budgetError, live) }
        yield* this.stream({ ...options, [RESUME_RETRIED]: true, [RETRY_KEY]: retryKey })
        return
      }
      throw error
    }
  }

  // Input for the CLI: a fresh prompt while it is idle; while a turn runs or
  // waits on a bridged call, steering for Codex and Claude, or a queued prompt
  // for ACP (it speaks one prompt at a time; the drain sends it when the turn
  // ends, inside the same stream). The prompt request itself stays open for
  // the whole turn (ACP session/prompt ends when the agent's turn does), so it
  // is sent but not awaited; a send failure lands in the queue as an error.
  sendInput(live, text, signal, effort) {
    if (live.state !== 'idle') {
      if (live.spec.kind === 'acp') { live.queue.push(text); return }
      try {
        Promise.resolve(live.engine.steer?.(live.engineSession, text))
          .catch(error => live.push({ type: 'error', error }))
      } catch (error) {
        live.push({ type: 'error', error })
      }
      return
    }
    live.state = 'running'
    try {
      Promise.resolve(live.engine.prompt(live.engineSession, [{ type: 'text', text }], { signal, effort }))
        .catch(error => live.push({ type: 'error', error }))
    } catch (error) {
      live.push({ type: 'error', error })
    }
  }

  // Consume the CLI's events until the turn ends or a bridged call suspends it.
  async *drain(live, options) {
    let index = 0
    let textBuf = ''
    let textIndex = -1
    let thinkBuf = ''
    let thinkIndex = -1
    // Open text and reasoning stay open in parallel; each closes when it has to.
    const closeBlocks = function* () {
      if (textIndex !== -1) { yield { type: 'block-end', index: textIndex, block: { type: 'text', text: textBuf } }; textIndex = -1; textBuf = '' }
      if (thinkIndex !== -1) { yield { type: 'block-end', index: thinkIndex, block: { type: 'reasoning', text: thinkBuf } }; thinkIndex = -1; thinkBuf = '' }
    }
    const emitCalls = (calls) => {
      const chunks = []
      calls.forEach((call, offset) => {
        const at = index + offset
        chunks.push(
          { type: 'block-start', index: at, blockType: 'tool-call' },
          { type: 'tool-call-delta', index: at, id: call.dshCallId, name: call.name, argumentsDelta: JSON.stringify(call.args ?? {}) },
          { type: 'block-end', index: at, block: { type: 'tool-call', id: call.dshCallId, name: call.name, arguments: JSON.stringify(call.args ?? {}) } },
        )
      })
      index += calls.length
      return chunks
    }
    // One abort promise for the whole drain: the earlier version added a
    // listener per event and never removed it.
    live.activeSignal = options.signal
    let abortReject
    const abortPromise = new Promise((_, reject) => { abortReject = reject })
    const onAbort = () => abortReject(options.signal?.reason ?? new Error('aborted'))
    if (options.signal?.aborted) onAbort()
    else options.signal?.addEventListener('abort', onAbort)
    if (live.governed && Number.isSafeInteger(live.lease?.lease_expires_at_ms)) {
      const nowMs = typeof this.deps.rt?.now === 'function' ? this.deps.rt.now() : Date.now()
      const remaining = live.lease.lease_expires_at_ms - nowMs
      if (remaining <= 0) {
        const expired = new LlmError('ANVIL lease expired', 'ANVIL_DENIED')
        this.stopTurn(live, expired.message, { forceKill: true, close: false })
        await this.closeLive(live, { error: expired })
        options.signal?.removeEventListener('abort', onAbort)
        throw expired
      }
      clearTimeout(live.expiryTimer)
      live.expiryTimer = setTimeout(() => {
        const expired = new LlmError('ANVIL lease expired', 'ANVIL_DENIED')
        this.stopTurn(live, expired.message, { forceKill: true, close: true, error: expired })
      }, Math.min(remaining, 2_147_483_647))
      live.expiryTimer.unref?.()
    }
    try {
    for (;;) {
      const event = await Promise.race([live.next(), abortPromise]).catch(error => ({ type: 'abort', error }))
      if (event.type === 'abort') {
        this.stopTurn(live, 'the turn was stopped', { forceKill: live.governed || live.spec.kind === 'claude', close: live.governed })
        yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'the turn was stopped' } } }
        return
      }
      switch (event.type) {
        case 'text': {
          if (textIndex === -1) {
            if (thinkIndex !== -1) { yield { type: 'block-end', index: thinkIndex, block: { type: 'reasoning', text: thinkBuf } }; thinkIndex = -1; thinkBuf = '' }
            yield { type: 'block-start', index: index++, blockType: 'text' }
            textIndex = index - 1
          }
          textBuf += event.text
          yield { type: 'text-delta', index: textIndex, text: event.text }
          break
        }
        case 'thought':
        case 'activity': {
          // An activity line stands on its own line of the reasoning, which is
          // how the chat tells it from the thought around it.
          const text = event.type === 'activity' ? `${thinkBuf === '' || thinkBuf.endsWith('\n') ? '' : '\n'}${event.text}\n` : event.text
          if (thinkIndex === -1) {
            if (textIndex !== -1) { yield { type: 'block-end', index: textIndex, block: { type: 'text', text: textBuf } }; textIndex = -1; textBuf = '' }
            yield { type: 'block-start', index: index++, blockType: 'reasoning' }
            thinkIndex = index - 1
          }
          thinkBuf += text
          yield { type: 'reasoning-delta', index: thinkIndex, text }
          break
        }
        case 'usage': yield { type: 'usage', usage: event.usage }; break
        case 'call': {
          yield* closeBlocks()
          live.state = 'suspended'
          // A team tool the CLI invoked over the loopback MCP server.
          for (const chunk of emitCalls([{ name: event.name, args: event.args, dshCallId: event.dshCallId }])) yield chunk
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        case 'permission': {
          // The preset answers what it already decides, also on an agent with no
          // matching mode of its own: full access allows, read-only refuses a change.
          const answer = presetAnswer(this.deps.presetFor(live.sessionId), event)
          if (answer !== undefined) { event.reply(answer); break }
          yield* closeBlocks()
          live.state = 'suspended'
          // The CLI's own permission prompt, bridged as an approval tool call.
          const call = { name: APPROVE_TOOL, args: { action: event.action, ...(event.detail ? { detail: event.detail } : {}) }, dshCallId: event.id }
          live.pending.set(event.id, { name: APPROVE_TOOL, resolve: (result) => event.reply(pickAllowOption(event.options, result)) })
          for (const chunk of emitCalls([call])) yield chunk
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        case 'done': {
          yield* closeBlocks()
          if (event.usage !== undefined) yield { type: 'usage', usage: event.usage }
          live.state = 'idle'
          // Input queued while this turn ran goes out as the next prompt
          // inside the same drain (ACP takes one prompt at a time).
          const next = live.queue.shift()
          if (next !== undefined) {
            this.sendInput(live, next, options.signal, options.reasoningEffort)
            break
          }
          live.releaseSlot?.()
          live.releaseSlot = undefined
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        case 'error': {
          live.state = 'idle'
          live.releaseSlot?.()
          live.releaseSlot = undefined
          throw toLlmError(event.error, live)
        }
        default: break
      }
    }
    } finally {
      clearTimeout(live.expiryTimer)
      live.expiryTimer = undefined
      live.activeSignal = undefined
      options.signal?.removeEventListener('abort', onAbort)
    }
  }

  async dispose() {
    this.disposed = true
    for (const live of Array.from(this.live.values())) await this.closeLive(live)
    for (const engine of Array.from(this.engines.values())) await engine.close?.().catch(() => {})
    this.engines.clear()
  }
}

// The result DSH gives approve_agent_action decides the agent's option: only
// the structured {"decision":"allow"} the tool returns on approval counts;
// free text, a parse failure, an error or a denial rejects the action.
function pickAllowOption(options, result) {
  if (result.isError === true) return null
  let decision
  try { decision = JSON.parse(result.text ?? '')?.decision } catch { decision = undefined }
  if (decision !== 'allow') return null
  return optionOf(options, 'allow') ?? null
}

// The agent's one-time option of a kind ('allow' or 'reject'), else any of it.
// A one-time allow leaves the agent's own saved rules as they were.
const optionOf = (options, kind) => ((options ?? []).find(entry => entry.kind === `${kind}_once`)
  ?? (options ?? []).find(entry => (entry.kind ?? '').startsWith(kind)))?.optionId

// What the preset answers without asking: an option id, null to refuse, or
// undefined to ask the user.
function presetAnswer(preset, event) {
  if (preset === 'danger-full-access') return optionOf(event.options, 'allow')
  if (preset === 'read-only' && event.changes === true) return optionOf(event.options, 'reject') ?? null
  return undefined
}

// The replay a fresh CLI session stands up on: the system prompt, then the
// recent messages rendered as text, newest first, always with the latest input
// and the handoff a new part opens with, both word for word.
function renderReplay(messages, system) {
  const picked = []
  let used = 0
  const body = (messages ?? []).filter(message => message.role !== 'system')
  const latest = body.at(-1)
  let full = false
  for (const message of [...body].reverse()) {
    const whole = message === latest || message.source?.handoff === true
    const text = textOf(message.content)
    const line = `${message.role === 'assistant' ? 'You' : message.role === 'tool' ? `Tool result (${message.toolCallId ?? 'call'})` : 'User'}: ${whole ? text : text.slice(0, 2_000)}`
    if (whole) { picked.unshift(line); used += line.length; continue }
    full ||= picked.length >= REPLAY_MESSAGES || used + line.length > REPLAY_BYTES
    if (full) continue
    picked.unshift(line)
    used += line.length
  }
  if (picked.length === 0) return ''
  const head = system === '' ? '' : `The team instructions for this conversation:\n${system}\n\n`
  return `${head}The conversation so far (oldest first):\n\n${picked.join('\n\n')}`
}

// Process exits, missing CLIs, quota and sign-in failures get typed codes so DS
// Bot's repair card can act on them.
function toLlmError(error, live) {
  if (error instanceof LlmError) return error
  const text = String(error?.message ?? error)
  const code = error instanceof EgressDeniedError || error?.code === 'ANVIL_DENIED' || error?.code === 'DEPTH_EXCEEDED' || error?.code === 'CONCURRENCY_LIMIT' || error?.code === 'RETRY_LIMIT'
    ? error.code
    : error?.code === 'NO_ADAPTER' ? 'LOCAL_AGENT_MISSING'
      : /not signed in|not logged in|login required|unauthorized|authentication/i.test(text) ? 'LOCAL_AGENT_SIGNIN'
        : /quota|rate.?limit|usage limit|exceeded/i.test(text) ? 'LOCAL_AGENT_QUOTA'
          : /exited|spawn|ENOENT/i.test(text) ? 'LOCAL_AGENT_EXIT'
            : error?.code ?? 'LOCAL_AGENT_ERROR'
  const hint = code === 'LOCAL_AGENT_SIGNIN' ? ` Sign in with: ${live?.spec?.signIn ?? `${live?.spec?.command ?? 'the CLI'} login`}.` : ''
  return new LlmError(`${text}${hint}`, code, error?.status === undefined ? {} : { status: error.status })
}
