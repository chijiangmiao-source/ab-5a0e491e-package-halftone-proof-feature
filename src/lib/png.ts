/**
 * 纯手写 PNG 解码器（零第三方编解码依赖）。
 *
 * 支持：8 位色深；灰度 / 灰度+Alpha / RGB / RGBA；所有标准 PNG 行过滤器；
 * 交错 Adam7；tRNS 透明块（灰度 / RGB 调色板）；PLTE 调色板颜色类型 3。
 * 不支持并明确报错：非 8 位色深（1/2/4/16）、未知关键块、损坏的 CRC/数据。
 *
 * 输出一律为 RGBA8，便于与 Canvas ImageData 对接。
 */

export class PngDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PngDecodeError';
  }
}

export interface DecodedPng {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

type Inflater = (compressed: Uint8Array) => Promise<Uint8Array>;

/** 默认解压器：浏览器与 Node 18+ 均内置 DecompressionStream；'deflate' 即 zlib 包装。 */
export async function defaultInflater(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export async function decodePng(bytes: Uint8Array, inflater: Inflater = defaultInflater): Promise<DecodedPng> {
  if (bytes.length < 8 + 12 + 12) {
    throw new PngDecodeError('数据过短，不是合法 PNG');
  }
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) {
      throw new PngDecodeError('PNG 签名不匹配');
    }
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette: Uint8Array | null = null; // RGB 三元组紧凑数组
  let trns: Uint8Array | null = null; // 调色板 alpha，或灰度 2 字节 / RGB 6 字节
  const idat: Uint8Array[] = [];
  let sawIend = false;

  while (offset + 8 <= bytes.length) {
    const length = readUint32(bytes, offset);
    const chunkType = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) {
      throw new PngDecodeError(`块 ${chunkType} 长度越界`);
    }
    const chunkData = bytes.subarray(dataStart, dataEnd);

    // CRC32 覆盖类型 + 数据；任何字节损坏都必须报解码失败
    const expectedCrc = (bytes[dataEnd] << 24 | bytes[dataEnd + 1] << 16 | bytes[dataEnd + 2] << 8 | bytes[dataEnd + 3]) >>> 0;
    if (crc32(bytes.subarray(offset + 4, dataEnd)) !== expectedCrc) {
      throw new PngDecodeError(`块 ${chunkType} CRC 校验失败`);
    }

    // 关键块必须被识别（IHDR/PLTE/IDAT/IEND 之外的首字母大写块一律拒绝）
    const isAncillary = (bytes[offset + 4] & 0x20) !== 0;
    if (!isAncillary && !['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(chunkType)) {
      throw new PngDecodeError(`不支持的关键块: ${chunkType}`);
    }

    switch (chunkType) {
      case 'IHDR': {
        if (length !== 13) throw new PngDecodeError('IHDR 长度非法');
        width = readUint32(chunkData, 0);
        height = readUint32(chunkData, 4);
        bitDepth = chunkData[8];
        colorType = chunkData[9];
        if (chunkData[10] !== 0) throw new PngDecodeError('仅支持 PNG 压缩方法 0');
        if (chunkData[11] !== 0) throw new PngDecodeError('仅支持 PNG 过滤方法 0');
        interlace = chunkData[12];
        if (interlace > 1) throw new PngDecodeError(`不支持的交错方式: ${interlace}`);
        break;
      }
      case 'PLTE': {
        if (length % 3 !== 0 || length / 3 > 256) throw new PngDecodeError('PLTE 非法');
        palette = chunkData.slice();
        break;
      }
      case 'tRNS': {
        trns = chunkData.slice();
        break;
      }
      case 'IDAT':
        idat.push(chunkData.slice());
        break;
      case 'IEND':
        if (length !== 0) throw new PngDecodeError('IEND 必须为空块');
        sawIend = true;
        break;
      default:
        break; // 辅助块（gAMA/iCCP/…）对采样解码无影响，跳过
    }

    if (chunkType === 'IEND') break;
    offset = dataEnd + 4;
  }

  // 缺少 IEND（包括在结束块处截断、尾部残留不足一个块头）一律判为损坏
  if (!sawIend) {
    throw new PngDecodeError('PNG 被截断：缺少 IEND 结束块');
  }

  if (width === 0 || height === 0) throw new PngDecodeError('缺少 IHDR 或尺寸为 0');
  if (![0, 2, 3, 4, 6].includes(colorType)) throw new PngDecodeError(`不支持的颜色类型: ${colorType}`);
  if (colorType === 3 && !palette) throw new PngDecodeError('索引色缺少 PLTE');
  const allowedDepths: Record<number, number[]> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  if (!allowedDepths[colorType].includes(bitDepth)) {
    throw new PngDecodeError(`颜色类型 ${colorType} 不支持色深 ${bitDepth}`);
  }

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]!;
  // 过滤器用的每像素字节数：子字节位深一律为 1（PNG 规范）
  const bpp = Math.max(1, Math.floor((channels * bitDepth + 7) / 8));
  // 扫描线原始字节数（子字节位深下一行可能有填充位）
  const rowBytesFor = (w: number) => Math.ceil((w * channels * bitDepth) / 8);
  const expectedRaw =
    interlace === 1 ? adam7ExpectedBytes(width, height, bitDepth, channels) : height * (1 + rowBytesFor(width));
  if (idat.length === 0) throw new PngDecodeError('缺少 IDAT 数据');

