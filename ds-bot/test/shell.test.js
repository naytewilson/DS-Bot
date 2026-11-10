import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { CACHE_CONTROL, ROUTES, THEME_DARK, THEME_LIGHT, apply, brandIndex, inject, manifest, name, resourceFor, respond } from '../shell.js'
import { BRAND, BRAND_SHORT } from '../src/shared/brand.js'

const PLUGIN = new URL('../', import.meta.url)
const asset = file => readFileSync(new URL(`assets/brand/${file}`, PLUGIN))

// DSH's index.html as DSH 0.2.2 ships it.
const DSH_INDEX = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="manifest" href="./manifest.webmanifest" />
    <link rel="apple-touch-icon" href="./apple-touch-icon.png" />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-title" content="DSH" />
    <link rel="icon" type="image/svg+xml" href="./favicon-dark.svg" media="(prefers-color-scheme: dark)" />
    <link rel="icon" type="image/svg+xml" href="./favicon.svg" media="(prefers-color-scheme: light)" />
    <title>DeepSeek Harness</title>
    <script type="module" crossorigin src="./assets/index-BgUyXZcc.js"></script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`

const metas = (html, metaName) => [...html.matchAll(new RegExp(`<meta\\b[^>]*\\bname="${metaName}"[^>]*>`, 'g'))].map(match => match[0])
const attr = (tag, key) => new RegExp(`\\b${key}="([^"]*)"`).exec(tag)?.[1]

