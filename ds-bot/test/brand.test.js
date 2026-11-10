import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { BRAND, BRAND_FAMILY, BRAND_SHORT, UPSTREAM } from '../src/shared/brand.js'
import { DEFAULT_THEME, allThemes } from '../src/client/themes.js'
import { luminance } from '../src/client/inks.js'

// jsdom comes from the harness that test/harness-resolve.mjs found, like the dsh packages.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { JSDOM } = createRequire(join(process.env.DSH_HARNESS ?? join(PLUGIN, '..', 'deepseek-harness'), 'package.json'))('jsdom')

const bundle = await build({
  stdin: {
    contents: "export * from './src/client/brand.js'\nexport { t, hostText, installLocale, language, DICTIONARY } from './src/client/i18n.js'",
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState: initial => [initial, () => {}],
  useEffect: () => {},
}
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, setTimeout, clearTimeout, require: name => (name === 'react' ? react : {}) })
const brand = module.exports

// Elements are { type, props, children }; a component element is drawn by calling it.
const drawn = node => (typeof node.type === 'function' ? node.type({ ...node.props, children: node.children }) : node)
const walk = (node, pick) => {
  if (Array.isArray(node)) return node.flatMap(one => walk(one, pick))
  if (node === null || typeof node !== 'object') return []
  const shown = drawn(node)
  return shown === null || typeof shown !== 'object' ? [] : [...pick(shown), ...walk(shown.children, pick)]
}
const strings = node => (Array.isArray(node) ? node.flatMap(strings) : typeof node === 'string' ? [node] : node && typeof node === 'object' ? strings(drawn(node)?.children ?? []) : [])
const textOf = node => strings(node).join('')
const withClass = (tree, name) => walk(tree, node => (String(node.props?.className ?? '').split(' ').includes(name) ? [node] : []))
const tick = () => new Promise(resolve => setImmediate(resolve))

test('the product name has one source, and its parts agree with it', () => {
  assert.equal(BRAND, `${BRAND_FAMILY} ${BRAND_SHORT}`)
  assert.deepEqual([...brand.brandParts(BRAND)], [BRAND_FAMILY, BRAND_SHORT])
  assert.deepEqual([...brand.brandParts('Forge')], ['Forge', ''])
  assert.notEqual(UPSTREAM, BRAND)
})

test('the anvil mark is one path in the text color; a label makes it an image', () => {
  const plain = brand.AnvilGlyph({ size: 18 })
  assert.equal(plain.type, 'svg')
  assert.equal(plain.props.fill, 'currentColor')
  assert.equal(plain.props.width, 18)
  assert.equal(plain.props['aria-hidden'], true)
  assert.equal(plain.props.role, undefined)
  assert.deepEqual(plain.children.map(node => [node.type, node.props.d]), [['path', brand.GLYPH_PATH]])
  const named = brand.AnvilGlyph({ label: BRAND, className: 'x' })
  assert.equal(named.props.role, 'img')
  assert.equal(named.props['aria-label'], BRAND)
  assert.equal(named.props['aria-hidden'], undefined)
  assert.equal(named.props.className, 'bt-glyph x')
  // No gradients or fixed colors: the mark follows the theme.
  assert.doesNotMatch(JSON.stringify(plain), /gradient|#[0-9a-f]{3,6}|rgb/i)
})

test('the brand cells read ANVIL Crew, and the rail shows the mark alone', () => {
  const name = brand.BrandName()
  assert.equal(textOf(name), `${BRAND_FAMILY}${BRAND_SHORT}`)
  assert.deepEqual(withClass(name, 'bt-brand-word').map(textOf), [BRAND_FAMILY])
  assert.deepEqual(withClass(name, 'bt-brand-crew').map(textOf), [BRAND_SHORT])
  assert.equal(withClass(brand.BrandMark({ size: 20 }), 'bt-glyph').length, 1)
  const rail = brand.RailBrand()
  assert.equal(rail.props['aria-label'], BRAND)
  assert.equal(rail.props.role, 'img')
  assert.equal(strings(rail).length, 0)
  // DSH hands the hero its size and its own class; the mark keeps both.
  const hero = brand.HeroMark({ size: 34, className: 'host' })
  assert.equal(hero.props.className, 'bt-hero-mark host')
  assert.equal(withClass(hero, 'bt-glyph')[0].props.width, 41)
})

test('assets/brand holds the same mark as the app, centred and inside the maskable safe zone', () => {
  const dir = new URL('../assets/brand/', import.meta.url)
  const mark = readFileSync(new URL('mark.svg', dir), 'utf8')
  const icon = readFileSync(new URL('icon.svg', dir), 'utf8')
  for (const [name, svg] of [['mark.svg', mark], ['icon.svg', icon]]) {
    assert.match(svg, /viewBox="0 0 512 512"/, name)
    assert.ok(svg.includes(`d="${brand.GLYPH_PATH}"`), `${name} draws the app's path`)
  }
  assert.match(mark, /fill="#ff7a1a"/)
  assert.match(icon, /<rect [^>]*fill="#0e1012"/)
  assert.match(icon, /<rect [^>]*rx="\d+"/)

  // Extents of the absolute path (M C H V Q Z): every end and control point.
  const xs = []
  const ys = []
  let x = 0
  let y = 0
  for (const [, op, args] of brand.GLYPH_PATH.matchAll(/([MCHVQZ])([^MCHVQZ]*)/g)) {
    const n = args.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? []
    if (op === 'H') { x = n[0]; xs.push(x); continue }
    if (op === 'V') { y = n[0]; ys.push(y); continue }
    for (let i = 0; i < n.length; i += 2) { xs.push(n[i]); ys.push(n[i + 1]) }
    if (n.length > 0) { x = n.at(-2); y = n.at(-1) }
  }
  const box = { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) }
  // The standalone mark is centred in its box...
  assert.ok(Math.abs((box.left + box.right) / 2 - 256) <= 4, `x centre ${(box.left + box.right) / 2}`)
  assert.ok(Math.abs((box.top + box.bottom) / 2 - 256) <= 4, `y centre ${(box.top + box.bottom) / 2}`)
  // ...and the icon scales it into the central 60% (307 px of 512).
  const scale = Number(icon.match(/scale\(([\d.]+)\)/)[1])
  assert.ok((box.right - box.left) * scale <= 512 * 0.6, 'wider than the safe zone')
  assert.ok((box.bottom - box.top) * scale <= 512 * 0.6, 'taller than the safe zone')
  // The app's viewBox crops to the same shape with a little room.
  const [vx, vy, vw, vh] = brand.GLYPH_VIEWBOX.split(' ').map(Number)
  assert.ok(vx <= box.left && vy <= box.top && vx + vw >= box.right && vy + vh >= box.bottom)
})

