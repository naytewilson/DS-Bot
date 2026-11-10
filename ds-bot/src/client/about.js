// Settings → About: the version, updates for ANVIL Crew and DSH, the credit to the project
// it is built on, and the links to that repository. The sidebar's cloud button shows the
// same update state.
import { createElement as h, useEffect, useState } from 'react'
import { GitHubMark } from './connector-marks.js'
import { whenText } from './feedback.js'
import { dateLocale, hostText, t } from './i18n.js'
import { StarLineIcon } from './icons.js'
import { SPRING_POP } from './motion.js'
import { AnvilGlyph } from './brand.js'
import { BRAND } from '../shared/brand.js'
import { showsDshRow } from './dsh-offer.js'

// The length of the mark's strike (bt-anvil-strike below).
const CHEER_MS = 1800

const starCount = count => new Intl.NumberFormat(dateLocale(), { notation: 'compact', maximumFractionDigits: 1 }).format(count)

// The edition's name for the About page, or null for the upstream release.
export function editionName(edition) {
  if (typeof edition !== 'string' || edition === '') return null
  return edition === 'anvil' ? t('ANVIL edition') : t('{edition} edition', { edition })
}

function botHint(update) {
  // An edition is installed from its owner's own commit and moves with the owner's fabric.
  if (update.managed || update.source === 'fabric') return t('Managed by your fabric.')
  if (update.phase === 'installing') return t('Updating {brand}…')
  if (update.phase === 'installed') return t('Restart DSH to start using {brand} {version}.', { version: update.installed ?? update.latest })
  if (update.phase === 'updated') return t('{brand} {version} is installed.', { version: update.installed ?? update.latest })
  if (update.phase === 'failed') return t('The update did not finish: {reason}', { reason: hostText(update.error ?? '') })
  if (update.available) return t('{brand} {version} is available', { version: update.latest })
  if (update.source === 'app') return t('Updates come with the {brand} app.')
  if (update.enabled === false) return t('Update checks are off.')
  if (update.source === 'path') return t('Installed from a local folder; update it there.')
  if (!update.checkedAt) return null
  if (!update.latest && update.source !== 'registry') return t('Updates are not offered for this install.')
  const checked = t('Checked {time}', { time: whenText(update.checkedAt) })
  return `${update.latest ? t('Up to date') : t('Could not check for updates.')} · ${checked}`
}

// The ANVIL Crew row in the desktop app shows the app's own update state, kept as ownApp on
// the update value. Anything that is not a state object (DSH Desktop, DSH Web, an
// unpackaged app) leaves the row with today's "comes with the app" text.
export function ownAppRow(ownApp) {
  if (ownApp === null || typeof ownApp !== 'object') return null
  const version = typeof ownApp.version === 'string' ? ownApp.version : ''
  switch (ownApp.phase) {
    case 'checking': return { hint: t('Checking for updates…'), button: null }
    case 'current': return { hint: t('Up to date'), button: 'check' }
    case 'downloading': return { hint: t('Downloading {version}…', { version }), button: null }
    case 'downloaded': return { hint: t('{version} is ready; it installs when you restart', { version }), button: 'restart' }
    case 'available': return { hint: t('{version} is available', { version }), button: 'open' }
    case 'failed': return { hint: t('Could not check for updates.'), button: 'check' }
    default: return null
  }
}

function dshHint(dsh, shown) {
  if (dsh.phase === 'installing') return t('Updating DSH…')
  if (dsh.phase === 'installed') return t('Restart DSH to start using DSH {version}.', { version: dsh.installed ?? dsh.verified })
  if (dsh.phase === 'failed') return t('The update did not finish: {reason}', { reason: hostText(dsh.error ?? '') })
  if (dsh.available === false && dsh.blockedBy) return t('Update {brand} {version} first.', { version: dsh.blockedBy })
  if (shown) return t('DSH {version} is available', { version: dsh.verified })
  return t('Version {version}', { version: dsh.current })
}

const linkProps = href => ({ className: 'bt-soft bt-soft-sm bt-about-link', href, target: '_blank', rel: 'noopener noreferrer' })