// The webserver's registration semantics (dsh-host-webserver): a second route on a path throws, a
// registration returns its disposer, taps run in order.
function fakeServer(extra = {}) {
  const exact = new Map()
  const taps = []
  return {
    exact,
    taps,
    register(route) {
      if (exact.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
      exact.set(route.path, route)
      return () => { exact.delete(route.path) }
    },
    tapIndex(transform) {
      taps.push(transform)
      return () => { const at = taps.indexOf(transform); if (at !== -1) taps.splice(at, 1) }
    },
    renderIndex: html => taps.reduce((out, transform) => transform(out), html),
    ...extra,
  }
}
function fakeCtx(webServer) {
  const effects = []
  const warnings = []
  return {
    webServer,
    warnings,
    effects,
    logger: { warn: message => warnings.push(message) },
    effect(make, label) { const off = make(); effects.push({ label, off }); return off },
    dispose() { for (const { off } of effects.splice(0)) off?.() },
  }
}
const get = (server, path, headers = {}) => server.exact.get(path).resource(new Request(`http://x${path}`, { headers }))

test('the plugin is mounted as bot-shell, injects the web server, and is exported and published with its assets', () => {
  assert.equal(name, 'bot-shell')
  assert.deepEqual(inject, ['webServer'])
  const pkg = JSON.parse(readFileSync(new URL('package.json', PLUGIN), 'utf8'))
  assert.equal(pkg.exports['./shell'], './shell.js')
  assert.ok(pkg.files.includes('shell.js'))
  assert.ok(pkg.files.includes('assets/'))
  // The bundle patch inserts it by the export's name.
  const patch = readFileSync(new URL('cordis.patch.yml', PLUGIN), 'utf8')
  assert.match(patch, /- id: bot-shell\n\s+name: ds-bot\/shell\n/)
  // Everything the plugin imports is in the published files.
  assert.ok(pkg.files.includes('src/shared/'))
})

test('the index gets this edition\'s title, home-screen name and toolbar colors, and nothing else of DSH\'s page moves', () => {
  const html = brandIndex(DSH_INDEX)
  assert.deepEqual([...html.matchAll(/<title>([^<]*)<\/title>/g)].map(match => match[1]), [BRAND])
  assert.deepEqual(metas(html, 'apple-mobile-web-app-title').map(tag => attr(tag, 'content')), [BRAND])
  assert.deepEqual(metas(html, 'apple-mobile-web-app-capable').map(tag => attr(tag, 'content')), ['yes'])
  const colors = metas(html, 'theme-color')
  assert.deepEqual(colors.map(tag => [attr(tag, 'content'), attr(tag, 'media')]), [[THEME_DARK, '(prefers-color-scheme: dark)'], [THEME_LIGHT, '(prefers-color-scheme: light)']])
  assert.equal(THEME_DARK, '#0e1012')
  assert.doesNotMatch(html, /DeepSeek Harness|content="DSH"/)
  // Everything else is as DSH sent it, in the same order.
  for (const kept of ['<link rel="manifest" href="./manifest.webmanifest" />', '<link rel="apple-touch-icon" href="./apple-touch-icon.png" />', '<script type="module" crossorigin src="./assets/index-BgUyXZcc.js"></script>', '<div id="root"></div>']) {
    assert.ok(html.includes(kept), kept)
  }
  assert.ok(html.indexOf('<meta charset') < html.indexOf('<title>') && html.indexOf('</head>') > html.lastIndexOf('theme-color'))
  assert.ok(html.endsWith('</html>\n'))
})

test('a page that already has theme colors, a second title or a differently written meta ends with one of each', () => {
  const messy = `<html><head><TITLE lang="en">Old</TITLE><meta content="#ffffff" NAME='theme-color'><meta name="theme-color" content="red">
<title>Again</title><meta content="Old" name="apple-mobile-web-app-title"><meta name="apple-mobile-web-app-title" content="Twice"></head><body></body></html>`
  const html = brandIndex(messy)
  assert.equal([...html.matchAll(/<title/gi)].length, 1)
  assert.equal(metas(html, 'apple-mobile-web-app-title').length, 1)
  assert.equal(metas(html, 'theme-color').length, 2)
  assert.doesNotMatch(html, /#ffffff|"red"|Old|Again|Twice/)
})

test('the index rewrite is idempotent, and escapes a name that has markup in it', () => {
  const once = brandIndex(DSH_INDEX)
  assert.equal(brandIndex(once), once)
  const odd = brandIndex(DSH_INDEX, { brand: 'A&B <"x">' })
  assert.match(odd, /<title>A&amp;B &lt;"x"&gt;<\/title>/)
  assert.match(odd, /name="apple-mobile-web-app-title" content="A&amp;B &lt;&quot;x&quot;&gt;"/)
  // A fragment with no head still gets the tags, first.
  const bare = brandIndex('<div id="root"></div>')
  assert.ok(bare.startsWith('<meta name="theme-color"'))
  assert.ok(bare.endsWith('<div id="root"></div>'))
  assert.match(bare, /<title>/)
})

test('apply taps the index and registers an exact route for each icon and the manifest', () => {
  const server = fakeServer()
  const ctx = fakeCtx(server)
  apply(ctx)
  assert.deepEqual([...server.exact.keys()].sort(), [
    '/apple-touch-icon.png', '/favicon-dark.svg', '/favicon.svg', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/manifest.webmanifest',
  ])
  assert.ok([...server.exact.values()].every(route => route.kind === 'exact' && typeof route.resource === 'function' && route.handler === undefined))
  assert.deepEqual(ROUTES.map(route => route.path).sort(), [...server.exact.keys()].sort())
  assert.equal(server.taps.length, 1)
  // What the webserver does with the tap on an index it renders.
  assert.match(server.renderIndex(DSH_INDEX), new RegExp(`<title>${BRAND}</title>`))
  // Each registration is an effect of the plugin, so the plugin's lifecycle owns its disposer.
  assert.equal(ctx.effects.length, 1 + ROUTES.length)
  assert.ok(ctx.effects.every(effect => typeof effect.off === 'function'))
  assert.deepEqual(ctx.warnings, [])
})

test('disposing the plugin removes every route and the tap, so a reload can register them again', () => {
  const server = fakeServer()
  const ctx = fakeCtx(server)
  apply(ctx)
  ctx.dispose()
  assert.equal(server.exact.size, 0)
  assert.equal(server.taps.length, 0)
  const again = fakeCtx(server)
  apply(again)
  assert.equal(server.exact.size, ROUTES.length)
  assert.deepEqual(again.warnings, [])
})

test('the icons and favicons are served from assets/brand with their content types and cache headers, without any cookie', async () => {
  const server = fakeServer()
  apply(fakeCtx(server))
  const types = { '/favicon.svg': 'image/svg+xml', '/favicon-dark.svg': 'image/svg+xml', '/apple-touch-icon.png': 'image/png', '/icon-192.png': 'image/png', '/icon-512.png': 'image/png', '/icon-maskable-512.png': 'image/png' }
  for (const [path, type] of Object.entries(types)) {
    const response = await get(server, path)
    assert.equal(response.status, 200, path)
    assert.equal(response.headers.get('content-type'), type, path)
    assert.equal(response.headers.get('cache-control'), CACHE_CONTROL, path)
    assert.match(response.headers.get('etag'), /^"[\w-]+"$/, path)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), asset(path.slice(1)), path)
  }
  assert.match(CACHE_CONTROL, /public, max-age=\d+/)
})