  const merged = concat(idat);
  let inflated: Uint8Array;
  try {
    inflated = await inflater(merged);
  } catch (err) {
    throw new PngDecodeError(`zlib 解压失败: ${(err as Error).message}`);
  }
  if (inflated.length !== expectedRaw) {
    throw new PngDecodeError(`解压后长度 ${inflated.length} 与期望 ${expectedRaw} 不符`);
  }

  const out = new Uint8ClampedArray(width * height * 4);

  if (interlace === 0) {
    const stride = rowBytesFor(width);
    const unfiltered = unfilter(inflated, width, height, bpp, stride);
    expandScanlines(unfiltered, width, height, colorType, bitDepth, palette, trns, out, 0, 0, 1, 1);
  } else {
    // Adam7
    const passes: Array<[number, number, number, number]> = [
      [0, 0, 8, 8],
      [4, 0, 8, 8],
      [0, 4, 4, 8],
      [2, 0, 4, 4],
      [0, 2, 2, 4],
      [1, 0, 2, 2],
      [0, 1, 1, 2],
    ];
    let cursor = 0;
    for (const [x0, y0, dx, dy] of passes) {
      const pw = Math.floor((width - x0 + dx - 1) / dx);
      const ph = Math.floor((height - y0 + dy - 1) / dy);
      if (pw === 0 || ph === 0) continue;
      const passStride = rowBytesFor(pw);
      const rawSize = ph * (1 + passStride);
      const raw = inflated.subarray(cursor, cursor + rawSize);
      cursor += rawSize;
      const unfiltered = unfilter(raw, pw, ph, bpp, passStride);
      expandScanlines(unfiltered, pw, ph, colorType, bitDepth, palette, trns, out, x0, y0, dx, dy, width);
    }
    if (cursor !== inflated.length) throw new PngDecodeError('Adam7 数据长度结算不一致');
  }

  return { width, height, data: out };
}

function readUint32(buf: Uint8Array, off: number): number {
  return ((buf[off] << 24) >>> 0) + (buf[off + 1] << 16) + (buf[off + 2] << 8) + buf[off + 3];
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** PNG CRC32（zlib 多项式，初始/异或值 0xffffffff）。 */
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function adam7ExpectedBytes(w: number, h: number, bitDepth: number, channels: number): number {
  const passes: Array<[number, number, number, number]> = [
    [0, 0, 8, 8],
    [4, 0, 8, 8],
    [0, 4, 4, 8],
    [2, 0, 4, 4],
    [0, 2, 2, 4],
    [1, 0, 2, 2],
    [0, 1, 1, 2],
  ];
  let total = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const pw = Math.floor((w - x0 + dx - 1) / dx);
    const ph = Math.floor((h - y0 + dy - 1) / dy);
    if (pw > 0 && ph > 0) total += ph * (1 + Math.ceil((pw * channels * bitDepth) / 8));
  }
  return total;
}

/** 撤销 PNG 行过滤器。bpp = 过滤器每像素字节数；stride = 每行实际字节数。 */
function unfilter(raw: Uint8Array, width: number, height: number, bpp: number, stride: number): Uint8Array {
  void width;
  const out = new Uint8Array(stride * height);
  let prevLineStart = -stride;

  for (let y = 0; y < height; y++) {
    const filterType = raw[y * (stride + 1)];
    const srcStart = y * (stride + 1) + 1;
    const dstStart = y * stride;
    if (filterType > 4) throw new PngDecodeError(`未知行过滤器: ${filterType}`);

    for (let x = 0; x < stride; x++) {
      const cur = raw[srcStart + x];
      const a = x >= bpp ? out[dstStart + x - bpp] : 0;
      const b = y > 0 ? out[prevLineStart + x] : 0;
      const c = y > 0 && x >= bpp ? out[prevLineStart + x - bpp] : 0;
      let v: number;
      switch (filterType) {
        case 0:
          v = cur;
          break;
        case 1:
          v = cur + a;
          break;
        case 2:
          v = cur + b;
          break;
        case 3:
          v = cur + Math.floor((a + b) / 2);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          v = cur + pr;
          break;
        }
        default:
          v = cur;
      }
      out[dstStart + x] = v & 0xff;
    }
    prevLineStart = dstStart;
  }
  return out;
}

/**
 * 将某一遍（pass 或整图）的去滤波采样展开为 RGBA，写入最终缓冲。
 * 支持灰度（1/2/4/8/16 位）、RGB（8/16 位）、灰度+Alpha（8/16）、
 * RGBA（8/16）以及索引色（1/2/4/8 位）。
 */