export function AboutPage({ useUpdate, actions, run, Section, Row }) {
  const update = useUpdate(value => value) ?? {}
  const [checking, setChecking] = useState(false)
  const [stars, setStars] = useState(null)
  useEffect(() => {
    let live = true
    actions.repoStars().then((count) => { if (live && Number.isInteger(count)) setStars(count) }, () => {})
    return () => { live = false }
  }, [])
  // The anvil strikes when the page opens, after a check, and when an update is in.
  const [cheer, setCheer] = useState(true)
  useEffect(() => {
    if (!cheer) return undefined
    const timer = setTimeout(() => setCheer(false), CHEER_MS)
    return () => clearTimeout(timer)
  }, [cheer])
  const check = () => {
    setChecking(true)
    void run(actions.checkUpdate()).then((done) => { setChecking(false); if (done) setCheer(true) })
  }
  const phase = update.phase ?? 'idle'
  const dsh = update.dsh
  const dshPhase = dsh?.phase ?? 'idle'
  useEffect(() => { if (phase === 'installed' || phase === 'updated' || dshPhase === 'installed') setCheer(true) }, [phase, dshPhase])
  const markState = checking ? 'searching' : phase === 'installing' || dshPhase === 'installing' ? 'working' : cheer ? 'done' : 'idle'
  // Same rule as the sidebar card.
  const dshNew = showsDshRow(dsh, update.app)
  const dshShown = dshNew && dsh.available
  const ownRow = update.source === 'app' ? ownAppRow(update.ownApp) : null
  const ownControl = ownRow?.button === 'restart'
    ? h('button', { type: 'button', className: 'bt-fb-primary', onClick: () => run(actions.installOwnApp()) }, t('Restart to update'))
    : ownRow?.button === 'check'
      ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => run(actions.checkOwnApp()) }, t('Check for updates'))
      : ownRow?.button === 'open'
        ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => run(actions.openOwnApp()) }, t('Download'))
        : null
  const botControl = update.managed ? null : ownRow !== null ? ownControl
    : phase === 'installed' || phase === 'updated' || update.source === 'app' ? null
    : update.available || phase === 'installing'
      ? h('button', { type: 'button', className: 'bt-fb-primary', disabled: phase === 'installing', onClick: () => run(actions.installUpdate()) },
          phase === 'installing' ? t('Updating…') : phase === 'failed' ? t('Try again') : t('Update'))
      : h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: checking || update.enabled === false, onClick: check }, checking ? t('Checking…') : t('Check for updates'))
  const dshControl = !dshNew || dshPhase === 'installed' ? null
    : dsh.kind === 'app'
      ? dsh.available ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => run(actions.openAppUpdates(dsh.verified)) }, t('Open updates')) : null
      : dsh.available || dshPhase !== 'idle'
        ? h('button', { type: 'button', className: 'bt-fb-primary', disabled: dshPhase === 'installing', onClick: () => run(actions.installDshUpdate()) },
            dshPhase === 'installing' ? t('Updating…') : dshPhase === 'failed' ? t('Try again') : t('Update'))
        : null
  const repo = update.repoUrl
  const edition = editionName(update.edition)
  return [
    h('div', { key: 'hero', className: 'bt-about-hero' },
      h('span', { className: 'bt-about-mark', 'data-state': markState }, h(AnvilGlyph, { size: 36 })),
      h('div', { className: 'bt-about-copy' },
        h('span', { className: 'bt-about-name' }, BRAND, edition ? h('span', { className: 'bt-about-edition' }, edition) : null),
        update.current ? h('span', { className: 'bt-about-version' }, t('Version {version}', { version: update.current })) : null,
        h('span', { className: 'bt-about-credit' }, edition && update.base ? t('Built on {upstream} {version}', { version: update.base }) : t('Built on {upstream}'))),
      repo ? h('a', {
        className: 'bt-star', href: repo, target: '_blank', rel: 'noopener noreferrer', title: t('Star {upstream} on GitHub'),
        'aria-label': stars === null ? t('Star {upstream} on GitHub') : `${t('Star {upstream} on GitHub')} · ${t('{count} stars', { count: stars })}`,
      },
      h('span', { className: 'bt-star-main' }, h('span', { className: 'bt-star-icon' }, h(StarLineIcon)), 'Star'),
      stars === null ? null : h('span', { className: 'bt-star-count' }, starCount(stars))) : null),
    repo ? h('p', { key: 'ask', className: 'bt-about-ask' }, t('If {upstream} helps you, a star on GitHub helps more people find it.')) : null,
    h(Section, { key: 'updates', title: t('Updates') },
      h(Row, { label: BRAND, hint: ownRow?.hint ?? botHint(update) }, botControl, update.available && update.notesUrl ? h('a', linkProps(update.notesUrl), t("What's new")) : null),
      dsh?.current ? h(Row, { label: 'DeepSeek Harness', hint: dshHint(dsh, dshShown) }, dshControl) : null),
    h(Section, { key: 'links', title: t('Links') },
      repo ? h(Row, { label: t('Source code'), hint: repo.replace(/^https:\/\//, '') }, h('a', linkProps(repo), h(GitHubMark), t('Open'))) : null,
      update.notesUrl ? h(Row, { label: update.edition ? t('Upstream release notes') : t('Release notes') }, h('a', linkProps(update.notesUrl), t('Open'))) : null,
      h(Row, { label: t('Report a problem') }, h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => actions.openSettings('feedback') }, t('Open')))),
  ]
}

