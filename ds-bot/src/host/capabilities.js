import { createHash } from 'node:crypto'
import { createEgressController, readService } from './egress.js'
import { encodeUrlComponent } from './secrets.js'
import { own } from './store.js'

const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client'
const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const SECRET_REFERENCE = /\$DSH_SECRET_([A-Z][A-Z0-9_]*)/g
const ENSURE_TIMEOUT_MS = 15_000
const DEFAULT_HEALTH_PROBE_MS = 15_000

export const DEFAULT_CAPABILITY_RETRY = Object.freeze({
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  maxAttempts: 24,
})

const MCP_LOG_RE = /^mcp-client\(([^)]+)\):\s*(.+)$/i
const RUNTIME_DISCONNECT_RE = /connection lost|giving up after|failed generation could not confirm|tool re-sync failed/i

function errorTexts(error) {
  const parts = []
  let cur = error
  for (let i = 0; i < 4 && cur !== undefined && cur !== null; i += 1) {
    if (typeof cur === 'string') parts.push(cur)
    else {
      if (cur.code) parts.push(String(cur.code))
      if (cur.syscall) parts.push(String(cur.syscall))
      if (cur.message) parts.push(String(cur.message))
    }
    cur = typeof cur === 'object' ? cur.cause : undefined
  }
  return parts.join(' | ')
}

export function classifyCapabilityError(error, item) {
  if (error?.permanent === true || error?.configError === true) return { permanent: true, kind: 'config' }
  if (error?.transient === true) return { permanent: false, kind: 'transient' }
  if (error?.code === 'NO_ADAPTER') return { permanent: true, kind: 'missing-binary' }
  const text = errorTexts(error)
  if (/Limited to Main Bots|Unknown Bot|Secret .+ is missing or unavailable/i.test(text)) {
    return { permanent: true, kind: 'config' }
  }
  if (/no current ANVIL observation|session observation unavailable|temporarily unavailable/i.test(text)) {
    return { permanent: false, kind: 'transient' }
  }
  if (error?.code === 'ANVIL_DENIED') return { permanent: true, kind: 'authority' }
  if (/ANVIL admission denied|lease expired|foreign agent|mismatched session|foreign native_id|stale lease|invalid lease/i.test(text)) {
    return { permanent: true, kind: 'authority' }
  }
  if (/serverName .+ already in use|exceeds maxInstructionBytes|Method not found|Unsupported protocol|Invalid params|-3260[012]|protocol mismatch|invalid configuration/i.test(text)) {
    return { permanent: true, kind: 'protocol' }
  }
  if (/EACCES|EPERM|\b(?:401|403)\b|unauthorized|forbidden|permission denied|authentication failed|invalid[_ ]token|invalid_client/i.test(text)) {
    return { permanent: true, kind: 'auth' }
  }
  const missingBinary = (/spawn\s+.+\s+ENOENT|ENOENT:\s*spawn|command not found|is not installed/i.test(text)
    || (error?.code === 'ENOENT' && typeof error?.syscall === 'string' && error.syscall.startsWith('spawn')))
    && !/\.sock\b|daemon listening/i.test(text)
  if (missingBinary || (item?.command && text.includes(`spawn ${item.command} ENOENT`))) {
    return { permanent: true, kind: 'missing-binary' }
  }
  return { permanent: false, kind: 'transient' }
}

// Connector ids are reserved: a capability named like one would collide with
// its mcp__<id>__* tool prefix. The connectors module registers its ids here.
export const CONNECTOR_IDS = new Set(['github', 'mail'])
export function validateCapabilityName(value, reserved = CONNECTOR_IDS) {
  const name = String(value ?? '').trim()
  if (name.length > 32 || !NAME.test(name) || name === 'github' || reserved.has(name)) {
    throw new Error('Use a capability name with lowercase letters, digits, and single hyphens; connector names are reserved.')
  }
  return name
}

export function expandCapabilityNames(capabilities, library) {
  const expanded = new Set()
  for (const name of capabilities ?? []) {
    const item = own(library, name)
    if (!item) throw new Error(`No capability named ${name}.`)
    if (item.kind === 'pack') {
      for (const childName of item.items ?? []) {
        const child = own(library, childName)
        if (!child || !['mcp', 'skill'].includes(child.kind)) throw new Error(`Pack ${name} refers to an unavailable capability ${childName}.`)
        expanded.add(childName)
      }
    } else if (item.kind === 'mcp' || item.kind === 'skill') {
      expanded.add(name)
    } else {
      throw new Error(`Capability ${name} has an unknown kind.`)
    }
  }
  return expanded
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const strings = value => {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error('Arguments must be a list of text values.')
  return [...value]
}
const stringMap = (value, label) => {
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.values(value).some(item => typeof item !== 'string')) throw new Error(`${label} must contain text values.`)
  return Object.fromEntries(Object.entries(value))
}

// ---- servers named in the profile's config.capabilities ----

