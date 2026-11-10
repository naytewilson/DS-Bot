// The ANVIL edition's shell: what the browser, and an iPhone's home screen, see of the page
// around the app. DSH serves its own index.html with its own title, icons and web manifest; this
// plugin rewrites the index on its way out (`tapIndex`) and answers the icon and manifest paths
// itself, ahead of DSH's static fallback (exact routes win), from assets/brand and from the
// product name in src/shared/brand.js. It is mounted by cordis.patch.yml as `bot-shell`, apart
// from the Bot team, so a profile can take it out and keep everything else.
//
// The routes are public the way DSH's own icons are: a browser fetches the manifest and the icons
// without the session cookie, and an installed web app needs them before it signs in.
//
// It fails soft. A web server without these two calls, or a route another plugin already holds,
// costs a warning and nothing else: the page then keeps DSH's own title and icons.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { BRAND, BRAND_SHORT } from './src/shared/brand.js'

export const name = 'bot-shell'
export const inject = ['webServer']

// The ANVIL theme's dark and light pages. The browser's toolbar takes the one that matches the
// system setting.
export const THEME_DARK = '#0e1012'
export const THEME_LIGHT = '#faf8f5'

// The routes: path, file under assets/brand (null for the generated manifest), content type.
export const ROUTES = Object.freeze([
  Object.freeze({ path: '/manifest.webmanifest', file: null, type: 'application/manifest+json' }),
  Object.freeze({ path: '/favicon.svg', file: 'favicon.svg', type: 'image/svg+xml' }),
  Object.freeze({ path: '/favicon-dark.svg', file: 'favicon-dark.svg', type: 'image/svg+xml' }),
  Object.freeze({ path: '/apple-touch-icon.png', file: 'apple-touch-icon.png', type: 'image/png' }),
  Object.freeze({ path: '/icon-192.png', file: 'icon-192.png', type: 'image/png' }),
  Object.freeze({ path: '/icon-512.png', file: 'icon-512.png', type: 'image/png' }),
  Object.freeze({ path: '/icon-maskable-512.png', file: 'icon-maskable-512.png', type: 'image/png' }),
])

// An hour: an icon changes with a release, and a browser asks again with its ETag after that.
export const CACHE_CONTROL = 'public, max-age=3600'

// ---- the index --------------------------------------------------------------------------

const escapeText = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
const escapeAttribute = value => escapeText(value).replaceAll('"', '&quot;')

// A tag with the indentation before it and the line break after it, as three groups, so taking one
// out takes its whole line and rewriting one keeps the layout.
const TITLE = /([ \t]*)(<title\b[^>]*>[\s\S]*?<\/title>)([ \t]*\r?\n?)/gi
const metaNamed = metaName => new RegExp(`([ \\t]*)(<meta\\b(?=[^>]*\\bname\\s*=\\s*["']${metaName}["'])[^>]*>)([ \\t]*\\r?\\n?)`, 'gi')

// Lines of markup go at the end of the head, each on a line of its own when the document is laid
// out that way, and first in a document with no head.
function intoHead(html, ...lines) {
  const close = /<\/head\s*>/i.exec(html)
  if (close === null) return `${lines.join('')}${html}`
  const lineStart = html.lastIndexOf('\n', close.index) + 1
  if (html.slice(lineStart, close.index).trim() !== '') return `${html.slice(0, close.index)}${lines.join('')}${html.slice(close.index)}`
  const indent = `${html.slice(lineStart, close.index)}  `
  return `${html.slice(0, lineStart)}${lines.map(line => `${indent}${line}\n`).join('')}${html.slice(lineStart)}`
}

// A named <meta> with exactly this content: the first one is rewritten where it stands, any others
// go, and with none the tag is added to the head.
function setMeta(html, metaName, content) {
  const tag = `<meta name="${metaName}" content="${escapeAttribute(content)}" />`
  let seen = false
  const out = html.replace(metaNamed(metaName), (_all, lead, _old, trail) => {
    if (seen) return ''
    seen = true
    return `${lead}${tag}${trail}`
  })
  return seen ? out : intoHead(out, tag)
}

