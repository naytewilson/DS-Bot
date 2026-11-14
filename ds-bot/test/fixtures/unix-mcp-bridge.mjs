import { appendFileSync } from 'node:fs'
import { createConnection } from 'node:net'

const [sockPath, pidLogPath, mode = 'normal'] = process.argv.slice(2)

function logPid(event) {
  if (!pidLogPath) return
  try {
    appendFileSync(pidLogPath, `${JSON.stringify({ pid: process.pid, event, at: Date.now() })}\n`)
  } catch { /* test directory already removed */ }
}

logPid('start')
process.on('exit', () => logPid('exit'))
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => {
    logPid(`signal:${sig}`)
    process.exit(0)
  })
}

if (mode === 'hang') {
  process.stdin.resume()
} else if (mode === 'auth-fail' || mode === 'bad-proto') {
  const errPayload = mode === 'auth-fail'
    ? { code: -32001, message: 'Unauthorized: authentication failed (401)' }
    : { code: -32601, message: 'Unsupported protocol mismatch' }
  let buf = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buf += chunk
    let at
    while ((at = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, at).trim()
      buf = buf.slice(at + 1)
      if (!line) continue
      try {
        const msg = JSON.parse(line)
        if (msg.id !== undefined) {
          process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: errPayload })}\n`)
        }
      } catch { /* ignore */ }
    }
  })
} else {
  const socket = createConnection(sockPath)
  socket.on('error', (error) => {
    process.stderr.write(`connect ${sockPath}: ${error.code ?? 'ERR'} ${error.message}\n`)
    process.exit(1)
  })
  socket.on('connect', () => {
    process.stdin.pipe(socket)
    socket.pipe(process.stdout)
  })
  socket.on('close', () => {
    process.exit(0)
  })
  process.stdin.on('end', () => {
    socket.end()
  })
}