test('a browser that already has an icon is told so, by its tag, weak or not, in a list', async () => {
  const server = fakeServer()
  apply(fakeCtx(server))
  const first = await get(server, '/icon-192.png')
  const etag = first.headers.get('etag')
  for (const header of [etag, `W/${etag}`, `"other", ${etag}`]) {
    const again = await get(server, '/icon-192.png', { 'if-none-match': header })
    assert.equal(again.status, 304, header)
    assert.equal(again.headers.get('etag'), etag)
    assert.equal(await again.text(), '')
  }
  assert.equal((await get(server, '/icon-192.png', { 'if-none-match': '"stale"' })).status, 200)
})

test('the manifest names the product, installs as a standalone app, and points only at icons the plugin serves', async () => {
  const server = fakeServer()
  apply(fakeCtx(server))
  const response = await get(server, '/manifest.webmanifest')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/manifest+json')
  const body = await response.json()
  assert.deepEqual(body, manifest())
  assert.equal(body.name, 'ANVIL Crew')
  assert.equal(body.name, BRAND)
  assert.equal(body.short_name, 'Crew')
  assert.equal(body.short_name, BRAND_SHORT)
  assert.equal(body.display, 'standalone')
  assert.equal(body.start_url, './')
  assert.equal(body.background_color, '#0e1012')
  assert.equal(body.theme_color, '#0e1012')
  assert.deepEqual(body.icons.map(icon => [icon.src, icon.sizes, icon.type, icon.purpose]), [
    ['icon-192.png', '192x192', 'image/png', 'any'],
    ['icon-512.png', '512x512', 'image/png', 'any'],
    ['icon-maskable-512.png', '512x512', 'image/png', 'maskable'],
  ])
  for (const icon of body.icons) assert.ok(server.exact.has(`/${icon.src}`), icon.src)
})