function expandScanlines(
  samples: Uint8Array,
  pw: number,
  ph: number,
  colorType: number,
  bitDepth: number,
  palette: Uint8Array | null,
  trns: Uint8Array | null,
  out: Uint8ClampedArray,
  x0: number,
  y0: number,
  dx: number,
  dy: number,
  fullWidth?: number,
): void {
  const w = fullWidth ?? pw;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType] as number;
  const subByte = bitDepth < 8;
  const samplesPerByte = subByte ? 8 / bitDepth : 1;
  const rowBytes = Math.ceil((pw * channels * bitDepth) / 8);
  /** 16 位采样按 PNG 规范近似线性缩减到 8 位：floor(v/257)。 */
  const scale16 = (v: number): number => Math.floor(v / 257);

  for (let py = 0; py < ph; py++) {
    /** 取某像素某通道的原始采样（可能是多位宽的灰度/索引或 16 位高低字节）。 */
    const sampleAt = (px: number, ch: number): number => {
      if (subByte) {
        // 每个字节打包多个采样，高位在前（MSB first）
        const pos = px * channels + ch;
        const byteIdx = Math.floor(pos / samplesPerByte);
        const inByte = pos % samplesPerByte;
        const mask = (1 << bitDepth) - 1;
        return (samples[py * rowBytes + byteIdx] >> (bitDepth * (samplesPerByte - 1 - inByte))) & mask;
      }
      if (bitDepth === 16) {
        const off = (py * pw + px) * channels * 2 + ch * 2;
        return samples[off] * 256 + samples[off + 1]; // 16 位线性值
      }
      const off = (py * pw + px) * channels + ch;
      return samples[off];
    };

    for (let px = 0; px < pw; px++) {
      let r: number;
      let g: number;
      let b: number;
      let a = 255;

      if (colorType === 0) {
        // 灰度
        const raw = sampleAt(px, 0);
        const gray = bitDepth === 16 ? scale16(raw) : subByte ? scaleToByte(raw, bitDepth) : raw;
        r = g = b = gray;
        if (trns && trns.length >= 2) {
          // tRNS 为 2 字节，与原始位深空间的采样直接比较
          if (raw === ((trns[0] << 8) | trns[1])) a = 0;
        }
      } else if (colorType === 4) {
        // 灰度 + Alpha
        const rawGray = sampleAt(px, 0);
        const gray = bitDepth === 16 ? scale16(rawGray) : subByte ? scaleToByte(rawGray, bitDepth) : rawGray;
        const rawA = sampleAt(px, 1);
        a = bitDepth === 16 ? scale16(rawA) : subByte ? scaleToByte(rawA, bitDepth) : rawA;
        r = g = b = gray;
      } else if (colorType === 2) {
        // RGB
        if (bitDepth === 16) {
          r = scale16(sampleAt(px, 0));
          g = scale16(sampleAt(px, 1));
          b = scale16(sampleAt(px, 2));
        } else {
          r = sampleAt(px, 0);
          g = sampleAt(px, 1);
          b = sampleAt(px, 2);
        }
        if (trns && trns.length >= 6) {
          const tr = (trns[0] << 8) | trns[1];
          const tg = (trns[2] << 8) | trns[3];
          const tb = (trns[4] << 8) | trns[5];
          // 16 位比原始 16 位采样；8 位 tRNS 高字节为 0，等价于比低字节
          const match = bitDepth === 16
            ? sampleAt(px, 0) === tr && sampleAt(px, 1) === tg && sampleAt(px, 2) === tb
            : r === trns[1] && g === trns[3] && b === trns[5];
          if (match) a = 0;
        }
      } else if (colorType === 6) {
        // RGBA
        if (bitDepth === 16) {
          r = scale16(sampleAt(px, 0));
          g = scale16(sampleAt(px, 1));
          b = scale16(sampleAt(px, 2));
          a = scale16(sampleAt(px, 3));
        } else {
          r = sampleAt(px, 0);
          g = sampleAt(px, 1);
          b = sampleAt(px, 2);
          a = sampleAt(px, 3);
        }
      } else {
        // colorType === 3 索引色
        const idx = sampleAt(px, 0);
        if (!palette || idx * 3 + 2 >= palette.length) throw new PngDecodeError('调色板索引越界');
        r = palette[idx * 3];
        g = palette[idx * 3 + 1];
        b = palette[idx * 3 + 2];
        if (trns && idx < trns.length) a = trns[idx];
      }

      const di = ((y0 + py * dy) * w + (x0 + px * dx)) * 4;
      out[di] = r;
      out[di + 1] = g;
      out[di + 2] = b;
      out[di + 3] = a;
    }
  }
}

/** 1/2/4 位灰度值线性放大到 8 位（PNG 规范：值 v 复制到高低位）。 */
function scaleToByte(v: number, bitDepth: number): number {
  if (bitDepth === 8) return v;
  const max = (1 << bitDepth) - 1;
  return Math.round((v * 255) / max);
}