test('page titles say the product, not the harness; only the suffix moves', () => {
  assert.equal(brand.brandTitle('Chief — DeepSeek Harness'), `Chief — ${BRAND}`)
  assert.equal(brand.brandTitle('DeepSeek Harness'), BRAND)
  assert.equal(brand.brandTitle('Settings'), 'Settings')
  assert.equal(brand.brandTitle('About DeepSeek Harness updates'), 'About DeepSeek Harness updates')
  assert.equal(brand.brandTitle(undefined), undefined)
})

test('the title guard rewrites each new title, survives a swapped element, and comes off cleanly', async () => {
  const dom = new JSDOM('<!doctype html><html><head><title>Chief — DeepSeek Harness</title></head><body></body></html>')
  const doc = dom.window.document
  const off = brand.installTitleGuard(doc)
  assert.equal(doc.title, `Chief — ${BRAND}`)
  doc.title = 'Writer — DeepSeek Harness'
  await tick()
  assert.equal(doc.title, `Writer — ${BRAND}`)
  // DSH can replace the element rather than its text.
  doc.head.querySelector('title').remove()
  const element = doc.createElement('title')
  element.textContent = 'DeepSeek Harness'
  doc.head.append(element)
  await tick()
  assert.equal(doc.title, BRAND)
  // Anything else is left as it is, and the guard never answers itself in a loop.
  doc.title = 'Settings'
  await tick()
  assert.equal(doc.title, 'Settings')
  off()
  doc.title = 'Late — DeepSeek Harness'
  await tick()
  assert.equal(doc.title, 'Late — DeepSeek Harness')
  assert.doesNotThrow(() => off())
  // Without a document (a test host, a worker) it is a no-op.
  assert.doesNotThrow(() => brand.installTitleGuard(null)())
})

test('copy names the product through {brand}, in English and Chinese, and host messages follow', () => {
  assert.equal(brand.t('{brand} {version} is available', { version: '1.2' }), `${BRAND} 1.2 is available`)
  assert.equal(brand.t('About {brand}'), `About ${BRAND}`)
  assert.equal(brand.t('Built on {upstream}'), `Built on ${UPSTREAM}`)
  assert.equal(brand.hostText('DS Bot restarted before this answer finished.'), `${BRAND} restarted before this answer finished.`)
  assert.equal(brand.hostText('Something new'), 'Something new')
  const dicts = new Map()
  const off = brand.installLocale({
    register: (ns, locale, dict) => { dicts.set(`${ns}:${locale}`, dict); return () => dicts.delete(`${ns}:${locale}`) },
    bind: ns => (key, params) => (dicts.get(`${ns}:zh`)?.[key] ?? key).replace(/\{(\w+)\}/g, (match, name) => (name in (params ?? {}) ? String(params[name]) : match)),
    getLocale: () => ({ active: 'zh' }),
  })
  try {
    assert.equal(brand.t('About {brand}'), `关于 ${BRAND}`)
    assert.equal(brand.t('{brand} {version} is available', { version: '1.2' }), `${BRAND} 1.2 可以更新`)
    assert.equal(brand.hostText('DS Bot restarted before this answer finished.'), `${BRAND} 在回答完成前重启了。`)
    assert.equal(brand.hostText('The API key for DeepSeek is set outside DS Bot and cannot be changed here'), `DeepSeek 的 API key 是在 ${BRAND} 之外设置的，这里改不了`)
    // The Chinese table keeps no copy of the old name for the client's own strings.
    const stale = Object.entries(brand.DICTIONARY.zh).filter(([key, value]) => /DS Bot/.test(String(value)) && !key.startsWith('DS Bot '))
    assert.deepEqual(stale, [])
  } finally {
    off()
  }
})

