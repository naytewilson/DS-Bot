// Settings → Fabric and the sidebar's Fabric chip: this host, its peers, the services of the
// ANVIL fabric, the hub's truth board and what SIEVE keeps out of the model's context. The
// numbers come from the host's `fabric-status` endpoint (src/host/fabric.js); the formatting
// and the decision of what state they add up to are in fabric-data.js.
import { createElement as h, useCallback, useEffect, useState } from 'react'
import { FabricIcon, RefreshIcon } from './icons.js'
import { dateLocale, t } from './i18n.js'
import {
  CHIP_POLL_MS, PAGE_POLL_MS, agoText, browserVisibility, bytesText, chipLabel, countText, deriveState, durationText, errorText,
  fabricFeed, harnessRows, hostMeters, hubGroups, isAbsent, latencyText, levelText, levelTone, metricLabel, metricValue,
  percentText, poll, savings, sinceText, unitState,
} from './fabric-data.js'

export { FabricIcon }

// The hub's other metrics show this many before "Show all".
const KV_SHOWN = 12

// ---- hooks ------------------------------------------------------------------------------

// The shared copy of the status, read again every `every` ms while the tab is visible. A page and
// a chip that are both mounted share the reads: whichever asks second finds a young copy.
export function useFabric(actions, { every = PAGE_POLL_MS } = {}) {
  const [snapshot, setSnapshot] = useState(() => fabricFeed.get())
  const read = useCallback(({ fresh }) => actions.fabricStatus({ fresh }), [actions])
  useEffect(() => {
    setSnapshot(fabricFeed.get())
    return fabricFeed.subscribe(setSnapshot)
  }, [])
  useEffect(() => poll({
    run: () => fabricFeed.refresh(read, { maxAge: Math.max(0, every - 2_000) }),
    every,
    ...browserVisibility,
  }), [read, every])
  const refresh = useCallback(() => fabricFeed.refresh(read, { fresh: true }), [read])
  return { ...snapshot, refresh }
}

// The clock the "Updated …" line is read against (exported for its test). It stands still while the tab is hidden (nobody
// reads it, and every tick draws the page again) and catches up when the tab is shown.
export function useNow(every = 5_000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => poll({
    run: () => setNow(Date.now()),
    every,
    ...browserVisibility,
  }), [every])
  return now
}

// ---- pieces -----------------------------------------------------------------------------

const Dot = ({ tone }) => h('span', { className: 'bt-fab-dot', 'data-tone': tone, 'aria-hidden': true })

// A bar for a share of something: a disk, memory, load, or the part of a tool's output that
// reached the model. Named for assistive technology by its label and value.
function Track({ label, valueText, fraction, tone }) {
  return h('div', {
    className: 'bt-fab-track', role: 'meter', 'aria-label': label, 'aria-valuetext': valueText,
    'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round((fraction ?? 0) * 100),
  }, h('span', { className: 'bt-fab-fill', 'data-tone': tone, style: { '--fab-frac': fraction ?? 0 } }))
}

function Meter({ label, valueText, detail, fraction, tone, mono = false }) {
  return h('div', { className: 'bt-fab-meter' },
    h('div', { className: 'bt-fab-meter-head' },
      h('span', { className: mono ? 'bt-fab-meter-label bt-fab-mono' : 'bt-fab-meter-label', title: label }, label),
      h('span', { className: 'bt-fab-meter-value' }, valueText)),
    h(Track, { label, valueText, fraction, tone }),
    detail ? h('div', { className: 'bt-fab-meter-detail' }, detail) : null)
}

// A section whose tool did not answer says so in its own card, with the reason.
function Problem({ what, section }) {
  const absent = isAbsent(section)
  return h('div', { className: 'bt-fab-row bt-fab-problem', 'data-absent': absent || undefined },
    h(Dot, { tone: absent ? 'muted' : 'warn' }),
    h('div', { className: 'bt-fab-row-main' },
      h('span', { className: 'bt-fab-name' }, what),
      h('span', { className: 'bt-fab-hint' }, absent ? errorText(section?.error) : t('Could not be read: {reason}', { reason: errorText(section?.error) }))))
}