// The page as DSH renders it, with this edition's title, name on the home screen and toolbar color.
// The `theme-color` metas that were there go, and one for each system setting takes their place.
export function brandIndex(html, { brand = BRAND } = {}) {
  let out = String(html)
  const title = `<title>${escapeText(brand)}</title>`
  let titled = false
  out = out.replace(TITLE, (_all, lead, _old, trail) => {
    if (titled) return ''
    titled = true
    return `${lead}${title}${trail}`
  })
  if (!titled) out = intoHead(out, title)
  out = setMeta(out, 'apple-mobile-web-app-title', brand)
  out = setMeta(out, 'apple-mobile-web-app-capable', 'yes')
  out = out.replace(metaNamed('theme-color'), '')
  return intoHead(out,
    `<meta name="theme-color" content="${THEME_DARK}" media="(prefers-color-scheme: dark)" />`,
    `<meta name="theme-color" content="${THEME_LIGHT}" media="(prefers-color-scheme: light)" />`)
}

// ---- the manifest and the icons ---------------------------------------------------------

export function manifest({ brand = BRAND, short = BRAND_SHORT } = {}) {
  return {
    name: brand,
    short_name: short,
    start_url: './',
    scope: './',
    display: 'standalone',
    background_color: THEME_DARK,
    theme_color: THEME_DARK,
    icons: [
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}

// Whether an If-None-Match header names this tag (a list; weak tags count).
const matches = (header, etag) => typeof header === 'string' && header.split(',').some(item => item.trim().replace(/^W\//, '') === etag)

// The answer for one body: 200 with its validators, or 304 when the browser already has it.
export function respond(request, body, type) {
  const etag = `"${createHash('sha1').update(body).digest('base64url')}"`
  const headers = { 'content-type': type, 'cache-control': CACHE_CONTROL, etag }
  if (matches(request.headers.get('if-none-match'), etag)) return new Response(null, { status: 304, headers })
  return new Response(body, { status: 200, headers })
}

const ASSETS = new URL('./assets/brand/', import.meta.url)

// The resource behind one route. A file that is missing is a 404 for that path only.
export function resourceFor(route, { read = file => readFile(new URL(file, ASSETS)) } = {}) {
  return async (request) => {
    if (route.file === null) return respond(request, Buffer.from(`${JSON.stringify(manifest(), null, 2)}\n`), route.type)
    let body
    try {
      body = await read(route.file)
    } catch (error) {
      if (error?.code === 'ENOENT') return new Response(null, { status: 404 })
      throw error
    }
    return respond(request, body, route.type)
  }
}

// ---- the plugin -------------------------------------------------------------------------

// Runs `make` as an effect of this plugin, so its disposer runs when the plugin does. A failure
// (a route someone else holds) is a warning, not a crash.
function own(ctx, label, make) {
  const effect = () => {
    try {
      return make()
    } catch (error) {
      ctx.logger?.warn?.(`ds-bot/shell: ${label} was not set up: ${error?.message ?? error}`)
      return undefined
    }
  }
  if (typeof ctx.effect === 'function') {
    ctx.effect(effect, `ds-bot/shell: ${label}`)
    return
  }
  const off = effect()
  if (typeof off === 'function') ctx.on?.('dispose', off)
}

export function apply(ctx) {
  const server = ctx.webServer
  if (typeof server?.tapIndex !== 'function' || typeof server?.register !== 'function') {
    ctx.logger?.warn?.('ds-bot/shell: this web server has no tapIndex or register; the page keeps DSH\'s own title, icons and manifest')
    return
  }
  own(ctx, 'the page title', () => server.tapIndex(brandIndex))
  for (const route of ROUTES) {
    own(ctx, route.path, () => server.register({ kind: 'exact', path: route.path, resource: resourceFor(route) }))
  }
}