test('the sidebar loads with the mark pulsing over three skeleton rows; the rail gets tiles', () => {
  const wide = brand.BootRows({ wide: true })
  assert.equal(wide.props.role, 'status')
  assert.equal(wide.props['aria-label'], 'Setting up your Main Bot…')
  assert.equal(withClass(wide, 'bt-boot-mark').length, 1)
  assert.equal(withClass(wide, 'bt-glyph').length, 1)
  assert.equal(withClass(wide, 'bt-skel-row').length, 3)
  assert.equal(withClass(wide, 'bt-skel-lines').length, 3)
  const rail = brand.BootRows({ wide: false })
  assert.equal(rail.props['data-wide'], undefined)
  assert.equal(withClass(rail, 'bt-skel-row').length, 3)
  assert.equal(withClass(rail, 'bt-skel-lines').length, 0)
  // The skeleton is decoration; the label above says what is happening.
  for (const row of withClass(wide, 'bt-skel-row')) assert.equal(row.props['aria-hidden'], true)
})

test('the main pane loads with the mark, the name and one status line, and leaves when asked', () => {
  const splash = brand.BootSplash({ paneLeft: 88 })
  assert.equal(splash.props.style.left, 88)
  assert.equal(splash.props.role, 'status')
  assert.equal(splash.props['data-leaving'], undefined)
  assert.deepEqual(withClass(splash, 'bt-splash-name').map(textOf), [BRAND])
  assert.deepEqual(withClass(splash, 'bt-splash-line').map(textOf), ['Setting up your Main Bot…'])
  assert.equal(withClass(splash, 'bt-glyph').length, 1)
  assert.equal(brand.BootSplash({ leaving: true }).props['data-leaving'], true)
  assert.ok(brand.COVER_MS > 0)
})

test('the finishing sheet respects reduced motion and the animation preference', () => {
  const css = brand.BRAND_CSS
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)\{[^@]*\.bt-splash/)
  assert.match(css, /body\[data-bt-motion=quiet\] :is\(\.bt-boot-mark,\.bt-splash-mark/)
  // The splash covers the pane with the theme's own surface and waits a beat before it shows.
  assert.match(css, /\.bt-splash\{[^}]*background:var\(--bt-main\)[^}]*animation:bt-splash-in \.32s ease-out \.14s backwards/)
  // Focus rings, selection and scrollbars all follow the accent or the ink.
  assert.match(css, /:focus-visible\{outline:2px solid var\(--bt-accent\)/)
  assert.match(css, /::selection\{background:color-mix\(in srgb,var\(--bt-accent\)/)
  assert.match(css, /scrollbar-color:color-mix\(in srgb,var\(--bt-ink\)/)
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i)
})

const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

test('ANVIL is the first theme and the default, in cold steel with one ember accent', () => {
  const themes = allThemes()
  assert.equal(DEFAULT_THEME, 'anvil')
  assert.deepEqual(Object.keys(themes).slice(0, 5), ['anvil', 'deepseek', 'mono', 'paper', 'moonlight'])
  assert.equal(themes.anvil.label, 'ANVIL')
  const { light, dark } = themes.anvil
  assert.deepEqual([dark.bg, dark.sidebar, dark.bubble, dark.card, dark.text, dark.accent], ['#0e1012', '#13161a', '#1f242a', '#181c21', '#ece8e1', '#ff7a1a'])
  assert.equal(light.bg, '#faf8f5')
  assert.equal(light.text, '#17191c')
  // Ink reads on every surface, and the accent reads as text on the page in both modes.
  for (const [name, mode] of [['light', light], ['dark', dark]]) {
    for (const surface of ['bg', 'sidebar', 'bubble', 'card']) assert.ok(ratio(mode.text, mode[surface]) >= 7, `${name} text on ${surface}`)
    assert.ok(ratio(mode.accent, mode.bg) >= 4.5, `${name} accent on the page: ${ratio(mode.accent, mode.bg).toFixed(2)}:1`)
    assert.ok(ratio(mode.userText, mode.user) >= 7, `${name} user bubble`)
  }
})
