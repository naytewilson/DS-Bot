// The ANVIL edition's own look: the anvil mark, the brand row, the boot state, the page
// title and the finishing touches (focus rings, selection, the empty pane). The product
// name comes from src/shared/brand.js; the mark's geometry is assets/brand/mark.svg.
import { createElement as h, useEffect, useState } from 'react'
import { BRAND, BRAND_FAMILY } from '../shared/brand.js'
import { t } from './i18n.js'

// One shape: horn, flat face, waist, wide base. Drawn in the 512 box of assets/brand/mark.svg
// and cropped here to its own bounds, so a 16 to 20 px mark is not mostly margin.
export const GLYPH_PATH = 'M52 156C96 154 134 134 176 120H440Q456 120 456 136V180Q456 196 440 196H388V258Q388 312 448 316V372Q448 392 428 392H204Q184 392 184 372V316Q244 312 244 258V196H190C134 196 90 188 52 156Z'
export const GLYPH_VIEWBOX = '46 104 416 304'

// The mark takes its color from the text around it (`currentColor`). Labelled, it is an
// image; unlabelled, it is decoration.
export function AnvilGlyph({ size = 20, className, label }) {
  return h('svg', {
    className: className ? `bt-glyph ${className}` : 'bt-glyph',
    width: size, height: size, viewBox: GLYPH_VIEWBOX, fill: 'currentColor', focusable: 'false',
    role: label ? 'img' : undefined, 'aria-label': label, 'aria-hidden': label ? undefined : true,
  }, h('path', { d: GLYPH_PATH }))
}

// The product name in two parts, "ANVIL" and "Crew", so a narrow sidebar can drop the second.
export function brandParts(brand = BRAND, family = BRAND_FAMILY) {
  return brand.startsWith(`${family} `) ? [family, brand.slice(family.length + 1)] : [brand, '']
}

// The sidebar's brand cells: DSH's own `sidebar.brand.mark` and `sidebar.brand.name`, and
// the team column's top row, draw these.
export function BrandMark({ size = 20 }) {
  return h('span', { className: 'bt-brand-glyph' }, h(AnvilGlyph, { size }))
}
export function BrandName() {
  const [word, rest] = brandParts()
  return h('span', { className: 'bt-brand-name' },
    h('span', { className: 'bt-brand-word' }, word),
    rest ? h('span', { className: 'bt-brand-crew' }, rest) : null)
}
// The avatar rail has no room for a name: the mark alone, named for assistive technology.
export function RailBrand() {
  return h('span', { className: 'bt-rail-brand', role: 'img', 'aria-label': BRAND, title: BRAND }, h(AnvilGlyph, { size: 22 }))
}

// What DSH shows before a chat is started, where its own mark stood.
export function HeroMark({ size = 34, className }) {
  return h('span', { className: className ? `bt-hero-mark ${className}` : 'bt-hero-mark' }, h(AnvilGlyph, { size: Math.round(size * 1.2) }))
}

// While the team is still loading: the mark, pulsing, above three rows that stand where
// the Main Bot and the first chats will be. `wide` is the open column; the rail gets tiles.
export function BootRows({ wide }) {
  return h('div', { className: 'bt-boot', 'data-wide': wide ? '' : undefined, role: 'status', 'aria-label': t('Setting up your Main Bot…') },
    h('span', { className: 'bt-boot-mark', 'aria-hidden': true }, h(AnvilGlyph, { size: wide ? 22 : 26 })),
    [0, 1, 2].map(index => h('span', { key: index, className: 'bt-skel-row', 'aria-hidden': true, style: { '--bt-skel-i': index } },
      h('i', { className: 'bt-skel-ava' }),
      wide ? h('span', { className: 'bt-skel-lines' }, h('i'), h('i')) : null)))
}

