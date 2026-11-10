// A whole, healthy status as the host's fabric module builds it (src/host/fabric.js), for the
// Fabric page and chip tests.
const GB = 1024 ** 3

// A whole, healthy status as the host's fabric module builds it.
export const healthy = () => ({
  enabled: true,
  generatedAt: '2026-11-10T06:00:00.000Z',
  tookMs: 840,
  host: {
    ok: true, hostname: 'node-02', platform: 'linux', arch: 'x64', uptimeSec: 3 * 86_400 + 4 * 3_600, load: [0.42, 0.38, 0.31], cpus: 8,
    memory: { totalBytes: 32 * GB, availableBytes: 20 * GB },
    disks: [{ mount: '/', sizeBytes: 500 * GB, availBytes: 300 * GB, usedPct: 40 }, { mount: '/srv/archive', sizeBytes: 4096 * GB, availBytes: 1200 * GB, usedPct: 71 }],
  },
  service: { ok: true, unit: 'anvil-dsh-fabric.service', state: 'active', since: '2026-11-07T02:00:00.000Z', memoryBytes: 412 * 1024 ** 2 },
  peers: [{ name: 'Neo', ok: true, latencyMs: 42, detail: 'Darwin neo' }],
  hub: { ok: true, metrics: [{ metric: 'open_blockers', value: '62' }, { metric: 'active_agents', value: '6' }, { metric: 'real_tasks', value: '408' }, { metric: 'receipt_unique_bytes', value: '92618298' }, { metric: 'receipt_backup_coverage', value: 'false' }] },
  os: {
    ok: true, generatedAt: '2026-11-10T05:59:30Z',
    services: [{ name: 'Hub', unit: 'anvil-hub.service', state: 'active' }, { name: 'Ingress', unit: 'sieve.service', state: 'active' }],
    disks: [{ name: 'Archive', path: '/srv/archive', total: 4096 * GB, free: 1200 * GB, present: true }],
    memory: { total: 32 * GB, available: 20 * GB, swapTotal: 0, swapFree: 0 }, load: '0.42 0.38 0.31',
  },
  sieve: {
    ok: true,
    output: {
      ok: true, lastAt: '2026-11-10T05:58:00.000Z',
      today: { calls: 120, inBytes: 80 * 1024 ** 2, outBytes: 12 * 1024 ** 2 },
      total: { calls: 5000, inBytes: 4 * GB, outBytes: 600 * 1024 ** 2 },
      byHarness: { codex: { calls: 90, inBytes: 60 * 1024 ** 2, outBytes: 8 * 1024 ** 2 }, claude: { calls: 30, inBytes: 20 * 1024 ** 2, outBytes: 4 * 1024 ** 2 } },
    },
    ingress: [{ url: 'http://127.0.0.1:8899/sieve/stats', ok: true, uptimeMs: 3 * 86_400_000, requestsToday: 120 }],
  },
})

