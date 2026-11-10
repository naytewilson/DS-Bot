// Renders the home-screen and web-app icons from assets/brand with the tools every Mac has:
// qlmanage draws the SVG at the size asked for, sips reads the result back to check it.
//
//   node scripts/brand-icons.mjs           writes the PNGs and favicons into assets/brand
//   node scripts/brand-icons.mjs --check   only checks that they are there and the sizes are right
//
// icon.svg (the mark on its dark tile) and mark.svg (the mark alone) are the sources. The outputs
// are committed, so a machine without macOS never needs this; shell.js serves them as they are.
//
//   apple-touch-icon.png     180 px, the tile without rounded corners (iOS rounds it itself)
//   icon-192.png, icon-512.png   the tile with rounded corners
//   icon-maskable-512.png    512 px, full-bleed square; the mark sits inside the 60% safe zone
//   favicon.svg              the mark alone in the ember for a light tab bar
//   favicon-dark.svg         the mark alone in the brighter ember for a dark tab bar
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
export const BRAND_DIR = join(PLUGIN, 'assets', 'brand')

// name -> [pixels, which tile it is drawn from]
export const PNGS = {
  'apple-touch-icon.png': [180, 'square'],
  'icon-192.png': [192, 'rounded'],
  'icon-512.png': [512, 'rounded'],
  'icon-maskable-512.png': [512, 'square'],
}
export const FAVICONS = { 'favicon.svg': '#c24607', 'favicon-dark.svg': '#ff7a1a' }

const read = name => readFileSync(join(BRAND_DIR, name), 'utf8')

// The tile's corner radius is what makes the rounded and the square versions differ.
export function tileVariants(icon) {
  const square = icon.replace(/(<rect\b[^>]*?)\s+rx="\d+"/, '$1')
  if (square === icon) throw new Error('icon.svg has no rounded <rect> to square off')
  return { rounded: icon, square }
}

// The mark alone, cropped square around its own bounds so a 16 px tab shows it large.
export function faviconSvg(mark, color) {
  const path = /<path\b[^>]*\sd="([^"]+)"/.exec(mark)?.[1]
  if (!path) throw new Error('mark.svg has no path')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="46 48 416 416" width="64" height="64"><title>ANVIL Crew</title><path fill="${color}" d="${path}"/></svg>\n`
}

const size = file => {
  const out = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file], { encoding: 'utf8' })
  return [Number(/pixelWidth:\s*(\d+)/.exec(out)?.[1]), Number(/pixelHeight:\s*(\d+)/.exec(out)?.[1])]
}

export function check() {
  const problems = []
  for (const [name, [pixels]] of Object.entries(PNGS)) {
    const file = join(BRAND_DIR, name)
    if (!existsSync(file)) { problems.push(`${name} is missing`); continue }
    const [width, height] = size(file)
    if (width !== pixels || height !== pixels) problems.push(`${name} is ${width}x${height}, not ${pixels}x${pixels}`)
  }
  for (const name of Object.keys(FAVICONS)) if (!existsSync(join(BRAND_DIR, name))) problems.push(`${name} is missing`)
  return problems
}

function render() {
  if (process.platform !== 'darwin') throw new Error('brand-icons needs macOS (qlmanage and sips)')
  const variants = tileVariants(read('icon.svg'))
  const work = mkdtempSync(join(tmpdir(), 'anvil-icons-'))
  try {
    const sources = {}
    for (const [kind, svg] of Object.entries(variants)) {
      sources[kind] = join(work, `tile-${kind}.svg`)
      writeFileSync(sources[kind], svg)
    }
    for (const [name, [pixels, kind]] of Object.entries(PNGS)) {
      execFileSync('qlmanage', ['-t', '-s', String(pixels), '-o', work, sources[kind]], { stdio: 'ignore' })
      const drawn = join(work, `${basename(sources[kind])}.png`)
      if (!existsSync(drawn)) throw new Error(`qlmanage drew nothing for ${name}`)
      const [width, height] = size(drawn)
      if (width !== pixels || height !== pixels) throw new Error(`${name} came out ${width}x${height}, not ${pixels}x${pixels}`)
      copyFileSync(drawn, join(BRAND_DIR, name))
      rmSync(drawn)
    }
    const mark = read('mark.svg')
    for (const [name, color] of Object.entries(FAVICONS)) writeFileSync(join(BRAND_DIR, name), faviconSvg(mark, color))
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--check')) {
    const problems = check()
    for (const problem of problems) console.error(`brand-icons: ${problem}`)
    process.exit(problems.length === 0 ? 0 : 1)
  }
  render()
  const problems = check()
  for (const problem of problems) console.error(`brand-icons: ${problem}`)
  if (problems.length > 0) process.exit(1)
  console.log(`brand-icons: wrote ${[...Object.keys(PNGS), ...Object.keys(FAVICONS)].join(', ')}`)
}