test('the PNGs are the sizes the manifest and the home screen say, and the favicons draw the same mark in two colors', () => {
  const size = (file) => {
    const bytes = asset(file)
    assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${file} is a PNG`)
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]
  }
  assert.deepEqual(size('apple-touch-icon.png'), [180, 180])
  assert.deepEqual(size('icon-192.png'), [192, 192])
  assert.deepEqual(size('icon-512.png'), [512, 512])
  assert.deepEqual(size('icon-maskable-512.png'), [512, 512])
  const mark = asset('mark.svg').toString('utf8')
  const path = /<path\b[^>]*\sd="([^"]+)"/.exec(mark)[1]
  const light = asset('favicon.svg').toString('utf8')
  const dark = asset('favicon-dark.svg').toString('utf8')
  for (const svg of [light, dark]) {
    assert.ok(svg.includes(`d="${path}"`))
    assert.match(svg, /viewBox="46 48 416 416"/)
  }
  assert.match(light, /fill="#c24607"/)
  assert.match(dark, /fill="#ff7a1a"/)
})

test('a missing asset is a 404 for its own path; any other read failure is left to the server to answer', async () => {
  const route = ROUTES.find(row => row.path === '/icon-512.png')
  const missing = resourceFor(route, { read: async () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }) } })
  assert.equal((await missing(new Request('http://x/icon-512.png'))).status, 404)
  const broken = resourceFor(route, { read: async () => { throw Object.assign(new Error('no access'), { code: 'EACCES' }) } })
  await assert.rejects(broken(new Request('http://x/icon-512.png')), /no access/)
  assert.equal(respond(new Request('http://x/'), Buffer.from('x'), 'text/plain').status, 200)
})

test('a web server without tapIndex or register costs one warning and nothing else', () => {
  for (const webServer of [{ register() { return () => {} } }, { tapIndex() { return () => {} } }, {}, undefined]) {
    const ctx = fakeCtx(webServer)
    assert.doesNotThrow(() => apply(ctx))
    assert.equal(ctx.warnings.length, 1)
    assert.match(ctx.warnings[0], /ds-bot\/shell: this web server has no tapIndex or register/)
    assert.equal(ctx.effects.length, 0)
  }
})

test('a path another plugin already holds is a warning for that path; the rest still register and dispose', () => {
  const server = fakeServer()
  server.exact.set('/favicon.svg', { kind: 'exact', path: '/favicon.svg', resource: () => {} })
  const ctx = fakeCtx(server)
  assert.doesNotThrow(() => apply(ctx))
  assert.equal(ctx.warnings.length, 1)
  assert.match(ctx.warnings[0], /\/favicon\.svg was not set up: webserver: duplicate exact route/)
  assert.equal(server.exact.size, ROUTES.length)
  ctx.dispose()
  // Only the foreign route is left: ours came out, and it was not touched.
  assert.deepEqual([...server.exact.keys()], ['/favicon.svg'])
  assert.equal(server.taps.length, 0)
})

test('a plugin context with no effect hook still registers and ties disposal to the context', () => {
  const server = fakeServer()
  const disposers = []
  const ctx = { webServer: server, logger: { warn() {} }, on: (event, fn) => { if (event === 'dispose') disposers.push(fn) } }
  apply(ctx)
  assert.equal(server.exact.size, ROUTES.length)
  for (const off of disposers) off()
  assert.equal(server.exact.size, 0)
  assert.equal(server.taps.length, 0)
})

// The same plugin on the real DSH web server (on an OS-assigned loopback port): its register,
// tapIndex and resource answers, as a browser meets them.
test('on DSH\'s own web server the routes answer, validate, refuse other methods and go away with the plugin', async (t) => {
  const { Context } = await import('@deepseek-ai/cordis')
  const { default: WebServer } = await import('@deepseek-ai/dsh-host-webserver')
  const ctx = new Context()
  const web = ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  const mine = ctx.plugin(await import('../shell.js'))
  t.after(async () => { await mine.dispose(); await web.dispose() })
  await new Promise(resolve => setTimeout(resolve, 250))
  const server = ctx.webServer
  const base = server.getOrigin()
  assert.equal(server.exact.size, ROUTES.length)
  assert.equal(server.indexTaps.length, 1)
  const manifestResponse = await fetch(`${base}/manifest.webmanifest`)
  assert.equal(manifestResponse.status, 200)
  assert.equal(manifestResponse.headers.get('content-type'), 'application/manifest+json')
  assert.equal((await manifestResponse.json()).name, BRAND)
  const icon = await fetch(`${base}/icon-512.png`)
  assert.equal(icon.status, 200)
  assert.deepEqual(Buffer.from(await icon.arrayBuffer()), asset('icon-512.png'))
  assert.equal((await fetch(`${base}/icon-512.png`, { headers: { 'if-none-match': icon.headers.get('etag') } })).status, 304)
  assert.equal((await fetch(`${base}/icon-512.png`, { method: 'HEAD' })).status, 200)
  assert.equal((await fetch(`${base}/icon-512.png`, { method: 'POST' })).status, 405)
  assert.match(server.applyIndexTaps('<html><head><title>DeepSeek Harness</title></head></html>'), new RegExp(`<title>${BRAND}</title>`))
  // Taking the plugin out takes its routes and its tap with it.
  await mine.dispose()
  assert.equal(server.exact.size, 0)
  assert.equal(server.indexTaps.length, 0)
  assert.equal((await fetch(`${base}/icon-512.png`)).status, 404)
})

// The committed favicons and the tiles the PNGs are drawn from come out of scripts/brand-icons.mjs.
test('the icon script squares off the tile for the iOS and maskable icons, and the committed favicons are what it makes', async () => {
  const { FAVICONS, PNGS, faviconSvg, tileVariants } = await import('../scripts/brand-icons.mjs')
  const icon = asset('icon.svg').toString('utf8')
  const { rounded, square } = tileVariants(icon)
  assert.equal(rounded, icon)
  assert.match(icon, /<rect [^>]*rx="\d+"/)
  assert.doesNotMatch(square, /<rect [^>]*rx=/)
  assert.equal(square.replace(/<rect [^>]*>/, ''), icon.replace(/<rect [^>]*>/, ''))
  assert.throws(() => tileVariants('<svg><rect width="1"/></svg>'), /no rounded <rect>/)
  const mark = asset('mark.svg').toString('utf8')
  for (const [file, color] of Object.entries(FAVICONS)) assert.equal(asset(file).toString('utf8'), faviconSvg(mark, color), file)
  assert.throws(() => faviconSvg('<svg/>', '#000'), /no path/)
  // Every PNG it writes is one the manifest or the page asks for.
  for (const name of Object.keys(PNGS)) assert.ok(ROUTES.some(route => route.file === name), name)
})
