// Generate a placeholder 256x256 app icon (resources/icon.png).
//
// A real branded icon should replace this before distribution — see the README
// "Icon" note. We emit a valid PNG programmatically (no binary blob committed
// blind) so `electron-builder` has an icon source it can convert to .ico/.icns.
//
// @tier T0

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 256;
const BG = [14, 15, 18]; // #0e0f12 (matches the window background)
const FG = [122, 162, 247]; // accent blue

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// Build RGBA raster: a filled rounded-ish square with a diagonal accent stripe.
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
let p = 0;
for (let y = 0; y < SIZE; y += 1) {
  raw[p++] = 0; // filter byte per scanline
  for (let x = 0; x < SIZE; x += 1) {
    const stripe = Math.abs(x - y) < 22 || Math.abs(x - (SIZE - y)) < 22;
    const c = stripe ? FG : BG;
    raw[p++] = c[0];
    raw[p++] = c[1];
    raw[p++] = c[2];
    raw[p++] = 255;
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
// 10,11,12 = compression/filter/interlace = 0

const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = resolve(dirname(fileURLToPath(import.meta.url)), "..", "resources", "icon.png");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`[make-icon] wrote ${out} (${png.length} bytes)`);