const platformText = host => [host.platform, host.arch].filter(Boolean).join(' · ')

function HostCard({ host }) {
  const meters = hostMeters(host)
  const cores = meters.cpus === 1 ? t('1 core') : t('{count} cores', { count: meters.cpus })
  const { load, memory } = meters
  return h('div', { className: 'bt-fab-host' },
    h('div', { className: 'bt-fab-host-head' },
      h('span', { className: 'bt-fab-host-icon', 'aria-hidden': true }, h(FabricIcon)),
      h('div', { className: 'bt-fab-host-copy' },
        h('span', { className: 'bt-fab-host-name', title: host.hostname }, host.hostname || t('This host')),
        h('span', { className: 'bt-fab-muted' }, [platformText(host), t('Up {time}', { time: durationText(host.uptimeSec) })].filter(Boolean).join(' · ')))),
    h('div', { className: 'bt-fab-meters' },
      load ? h(Meter, {
        label: t('Load'),
        valueText: [load.one, load.five, load.fifteen].filter(Number.isFinite).map(value => value.toFixed(2)).join(' · '),
        detail: t('1, 5 and 15 minutes on {cores}', { cores }),
        fraction: load.fraction, tone: load.tone,
      }) : null,
      memory ? h(Meter, memory.mac
        ? { label: t('System memory'), valueText: bytesText(memory.total), detail: t('Free memory is not measured on macOS'), fraction: null, tone: 'muted' }
        : {
            label: t('System memory'),
            valueText: t('{percent} used', { percent: percentText(memory.fraction) }),
            detail: memory.pressure
              ? t('{free} available of {total}, by memory pressure', { free: bytesText(memory.available), total: bytesText(memory.total) })
              : t('{free} free of {total}', { free: bytesText(memory.available), total: bytesText(memory.total) }),
            fraction: memory.fraction, tone: memory.tone,
          }) : null,
      meters.disks.map(disk => h(Meter, {
        key: disk.mount, mono: true, label: disk.mount,
        valueText: t('{percent} used', { percent: percentText(disk.fraction) }),
        detail: t('{free} free of {total}', { free: bytesText(disk.free), total: bytesText(disk.size) }),
        fraction: disk.fraction, tone: disk.tone,
      }))),
    host.disksError ? h('div', { className: 'bt-fab-hint' }, t('Disks could not be read: {reason}', { reason: errorText(host.disksError) })) : null)
}

function PeerRow({ peer }) {
  return h('div', { className: 'bt-fab-row' },
    h(Dot, { tone: peer.ok ? 'ok' : 'bad' }),
    h('div', { className: 'bt-fab-row-main' },
      h('span', { className: 'bt-fab-name' }, peer.name),
      peer.ok ? (peer.detail ? h('span', { className: 'bt-fab-hint' }, peer.detail) : null) : h('span', { className: 'bt-fab-hint' }, errorText(peer.error))),
    h('span', { className: 'bt-fab-meta' }, peer.ok ? [t('Reachable'), ' ', h('em', { key: 'ms' }, latencyText(peer.latencyMs))] : t('Unreachable')))
}

// The volumes ANVIL OS names (an external archive drive, say) and whether each is mounted.
function VolumeRow({ disk }) {
  return h('div', { className: 'bt-fab-row' },
    h(Dot, { tone: disk.present ? 'ok' : 'warn' }),
    h('div', { className: 'bt-fab-row-main' },
      h('span', { className: 'bt-fab-name' }, disk.name || disk.path),
      disk.name && disk.path ? h('span', { className: 'bt-fab-hint bt-fab-mono' }, disk.path) : null),
    h('span', { className: 'bt-fab-meta' }, disk.present
      ? t('{free} free of {total}', { free: bytesText(disk.free), total: bytesText(disk.total) })
      : t('Not present')))
}