export const ABOUT_CSS = `
.bt-about-hero{display:flex;align-items:center;gap:14px;padding:16px;border:1px solid var(--bt-line);border-radius:12px;background:var(--bt-card)}
.bt-about-mark{flex:none;display:inline-flex;align-items:center;justify-content:center;width:56px;height:56px;border-radius:16px;color:var(--bt-accent);background:color-mix(in srgb,var(--bt-accent) 12%,var(--bt-card));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--bt-accent) 24%,transparent)}
body:not([data-bt-motion=quiet]) .bt-about-mark[data-state=done] .bt-glyph{animation:bt-anvil-strike .56s cubic-bezier(.3,0,.2,1)}
body:not([data-bt-motion=quiet]) .bt-about-mark:is([data-state=searching],[data-state=working]) .bt-glyph{animation:bt-boot-pulse 1.2s ease-in-out infinite}
@keyframes bt-anvil-strike{0%{transform:none}28%{transform:translateY(3px) scale(1.05,.93)}58%{transform:translateY(-1.5px) scale(.99,1.02)}100%{transform:none}}
.bt-about-copy{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.bt-about-name{display:flex;align-items:center;flex-wrap:wrap;gap:4px 8px;font-size:16px;line-height:22px;font-weight:600;letter-spacing:.04em}
.bt-about-edition{display:inline-flex;align-items:center;height:18px;padding:0 8px;border-radius:999px;background:color-mix(in srgb,var(--bt-accent) 14%,transparent);color:var(--bt-accent);font-size:11px;line-height:16px;font-weight:600;letter-spacing:.05em;text-transform:uppercase}
.bt-about-credit{font-size:12px;line-height:16px;color:var(--bt-ink-3)}
.bt-about-version{font-size:12px;line-height:16px;color:var(--bt-ink-2);font-variant-numeric:tabular-nums}
.bt-about-ask{margin:-10px 4px 0;font-size:12px;line-height:16px;color:var(--bt-ink-3)}
.bt-star{flex:none;display:inline-flex;align-items:stretch;height:30px;border-radius:999px;border:1px solid var(--bt-line-2,var(--bt-line));overflow:hidden;color:var(--bt-ink);text-decoration:none;font-size:12px;line-height:28px;transition:transform .12s ease,border-color .15s ease}
.bt-star:hover{border-color:color-mix(in srgb,#e3a008 55%,var(--bt-line))}
.bt-star:active{transform:scale(.96)}
.bt-star-main{display:inline-flex;align-items:center;gap:6px;padding:0 12px 0 10px;background:var(--bt-hover);font-weight:500}
.bt-star-icon{display:inline-flex;color:var(--bt-ink-2);transition:color .15s ease}
.bt-star-icon path{transition:fill .15s ease}
.bt-star:hover .bt-star-icon{color:#e3a008;animation:bt-star-pop ${SPRING_POP.duration}ms ${SPRING_POP.easing}}
.bt-star:hover .bt-star-icon path{fill:currentColor}
.bt-star-count{display:inline-flex;align-items:center;padding:0 11px;border-left:1px solid var(--bt-line-2,var(--bt-line));color:var(--bt-ink-2);font-variant-numeric:tabular-nums;animation:bt-star-count-in ${SPRING_POP.duration}ms ${SPRING_POP.easing},bt-veil-in .2s ease-out}
@keyframes bt-star-pop{from{scale:.6;rotate:-30deg}}
@keyframes bt-star-count-in{from{translate:-6px 0}}
.bt-about-link{display:inline-flex;align-items:center;gap:6px;text-decoration:none}
.bt-about-link svg{width:14px;height:14px}
.bt-fb-primary:disabled{opacity:.6;cursor:default;filter:none}
@media (prefers-reduced-motion:reduce){.bt-star:hover .bt-star-icon,.bt-star-count,.bt-about-mark .bt-glyph{animation:none!important}}
`
