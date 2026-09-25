import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

/**
 * 头像测试夹具（E5.1）：手写 PNG，不引入任何图片库。
 *
 * - `tinyPngBytes()` 是 1×1 的合法 PNG（测试只关心字节原样落盘/回读）；
 * - `makeTestPng(n)` 画出 n×n 的图案，给截图与人工验收一张「看得出是张图」的头像。
 */

/** 一张 1×1 的合法 PNG（IHDR + IDAT + IEND），固定不变 */
export const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

export function tinyPngDataUrl(): string {
  return `data:image/png;base64,${TINY_PNG_BASE64}`;
}

export function tinyPngBytes(): Buffer {
  return Buffer.from(TINY_PNG_BASE64, 'base64');
}

/** 写一张临时 PNG 到磁盘，给 update_state 的 path 入口用 */
export async function writeTinyPng(dir: string, name = 'avatar.png'): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, tinyPngBytes());
  return path;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/**
 * 画出 size×size 的 PNG：底色 + 对角条纹 + 中间方块，
 * 一眼能看出「这是上传的图片」而不是默认生成的脸。
 */
export function makeTestPng(size = 96): Buffer {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  let offset = 0;
  for (let y = 0; y < size; y += 1) {
    raw[offset] = 0; // filter: none
    offset += 1;
    for (let x = 0; x < size; x += 1) {
      const stripe = (x + y) % 12 < 6;
      const center = Math.abs(x - size / 2) < size / 5 && Math.abs(y - size / 2) < size / 5;
      const [r, g, b] = center ? [255, 255, 255] : stripe ? [47, 111, 184] : [16, 32, 64];
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      offset += 3;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function testPngDataUrl(size = 96): string {
  return `data:image/png;base64,${makeTestPng(size).toString('base64')}`;
}