function HostsSection({ value, Section }) {
  const { host, os } = value
  const peers = Array.isArray(value.peers) ? value.peers : []
  const volumes = os?.ok === true ? os.disks ?? [] : []
  return h(Section, { title: t('Hosts'), className: 'bt-fab-sec' },
    host?.ok === true ? h(HostCard, { host }) : h(Problem, { what: t('This host'), section: host }),
    peers.map(peer => h(PeerRow, { key: peer.name, peer })),
    volumes.map(disk => h(VolumeRow, { key: `${disk.name}:${disk.path}`, disk })))
}

function ServiceRow({ service, now }) {
  const state = unitState(service.state)
  const since = service.state === 'active' ? sinceText(service.since, now) : null
  const memory = Number.isFinite(service.memoryBytes) && service.memoryBytes > 0 ? bytesText(service.memoryBytes) : null
  return h('div', { className: 'bt-fab-row' },
    h(Dot, { tone: state.tone }),
    h('div', { className: 'bt-fab-row-main' },
      h('span', { className: 'bt-fab-name bt-fab-mono', title: service.unit }, service.unit),
      since || memory ? h('span', { className: 'bt-fab-hint' }, [since, memory].filter(Boolean).join(' · ')) : null),
    h('span', { className: 'bt-fab-meta' }, state.text))
}

function OsServices({ os, now }) {
  const services = os.services ?? []
  const running = services.filter(item => item.state === 'active').length
  const time = Date.parse(os.generatedAt ?? '')
  return h('div', { className: 'bt-fab-os' },
    h('div', { className: 'bt-fab-os-head' },
      h('span', { className: 'bt-fab-name' }, t('ANVIL OS')),
      h('span', { className: 'bt-fab-meta' }, [t('{running} of {total} running', { running, total: services.length }), Number.isFinite(time) ? ` · ${agoText(time, now)}` : ''].join(''))),
    services.length > 0 ? h('ul', { className: 'bt-fab-services' }, services.map(item => {
      const state = unitState(item.state)
      return h('li', { key: item.unit || item.name, title: item.unit },
        h(Dot, { tone: state.tone }),
        h('span', { className: 'bt-fab-svc-name' }, item.name || item.unit),
        item.state === 'active' ? null : h('span', { className: 'bt-fab-svc-state' }, state.text))
    })) : h('div', { className: 'bt-fab-hint bt-fab-pad' }, t('ANVIL OS lists no services.')))
}

function ServicesSection({ value, now, Section }) {
  const { service, os } = value
  return h(Section, { title: t('Services'), className: 'bt-fab-sec' },
    service?.unit ? h(ServiceRow, { service, now }) : h(Problem, { what: t('Fabric service'), section: service }),
    os?.ok === true ? h(OsServices, { os, now }) : h(Problem, { what: t('ANVIL OS'), section: os }))
}

function HubSection({ value, Section }) {
  const hub = value.hub
  const [all, setAll] = useState(false)
  if (hub?.ok !== true) return h(Section, { title: t('ANVIL hub'), className: 'bt-fab-sec' }, h(Problem, { what: t('Truth board'), section: hub }))
  const { featured, rest } = hubGroups(hub.metrics)
  const shown = all ? rest : rest.slice(0, KV_SHOWN)
  return h(Section, { title: t('ANVIL hub'), className: 'bt-fab-sec' },
    featured.length > 0 ? h('div', { className: 'bt-fab-tiles' }, featured.map(entry => h('div', { key: entry.metric, className: 'bt-fab-tile' },
      h('span', { className: 'bt-fab-k' }, metricLabel(entry.metric)),
      h('span', { className: 'bt-fab-tile-value' }, metricValue(entry.metric, entry.value))))) : null,
    shown.length > 0 ? h('dl', { className: 'bt-fab-kv' }, shown.map(entry => h('div', { key: entry.metric },
      h('dt', { title: metricLabel(entry.metric) }, metricLabel(entry.metric)),
      h('dd', null, metricValue(entry.metric, entry.value))))) : null,
    rest.length > KV_SHOWN ? h('div', { className: 'bt-fab-more' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', 'aria-expanded': all, onClick: () => setAll(!all) },
        all ? t('Show fewer') : t('Show all {count}', { count: rest.length }))) : null,
    featured.length + rest.length === 0 ? h('div', { className: 'bt-fab-row' }, h('span', { className: 'bt-fab-hint' }, t('The hub reports no metrics.'))) : null)
}