const BOTS_CHOICES = ['none', 'main', 'all']
// YAML reads `PORT: 8080` as a number; a setting the user wrote may say so.
const configText = value => (typeof value === 'number' || typeof value === 'boolean' ? String(value) : value)
const configStrings = value => (value === undefined || value === null ? [] : strings(Array.isArray(value) ? value.map(configText) : value))
const configMap = (value, label) => {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must contain text values.`)
  return stringMap(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, configText(item)])), label)
}

// The valid entries of `config.capabilities`, in the shape the library keeps them plus `bots`
// (who they are switched on for) and a `hash` of the definition. A bad entry is reported
// through `warn(label, reason)` and skipped; the rest still load.
export function parseConfiguredCapabilities(raw, warn = () => {}) {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    warn('config.capabilities', 'the setting must be a list')
    return []
  }
  const entries = []
  const names = new Set()
  raw.forEach((value, index) => {
    const label = typeof value?.name === 'string' && value.name !== '' ? value.name : `entry ${index + 1}`
    try {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('an entry must be a mapping')
      const name = validateCapabilityName(value.name)
      if (names.has(name)) throw new Error('the name is listed twice')
      if (value.kind !== undefined && value.kind !== 'mcp') throw new Error('only MCP servers (kind: mcp) can be configured')
      const bots = value.bots ?? 'none'
      if (!BOTS_CHOICES.includes(bots)) throw new Error('bots must be none, main or all')
      const entry = { name, description: String(value.description ?? '').trim().slice(0, 2000), bots }
      const transport = value.transport ?? (value.url !== undefined ? 'http' : 'stdio')
      if (transport === 'stdio') {
        const command = typeof value.command === 'string' ? value.command.trim() : ''
        if (command === '') throw new Error('a stdio server needs a command')
        Object.assign(entry, { transport: 'stdio', command, args: configStrings(value.args), env: configMap(value.env, 'Environment variables') })
      } else if (transport === 'http' || transport === 'streamable-http') {
        const url = typeof value.url === 'string' ? value.url.trim() : ''
        let parsed
        try { parsed = new URL(url) } catch { /* reported below */ }
        if (parsed?.protocol !== 'https:' && parsed?.protocol !== 'http:') throw new Error('an http server needs a valid http or https url')
        Object.assign(entry, { transport: 'streamable-http', url, headers: configMap(value.headers, 'Headers') })
      } else {
        throw new Error('transport must be stdio or http')
      }
      entry.hash = createHash('sha256').update(JSON.stringify(entry)).digest('hex').slice(0, 16)
      names.add(name)
      entries.push(entry)
    } catch (error) {
      warn(label, error.message)
    }
  })
  return entries
}

// The names a config.capabilities list names, valid or not, or null when the setting is not a
// list. An entry that is only invalid is still the user's: a typo in it must not withdraw a server.
export function listedCapabilityNames(raw) {
  if (raw === undefined || raw === null) return new Set()
  if (!Array.isArray(raw)) return null
  return new Set(raw.map(entry => (typeof entry?.name === 'string' ? entry.name.trim() : '')).filter(name => name !== ''))
}

export function install(rt) {
  const { ctx, state } = rt
  const configured = parseConfiguredCapabilities(rt.config?.capabilities, (label, reason) => rt.warn?.('ds-bot: configured capability %s skipped: %s', label, reason))
  const listed = listedCapabilityNames(rt.config?.capabilities)
  // Who a configured server is for, by name: `bots: main` limits it to Main Bots. It is read from
  // the live config and applies to the item only while the item is still the config's own, so
  // an item the user rewrote in Settings (which drops the mark) is theirs to share as they like.
  const botsOf = new Map(configured.map(entry => [entry.name, entry.bots]))
  const limitedToMain = name => own(state.capabilities?.items ?? {}, name)?.source === 'config' && botsOf.get(name) === 'main'
  const agents = new Map()
  // Mounted fibers live in each Agent's own context, so they outlive this plugin unless
  // its cleanup disposes them; a strong map keeps them reachable for that.
  const mounts = new Map()
  // One reconcile chain per Agent: a slow MCP server holds up only its own Agent.
  const chains = new WeakMap()
  const queued = new WeakSet()
  const supervisors = new WeakMap() // agent -> Map<name, supervisor>
  const healthTimers = new WeakMap()
  const observedLoggers = new WeakSet()
  const sessionStatuses = new Map()
  const egress = rt.egress ?? (ctx ? createEgressController(rt) : undefined)
  let pluginPromise
  let scheduled = null
  let loadingSecrets = 0
  let stopped = false

  const retryPolicy = () => ({
    ...DEFAULT_CAPABILITY_RETRY,
    ...rt.capabilityRetryPolicy,
  })
  const getSup = (agent, name) => {
    let byName = supervisors.get(agent)
    if (!byName) supervisors.set(agent, byName = new Map())
    let sup = byName.get(name)
    if (!sup) byName.set(name, sup = { generation: 0, retryTimer: undefined, attempts: 0, lastKey: undefined, lastPermanent: false })
    return sup
  }
  const clearRetry = (sup) => {
    if (!sup?.retryTimer) return
    clearTimeout(sup.retryTimer)
    sup.retryTimer = undefined
  }
  const clearAgentTimers = (agent) => {
    const byName = supervisors.get(agent)
    if (byName) {
      for (const sup of byName.values()) {
        sup.generation += 1
        clearRetry(sup)
      }
      byName.clear()
    }
    const timer = healthTimers.get(agent)
    if (timer) {
      clearInterval(timer)
      healthTimers.delete(agent)
    }
  }

  const library = () => state.capabilities.items
  const ensureLibrary = () => {
    state.capabilities ??= { items: {} }
    state.capabilities.items ??= {}
    return library()
  }
  const writeCheck = () => {
    const readOnly = rt.readOnly()
    if (readOnly !== undefined) throw new Error(readOnly)
  }
  // A server from the profile config is the user's own: it is approved, owned by no Bot, and
  // marked `source: 'config'` until someone changes it in Settings (a save builds the item
  // anew, without the mark).
  const itemFromConfig = (entry, now, previous) => ({
    name: entry.name,
    kind: 'mcp',
    description: entry.description,
    createdBy: null,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    ...(entry.transport === 'stdio'
      ? { transport: 'stdio', command: entry.command, args: [...entry.args], env: { ...entry.env }, approved: true }
      : { transport: 'streamable-http', url: entry.url, headers: { ...entry.headers }, approved: true }),
    source: 'config',
  })
  // Adds each configured server the library has never had, and switches it on for the Bots its
  // `bots` names, once per Bot. What was seeded is remembered by name in
  // state.capabilities.seeded, so a server the user later removes stays removed, a Bot the user
  // detaches it from stays detached, and an item the user edited is never overwritten. An item
  // still marked as from the config follows the config when the definition changes.
  // The config is the trust root of what it seeded: a server whose entry is gone from the list
  // (removed because it was compromised or is no longer wanted) leaves the library, every Bot and
  // every pack with it, and its record here; adding the entry again seeds it afresh. A setting
  // that is not a list, or an entry that is only invalid, withdraws nothing.
  // The state changes before this returns; the promise settles once it is saved.
  const seedConfigured = () => {
    if (stopped || rt.readOnly() !== undefined) return undefined
    const current = state.capabilities?.items ?? {}
    const recorded = state.capabilities?.seeded
    const withdrawn = listed === null ? [] : Object.values(current).filter(item => item.source === 'config' && !listed.has(item.name))
    const stale = listed === null || recorded === null || typeof recorded !== 'object' || Array.isArray(recorded) ? [] : Object.keys(recorded).filter(name => !listed.has(name))
    if (configured.length === 0 && withdrawn.length === 0 && stale.length === 0) return undefined
    const items = ensureLibrary()
    if (state.capabilities.seeded === null || typeof state.capabilities.seeded !== 'object' || Array.isArray(state.capabilities.seeded)) state.capabilities.seeded = {}
    const seeded = state.capabilities.seeded
    const now = Date.now()
    const filled = []
    let changed = false
    for (const item of withdrawn) {
      removeItem(items, item.name)
      rt.warn?.('ds-bot: configured capability %s is no longer in the configuration; it was removed from the library and from every Bot', item.name)
      changed = true
    }
    for (const name of stale) {
      delete seeded[name]
      changed = true
    }
    for (const entry of configured) {
      let record = own(seeded, entry.name)
      if (record === null || typeof record !== 'object' || Array.isArray(record)) {
        const fresh = record === undefined
        record = seeded[entry.name] = { hash: entry.hash, bots: [] }
        changed = true
        if (fresh && own(items, entry.name) === undefined) items[entry.name] = itemFromConfig(entry, now)
      } else if (own(items, entry.name)?.source === 'config' && record.hash !== entry.hash) {
        items[entry.name] = itemFromConfig(entry, now, items[entry.name])
        record.hash = entry.hash
        changed = true
      }
      if (!Array.isArray(record.bots)) record.bots = []
      const live = own(items, entry.name)
      const known = record.bots.filter(id => own(state.bots, id) !== undefined)
      if (known.length !== record.bots.length) {
        record.bots = known
        changed = true
      }
      if (live?.source !== 'config' || entry.bots === 'none') continue
      for (const bot of Object.values(state.bots)) {
        if (record.bots.includes(bot.id) || (entry.bots === 'main' && !rt.isMain(bot.id))) continue
        record.bots.push(bot.id)
        changed = true
        bot.capabilities ??= []
        if (bot.capabilities.includes(entry.name)) continue
        if (bot.capabilities.length === 0) filled.push(bot)
        bot.capabilities.push(entry.name)
      }
    }
    if (!changed) return undefined
    return rt.save()
      .then(() => Promise.all(filled.map(bot => trackBotAgents(bot))))
      .catch(error => rt.warn('ds-bot: saving the configured capabilities failed: %s', error))
  }
  // Takes an item out of the library, out of every pack and off every Bot.
  const removeItem = (items, name) => {
    delete items[name]
    for (const pack of Object.values(items)) if (pack.kind === 'pack') pack.items = (pack.items ?? []).filter(child => child !== name)
    for (const bot of Object.values(state.bots)) bot.capabilities = (bot.capabilities ?? []).filter(attached => attached !== name)
  }
  const allowedToEdit = (item, botId) => rt.isMain(botId) || item.createdBy === botId
  const usedByOthers = (name, botId) => Object.values(state.bots).some(bot => bot.id !== botId
    && (bot.capabilities ?? []).some((attached) => {
      const item = own(library(), attached)
      return attached === name || (item?.kind === 'pack' && (item.items ?? []).includes(name))
    }))
  // A creator that is not a Main Bot could otherwise rewrite what a Main Bot runs.
  const editCheck = (item, botId, verb) => {
    if (!allowedToEdit(item, botId)) throw new Error(`Only ${item.createdBy ? 'its creator or a Main Bot' : 'a Main Bot'} can ${verb} ${item.name}.`)
    if (!rt.isMain(botId) && usedByOthers(item.name, botId)) throw new Error(`Another Bot uses ${item.name}, so only a Main Bot can ${verb} it.`)
  }
  const itemInput = (body, { botId, ui }) => {
    const name = validateCapabilityName(body.name)
    const kind = body.kind
    if (!['mcp', 'skill', 'pack'].includes(kind)) throw new Error('Choose an MCP server, skill, or pack.')
    const items = ensureLibrary()
    const previous = own(items, name)
    if (previous && !ui) editCheck(previous, botId, 'change')
    if (previous && previous.kind !== kind) throw new Error('A capability cannot change its kind. Delete it and save a new one.')
    const now = Date.now()
    const item = {
      name,
      kind,
      description: String(body.description ?? '').trim().slice(0, 2000),
      createdBy: previous?.createdBy ?? (ui ? null : botId),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    }
    if (kind === 'mcp') {
      const transport = body.transport === 'streamable-http' ? 'streamable-http' : 'stdio'
      if (transport === 'stdio') {
        const command = String(body.command ?? '').trim()
        if (command === '') throw new Error('Enter a command for the MCP server.')
        const args = strings(body.args)
        const env = stringMap(body.env, 'Environment variables')
        const changed = !previous || previous.kind !== 'mcp' || previous.transport !== 'stdio'
          || previous.command !== command || !same(previous.args ?? [], args) || !same(previous.env ?? {}, env)
        Object.assign(item, { transport, command, args, env, approved: ui ? true : changed ? false : previous.approved === true })
      } else {
        const url = String(body.url ?? '').trim()
        try {
          const parsed = new URL(url)
          if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error()
        } catch { throw new Error('Enter a valid HTTP or HTTPS URL.') }
        Object.assign(item, { transport, url, headers: stringMap(body.headers, 'Headers'), approved: true })
      }
    } else if (kind === 'skill') {
      item.content = String(body.content ?? '').trim()
    } else {
      const names = [...new Set(strings(body.items))]
      for (const childName of names) {
        const child = own(items, childName)
        if (!child || !['mcp', 'skill'].includes(child.kind)) throw new Error(`Packs can include only saved MCP servers and skills. ${childName} is not one.`)
      }
      item.items = names
    }
    items[name] = item
    return item
  }
  const capabilitySave = async (body, options = {}) => {
    await rt.load()
    writeCheck()
    const item = itemInput(body ?? {}, options)
    await rt.save()
    return item
  }
  const capabilityDelete = async (name, { botId, ui } = {}) => {
    await rt.load()
    writeCheck()
    const items = ensureLibrary()
    const item = own(items, String(name ?? ''))
    if (!item) throw new Error(`No capability named ${name}.`)
    if (!ui) editCheck(item, botId, 'delete')
    removeItem(items, item.name)
    await rt.save()
    return true
  }
  // Called with the Bot being deleted, after it left the team. The shared list belongs to
  // the user, so only a local MCP this Bot added, nobody approved and no other Bot or pack
  // uses goes: no one is left to ask for it, and approving it would start a server for no one.
  // Anything a pack lists stays.
  const dropOrphanCapabilities = (bot) => {
    const items = library()
    const packed = name => Object.values(items).some(item => item.kind === 'pack' && (item.items ?? []).includes(name))
    for (const name of bot.capabilities ?? []) {
      const item = own(items, name)
      if (item === undefined || item.kind !== 'mcp' || item.transport !== 'stdio' || item.approved === true) continue
      if (item.createdBy !== bot.id || usedByOthers(name, bot.id) || packed(name)) continue
      delete items[item.name]
    }
  }
  const changeAttachment = async (endpoint, { name, bot: targetRef }, callerId) => {
    await rt.load()
    writeCheck()
    const caller = rt.botOf(callerId)
    if (!caller) throw new Error('Only Bots on the team can change capabilities.')
    const target = targetRef ? rt.findBot(targetRef) : caller
    if (!target) throw new Error(`No Bot named ${targetRef}.`)
    if (target.id !== caller.id && !rt.isMain(callerId)) throw new Error('Only a Main Bot can change another Bot’s capabilities.')
    const item = own(ensureLibrary(), String(name ?? ''))
    if (!item) throw new Error(`No capability named ${name}.`)
    if (endpoint === 'attach' && !rt.isMain(target.id)) {
      const members = item.kind === 'pack' ? (item.items ?? []) : [item.name]
      const limited = members.find(limitedToMain)
      if (limited !== undefined) throw new Error(`${limited} is limited to Main Bots by this host's configuration (bots: main); ${target.name} is not one.`)
    }
    await setAttached(target, item.name, endpoint === 'attach')
    return { bot: target.name, attached: endpoint === 'attach' }
  }
  // Changes one name against the saved list, so two quick changes both land.
  const setAttached = async (bot, name, attached) => {
    bot.capabilities ??= []
    const wasEmpty = bot.capabilities.length === 0
    if (attached && !bot.capabilities.includes(name)) bot.capabilities.push(name)
    if (!attached) bot.capabilities = bot.capabilities.filter(entry => entry !== name)
    await rt.save()
    if (wasEmpty && bot.capabilities.length > 0) {
      await trackBotAgents(bot)
      void scheduleReconcile()
    }
    return bot.capabilities
  }

  const statusSet = (botId, itemName, sessionId, status) => {
    let byItem = sessionStatuses.get(botId)
    if (!byItem) sessionStatuses.set(botId, byItem = new Map())
    let bySession = byItem.get(itemName)
    if (!bySession) byItem.set(itemName, bySession = new Map())
    bySession.set(sessionId, status)
  }
  const clearStatus = (botId, itemName, sessionId) => {
    const byItem = sessionStatuses.get(botId)
    const bySession = byItem?.get(itemName)
    bySession?.delete(sessionId)
    if (bySession?.size === 0) byItem.delete(itemName)
    if (byItem?.size === 0) sessionStatuses.delete(botId)
  }
  const clearSession = sessionId => {
    for (const [botId, byItem] of sessionStatuses) {
      for (const [name, bySession] of byItem) {
        bySession.delete(sessionId)
        if (bySession.size === 0) byItem.delete(name)
      }
      if (byItem.size === 0) sessionStatuses.delete(botId)
    }
  }
  const statusFor = (botId, name) => {
    const values = [...(sessionStatuses.get(botId)?.get(name)?.values() ?? [])]
    if (values.some(status => status.state === 'error')) return values.find(status => status.state === 'error')
    if (values.some(status => status.state === 'needs-approval')) return { state: 'needs-approval' }
    if (values.some(status => status.state === 'connecting')) return { state: 'connecting' }
    return values.length > 0 ? { state: 'ready' } : undefined
  }
  const capabilityStatusesView = () => {
    const result = {}
    for (const bot of Object.values(state.bots)) {
      const statuses = {}
      for (const name of bot.capabilities ?? []) {
        const item = own(library(), name)
        if (!item) continue
        if (item.kind !== 'pack') {
          const status = statusFor(bot.id, name)
          if (status) statuses[name] = status
          continue
        }
        const children = (item.items ?? []).map(child => statusFor(bot.id, child)).filter(Boolean)
        const status = children.find(status => status.state === 'error')
          ?? children.find(status => status.state === 'needs-approval')
          ?? children.find(status => status.state === 'connecting')
          ?? children[0]
        if (status) statuses[name] = status
      }
      result[bot.id] = statuses
    }
    return result
  }
  const libraryView = () => Object.values(library()).map(item => ({
    ...item,
    ...(item.env ? { env: { ...item.env } } : {}),
    ...(item.headers ? { headers: { ...item.headers } } : {}),
    ...(item.items ? { items: [...item.items] } : {}),
  }))

  async function loadMcpPlugin() {
    if (!pluginPromise) {
      pluginPromise = (async () => {
        const loader = ctx.get?.('loader')
        if (typeof loader?.import !== 'function') throw new Error('This DSH cannot load MCP servers.')
        const exports = await loader.import(MCP_CLIENT)
        return loader.unwrapExports?.(exports) ?? exports?.default ?? exports
      })()
    }
    return pluginPromise
  }
  function secretFor(name, botId) {
    const value = rt.canUseSecret(name, botId) ? rt.secretValue(name) : undefined
    if (value === undefined) throw new Error(`Secret ${name} is missing or unavailable for this Bot.`)
    return value
  }
  function resolveValues(values, botId) {
    const resolved = {}
    for (const [key, raw] of Object.entries(values ?? {})) {
      resolved[key] = String(raw).replace(SECRET_REFERENCE, (_match, name) => secretFor(name, botId))
    }
    return resolved
  }
  const resolveUrl = (url, botId) => String(url).replace(SECRET_REFERENCE, (_match, name) => encodeUrlComponent(secretFor(name, botId)))
  const resolveList = (list, botId) => (list ?? []).map(raw => String(raw).replace(SECRET_REFERENCE, (_match, name) => secretFor(name, botId)))
  const configFor = (item, botId) => {
    if (item.kind === 'skill') return { name: item.name, description: item.description, content: item.content }
    const reconnect = { enabled: false }
    if (item.transport === 'stdio') return { transport: 'stdio', serverName: item.name, command: item.command, args: resolveList(item.args, botId), env: resolveValues(item.env, botId), failOnStartupError: true, reconnect }
    return { transport: 'streamable-http', serverName: item.name, url: resolveUrl(item.url, botId), headers: resolveValues(item.headers, botId), failOnStartupError: true, reconnect }
  }
  const disposeMount = async mount => {
    if (mount?.fiber) await Promise.resolve().then(() => mount.fiber.dispose()).catch(() => {})
  }
  const probeMcpAlive = async (agent, serverName) => {
    const mcpResources = readService(agent?.ctx, 'mcpResources')
    if (typeof mcpResources?.request !== 'function') return { alive: true }
    try {
      await mcpResources.request(serverName, { method: 'resources/list' }, { agent })
      return { alive: true }
    } catch (error) {
      return { alive: false, error }
    }
  }
  const readDiscoveredTools = (agent, serverName) => {
    const toolsSvc = readService(agent?.ctx, 'tools')
    if (typeof toolsSvc?.schemas !== 'function') return undefined
    const prefix = `mcp__${serverName}__`
    try {
      return toolsSvc.schemas(agent).filter(def => typeof def?.name === 'string' && def.name.startsWith(prefix)).map(def => def.name)
    } catch {
      return undefined
    }
  }
  const scheduleRetry = (agent, name, myGen) => {
    if (stopped) return
    const sessionId = agent?.session?.id
    if (typeof sessionId !== 'string' || agents.get(sessionId)?.deref() !== agent) return
    const sup = getSup(agent, name)
    if (sup.generation !== myGen) return
    clearRetry(sup)
    const policy = retryPolicy()
    sup.attempts += 1
    if (sup.attempts > policy.maxAttempts) {
      rt.warn?.('ds-bot: capability %s for %s exceeded max retries (%d)', name, sessionId, policy.maxAttempts)
      return
    }
    const baseDelay = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** (sup.attempts - 1))
    const jitter = policy.jitterRatio ? Math.floor(baseDelay * policy.jitterRatio * Math.random()) : 0
    const delayMs = Math.max(1, baseDelay + jitter)
    sup.retryTimer = setTimeout(() => {
      sup.retryTimer = undefined
      if (stopped || sup.generation !== myGen || agents.get(sessionId)?.deref() !== agent) return
      const currentBot = botOfSession(sessionId)
      if (!currentBot || !expandCapabilityNames(currentBot.capabilities, library()).has(name)) return
      void reconcileOne(agent)
    }, delayMs)
    sup.retryTimer.unref?.()
  }
  const handleRuntimeDisconnect = async (agent, name, reason) => {
    const sessionId = agent?.session?.id
    if (stopped || typeof sessionId !== 'string' || agents.get(sessionId)?.deref() !== agent) return
    const agentMounts = mounts.get(agent)
    const existing = agentMounts?.get(name)
    if (!existing || existing.connected !== true) return
    const sup = getSup(agent, name)
    sup.generation += 1
    const myGen = sup.generation
    existing.connected = false
    agentMounts.delete(name)
    const bot = botOfSession(sessionId)
    const message = rt.redactSecrets(String(reason || 'MCP server disconnected')).slice(0, 300)
    if (bot) statusSet(bot.id, name, sessionId, { state: 'error', error: message })
    await disposeMount(existing)
    if (stopped || sup.generation !== myGen || agents.get(sessionId)?.deref() !== agent) return
    const item = own(library(), name)
    if (!item) return
    const currentBot = botOfSession(sessionId)
    if (!currentBot || !expandCapabilityNames(currentBot.capabilities, library()).has(name)) return
    const { permanent } = classifyCapabilityError(new Error(message), item)
    sup.lastPermanent = permanent
    if (!permanent) scheduleRetry(agent, name, myGen)
  }
  const dispatchDisconnectLog = (text, { logFiber, logger } = {}) => {
    const match = MCP_LOG_RE.exec(text)
    if (!match || !RUNTIME_DISCONNECT_RE.test(match[2])) return
    const [, serverName, detail] = match
    const uid = logFiber?.uid
    for (const [, ref] of agents) {
      const target = ref.deref()
      if (!target) continue
      const mount = mounts.get(target)?.get(serverName)
      if (!mount || mount.connected !== true) continue
      if (uid !== undefined && mount.fiber?.uid !== undefined) {
        if (mount.fiber.uid !== uid) continue
        void handleRuntimeDisconnect(target, serverName, `${serverName}: ${detail}`)
      } else if (logger === undefined || target.ctx?.logger === logger) {
        void handleRuntimeDisconnect(target, serverName, `${serverName}: ${detail}`)
      }
    }
  }
  if (typeof ctx?.logger?.exporter === 'function') {
    try {
      ctx.logger.exporter({
        colors: 0,
        export(message) {
          if (stopped) return
          const text = Array.isArray(message?.args)
            ? message.args.map(part => String(part ?? '')).join(' ')
            : String(message?.content ?? '')
          dispatchDisconnectLog(text, { logFiber: message?.fiber?.deref?.() })
        },
      })
    } catch { /* fallback handled by per-agent observeLogger */ }
  }
  const observeLogger = (agent) => {
    const logger = agent?.ctx?.logger
    if (!logger || typeof logger.exporter === 'function' || observedLoggers.has(logger)) return
    observedLoggers.add(logger)
    for (const level of ['warn', 'error']) {
      const original = logger[level]
      if (typeof original !== 'function') continue
      try {
        logger[level] = function (...args) {
          dispatchDisconnectLog(args.map(part => String(part ?? '')).join(' '), { logger })
          return original.apply(this, args)
        }
      } catch { /* frozen logger object */ }
    }
  }
  const ensureHealthMonitor = (agent) => {
    if (stopped || healthTimers.has(agent)) return
    const mcpResources = readService(agent?.ctx, 'mcpResources')
    const intervalMs = rt.capabilityHealthProbeMs ?? (typeof mcpResources?.request === 'function' ? DEFAULT_HEALTH_PROBE_MS : undefined)
    if (!intervalMs || intervalMs <= 0) return
    const timer = setInterval(() => {
      if (stopped || agents.get(agent?.session?.id)?.deref() !== agent) {
        clearInterval(timer)
        healthTimers.delete(agent)
        return
      }
      const agentMounts = mounts.get(agent)
      if (!agentMounts || agentMounts.size === 0) return
      for (const [name, mount] of agentMounts) {
        if (mount.connected !== true || mount.kind !== 'mcp') continue
        void probeMcpAlive(agent, mount.serverName ?? name).then((probe) => {
          if (!probe.alive) void handleRuntimeDisconnect(agent, name, probe.error?.message ?? 'server is disconnected')
        })
      }
    }, intervalMs)
    timer.unref?.()
    healthTimers.set(agent, timer)
  }
  const mountOne = async (agent, bot, agentMounts, name) => {
    const sessionId = agent.session.id
    const item = own(library(), name)
    const sup = getSup(agent, name)
    const drop = async (keepRetry = false) => {
      sup.generation += 1
      if (!keepRetry) clearRetry(sup)
      const prev = agentMounts.get(name)
      agentMounts.delete(name)
      await disposeMount(prev)
    }
    if (item.kind === 'mcp' && item.transport === 'stdio' && item.approved !== true) {
      await drop()
      statusSet(bot.id, name, sessionId, { state: 'needs-approval' })
      return
    }
    let admission = { governed: false, env: {}, scopeKey: undefined }
    if (item.kind === 'mcp' && egress?.isGoverned?.()) {
      try {
        admission = await egress.admit({
          agent,
          sessionId,
          purpose: 'capability-mount',
          detail: { capability: name, transport: item.transport },
          waitForBirth: true,
        })
      } catch (error) {
        const prev = agentMounts.get(name)
        sup.generation += 1
        const myGen = sup.generation
        clearRetry(sup)
        agentMounts.delete(name)
        await disposeMount(prev)
        if (stopped || sup.generation !== myGen || agents.get(sessionId)?.deref() !== agent) return
        sup.lastKey = undefined
        const { permanent } = classifyCapabilityError(error, item)
        sup.lastPermanent = permanent
        statusSet(bot.id, name, sessionId, { state: 'error', error: rt.redactSecrets(String(error?.message ?? error)).slice(0, 300) })
        if (!permanent) scheduleRetry(agent, name, myGen)
        return
      }
    }
    let config
    try {
      config = configFor(item, bot.id)
    } catch (error) {
      await drop()
      sup.lastPermanent = true
      statusSet(bot.id, name, sessionId, { state: 'error', error: rt.redactSecrets(error.message).slice(0, 300) })
      return
    }
    const keyBase = admission.governed ? { config, scope: admission.scopeKey } : config
    const key = `${name}:${createHash('sha256').update(JSON.stringify(keyBase)).digest('hex')}`
    const existing = agentMounts.get(name)
    if (existing?.key === key) {
      if (existing.inFlight) return existing.inFlight
      if (existing.connected) {
        if (item.kind !== 'mcp') return
        const probe = await probeMcpAlive(agent, item.name)
        if (probe.alive) return
      }
    }
    if (sup.lastKey !== key) {
      sup.attempts = 0
      sup.lastPermanent = false
      sup.lastKey = key
    } else if (sup.lastPermanent) {
      return
    }
    clearRetry(sup)
    await drop(true)
    const myGen = sup.generation
    observeLogger(agent)
    statusSet(bot.id, name, sessionId, { state: 'connecting' })
    const mount = { key, fiber: null, connected: false, kind: item.kind, serverName: item.name, tools: [], inFlight: undefined }
    agentMounts.set(name, mount)
    let fiber
    const run = (async () => {
      try {
        const plugin = item.kind === 'skill'
          ? {
            name: `ds-bot-capability-skill-${name}`,
            inject: ['skills'],
            apply(c) {
              c.effect(() => c.skills.register({ name: config.name, description: config.description, source: 'runtime', content: config.content }))
            },
          }
          : await loadMcpPlugin()
        if (stopped || sup.generation !== myGen || agents.get(sessionId)?.deref() !== agent || agentMounts.get(name) !== mount) {
          if (agentMounts.get(name) === mount) agentMounts.delete(name)
          return
        }
        const mountConfig = item.kind === 'mcp' && item.transport === 'stdio' && admission.governed
          ? { ...config, env: { ...config.env, ...admission.env } }
          : config
        fiber = item.kind === 'skill' ? agent.ctx.plugin(plugin) : agent.ctx.plugin(plugin, mountConfig)
        mount.fiber = fiber
        await fiber.await()
        if (stopped || sup.generation !== myGen || agents.get(sessionId)?.deref() !== agent || agentMounts.get(name) !== mount) {
          await disposeMount({ fiber })
          return
        }
        if (item.kind === 'mcp') {
          const probe = await probeMcpAlive(agent, item.name)
          if (!probe.alive) throw probe.error ?? new Error(`${item.name}: server is disconnected`)
          if (stopped || sup.generation !== myGen || agents.get(sessionId)?.deref() !== agent || agentMounts.get(name) !== mount) {
            await disposeMount({ fiber })
            return
          }
          mount.tools = readDiscoveredTools(agent, item.name) ?? []
        }
        mount.connected = true
        mount.inFlight = undefined
        sup.attempts = 0
        sup.lastPermanent = false
        statusSet(bot.id, name, sessionId, { state: 'ready' })
        if (item.kind === 'mcp') ensureHealthMonitor(agent)
      } catch (error) {
        if (agentMounts.get(name) === mount) agentMounts.delete(name)
        await disposeMount({ fiber })
        if (stopped || sup.generation !== myGen || agents.get(sessionId)?.deref() !== agent) return
        const message = rt.redactSecrets([error, error?.cause].filter(Boolean).map(part => String(part?.message ?? part)).join(': ') || 'Connection failed').slice(0, 300)
        statusSet(bot.id, name, sessionId, { state: 'error', error: message })
        const { permanent } = classifyCapabilityError(error, item)
        sup.lastPermanent = permanent
        if (!permanent) scheduleRetry(agent, name, myGen)
      }
    })()
    mount.inFlight = run
    return run
  }
  const reconcileAgent = async (agent, bot) => {
    const sessionId = agent.session.id
    const desired = bot ? expandCapabilityNames(bot.capabilities, library()) : new Set()
    // However a server reached a Bot (attached by itself, through a pack, or edited into one), a
    // Bot outside `bots: main` never mounts it.
    const limited = bot && !rt.isMain(bot.id) ? [...desired].filter(limitedToMain) : []
    for (const name of limited) desired.delete(name)
    const agentMounts = mounts.get(agent) ?? new Map()
    if (desired.size > 0) mounts.set(agent, agentMounts)
    if (bot) {
      for (const name of sessionStatuses.get(bot.id)?.keys() ?? []) {
        if (!desired.has(name)) clearStatus(bot.id, name, sessionId)
      }
      for (const name of limited) statusSet(bot.id, name, sessionId, { state: 'error', error: 'Limited to Main Bots by the configuration (bots: main)' })
    } else {
      clearSession(sessionId)
    }
    for (const [name, mount] of agentMounts) {
      if (desired.has(name)) continue
      const sup = supervisors.get(agent)?.get(name)
      if (sup) {
        sup.generation += 1
        clearRetry(sup)
        supervisors.get(agent).delete(name)
      }
      await disposeMount(mount)
      agentMounts.delete(name)
    }
    await Promise.all([...desired].map(name => mountOne(agent, bot, agentMounts, name)))
    if (agentMounts.size === 0 && mounts.get(agent) === agentMounts) mounts.delete(agent)
  }
  const botOfSession = sessionId => (rt.isBotSession(sessionId) ? rt.botOf(rt.selfOf(sessionId)) : undefined)
  // At most one run waits behind the running one; it reads the latest state when it starts.
  const reconcileOne = agent => {
    if (queued.has(agent)) return chains.get(agent)
    queued.add(agent)
    const run = (chains.get(agent) ?? Promise.resolve()).then(async () => {
      queued.delete(agent)
      const sessionId = agent.session.id
      if (stopped || agents.get(sessionId)?.deref() !== agent) return
      await reconcileAgent(agent, botOfSession(sessionId))
    }).catch(error => rt.warn('ds-bot: capability reconcile for %s failed: %s', agent.session?.id, error))
    chains.set(agent, run)
    return run
  }
  const loadInputs = async () => {
    await rt.load()
    await seedConfigured()
    loadingSecrets += 1
    try {
      await rt.loadSecrets()
    } finally {
      loadingSecrets -= 1
    }
  }
  async function reconcile() {
    if (stopped) return
    await loadInputs()
    const runs = []
    for (const [sessionId, reference] of agents) {
      const agent = reference.deref()
      if (agent) {
        runs.push(reconcileOne(agent))
        continue
      }
      agents.delete(sessionId)
      clearSession(sessionId)
    }
    await Promise.all(runs)
  }
  const scheduleReconcile = () => {
    if (!scheduled) {
      scheduled = new Promise(resolve => queueMicrotask(() => {
        scheduled = null
        resolve(reconcile().catch(error => rt.warn('ds-bot: capability reconcile failed: %s', error)))
      }))
    }
    return scheduled
  }
  // A run that outlasts the limit goes on in the background, and later requests for the
  // same Agent do not wait for it again.
  const stalled = new WeakSet()
  const prepare = async (agent, sessionId) => {
    const run = loadInputs().then(() => reconcileOne(agent)).then(() => true, error => {
      rt.warn('ds-bot: capability mount for %s failed: %s', sessionId, error)
      return true
    })
    if (stalled.has(agent)) return
    const timeoutMs = rt.capabilityEnsureTimeoutMs ?? ENSURE_TIMEOUT_MS
    let timer
    const completed = await Promise.race([run, new Promise(resolve => { timer = setTimeout(resolve, timeoutMs, false) })])
    clearTimeout(timer)
    if (completed) return
    stalled.add(agent)
    void run.then(() => stalled.delete(agent))
    rt.warn('ds-bot: capability mount for %s did not finish within %dms; continuing', sessionId, timeoutMs)
  }
  async function ensureCapabilities(sessionId) {
    await rt.load()
    await seedConfigured()
    const bot = botOfSession(sessionId)
    if (!bot) return
    if ((bot.capabilities ?? []).length === 0 && !mounts.get(agents.get(sessionId)?.deref())?.size) return
    let agent
    try {
      agent = await rt.resolveAgent(sessionId)
    } catch (error) {
      rt.warn('ds-bot: capability Agent for %s could not be resolved: %s', sessionId, rt.redactSecrets(String(error)))
      return
    }
    trackAgent(agent)
    const byName = supervisors.get(agent)
    if (byName) {
      for (const sup of byName.values()) {
        if (!sup.lastPermanent) {
          clearRetry(sup)
          sup.attempts = 0
        }
      }
    }
    await prepare(agent, sessionId)
  }
  const trackAgent = agent => {
    const sessionId = agent?.session?.id
    if (typeof sessionId !== 'string' || !agent.ctx) return
    if (agents.get(sessionId)?.deref() === agent) return
    agents.set(sessionId, new WeakRef(agent))
    agent.ctx.effect(() => () => {
      if (agents.get(sessionId)?.deref() === agent) agents.delete(sessionId)
      clearSession(sessionId)
      clearAgentTimers(agent)
      for (const mount of mounts.get(agent)?.values() ?? []) void disposeMount(mount)
      mounts.delete(agent)
    }, `ds-bot: capabilities ${sessionId}`)
  }
  const trackBotAgents = async bot => {
    const sessionIds = new Set()
    try {
      const sessionId = rt.chatOf(bot.id)
      if (typeof sessionId === 'string') sessionIds.add(sessionId)
    } catch (error) {
      rt.warn('ds-bot: capability chat session for %s could not be read: %s', bot.id, error)
    }
    try {
      for (const sessionId of rt.groupSessionsOf(bot.id) ?? []) {
        if (typeof sessionId === 'string') sessionIds.add(sessionId)
      }
    } catch (error) {
      rt.warn('ds-bot: capability group sessions for %s could not be read: %s', bot.id, error)
    }
    for (const sessionId of sessionIds) {
      try {
        trackAgent(await rt.resolveAgent(sessionId))
      } catch (error) {
        rt.warn('ds-bot: capability Agent for %s could not be resolved: %s', sessionId, error)
      }
    }
  }

  async function capabilityEndpoint(endpoint, body = {}) {
    if (endpoint === 'capability-save') return capabilitySave(body, { ui: true })
    if (endpoint === 'capability-delete') return capabilityDelete(body.name, { ui: true })
    if (endpoint === 'capability-approve') {
      await rt.load()
      writeCheck()
      const item = own(library(), String(body.name ?? ''))
      if (!item || item.kind !== 'mcp' || item.transport !== 'stdio') throw new Error(`No unapproved stdio MCP named ${body.name}.`)
      item.approved = true
      item.updatedAt = Date.now()
      await rt.save()
      return item
    }
    if (endpoint === 'bot-capability') {
      await rt.load()
      writeCheck()
      const bot = rt.botOf(String(body.botId ?? ''))
      if (!bot) throw new Error('Unknown Bot')
      const name = String(body.name ?? '')
      if (!own(library(), name)) throw new Error(`No capability named ${name}.`)
      return setAttached(bot, name, body.attached === true)
    }
    throw new Error('Unknown capability operation.')
  }
  const secretsChanged = rt.secretsChanged
  rt.secretsChanged = () => {
    secretsChanged?.()
    if (loadingSecrets === 0) void scheduleReconcile()
  }
  rt.capabilitiesStateSaved = () => { void scheduleReconcile() }
  // Creation waits for these listeners, so a new Agent's first request already has its
  // tools and skill catalog. agent/pre-step is too late: a step assembles its tools first.
  ctx.on('agent/created', async function prepareCapabilities({ agent }) {
    trackAgent(agent)
    try {
      await rt.load()
      await seedConfigured()
      const bot = botOfSession(agent.session.id)
      if ((bot?.capabilities ?? []).length > 0) await prepare(agent, agent.session.id)
    } catch (error) {
      rt.warn('ds-bot: capability load failed: %s', error)
    }
  })
  ctx.effect(() => {
    void rt.load().then(async () => {
      // First, and synchronously up to its save: the Bots it switches a server on for join the
      // loop below, and anything that awaits rt.load() after this finds the library whole.
      await seedConfigured()
      for (const bot of Object.values(state.bots)) {
        if ((bot.capabilities ?? []).length > 0) await trackBotAgents(bot)
      }
      await scheduleReconcile()
    }).catch(error => rt.warn('ds-bot: capability startup failed: %s', error))
    return async () => {
      stopped = true
      for (const ref of agents.values()) {
        const agent = ref.deref()
        if (agent) clearAgentTimers(agent)
      }
      for (const agent of mounts.keys()) clearAgentTimers(agent)
      const live = [...mounts.values()]
      mounts.clear()
      agents.clear()
      sessionStatuses.clear()
      await Promise.all(live.flatMap(agentMounts => [...agentMounts.values()].map(disposeMount)))
    }
  }, 'ds-bot: capabilities')
  Object.assign(rt, {
    capabilitySave,
    capabilityDelete,
    dropOrphanCapabilities,
    capabilityEndpoint,
    capabilityLibraryView: libraryView,
    capabilityStatusesView,
    reconcileCapabilities: reconcile,
    scheduleCapabilitiesReconcile: scheduleReconcile,
    ensureCapabilities,
    expandCapabilities: names => expandCapabilityNames(names, library()),
    changeCapabilityAttachment: changeAttachment,
  })
}
