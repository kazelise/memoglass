#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS one-off script, no TS types available */
// Generator for the memoglass app icon.
//
// Same approach as scripts/gen-tray-icon.mjs (hand-rolled PNG encoder --
// zlib deflate + CRC32 -- and pure-math rasterization, no external deps),
// scaled up to a full 1024x1024 macOS app icon:
//
//   - a warm off-white rounded "card" inset from the canvas edges, echoing
//     the macOS Big Sur+ squircle-icon convention (icons live inside a
//     padded, rounded square rather than filling the full 1024 bleed)
//   - a diagonal, low-opacity sage highlight band across the card for a
//     touch of "glass"
//   - a big diagonal pencil silhouette (same shaft/tip/eraser construction
//     as the tray glyph) in deep ink, sized to dominate the card
//
// electron-builder's mac target converts build/icon.png -> .icns
// automatically, so this script only needs to produce that one PNG.
// resources/icon.png (used at runtime, e.g. dock/about) is generated at a
// smaller 512px size from the exact same renderer.
//
// Run: node scripts/gen-app-icon.mjs

import zlib from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

// ---------- CRC32 + minimal PNG encoder (identical approach to gen-tray-icon.mjs) ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii')
  const lenBuf = Buffer.alloc(4)
  lenBuf.writeUInt32BE(data.length, 0)
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf])
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: truecolor + alpha
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter type: None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  const idatData = zlib.deflateSync(raw, { level: 9 })

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idatData),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ---------- geometry helpers ----------

function hex(h) {
  const n = parseInt(h.replace('#', ''), 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1
  const dy = y2 - y1
  const lenSq = dx * dx + dy * dy
  let t = lenSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  const cx = x1 + t * dx
  const cy = y1 + t * dy
  return Math.hypot(px - cx, py - cy)
}

function pointInTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by)
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy)
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay)
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0
  return !(hasNeg && hasPos)
}

/** Signed "inside" test for an axis-aligned rounded rect. */
function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false
  const inLeft = x < x0 + r
  const inRight = x > x1 - r
  const inTop = y < y0 + r
  const inBottom = y > y1 - r
  if (inLeft && inTop) return Math.hypot(x - (x0 + r), y - (y0 + r)) <= r
  if (inRight && inTop) return Math.hypot(x - (x1 - r), y - (y0 + r)) <= r
  if (inLeft && inBottom) return Math.hypot(x - (x0 + r), y - (y1 - r)) <= r
  if (inRight && inBottom) return Math.hypot(x - (x1 - r), y - (y1 - r)) <= r
  return true
}

// ---------- icon design (authored on a 1024 grid, scaled for other sizes) ----------

const BASE = 1024
const CARD = { x0: 100, y0: 100, x1: 924, y1: 924, r: 180 } // ~100px inset, ~180px corner radius
const CARD_FILL = hex('#F5F2ED')
const PENCIL_COLOR = hex('#2E2B28')
const HIGHLIGHT_COLOR = hex('#4A7C59')
const HIGHLIGHT_ALPHA = 0.12

// Pencil silhouette: same tail/neck/apex/shaft-radius/eraser-radius
// construction as renderPencil() in gen-tray-icon.mjs, re-authored at
// app-icon scale so the shaft is bold enough to read at a glance (roughly
// half the card's width) while keeping the same diagonal "✎" proportions.
const cardW = CARD.x1 - CARD.x0
const cardCx = (CARD.x0 + CARD.x1) / 2
const cardCy = (CARD.y0 + CARD.y1) / 2
const PENCIL = {
  tail: [cardCx - 0.34 * cardW, cardCy + 0.34 * cardW], // eraser end, bottom-left
  neck: [cardCx + 0.2 * cardW, cardCy - 0.16 * cardW], // shaft/tip join
  apex: [cardCx + 0.36 * cardW, cardCy - 0.34 * cardW], // point, top-right
  shaftR: 0.09 * cardW,
  eraserR: 0.13 * cardW
}

// Highlight band: a soft diagonal stripe from the card's top-left corner
// down through the card, catching a bit of "glass" light.
const HIGHLIGHT = {
  x1: CARD.x0 + 0.08 * cardW,
  y1: CARD.y0,
  x2: CARD.x0 + 0.4 * cardW,
  y2: CARD.y1,
  halfWidth: 0.11 * cardW
}