// The main pane while the team loads: the mark, the name and one line of status. It
// waits a beat before it shows, so a quick start never flashes it, and it gives the pane
// back after COVER_MS in case the team never answers.
export const COVER_MS = 30_000
export function BootSplash({ paneLeft = 0, leaving = false }) {
  const [tired, setTired] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setTired(true), COVER_MS)
    return () => clearTimeout(timer)
  }, [])
  if (tired) return null
  return h('div', { className: 'bt-splash', style: { left: paneLeft }, role: 'status', 'aria-live': 'polite', 'data-leaving': leaving || undefined },
    h('div', { className: 'bt-splash-card' },
      h('span', { className: 'bt-splash-mark', 'aria-hidden': true }, h(AnvilGlyph, { size: 56 })),
      h('div', { className: 'bt-splash-name' }, BRAND),
      h('div', { className: 'bt-splash-line' }, t('Setting up your Main Bot…'))))
}

// DSH names its pages "Chief — DeepSeek Harness". The tab and the window show this
// edition's name in its place. Only the product suffix changes.
const SUFFIX = /DeepSeek Harness\s*$/
export const brandTitle = (title, brand = BRAND) => (typeof title === 'string' && SUFFIX.test(title) ? title.replace(SUFFIX, brand) : title)

// Rewrites the title now and each time DSH sets it again. Returns the remover. Setting a
// title that already reads right changes nothing, so the guard never answers itself.
export function installTitleGuard(doc = globalThis.document) {
  if (!doc) return () => {}
  const apply = () => {
    const next = brandTitle(doc.title)
    if (next !== doc.title) doc.title = next
  }
  apply()
  const view = doc.defaultView
  if (!view?.MutationObserver || !doc.head) return () => {}
  const observer = new view.MutationObserver(apply)
  // The <title> element's text changes, or DSH swaps the element itself.
  observer.observe(doc.head, { childList: true, subtree: true, characterData: true })
  return () => observer.disconnect()
}

