import { describe, expect, it } from 'vitest';
import { decodePng, PngDecodeError } from './png';

/* ----------------------- 测试用最小 PNG 编码器 ----------------------- */

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

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate');
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function u32(n: number): number[] {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

function chunk(type: string, data: number[] | Uint8Array): Uint8Array {
  const body = typeof data === 'object' && data instanceof Uint8Array ? data : Uint8Array.from(data as number[]);
  const typeBytes = [...type].map((c) => c.charCodeAt(0));
  const crcInput = Uint8Array.from([...typeBytes, ...body]);
  return Uint8Array.from([...u32(body.length), ...typeBytes, ...body, ...u32(crc32(crcInput))]);
}

interface EncodeOpts {
  width: number;
  height: number;
  bitDepth?: number;
  colorType?: number; // 0 灰 / 2 RGB / 3 索引 / 6 RGBA
  interlace?: 0 | 1;
  palette?: number[][]; // RGB 三元组数组
  rowFilter?: (passY: number, passHeight: number) => number; // 0..4，默认全 0
  rgba: (x: number, y: number) => [number, number, number, number];
  corruptCrc?: boolean;
}

async function encodePng(opts: EncodeOpts): Promise<Uint8Array> {
  const { width: w, height: h, bitDepth = 8, colorType = 6, interlace = 0 } = opts;
  const channels = ({ 0: 1, 2: 3, 3: 1, 6: 4 } as Record<number, number>)[colorType]!;
  const bpp = Math.max(1, Math.floor((channels * bitDepth + 7) / 8));

  const pixelBytes = (x: number, y: number): number[] => {
    const [r, g, b, a] = opts.rgba(x, y);
    if (colorType === 6) return bitDepth === 16 ? [r, 0, g, 0, b, 0, a, 0] : [r, g, b, a];
    if (colorType === 2) return bitDepth === 16 ? [r, 0, g, 0, b, 0] : [r, g, b];
    if (colorType === 0) {
      const gray = Math.round((r + g + b) / 3);
      return bitDepth === 16 ? [gray, 0] : bitDepth === 8 ? [gray] : [];
    }
    if (colorType === 3) return []; // 打包在 sub-byte 阶段
    throw new Error('未支持的编码颜色类型');
  };

  const buildPass = (pw: number, ph: number, x0: number, y0: number, dx: number, dy: number): Uint8Array => {
    const rowBytes = Math.ceil((pw * channels * bitDepth) / 8);
    const raw = new Uint8Array(ph * (1 + rowBytes));
    const unfiltered = new Uint8Array(ph * rowBytes);
    const filterBpp = bitDepth < 8 ? 1 : bpp;

    for (let py = 0; py < ph; py++) {
      const line = py * rowBytes;
      if (colorType === 3 || (colorType === 0 && bitDepth < 8)) {
        // 打包多采样/字节，MSB first
        let bitBuf = 0;
        let bitLen = 0;
        let bytePos = 0;
        for (let px = 0; px < pw; px++) {
          const x = x0 + px * dx;
          const y = y0 + py * dy;
          const [r, g, b] = opts.rgba(x, y);
          let v: number;
          if (colorType === 3) {
            const pal = opts.palette!;
            v = pal.findIndex(([pr, pg, pb]) => pr === r && pg === g && pb === b);
            if (v < 0) throw new Error('像素不在调色板中');
          } else {
            const gray = Math.round((r + g + b) / 3);
            v = Math.round((gray / 255) * ((1 << bitDepth) - 1));
          }
          bitBuf = (bitBuf << bitDepth) | v;
          bitLen += bitDepth;
          while (bitLen >= 8) {
            unfiltered[line + bytePos] = (bitBuf >>> (bitLen - 8)) & 0xff;
            bitBuf &= (1 << (bitLen - 8)) - 1;
            bitLen -= 8;
            bytePos++;
          }
        }
        if (bitLen > 0) unfiltered[line + bytePos] = (bitBuf << (8 - bitLen)) & 0xff;
      } else {
        for (let px = 0; px < pw; px++) {
          const x = x0 + px * dx;
          const y = y0 + py * dy;
          unfiltered.set(pixelBytes(x, y), line + px * bpp);
        }
      }
    }

    // 按行施加过滤器（正向编码，与解码器互为逆运算）
    for (let py = 0; py < ph; py++) {
      const filterType = opts.rowFilter ? opts.rowFilter(py, ph) : 0;
      const outLine = py * (1 + rowBytes);
      const curLine = py * rowBytes;
      raw[outLine] = filterType;
      for (let x = 0; x < rowBytes; x++) {
        const cur = unfiltered[curLine + x];
        const a = x >= filterBpp ? unfiltered[curLine + x - filterBpp] : 0;
        const b = py > 0 ? unfiltered[curLine - rowBytes + x] : 0;
        const c = py > 0 && x >= filterBpp ? unfiltered[curLine - rowBytes + x - filterBpp] : 0;
        let v: number;
        switch (filterType) {
          case 0: v = cur; break;
          case 1: v = cur - a; break;
          case 2: v = cur - b; break;
          case 3: v = cur - Math.floor((a + b) / 2); break;
          default: {
            const p = a + b - c;
            const pa = Math.abs(p - a);
            const pb = Math.abs(p - b);
            const pc = Math.abs(p - c);
            const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
            v = cur - pr;
          }
        }
        raw[outLine + 1 + x] = v & 0xff;
      }
    }
    return raw;
  };

  let raw: Uint8Array;
  if (interlace === 0) {
    raw = buildPass(w, h, 0, 0, 1, 1);
  } else {
    const passes: Array<[number, number, number, number]> = [
      [0, 0, 8, 8],
      [4, 0, 8, 8],
      [0, 4, 4, 8],
      [2, 0, 4, 4],
      [0, 2, 2, 4],
      [1, 0, 2, 2],
      [0, 1, 1, 2],
    ];
    const parts: Uint8Array[] = [];
    for (const [x0, y0, dx, dy] of passes) {
      const pw = Math.floor((w - x0 + dx - 1) / dx);
      const ph = Math.floor((h - y0 + dy - 1) / dy);
      if (pw > 0 && ph > 0) parts.push(buildPass(pw, ph, x0, y0, dx, dy));
    }
    raw = Uint8Array.from(parts.flatMap((p) => [...p]));
  }

  const idat = await deflate(raw);
  const ihdr = [...u32(w), ...u32(h), bitDepth, colorType, 0, 0, interlace];
  const parts = [
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
  ];
  if (opts.palette) {
    parts.push(chunk('PLTE', opts.palette.flat()));
  }
  let idatChunk = chunk('IDAT', idat);
  if (opts.corruptCrc) idatChunk[idatChunk.length - 1] ^= 0xff;
  parts.push(idatChunk);
  parts.push(chunk('IEND', []));
  return Uint8Array.from(parts.flatMap((p) => [...p]));
}

/* ------------------------------ 测试 ------------------------------ */

describe('decodePng 基本解码', () => {
  it('RGBA 8 位往返', async () => {
    const png = await encodePng({
      width: 3,
      height: 2,
      colorType: 6,
      rgba: (x, y) => [x * 10, y * 20 + 5, x + y, ((x + y) % 2) * 255],
    });
    const img = await decodePng(png);
    expect([img.width, img.height]).toEqual([3, 2]);
    expect(img.data[0]).toBe(0);
    expect(img.data[1]).toBe(5);
    expect(img.data[3]).toBe(0); // (0,0): ((0+0)%2)*255 = 0
    expect(img.data[4 * 3 + 3]).toBe(255); // (0,1): ((0+1)%2)*255 = 255
    const i = (1 * 3 + 2) * 4;
    expect([img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]]).toEqual([20, 25, 3, 255]);
  });

  it('RGB 8 位（alpha 补 255）', async () => {
    const png = await encodePng({
      width: 2,
      height: 1,
      colorType: 2,
      rgba: (x) => [10 + x, 20, 30, 255],
    });
    const img = await decodePng(png);
    expect(Array.from(img.data.slice(0, 8))).toEqual([10, 20, 30, 255, 11, 20, 30, 255]);
  });

  it('灰度 8 位', async () => {
    const png = await encodePng({
      width: 1,
      height: 2,
      colorType: 0,
      rgba: (_x, y) => [y * 40, y * 40, y * 40, 255],
    });
    const img = await decodePng(png);
    expect([img.data[0], img.data[4]]).toEqual([0, 40]);
    expect(img.data[3]).toBe(255);
  });

  it('1 位灰度拆包与放大', async () => {
    // 4×1: 黑 白 黑 白
    const png = await encodePng({
      width: 4,
      height: 1,
      colorType: 0,
      bitDepth: 1,
      rgba: (x) => [x % 2 ? 255 : 0, x % 2 ? 255 : 0, x % 2 ? 255 : 0, 255],
    });
    const img = await decodePng(png);
    expect([img.data[0], img.data[4], img.data[8], img.data[12]]).toEqual([0, 255, 0, 255]);
  });

  it('索引色（PLTE，8 位）', async () => {
    const png = await encodePng({
      width: 3,
      height: 1,
      colorType: 3,
      palette: [[227, 6, 19], [0, 0, 0], [255, 221, 0]],
      rgba: (x): [number, number, number, number] =>
        ([[227, 6, 19, 255], [0, 0, 0, 255], [255, 221, 0, 255]] as Array<[number, number, number, number]>)[x],
    });
    const img = await decodePng(png);
    expect(Array.from(img.data.slice(0, 12))).toEqual([227, 6, 19, 255, 0, 0, 0, 255, 255, 221, 0, 255]);
  });

  it('RGBA 16 位缩减为 8 位', async () => {
    const png = await encodePng({
      width: 1,
      height: 1,
      colorType: 6,
      bitDepth: 16,
      rgba: () => [255, 128, 0, 255],
    });
    const img = await decodePng(png);
    // 编码器高字节存 8 位值：255→0xFF00=65280，floor(/257)=254；128→0x8000，floor(/257)=127
    expect([img.data[0], img.data[1], img.data[2], img.data[3]]).toEqual([254, 127, 0, 254]);
  });

  it('五种行过滤器均能正确去滤波（RGBA 8 位）', async () => {
    const rgba = (x: number, y: number): [number, number, number, number] => [
      (x * 37 + y * 91 + 13) % 256,
      (x * 53 + 17) % 256,
      (y * 71 + x * 11) % 256,
      255,
    ];
    const reference = await encodePng({ width: 7, height: 5, colorType: 6, rowFilter: () => 0, rgba });
    const refImg = await decodePng(reference);
    for (let f = 1; f <= 4; f++) {
      const png = await encodePng({ width: 7, height: 5, colorType: 6, rowFilter: () => f, rgba });
      const img = await decodePng(png);
      expect(Array.from(img.data)).toEqual(Array.from(refImg.data));
    }
  });

  it('过滤器与 1 位索引色、交错组合也正确', async () => {
    const rgba = (x: number, y: number): [number, number, number, number] =>
      (x + y) % 2 === 0 ? [10, 20, 30, 255] : [200, 210, 220, 255];
    const reference = await encodePng({
      width: 13,
      height: 9,
      colorType: 3,
      bitDepth: 1,
      palette: [[10, 20, 30], [200, 210, 220]],
      interlace: 1,
      rgba,
    });
    const filtered = await encodePng({
      width: 13,
      height: 9,
      colorType: 3,
      bitDepth: 1,
      palette: [[10, 20, 30], [200, 210, 220]],
      interlace: 1,
      rowFilter: (py) => (py % 5) as 0 | 1 | 2 | 3 | 4,
      rgba,
    });
    const a = await decodePng(reference);
    const b = await decodePng(filtered);
    expect(Array.from(b.data)).toEqual(Array.from(a.data));
  });

  it('Adam7 交错图与逐行图结果一致', async () => {
    const rgba = (x: number, y: number): [number, number, number, number] => [
      (x * 37 + y * 91) % 256,
      (x * 53 + 17) % 256,
      (y * 71 + x * 11) % 256,
      ((x + y) % 3 === 0 ? 0 : 255),
    ];
    const normal = await encodePng({ width: 11, height: 7, colorType: 6, interlace: 0, rgba });
    const interlaced = await encodePng({ width: 11, height: 7, colorType: 6, interlace: 1, rgba });
    const a = await decodePng(normal);
    const b = await decodePng(interlaced);
    expect(Array.from(b.data)).toEqual(Array.from(a.data));
  });
});