function pencilHit(x, y) {
  const { tail, neck, apex, shaftR, eraserR } = PENCIL
  const dx = neck[0] - tail[0]
  const dy = neck[1] - tail[1]
  const len = Math.hypot(dx, dy)
  const ux = dx / len
  const uy = dy / len
  const perpX = -uy
  const perpY = ux
  const tipBaseA = [neck[0] + perpX * shaftR, neck[1] + perpY * shaftR]
  const tipBaseB = [neck[0] - perpX * shaftR, neck[1] - perpY * shaftR]

  return (
    distToSegment(x, y, tail[0], tail[1], neck[0], neck[1]) <= shaftR ||
    pointInTriangle(
      x,
      y,
      tipBaseA[0],
      tipBaseA[1],
      tipBaseB[0],
      tipBaseB[1],
      apex[0],
      apex[1]
    ) ||
    Math.hypot(x - tail[0], y - tail[1]) <= eraserR
  )
}

function highlightHit(x, y) {
  const { x1, y1, x2, y2, halfWidth } = HIGHLIGHT
  return distToSegment(x, y, x1, y1, x2, y2) <= halfWidth
}

/**
 * Renders the icon at `size` pixels. Design is authored on the 1024 grid
 * above and uniformly scaled down/up; sub-sampling (3x3 per output pixel)
 * gives antialiased edges without needing a real rasterizer library.
 */
function renderIcon(size) {
  const scale = size / BASE
  const card = {
    x0: CARD.x0 * scale,
    y0: CARD.y0 * scale,
    x1: CARD.x1 * scale,
    y1: CARD.y1 * scale,
    r: CARD.r * scale
  }
  const SUB = 3
  const rgba = Buffer.alloc(size * size * 4)

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rSum = 0
      let gSum = 0
      let bSum = 0
      let aSum = 0

      for (let sy = 0; sy < SUB; sy++) {
        for (let sx = 0; sx < SUB; sx++) {
          // Sample positions in *design-grid* coordinates so pencilHit /
          // highlightHit (authored on the 1024 grid) can be reused as-is.
          const px = ((x + (sx + 0.5) / SUB) / size) * BASE
          const py = ((y + (sy + 0.5) / SUB) / size) * BASE
          const sampleX = px * scale
          const sampleY = py * scale

          if (!inRoundedRect(sampleX, sampleY, card.x0, card.y0, card.x1, card.y1, card.r)) {
            continue // fully transparent outside the card
          }

          let r = CARD_FILL[0]
          let g = CARD_FILL[1]
          let b = CARD_FILL[2]

          if (highlightHit(px, py)) {
            r = r * (1 - HIGHLIGHT_ALPHA) + HIGHLIGHT_COLOR[0] * HIGHLIGHT_ALPHA
            g = g * (1 - HIGHLIGHT_ALPHA) + HIGHLIGHT_COLOR[1] * HIGHLIGHT_ALPHA
            b = b * (1 - HIGHLIGHT_ALPHA) + HIGHLIGHT_COLOR[2] * HIGHLIGHT_ALPHA
          }

          if (pencilHit(px, py)) {
            r = PENCIL_COLOR[0]
            g = PENCIL_COLOR[1]
            b = PENCIL_COLOR[2]
          }

          // Accumulate premultiplied so the card/transparent edge
          // antialiases without a dark fringe.
          rSum += r
          gSum += g
          bSum += b
          aSum += 255
        }
      }

      const n = SUB * SUB
      const alpha = aSum / n
      const i = (y * size + x) * 4
      if (alpha <= 0) {
        rgba[i] = 0
        rgba[i + 1] = 0
        rgba[i + 2] = 0
        rgba[i + 3] = 0
      } else {
        const covered = aSum / 255 // number of samples that were inside the card
        rgba[i] = Math.round(rSum / covered)
        rgba[i + 1] = Math.round(gSum / covered)
        rgba[i + 2] = Math.round(bSum / covered)
        rgba[i + 3] = Math.round(alpha)
      }
    }
  }
  return rgba
}

const size1024 = 1024
const png1024 = encodePNG(size1024, size1024, renderIcon(size1024))
const buildIconPath = join(ROOT, 'build', 'icon.png')
writeFileSync(buildIconPath, png1024)
console.log(`wrote ${buildIconPath} (${size1024}x${size1024}, ${png1024.length} bytes)`)

const size512 = 512
const png512 = encodePNG(size512, size512, renderIcon(size512))
const resourcesIconPath = join(ROOT, 'resources', 'icon.png')
writeFileSync(resourcesIconPath, png512)
console.log(`wrote ${resourcesIconPath} (${size512}x${size512}, ${png512.length} bytes)`)