// How much of a stretch of tool output SIEVE kept out of the model's context: the bar is the
// share saved, and the line under it says what did reach the model.
function SaveCard({ label, row }) {
  const sum = savings(row)
  const kept = t('{out} reached the model, of {in}', { out: bytesText(sum.outBytes), in: bytesText(sum.inBytes) })
  return h('div', { className: 'bt-fab-save' },
    h('span', { className: 'bt-fab-k' }, label),
    sum.calls === 0
      ? h('div', { className: 'bt-fab-hint' }, t('No tool calls yet'))
      : [
          h('div', { key: 'main', className: 'bt-fab-save-main' }, h('strong', null, sum.fraction === null ? '–' : percentText(sum.fraction)), h('span', { className: 'bt-fab-muted' }, t('saved'))),
          h(Track, { key: 'bar', label: t('Saved'), valueText: kept, fraction: sum.fraction ?? 0, tone: 'ok' }),
          h('div', { key: 'detail', className: 'bt-fab-meter-detail' }, `${kept} · ${t('{count} calls', { count: countText(sum.calls) })}`),
        ])
}

function HarnessRow({ row }) {
  const kept = t('{out} reached the model, of {in}', { out: bytesText(row.outBytes), in: bytesText(row.inBytes) })
  return h('div', { className: 'bt-fab-row bt-fab-harness' },
    h('span', { className: 'bt-fab-name', title: row.name }, row.name),
    h('div', { className: 'bt-fab-harness-bar' }, h(Track, { label: row.name, valueText: kept, fraction: row.fraction ?? 0, tone: 'ok' })),
    h('span', { className: 'bt-fab-meta' }, [t('{count} calls', { count: countText(row.calls) }), row.fraction === null ? '' : ` · ${t('{percent} saved', { percent: percentText(row.fraction) })}`].join('')))
}

function IngressRow({ entry }) {
  const detail = [
    Number.isFinite(entry.uptimeMs) ? t('Up {time}', { time: durationText(entry.uptimeMs / 1000) }) : null,
    Number.isFinite(entry.requestsToday) ? t('{count} requests today', { count: countText(entry.requestsToday) }) : null,
  ].filter(Boolean)
  return h('div', { className: 'bt-fab-row' },
    h(Dot, { tone: entry.ok ? 'ok' : 'bad' }),
    h('div', { className: 'bt-fab-row-main' },
      h('span', { className: 'bt-fab-name bt-fab-mono', title: entry.url }, entry.url),
      entry.ok ? (detail.length > 0 ? h('span', { className: 'bt-fab-hint' }, detail.join(' · ')) : null) : h('span', { className: 'bt-fab-hint' }, errorText(entry.error))),
    h('span', { className: 'bt-fab-meta' }, entry.ok ? t('Healthy') : t('Down')))
}

function SieveSection({ value, now, Section }) {
  const sieve = value.sieve
  const out = sieve?.output
  const ingress = Array.isArray(sieve?.ingress) ? sieve.ingress : []
  const { rows, more } = out?.ok === true ? harnessRows(out.byHarness) : { rows: [], more: 0 }
  const last = out?.ok === true ? Date.parse(out.lastAt ?? '') : Number.NaN
  return h(Section, { title: 'SIEVE', className: 'bt-fab-sec' },
    out?.ok === true
      ? h('div', { className: 'bt-fab-save-pair' }, h(SaveCard, { label: t('Today'), row: out.today }), h(SaveCard, { label: t('All time'), row: out.total }))
      : h(Problem, { what: t('Tool output'), section: out ?? sieve }),
    rows.map(row => h(HarnessRow, { key: row.name, row })),
    more > 0 ? h('div', { className: 'bt-fab-row' }, h('span', { className: 'bt-fab-hint' }, t('And {count} more', { count: more }))) : null,
    out?.ok === true && (Number.isFinite(last) || out.partial) ? h('div', { className: 'bt-fab-row' },
      h('span', { className: 'bt-fab-hint' }, [
        Number.isFinite(last) ? t('Last tool call {time}', { time: agoText(last, now) }) : null,
        out.partial ? t('Counts cover the recent part of the log only.') : null,
      ].filter(Boolean).join(' · '))) : null,
    ingress.map(entry => h(IngressRow, { key: entry.url, entry })))
}

