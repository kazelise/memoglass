#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS one-off script, no TS types available */
// One-time generator for the memoglass tray icon.
//
// Builds a minimal 18x18 (and 36x36 @2x) black-on-transparent "pencil"
// glyph PNG by hand -- pure Node core (zlib for deflate + a hand-rolled
// CRC32), no external deps -- and prints both as base64 to stdout so they
// can be pasted into src/main/index.ts as
// nativeImage.createFromDataURL(...) + image.addRepresentation(...).
//
// Run: node scripts/gen-tray-icon.mjs

import zlib from 'node:zlib'

// ---------- CRC32 (table-based; PNG chunk trailers need this) ----------

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

// ---------- minimal PNG encoder (8-bit RGBA, no filtering, zlib IDAT) ----------

function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: truecolor + alpha
  ihdr[10] = 0 // compression method
  ihdr[11] = 0 // filter method
  ihdr[12] = 0 // interlace method

  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // per-scanline filter type: None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  // zlib.deflateSync produces a full zlib stream (header + adler32), which
  // is exactly what PNG's IDAT chunk expects.
  const idatData = zlib.deflateSync(raw, { level: 9 })

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idatData),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ---------- glyph: minimal pencil silhouette ----------
//
// Designed on an 18x18 unit grid (a diagonal shaft + tapered tip + round
// eraser cap, echoing the "✎" glyph previously used as the tray title).
// render() rasterizes it at any pixel size by scaling coordinates by
// size/18, so the 1x and @2x bitmaps are exactly the same shape.

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

function renderPencil(size) {
  const scale = size / 18
  const tail = [4.5 * scale, 14.5 * scale] // eraser end (bottom-left)
  const neck = [11 * scale, 8 * scale] // where the shaft meets the tip
  const apex = [14.5 * scale, 4.5 * scale] // pencil point (top-right)
  const shaftR = 1.4 * scale
  const eraserR = 2.0 * scale

  const dx = neck[0] - tail[0]
  const dy = neck[1] - tail[1]
  const len = Math.hypot(dx, dy)
  const ux = dx / len
  const uy = dy / len
  const perpX = -uy
  const perpY = ux
  const tipBaseA = [neck[0] + perpX * shaftR, neck[1] + perpY * shaftR]
  const tipBaseB = [neck[0] - perpX * shaftR, neck[1] - perpY * shaftR]

  const rgba = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = x + 0.5
      const cy = y + 0.5
      const hit =
        distToSegment(cx, cy, tail[0], tail[1], neck[0], neck[1]) <= shaftR ||
        pointInTriangle(
          cx,
          cy,
          tipBaseA[0],
          tipBaseA[1],
          tipBaseB[0],
          tipBaseB[1],
          apex[0],
          apex[1]
        ) ||
        Math.hypot(cx - tail[0], cy - tail[1]) <= eraserR

      const i = (y * size + x) * 4
      rgba[i] = 0
      rgba[i + 1] = 0
      rgba[i + 2] = 0
      rgba[i + 3] = hit ? 255 : 0
    }
  }
  return rgba
}

const png18 = encodePNG(18, 18, renderPencil(18))
const png36 = encodePNG(36, 36, renderPencil(36))

console.log('--- 18x18 (1x) base64 ---')
console.log(png18.toString('base64'))
console.log('--- 36x36 (@2x) base64 ---')
console.log(png36.toString('base64'))
