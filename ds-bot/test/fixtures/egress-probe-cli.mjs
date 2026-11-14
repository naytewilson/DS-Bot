import { appendFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

const args = process.argv.slice(2)
const argVal = (flag) => {
  const idx = args.indexOf(flag)
  return idx === -1 ? undefined : args[idx + 1]
}
const envOut = argVal('--env-out')
const pidOut = argVal('--pid-out')
const spawnOrphan = args.includes('--spawn-orphan')
const holdTurn = args.includes('--hold')
const mode = args.includes('--print') ? 'claude' : args.includes('--codex') ? 'codex' : 'acp'

if (envOut) {
  appendFileSync(envOut, `${JSON.stringify({ pid: process.pid, argv: args, env: process.env })}\n`)
}
if (spawnOrphan && pidOut) {
  const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], { stdio: 'ignore' })
  writeFileSync(pidOut, JSON.stringify({ parentPid: process.pid, orphanPid: orphan.pid }))
}

const send = obj => process.stdout.write(`${JSON.stringify(obj)}\n`)

if (mode === 'claude') {
  const sid = `claude-${process.pid}-${Math.random().toString(36).slice(2, 6)}`
  send({ type: 'system', subtype: 'init', session_id: sid })
  let buf = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buf += chunk
    let at
    while ((at = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, at).trim()
      buf = buf.slice(at + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      const shouldHold = holdTurn || JSON.stringify(msg).includes('hold-now')
      if (msg.type === 'user' && !shouldHold) {
        const snapshot = {
          pid: process.pid,
          mode: argVal('--permission-mode'),
          ANVIL_TASK_ID: process.env.ANVIL_TASK_ID ?? null,
          ANVIL_AGENT: process.env.ANVIL_AGENT ?? null,
          ANVIL_OWNER_TOKEN: process.env.ANVIL_OWNER_TOKEN ?? null,
        }
        send({ type: 'assistant', message: { content: [{ type: 'text', text: JSON.stringify(snapshot) }] } })
        send({ type: 'result', subtype: 'success', session_id: sid, result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } })
      }
    }
  })
} else if (mode === 'codex') {
  let buf = ''
  let turnN = 0
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buf += chunk
    let at
    while ((at = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, at).trim()
      buf = buf.slice(at + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.method === 'initialize') {
        send({ jsonrpc: '2.0', id: msg.id, result: { userAgent: 'probe-codex' } })
      } else if (msg.method === 'thread/start') {
        send({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: 'thr-1' } } })
      } else if (msg.method === 'thread/resume') {
        send({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: msg.params.threadId } } })
      } else if (msg.method === 'turn/start') {
        const turnId = `t-${++turnN}`
        send({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: turnId } } })
        if (!holdTurn) {
          send({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: msg.params.threadId, item: { id: 'i1', type: 'agentMessage', text: JSON.stringify({ pid: process.pid, ANVIL_TASK_ID: process.env.ANVIL_TASK_ID ?? null }) } } })
          send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: msg.params.threadId, turn: { id: turnId, status: 'completed' } } })
        }
      }
    }
  })
} else {
  let buf = ''
  let mcpServers = []
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buf += chunk
    let at
    while ((at = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, at).trim()
      buf = buf.slice(at + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.method === 'initialize') {
        send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true, sse: true } }, agentInfo: { name: 'probe-acp', version: '1' } } })
      } else if (msg.method === 'session/new' || msg.method === 'session/load') {
        mcpServers = msg.params?.mcpServers ?? []
        send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: msg.params?.sessionId ?? 'acp-probe-1', modes: { currentModeId: 'ask', availableModes: [{ id: 'ask' }, { id: 'accept-edits' }, { id: 'bypass' }] } } })
      } else if (msg.method === 'session/set_config_option' || msg.method === 'session/set_mode') {
        send({ jsonrpc: '2.0', id: msg.id, result: {} })
      } else if (msg.method === 'session/prompt') {
        const text = (msg.params?.prompt ?? []).map(block => block.text ?? '').join('\n')
        if (text.includes('call-tool') && mcpServers[0]) {
          const srv = mcpServers[0]
          const auth = srv.headers?.find(h => h.name.toLowerCase() === 'authorization')?.value ?? ''
          const headers = { 'content-type': 'application/json', authorization: auth }
          void fetch(srv.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'probe-acp', version: '1' } } }) })
            .then(() => fetch(srv.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_bots', arguments: {} } }) }))
            .catch(() => {})
        } else if (!holdTurn) {
          send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify({ pid: process.pid, ANVIL_TASK_ID: process.env.ANVIL_TASK_ID ?? null, ANVIL_AGENT: process.env.ANVIL_AGENT ?? null, ANVIL_OWNER_TOKEN: process.env.ANVIL_OWNER_TOKEN ?? null }) } } } })
          send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
        }
      }
    }
  })
}