describe('decodePng 失败必须抛出', () => {
  it('不是 PNG（纯文本）', async () => {
    await expect(decodePng(new TextEncoder().encode('hello world, not a png at all'))).rejects.toBeInstanceOf(PngDecodeError);
  });

  it('签名错误', async () => {
    const png = await encodePng({ width: 1, height: 1, colorType: 6, rgba: () => [1, 2, 3, 255] });
    png[0] = 0;
    await expect(decodePng(png)).rejects.toThrow(/签名/);
  });

  it('数据截断', async () => {
    const png = await encodePng({ width: 4, height: 4, colorType: 6, rgba: () => [9, 9, 9, 255] });
    await expect(decodePng(png.subarray(0, 30))).rejects.toThrow(/过短|越界|IHDR/);
  });

  it('缺少 IEND 结束块（在结束块处截断）必须报错', async () => {
    const png = await encodePng({ width: 3, height: 3, colorType: 6, rgba: () => [50, 100, 150, 255] });
    // 合法 PNG 末尾固定是 IEND 块：4 长度 + 4 类型 + 4 CRC = 12 字节
    expect(String.fromCharCode(...png.subarray(png.length - 8, png.length - 4))).toBe('IEND');
    const truncated = png.subarray(0, png.length - 12);
    await expect(decodePng(truncated)).rejects.toThrow(/IEND|截断/);
  });

  it('IEND 非空也判损坏', async () => {
    const png = await encodePng({ width: 1, height: 1, colorType: 6, rgba: () => [1, 2, 3, 255] });
    // 把 IEND 声明长度改为 1（尾部结构随之异常，按截断/损坏处理）
    png[png.length - 11] = 0;
    png[png.length - 10] = 0;
    png[png.length - 9] = 0;
    png[png.length - 8] = 1;
    await expect(decodePng(png)).rejects.toThrow(/IEND|截断|越界|CRC/);
  });

  it('CRC 损坏被检出', async () => {
    const png = await encodePng({
      width: 2,
      height: 2,
      colorType: 6,
      corruptCrc: true,
      rgba: () => [1, 2, 3, 255],
    });
    await expect(decodePng(png)).rejects.toThrow(/CRC/);
  });

  it('IDAT 数据被破坏导致解压失败', async () => {
    const png = await encodePng({ width: 4, height: 4, colorType: 2, rgba: () => [1, 2, 3, 255] });
    // 找到 IDAT 载荷中部翻转一位（避开 CRC，让 zlib 自己报错）
    const marker = [73, 68, 65, 84];
    let pos = 8;
    for (let i = 8; i < png.length - 4; i++) {
      if (marker.every((m, k) => png[i + k] === m)) {
        pos = i + 4 + 3;
        break;
      }
    }
    png[pos] ^= 0x0c;
    await expect(decodePng(png)).rejects.toThrow(/CRC|zlib|长度/);
  });
});