// ---- the page ---------------------------------------------------------------------------

const clockText = time => new Date(time).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' })

function StatusBar({ state, snapshot, now, onRefresh }) {
  const { loading, at } = snapshot
  const detail = state.reasons.length > 0 ? state.reasons.slice(0, 3).join(' · ') : null
  return h('div', { className: 'bt-fab-bar' },
    h('div', { className: 'bt-fab-overall' },
      h(Dot, { tone: levelTone(state.level) }),
      h('div', { className: 'bt-fab-overall-copy' },
        h('strong', null, levelText(state.level)),
        detail ? h('span', { className: 'bt-fab-sub' }, detail) : null)),
    h('div', { className: 'bt-fab-bar-actions' },
      at > 0 ? h('span', { className: 'bt-fab-updated', title: clockText(at) }, t('Updated {time}', { time: agoText(at, now) })) : null,
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-with-icon', disabled: loading, 'aria-busy': loading || undefined, onClick: onRefresh },
        h('span', { className: 'bt-fab-spin', 'data-on': loading || undefined }, h(RefreshIcon)),
        loading ? t('Refreshing…') : t('Refresh'))))
}

function Skeleton() {
  return h('div', { className: 'bt-fab-skel', role: 'status', 'aria-busy': true, 'aria-label': t('Reading the fabric…') },
    [64, 168, 132, 96].map((height, index) => h('i', { key: index, 'aria-hidden': true, style: { height, '--bt-skel-i': index } })))
}

// The view is turned off in this host's configuration.
function NotConfigured() {
  return h('div', { className: 'bt-fab-empty' },
    h('span', { className: 'bt-fab-empty-mark', 'aria-hidden': true }, h(FabricIcon)),
    h('h3', null, t('Fabric is not configured')),
    h('p', null, t('This host has the Fabric view turned off. Turn it on in the plugin\'s configuration to see this machine, its peers, the ANVIL hub and SIEVE here.')),
    h('pre', { className: 'bt-fab-code' }, 'fabric:\n  enabled: true\n  peers:\n    - { name: Neo, ssh: neo }'))
}

function ReadFailed({ error, loading, onRefresh }) {
  return h('div', { className: 'bt-fab-empty', role: 'alert' },
    h('span', { className: 'bt-fab-empty-mark', 'aria-hidden': true }, h(FabricIcon)),
    h('h3', null, t('The Fabric status could not be read')),
    h('p', null, error),
    h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: loading, onClick: onRefresh }, t('Try again')))
}

// What the page draws for one snapshot of the shared copy. It reads nothing itself, so a test
// can hand it any status.
export function FabricView({ snapshot, now, onRefresh, Section }) {
  const { value, error, loading } = snapshot
  if (value === null || value === undefined) {
    return error === '' ? h(Skeleton) : h(ReadFailed, { error, loading, onRefresh })
  }
  if (value.enabled === false) return h(NotConfigured)
  const state = deriveState(value, { failed: error !== '' })
  const whole = typeof value.error === 'string' && value.error !== ''
  return [
    h(StatusBar, { key: 'bar', state, snapshot, now, onRefresh }),
    whole ? h(Section, { key: 'whole', title: t('Fabric') }, h(Problem, { what: t('Fabric'), section: { ok: false, error: value.error } })) : null,
    whole ? null : h(HostsSection, { key: 'hosts', value, Section }),
    whole ? null : h(ServicesSection, { key: 'services', value, now, Section }),
    whole ? null : h(HubSection, { key: 'hub', value, Section }),
    whole ? null : h(SieveSection, { key: 'sieve', value, now, Section }),
    h('p', { key: 'foot', className: 'bt-fab-foot' }, t('Checked in {time}. This page reads again every 30 seconds while it is open.', { time: latencyText(value.tookMs) })),
  ]
}