// The finishing sheet. Colors come from the theme variables, corners from the shared steps.
export const BRAND_CSS = `
/* The mark and the brand row. Wide, the row reads "ANVIL Crew"; as the column narrows
   "Crew" goes, then the name, and the mark stays. The widths are those of the row beside
   four 32px buttons (five while the update button shows) and its 4px gaps. */
.bt-glyph{display:block;flex:none;overflow:visible}
.bt-brand-glyph{display:inline-flex;flex:none;color:var(--bt-accent)}
.bt-brand{min-width:0;overflow:hidden;gap:7px;padding-right:4px}
.bt-brand-name{display:inline-flex;align-items:baseline;gap:.32em;min-width:0;overflow:hidden;white-space:nowrap;font-size:14px;line-height:20px;font-weight:600}
.bt-brand-word{letter-spacing:.07em}
.bt-brand-crew{font-weight:500;color:var(--bt-ink-2)}
.bt-side-top{container:bt-top/inline-size;gap:4px}
.bt-side-top .bt-round{flex:none;width:32px;height:32px}
@container bt-top (max-width:271px){.bt-brand-crew{display:none}}
@container bt-top (max-width:233px){.bt-brand-name{display:none}}
.bt-side-top:has(.bt-update){container-name:bt-top-update}
@container bt-top-update (max-width:309px){.bt-brand-crew{display:none}}
@container bt-top-update (max-width:269px){.bt-brand-name{display:none}}
.bt-rail-brand{display:inline-flex;align-items:center;justify-content:center;width:36px;height:28px;flex:none;color:var(--bt-accent)}

/* Loading: the sidebar's skeleton and the main pane's splash. */
.bt-boot{display:flex;flex-direction:column;gap:3px;padding:2px 0}
.bt-boot-mark{display:flex;align-items:center;justify-content:center;height:34px;color:var(--bt-accent);animation:bt-boot-pulse 2s ease-in-out infinite}
.bt-boot:not([data-wide]){align-items:center;gap:6px}
.bt-skel-row{display:flex;align-items:center;gap:10px;height:54px;padding:8px;box-sizing:border-box;animation:bt-veil-in .3s ease-out calc(var(--bt-skel-i,0) * 70ms) backwards}
.bt-boot:not([data-wide]) .bt-skel-row{width:56px;height:56px;padding:0;justify-content:center}
.bt-skel-lines{display:flex;flex-direction:column;gap:7px;flex:1;min-width:0}
.bt-skel-ava,.bt-skel-lines i{display:block;background-color:var(--bt-hover);background-image:linear-gradient(100deg,transparent 30%,color-mix(in srgb,var(--bt-ink) 8%,transparent) 50%,transparent 70%);background-size:220% 100%;background-repeat:no-repeat;animation:bt-skel-sweep 1.7s ease-in-out infinite}
.bt-skel-ava{flex:none;width:36px;height:36px;border-radius:50%}
.bt-boot:not([data-wide]) .bt-skel-ava{width:40px;height:40px;border-radius:16px}
.bt-skel-lines i{height:9px;border-radius:999px}
.bt-skel-lines i:first-child{width:62%}
.bt-skel-lines i:last-child{width:38%;height:8px}
@keyframes bt-boot-pulse{0%,100%{opacity:.5;transform:scale(.94)}50%{opacity:1;transform:scale(1)}}
@keyframes bt-skel-sweep{from{background-position:130% 0}to{background-position:-30% 0}}
.bt-splash{position:fixed;top:var(--dsh-frame-chrome-top,0px);right:0;bottom:0;z-index:24;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;background:var(--bt-main);color:var(--bt-ink);font-family:var(--bt-font);animation:bt-splash-in .32s ease-out .14s backwards}
.bt-splash[data-leaving]{animation:bt-splash-out .2s ease-in forwards;pointer-events:none}
.bt-splash-card{display:flex;flex-direction:column;align-items:center;gap:6px;text-align:center}
.bt-splash-mark{display:flex;color:var(--bt-accent);margin-bottom:10px;animation:bt-boot-pulse 2s ease-in-out infinite}
.bt-splash-name{font-size:15px;line-height:20px;font-weight:600;letter-spacing:.05em}
.bt-splash-line{font-size:13px;line-height:18px;color:var(--bt-ink-3)}
@keyframes bt-splash-in{from{opacity:0}}
@keyframes bt-splash-out{to{opacity:0}}
body[data-bt-motion=quiet] :is(.bt-boot-mark,.bt-splash-mark,.bt-skel-ava,.bt-skel-lines i){animation:none}
@media (prefers-reduced-motion:reduce){
  .bt-boot-mark,.bt-splash-mark,.bt-skel-ava,.bt-skel-lines i,.bt-skel-row{animation:none}
  .bt-splash,.bt-splash[data-leaving]{animation:none}
  .bt-splash[data-leaving]{opacity:0}
}

/* The pane before a chat is started: the anvil where DSH's own mark stood. */
html body .bt-hero-mark{display:inline-flex;align-items:center;justify-content:center;color:var(--bt-accent)}

/* Focus, selection and scrollbars. Focus rings the sheets above do not already draw: the
   accent, 2px, offset outward. :where keeps these at no specificity, so a ring that sets its
   own offset keeps it. */
:where(.bt-leftcol,.bt-pane,.bt-panel,.bt-settings-layer,.bt-mem-layer,.bt-palette-layer,.bt-menu,.bt-update-pop) :where(a[href],button,[role=button],[role=menuitem],[role=tab],summary,input,select,textarea,[tabindex]:not([tabindex="-1"])):focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
:where(.bt-leftcol,.bt-pane,.bt-panel,.bt-settings-layer,.bt-mem-layer,.bt-palette-layer,.bt-menu,.bt-update-pop) :where(input,select,textarea):focus-visible{outline-offset:0}
::selection{background:color-mix(in srgb,var(--bt-accent) 32%,transparent)}
:is(.bt-pane,.bt-panel,.bt-settings-layer,.bt-mem-layer,.bt-palette-layer,.bt-menu,.bt-update-pop,.bt-leftcol[data-left=rail]){scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--bt-ink) 24%,transparent) transparent}
`
