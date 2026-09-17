/**
 * 测试夹具：零依赖最小 PNG（RGBA 8 位，逐行 filter 0）编码器。
 * 仅供 Vitest / Playwright 在本机生成确定性图像，不进入业务代码包。
 */
import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u32(n: number): number[] {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Uint8Array.from([...type].map((c) => c.charCodeAt(0)));
  const crcInput = Uint8Array.from([...typeBytes, ...data]);
  return Uint8Array.from([...u32(data.length), ...typeBytes, ...data, ...u32(crc32(crcInput))]);
}

export function makePng(
  width: number,
  height: number,
  rgba: (x: number, y: number) => [number, number, number, number],
): Buffer {
  const raw: number[] = [];
  for (let y = 0; y < height; y++) {
    raw.push(0);
    for (let x = 0; x < width; x++) {
      raw.push(...rgba(x, y));
    }
  }
  const ihdr = Uint8Array.from([...u32(width), ...u32(height), 8, 6, 0, 0, 0]);
  const idat = deflateSync(Buffer.from(raw));
  return Buffer.from(
    Uint8Array.from([
      ...[137, 80, 78, 71, 13, 10, 26, 10],
      ...chunk('IHDR', ihdr),
      ...chunk('IDAT', new Uint8Array(idat)),
      ...chunk('IEND', new Uint8Array(0)),
    ]),
  );
}
