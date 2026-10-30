#!/usr/bin/env node
// Build the artwork set the in-game chooser offers.
//
//   node tools/artwork-build.cjs <out-directory> <image.png> [more.png ...]
//   node tools/artwork-build.cjs <out-directory> --generate   # built-in samples
//   node tools/artwork-build.cjs <out-directory> --sheet out.png <png...>
//
// Each image becomes a 40x69 BGRA blob (11040 bytes) - the exact layout META stores
// at 0x70 - plus an index the payload reads. The index is one line per artwork:
//
//   <file>\t<title>\t<description>
//
// Why raw blobs and not PNG: the Lua sandbox has no image decoder (docs/RESULTS.md:
// io yes, no shell, no libraries), so a PNG cannot be applied there. Converting on
// the host keeps the console side to a byte copy, which is the part that is proven.
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const zlib = require('node:zlib');

const WIDTH = 40, HEIGHT = 69, BYTES = WIDTH * HEIGHT * 4;

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = -1;
  for (const byte of buf) c = table[(c ^ byte) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function writePng(file, width, height, rgbAt) {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 3)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = rgbAt(x, y);
      const at = y * (1 + width * 3) + 1 + x * 3;
      raw[at] = r; raw[at + 1] = g; raw[at + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))
  ]));
}

// Built-in samples: simple geometric art so the chooser has something to show
// without needing image files from the operator.
const BUILTINS = {
  gear: (x, y) => {
    const cx = 20, cy = 34.5, dx = x - cx, dy = y - cy;
    const r = Math.hypot(dx, dy), a = Math.atan2(dy, dx);
    const teeth = r < 13 && Math.cos(a * 8) > -0.2 ? 90 : 40;
    return r < 9 ? [235, 245, 235] : [teeth, teeth + 40, teeth];
  },
  arrow: (x, y) => {
    const dx = Math.abs(x - 20);
    const head = y > 20 && y < 34 && dx < (34 - y) * 1.6;
    const shaft = y >= 34 && y < 58 && dx < 4;
    return head || shaft ? [90, 200, 255] : [18, 22, 28];
  },
  star: (x, y) => {
    const cx = 20, cy = 34, dx = x - cx, dy = y - cy;
    const r = Math.hypot(dx, dy), a = Math.atan2(dy, dx);
    const spikes = 0.62 + 0.38 * Math.cos(a * 5);
    return r < 16 * spikes ? [255, 220, 90] : [20, 20, 24];
  },
  checker: (x, y) => ((Math.floor(x / 5) + Math.floor(y / 5)) % 2
    ? [200, 80, 120] : [40, 40, 60])
};

// A 40x69 PNG -> 11040-byte BGRA. sips is used only to resize and normalise the
// input format; the pixel loop below is ours so the layout is explicit.
function toRaw(png) {
  const scaled = png + '.scaled.png';
  const bmp = png + '.scaled.bmp';
  execFileSync('sips', ['-s', 'format', 'png', '-z', String(HEIGHT), String(WIDTH), png,
    '--out', scaled], {stdio: 'ignore'});
  execFileSync('sips', ['-s', 'format', 'bmp', scaled, '--out', bmp], {stdio: 'ignore'});
  const data = fs.readFileSync(bmp);
  const offset = data.readUInt32LE(10);
  const width = data.readInt32LE(18), height = Math.abs(data.readInt32LE(22));
  const bpp = data.readUInt16LE(28);
  if (width !== WIDTH || height !== HEIGHT) throw Error(`${path.basename(png)}: got ${width}x${height}`);
  if (bpp !== 24) throw Error(`${path.basename(png)}: expected 24-bit BMP, got ${bpp}`);
  const stride = Math.floor((bpp * width + 31) / 32) * 4;
  const out = Buffer.alloc(BYTES);
  for (let y = 0; y < HEIGHT; y++) {
    const srcY = height - 1 - y;                       // BMP rows are bottom-up
    for (let x = 0; x < WIDTH; x++) {
      const s = offset + srcY * stride + x * 3;
      const d = (y * WIDTH + x) * 4;
      out[d] = data[s]; out[d + 1] = data[s + 1]; out[d + 2] = data[s + 2]; out[d + 3] = 0xFF;
    }
  }
  fs.rmSync(scaled, {force: true}); fs.rmSync(bmp, {force: true});
  return out;
}

function contactSheet(files, out) {
  const columns = files.length, gap = 4;
  const width = columns * (WIDTH + gap) + gap, height = HEIGHT + 2 * gap;
  writePng(out, width, height, (x, y) => {
    const column = Math.floor((x - gap) / (WIDTH + gap));
    const insideX = (x - gap) - column * (WIDTH + gap);
    const insideY = y - gap;
    if (column < 0 || column >= files.length || insideX < 0 || insideX >= WIDTH ||
        insideY < 0 || insideY >= HEIGHT) return [12, 12, 16];
    const raw = fs.readFileSync(files[column]);
    const at = (insideY * WIDTH + insideX) * 4;
    return [raw[at + 2], raw[at + 1], raw[at]];
  });
}

function main() {
  const argv = process.argv.slice(2);
  const out = argv[0];
  if (!out) {
    console.error('usage: artwork-build.cjs <out-directory> <png...|--generate> [--sheet out.png]');
    process.exit(2);
  }
  const sheetAt = argv.indexOf('--sheet');
  const sheet = sheetAt >= 0 ? argv[sheetAt + 1] : null;
  const inputs = argv.slice(1).filter((a, i) => a !== '--sheet' && argv[sheetAt + 1] !== a &&
    a !== '--generate');
  fs.mkdirSync(out, {recursive: true});
  const entries = [];
  let counter = 0;
  const add = (png, title, description) => {
    const name = path.basename(png, path.extname(png)).replace(/[^A-Za-z0-9_-]/g, '_');
    const file = path.join(out, name + '.raw');
    fs.writeFileSync(file, toRaw(png));
    entries.push({file: name + '.raw', title, description});
    counter++;
    fs.rmSync(png, {force: true});
  };
  if (argv.includes('--generate')) {
    for (const [title, paint] of Object.entries(BUILTINS)) {
      const png = path.join(require('node:os').tmpdir(), 'artwork-' + title + '.png');
      writePng(png, WIDTH, HEIGHT, paint);
      add(png, title.toUpperCase(), 'built-in sample');
    }
  }
  for (const input of inputs) add(input, path.basename(input, path.extname(input)).toUpperCase(), '');
  if (!counter) {
    console.error('nothing to build: pass PNGs or --generate');
    process.exit(2);
  }
  entries.sort((a, b) => a.file.localeCompare(b.file));
  fs.writeFileSync(path.join(out, 'index.txt'),
    entries.map(e => [e.file, e.title, e.description].join('\t')).join('\n') + '\n');
  if (sheet) contactSheet(entries.map(e => path.join(out, e.file)), sheet);
  console.log(`${entries.length} artwork(s) in ${out}` +
    (sheet ? `, sheet ${sheet}` : ''));
}

try { main(); } catch (error) { console.error('FAILED:', error.message); process.exit(1); }