export function FabricPage({ actions, Section }) {
  const feed = useFabric(actions, { every: PAGE_POLL_MS })
  const now = useNow()
  return h(FabricView, { snapshot: feed, now, onRefresh: feed.refresh, Section })
}

// ---- the sidebar chip -------------------------------------------------------------------

// A dot and "Fabric" beside the settings control (the dot alone on the narrow rail). It is mounted
// only while the host has the Fabric view on, reads the status once a minute, and opens
// Settings → Fabric.
export function FabricChip({ actions, rail = false }) {
  const feed = useFabric(actions, { every: CHIP_POLL_MS })
  if (feed.value?.enabled === false) return null
  const state = deriveState(feed.value ?? null, { failed: feed.error !== '' })
  const label = chipLabel(state)
  return h('button', {
    type: 'button', className: 'bt-fab-chip', 'data-level': state.level, 'data-rail': rail || undefined,
    'aria-label': label, title: label, onClick: () => actions.openSettings('fabric'),
  },
  h('span', { className: 'bt-fab-dot', 'data-tone': levelTone(state.level), 'data-busy': (feed.loading && feed.value === null) || undefined, 'aria-hidden': true }),
  rail ? null : h('span', { className: 'bt-fab-chip-label' }, t('Fabric')))
}

export const FABRIC_CSS = `
:is(.bt-fab-dot,.bt-fab-fill)[data-tone=ok]{--fab-tone:color-mix(in srgb,var(--bt-green) 72%,var(--bt-ink))}
:is(.bt-fab-dot,.bt-fab-fill)[data-tone=warn]{--fab-tone:var(--bt-warn)}
:is(.bt-fab-dot,.bt-fab-fill)[data-tone=bad]{--fab-tone:var(--bt-danger)}
:is(.bt-fab-dot,.bt-fab-fill)[data-tone=muted]{--fab-tone:var(--bt-ink-3)}
.bt-fab-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--fab-tone,var(--bt-ink-3));box-shadow:0 0 0 3px color-mix(in srgb,var(--fab-tone,var(--bt-ink-3)) 18%,transparent)}
.bt-fab-dot[data-tone=muted]{background:transparent;box-shadow:inset 0 0 0 1.5px var(--bt-ink-3)}
.bt-fab-dot[data-busy]{animation:bt-boot-pulse 1.6s ease-in-out infinite}

.bt-fab-bar{display:flex;align-items:center;flex-wrap:wrap;gap:10px 16px;padding:12px 14px;border:1px solid var(--bt-line);border-radius:12px;background:var(--bt-card)}
.bt-fab-overall{display:flex;align-items:center;gap:12px;flex:1 1 240px;min-width:0}
.bt-fab-overall-copy{display:flex;flex-direction:column;gap:1px;min-width:0}
.bt-fab-overall strong{font-size:14px;line-height:20px;font-weight:600}
.bt-fab-sub{font-size:12px;line-height:16px;color:var(--bt-ink-2);overflow-wrap:anywhere}
.bt-fab-bar-actions{display:flex;align-items:center;gap:10px;flex:none;margin-left:auto}
.bt-fab-updated{font-size:12px;line-height:16px;color:var(--bt-ink-3);font-variant-numeric:tabular-nums}
.bt-fab-spin{display:inline-flex}
.bt-fab-spin[data-on]{animation:bt-fab-spin .9s linear infinite}
@keyframes bt-fab-spin{to{transform:rotate(360deg)}}

.bt-fab-host{display:flex;flex-direction:column;gap:14px;padding:14px 14px 16px}
.bt-fab-host-head{display:flex;align-items:center;gap:10px;min-width:0}
.bt-fab-host-icon{flex:none;display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:10px;background:var(--bt-hover);color:var(--bt-ink-2)}
.bt-fab-host-copy{display:flex;flex-direction:column;min-width:0}
.bt-fab-host-name{font-size:14px;line-height:20px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-fab-muted{font-size:12px;line-height:16px;color:var(--bt-ink-2)}
.bt-fab-meters{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px 24px}
.bt-fab-meter{display:flex;flex-direction:column;gap:6px;min-width:0}
.bt-fab-meter-head{display:flex;justify-content:space-between;align-items:baseline;gap:8px;font-size:12px;line-height:16px}
.bt-fab-meter-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--bt-ink-2)}
.bt-fab-meter-value{flex:none;font-weight:500;font-variant-numeric:tabular-nums}
.bt-fab-meter-detail{font-size:12px;line-height:16px;color:var(--bt-ink-3);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.bt-fab-track{position:relative;height:6px;border-radius:999px;background:color-mix(in srgb,var(--bt-ink) 9%,transparent);overflow:hidden}
.bt-fab-fill{position:absolute;inset:0 auto 0 0;width:calc(var(--fab-frac,0) * 100%);border-radius:999px;background:var(--fab-tone,var(--bt-accent));transition:width .45s cubic-bezier(.3,0,.2,1)}
.bt-fab-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}

.bt-fab-row{display:flex;align-items:center;gap:10px;min-width:0;padding:10px 12px;font-size:13px;line-height:18px}
.bt-fab-row-main{flex:1;display:flex;flex-direction:column;gap:1px;min-width:0}
.bt-fab-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.bt-fab-hint{font-size:12px;line-height:16px;color:var(--bt-ink-2);overflow-wrap:anywhere}
.bt-fab-pad{padding:0 12px 12px}
.bt-fab-meta{flex:none;font-size:12px;line-height:16px;color:var(--bt-ink-2);font-variant-numeric:tabular-nums;text-align:right}
.bt-fab-meta em{font-style:normal;color:var(--bt-ink-3)}
.bt-fab-problem[data-absent] .bt-fab-name{color:var(--bt-ink-2);font-weight:400}

.bt-fab-os-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding:10px 12px 4px;font-size:13px;line-height:18px}
.bt-fab-services{list-style:none;margin:0;padding:4px 12px 12px;display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:0 20px}
.bt-fab-services li{display:flex;align-items:center;gap:8px;min-width:0;padding:5px 0;font-size:13px;line-height:18px}
.bt-fab-svc-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-fab-svc-state{flex:none;font-size:12px;color:var(--bt-ink-2)}

.bt-fab-k{font-size:12px;line-height:16px;color:var(--bt-ink-2)}
.bt-fab-tiles,.bt-fab-save-pair{display:grid;gap:1px;background:var(--bt-line)}
.bt-fab-tiles{grid-template-columns:repeat(auto-fit,minmax(128px,1fr))}
.bt-fab-save-pair{grid-template-columns:repeat(auto-fit,minmax(230px,1fr))}
.bt-set-card>:is(.bt-fab-tiles,.bt-fab-save-pair):first-child{border-radius:12px 12px 0 0;overflow:hidden}
.bt-fab-tile{display:flex;flex-direction:column;gap:2px;min-width:0;padding:12px 14px;background:var(--bt-card)}
.bt-fab-tile-value{font-size:20px;line-height:26px;font-weight:600;letter-spacing:-.01em;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.bt-fab-kv{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px 28px;margin:0;padding:12px 14px}
.bt-fab-kv>div{display:flex;justify-content:space-between;align-items:baseline;gap:10px;min-width:0;font-size:12px;line-height:16px}
.bt-fab-kv dt{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--bt-ink-2)}
.bt-fab-kv dd{margin:0;font-weight:500;font-variant-numeric:tabular-nums;text-align:right;overflow-wrap:anywhere}
.bt-fab-more{display:flex;padding:0 12px 12px}
.bt-fab-save{display:flex;flex-direction:column;gap:8px;min-width:0;padding:14px;background:var(--bt-card)}
.bt-fab-save-main{display:flex;align-items:baseline;gap:6px}
.bt-fab-save-main strong{font-size:24px;line-height:28px;font-weight:600;letter-spacing:-.01em;font-variant-numeric:tabular-nums}
.bt-fab-harness-bar{flex:0 1 160px;min-width:48px}
.bt-fab-harness .bt-fab-name{flex:0 1 150px}

.bt-fab-empty{display:flex;flex-direction:column;align-items:center;gap:8px;padding:36px 20px;border:1px dashed var(--bt-line-2);border-radius:12px;color:var(--bt-ink-2);text-align:center}
.bt-fab-empty-mark{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:16px;background:var(--bt-hover);color:var(--bt-ink-2)}
.bt-fab-empty-mark svg{width:22px;height:22px}
.bt-fab-empty h3{margin:6px 0 0;font-size:14px;line-height:20px;font-weight:600;color:var(--bt-ink)}
.bt-fab-empty p{max-width:46ch;margin:0;font-size:13px;line-height:19px;overflow-wrap:anywhere}
.bt-fab-code{max-width:100%;margin:8px 0 0;padding:10px 14px;border-radius:10px;background:var(--bt-hover);color:var(--bt-ink);font:12px/18px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;text-align:left;tab-size:2;overflow-x:auto}
.bt-fab-skel{display:flex;flex-direction:column;gap:20px}
.bt-fab-skel i{display:block;border-radius:12px;background-color:var(--bt-hover);background-image:linear-gradient(100deg,transparent 30%,color-mix(in srgb,var(--bt-ink) 8%,transparent) 50%,transparent 70%);background-size:220% 100%;background-repeat:no-repeat;animation:bt-skel-sweep 1.7s ease-in-out calc(var(--bt-skel-i,0) * 90ms) infinite}
.bt-fab-foot{margin:-8px 4px 0;font-size:12px;line-height:16px;color:var(--bt-ink-3)}

.bt-fab-chip{flex:none;display:inline-flex;align-items:center;gap:7px;height:28px;padding:0 11px 0 10px;border:0;border-radius:999px;background:none;color:var(--bt-ink-2);font:inherit;font-size:12px;line-height:16px;font-weight:500;letter-spacing:.01em;cursor:pointer;box-shadow:inset 0 0 0 1px var(--bt-line);transition:background-color .12s ease,color .12s ease,transform .12s ease}
.bt-fab-chip:hover{background:var(--bt-hover);color:var(--bt-ink)}
.bt-fab-chip:active{transform:scale(.97)}
.bt-fab-chip:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-fab-chip:is([data-level=degraded],[data-level=down]){color:var(--bt-ink)}
.bt-fab-chip[data-rail]{width:36px;height:36px;padding:0;justify-content:center;box-shadow:none}
.bt-fab-chip-label{white-space:nowrap}

/* A capability seeded from the host's configuration (Settings → Capabilities). */
.bt-config-tag{max-width:none}

@media (max-width:640px){
  .bt-fab-bar-actions{width:100%;justify-content:space-between;margin-left:0}
  .bt-fab-row{align-items:flex-start}
  .bt-fab-row>.bt-fab-dot{margin-top:5px}
  .bt-fab-meta{max-width:42%;overflow-wrap:anywhere}
  .bt-fab-harness{flex-wrap:wrap}
  .bt-fab-harness .bt-fab-name{flex:1 1 100%}
  .bt-fab-harness-bar{flex:1 1 40%}
}
body[data-bt-motion=quiet] :is(.bt-fab-spin,.bt-fab-dot,.bt-fab-skel i){animation:none}
body[data-bt-motion=quiet] :is(.bt-fab-fill,.bt-fab-chip){transition:none}
@media (prefers-reduced-motion:reduce){
  .bt-fab-spin,.bt-fab-dot,.bt-fab-skel i{animation:none}
  .bt-fab-fill,.bt-fab-chip{transition:none}
}
`
