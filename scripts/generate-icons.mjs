/**
 * Generates Gryd Lock PNG icons at the four sizes required by the Chrome Web
 * Store (16, 32, 48, 128 px) using only Node built-ins (zlib + fs).
 *
 * Design: a padded lock glyph (🔒 simplified) rendered as solid pixels on a
 * dark-blue background (#1a1f36), matching the extension's dark-mode palette.
 * No external dependencies.
 */

import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ICONS_DIR = join(__dirname, '..', 'icons')

mkdirSync(ICONS_DIR, { recursive: true })

// ─── PNG helpers ────────────────────────────────────────────────────────────

function crc32(buf) {
  let crc = 0xffffffff
  const table = crc32.table || (crc32.table = buildCRCTable())
  for (const byte of buf) crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff]
  return (crc ^ 0xffffffff) >>> 0
}

function buildCRCTable() {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c
  }
  return t
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const crcInput = Buffer.concat([typeBytes, data])
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(crcInput))
  return Buffer.concat([len, typeBytes, data, crcBuf])
}

function encodePNG(pixels, size) {
  // PNG signature
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

  // IHDR: width, height, bit-depth=8, colour-type=2 (RGB), compression=0,
  //       filter=0, interlace=0
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8  // bit depth
  ihdr[9] = 2  // RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0

  // Raw image data: one filter byte (0 = None) per row, then RGB triples
  const raw = Buffer.alloc(size * (1 + size * 3))
  for (let y = 0; y < size; y++) {
    const rowOff = y * (1 + size * 3)
    raw[rowOff] = 0 // filter type None
    for (let x = 0; x < size; x++) {
      const pix = pixels[y * size + x]
      raw[rowOff + 1 + x * 3 + 0] = (pix >> 16) & 0xff
      raw[rowOff + 1 + x * 3 + 1] = (pix >> 8) & 0xff
      raw[rowOff + 1 + x * 3 + 2] = pix & 0xff
    }
  }

  const compressed = deflateSync(raw, { level: 9 })
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', compressed), chunk('IEND', Buffer.alloc(0))])
}

// ─── Icon renderer ──────────────────────────────────────────────────────────

const BG   = 0x1a1f36  // dark blue background
const FG   = 0xffffff  // white lock glyph

/**
 * Renders a simple padlock icon for the given size.
 * The design scales cleanly: shackle arc + body rectangle.
 */
function renderIcon(size) {
  const pixels = new Uint32Array(size * size).fill(BG)

  const s = size

  // Fractional coordinates — all values are ratios of the icon size
  // Shackle: rounded U-shape above the lock body
  const bodyTop    = Math.round(s * 0.47)
  const bodyBottom = Math.round(s * 0.88)
  const bodyLeft   = Math.round(s * 0.22)
  const bodyRight  = Math.round(s * 0.78)
  const bodyCorner = Math.round(s * 0.07)

  const shackleLeft  = Math.round(s * 0.32)
  const shackleRight = Math.round(s * 0.68)
  const shackleTop   = Math.round(s * 0.12)
  const shackleThick = Math.max(1, Math.round(s * 0.10))

  // Keyhole
  const khCX = Math.round(s * 0.50)
  const khCY = Math.round(s * 0.65)
  const khR  = Math.round(s * 0.09)
  const khStemTop    = Math.round(s * 0.65)
  const khStemBottom = Math.round(s * 0.78)
  const khStemHalf   = Math.max(1, Math.round(s * 0.04))

  function set(x, y, color) {
    if (x >= 0 && x < s && y >= 0 && y < s) pixels[y * s + x] = color
  }

  // Draw rounded rectangle body
  for (let y = bodyTop; y <= bodyBottom; y++) {
    for (let x = bodyLeft; x <= bodyRight; x++) {
      const inTL = (x - bodyLeft  < bodyCorner && y - bodyTop    < bodyCorner)
      const inTR = (bodyRight - x < bodyCorner && y - bodyTop    < bodyCorner)
      const inBL = (x - bodyLeft  < bodyCorner && bodyBottom - y < bodyCorner)
      const inBR = (bodyRight - x < bodyCorner && bodyBottom - y < bodyCorner)
      let inside = true
      if (inTL && Math.hypot(x - (bodyLeft  + bodyCorner), y - (bodyTop    + bodyCorner)) > bodyCorner) inside = false
      if (inTR && Math.hypot(x - (bodyRight - bodyCorner), y - (bodyTop    + bodyCorner)) > bodyCorner) inside = false
      if (inBL && Math.hypot(x - (bodyLeft  + bodyCorner), y - (bodyBottom - bodyCorner)) > bodyCorner) inside = false
      if (inBR && Math.hypot(x - (bodyRight - bodyCorner), y - (bodyBottom - bodyCorner)) > bodyCorner) inside = false
      if (inside) set(x, y, FG)
    }
  }

  // Draw shackle (U-shape): two vertical bars + arc at top
  const shackleMid = Math.round((shackleLeft + shackleRight) / 2)
  const arcRadius  = Math.round((shackleRight - shackleLeft) / 2)
  const arcCY      = shackleTop + arcRadius

  for (let y = shackleTop; y < bodyTop; y++) {
    for (let t = 0; t < shackleThick; t++) {
      set(shackleLeft  + t, y, FG)
      set(shackleRight - t, y, FG)
    }
  }
  // Arc top
  for (let angle = 180; angle <= 360; angle++) {
    const rad = (angle * Math.PI) / 180
    const ax = Math.round(shackleMid + arcRadius * Math.cos(rad))
    const ay = Math.round(arcCY     + arcRadius * Math.sin(rad))
    for (let t = 0; t < shackleThick; t++) {
      const rx = Math.round(shackleMid + (arcRadius - t) * Math.cos(rad))
      const ry = Math.round(arcCY     + (arcRadius - t) * Math.sin(rad))
      set(rx, ry, FG)
    }
    void ax; void ay
  }

  // Draw keyhole: circle + stem (cut out of body = BG)
  for (let y = -khR - 1; y <= khR + 1; y++) {
    for (let x = -khR - 1; x <= khR + 1; x++) {
      if (Math.hypot(x, y) <= khR) set(khCX + x, khCY + y, BG)
    }
  }
  for (let y = khStemTop; y <= khStemBottom; y++) {
    for (let x = khCX - khStemHalf; x <= khCX + khStemHalf; x++) {
      set(x, y, BG)
    }
  }

  return pixels
}

// ─── Generate files ─────────────────────────────────────────────────────────

const SIZES = [16, 32, 48, 128]

for (const size of SIZES) {
  const pixels = renderIcon(size)
  const png = encodePNG(pixels, size)
  const outPath = join(ICONS_DIR, `icon${size}.png`)
  writeFileSync(outPath, png)
  console.log(`  wrote ${outPath} (${png.length} bytes)`)
}

console.log('\nIcons generated successfully.')
