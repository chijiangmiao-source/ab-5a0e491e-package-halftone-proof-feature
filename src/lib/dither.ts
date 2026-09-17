/**
 * 蛇形（boustrophedon）Floyd–Steinberg 专色量化引擎。
 *
 * 关键不变式（供制版员逐像素复核）：
 *  - 累计误差以「1/16」为单位用 Int32 记账，是各份「已按半数远离零取整」的
 *    整数贡献之和，任何中间结果不使用浮点；
 *  - alpha < 阈值的像素输出透明，既不接收也不传播误差；
 *  - 调整值 = 源值 + 累计误差/16，逐通道夹到 [0,255]，再四舍五入（半数向上）；
 *  - 以「四舍五入后的整数 RGB」对色板逐项求平方距离，等距时取色板中靠前者；
 *  - 量化误差 = 取整后整数 RGB − 选中专色（整数，可正可负）；
 *  - 7/16 右、3/16 左下、5/16 正下、1/16 右下；奇数行水平镜像；
 *  - 单份贡献（整数量化误差 × 权重 / 16）遇半数向远离零方向取整后，以 1/16 记账；
 *    误差为 8 时四份贡献恰为 3.5/1.5/2.5/0.5，半数规则真实可达；
 *  - 目标邻点越界或源像素透明（alpha < 阈值）时，该份误差直接丢弃。
 *
 * 内存策略：全图只保留三份 1/16 误差的 Int32Array；某一像素的完整证据
 * （距离表、传播去向）在点击时由 getPixelEvidence 即时构造，O(1)。
 */

import type { RGB } from './validation';

export interface CandidateEvidence {
  index: number;
  r: number;
  g: number;
  b: number;
  dist2: number;
  chosen: boolean;
}

export interface SpreadEvidence {
  dir: string; // 右 / 左下 / 正下 / 右下（按扫描方向描述）
  dx: number;
  dy: number;
  targetIndex: number; // -1 表示丢弃
  weightNum: number; // 7/3/5/1
  weightDen: 16;
  q16: { r: number; g: number; b: number }; // 该方向实际记账的 1/16 误差（丢弃则为 0）
  kept: boolean;
  reason: string;
}

export interface PixelEvidence {
  index: number;
  x: number;
  y: number;
  reversed: boolean;
  source: { r: number; g: number; b: number; a: number };
  incoming16: { r: number; g: number; b: number };
  adjusted16: { r: number; g: number; b: number }; // 夹取后调整值的 16 倍分子
  rounded: [number, number, number];
  transparent: boolean;
  chosen: number; // 色板下标；透明为 -1
  /** 量化误差（整数）= 取整后调整值 − 选中专色。 */
  quantError: { r: number; g: number; b: number };
  candidates: CandidateEvidence[];
  spread: SpreadEvidence[];
}

export interface DitherResult {
  width: number;
  height: number;
  source: Uint8ClampedArray;
  palette: RGB[];
  alphaThreshold: number;
  output: Uint8ClampedArray;
  errR: Int32Array;
  errG: Int32Array;
  errB: Int32Array;
  /** 每个像素的蛇形扫描序号（从 0 开始），透明像素同样有序号。 */
  scanOrder: Int32Array;
}

/** 证据/输出上限（约 200 万像素），超过直接拒绝。 */
export const MAX_PIXELS = 2_000_000;

export class DitherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DitherError';
  }
}

/** 调整值（16 倍分子，整数，非负）四舍五入到整数：半数向上。 */
export function roundHalfUp(n16: number): number {
  return Math.floor((n16 + 8) / 16);
}

/**
 * 单份贡献：整数量化误差 × FS 权重 / 16，以 1/16 记账，遇半数向远离零取整。
 * 例：误差 8 × 7/16 = 3.5 → 记账 4（即 4/16）；误差 −8 × 3/16 = −1.5 → −2。
 */
export function shareRoundAwayZero(error: number, num: number): number {
  const q = error * num;
  const abs = Math.floor((Math.abs(q) + 8) / 16);
  return q < 0 ? -abs : abs;
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 某行扫描方向下的四个传播槽位：dx、dy、权重、屏幕几何方向名称。 */
function offsetsFor(reversed: boolean): Array<[number, number, number, string]> {
  // 名称按屏幕几何方位；扫描方向（镜像与否）由槽位顺序与 dx 符号体现。
  return reversed
    ? [
        [-1, 0, 7, '左（扫描前方）'],
        [1, 1, 3, '右下'],
        [0, 1, 5, '正下'],
        [-1, 1, 1, '左下'],
      ]
    : [
        [1, 0, 7, '右（扫描前方）'],
        [-1, 1, 3, '左下'],
        [0, 1, 5, '正下'],
        [1, 1, 1, '右下'],
      ];
}

export function runDither(
  source: Uint8ClampedArray,
  width: number,
  height: number,
  palette: RGB[],
  alphaThreshold: number,
): DitherResult {
  if (palette.length < 2 || palette.length > 8) throw new DitherError('色板必须含 2~8 个专色');
  if (source.length !== width * height * 4) throw new DitherError('源数据尺寸不一致');
  if (width * height > MAX_PIXELS) {
    throw new DitherError(`图像像素数 ${width * height} 超过上限 ${MAX_PIXELS}，请缩小后重试`);
  }

  const n = width * height;
  const output = new Uint8ClampedArray(n * 4);
  const errR = new Int32Array(n);
  const errG = new Int32Array(n);
  const errB = new Int32Array(n);
  const scanOrder = new Int32Array(n);

  let order = 0;
  for (let y = 0; y < height; y++) {
    const reversed = (y & 1) === 1;
    for (let step = 0; step < width; step++) {
      const x = reversed ? width - 1 - step : step;
      const i = y * width + x;
      scanOrder[i] = order++;
      const p = i * 4;
      const sa = source[p + 3];

      if (sa < alphaThreshold) {
        // 透明像素：输出全透明；不接收（任何投向它的贡献都在传播端丢弃）、不传播。
        output[p + 3] = 0;
        continue;
      }

      const sr = source[p];
      const sg = source[p + 1];
      const sb = source[p + 2];

      // 1) 累计误差加入 RGB，夹取，四舍五入（全程整数 1/16 分子）
      const nR = clampInt(sr * 16 + errR[i], 0, 255 * 16);
      const nG = clampInt(sg * 16 + errG[i], 0, 255 * 16);
      const nB = clampInt(sb * 16 + errB[i], 0, 255 * 16);
      const rr = roundHalfUp(nR);
      const rg = roundHalfUp(nG);
      const rb = roundHalfUp(nB);

      // 2) 平方距离选色；严格小于才替换 → 等距时色板靠前者胜出
      let chosen = 0;
      let best = Infinity;
      for (let ci = 0; ci < palette.length; ci++) {
        const c = palette[ci];
        const dr = rr - c.r;
        const dg = rg - c.g;
        const db = rb - c.b;
        const dist2 = dr * dr + dg * dg + db * db;
        if (dist2 < best) {
          best = dist2;
          chosen = ci;
        }
      }

      const pc = palette[chosen];
      output[p] = pc.r;
      output[p + 1] = pc.g;
      output[p + 2] = pc.b;
      output[p + 3] = 255;

      // 3) 量化误差（取整后整数 RGB − 专色），按蛇形 FS 权重逐份半数远离零取整后传播
      const eR = rr - pc.r;
      const eG = rg - pc.g;
      const eB = rb - pc.b;
      for (const [dx, dy, num] of offsetsFor(reversed)) {
        const tx = x + dx;
        const ty = y + dy;
        if (tx < 0 || tx >= width || ty < 0 || ty >= height) continue; // 越界丢弃
        const ti = ty * width + tx;
        if (source[ti * 4 + 3] < alphaThreshold) continue; // 透明邻点丢弃
        errR[ti] += shareRoundAwayZero(eR, num);
        errG[ti] += shareRoundAwayZero(eG, num);
        errB[ti] += shareRoundAwayZero(eB, num);
      }
    }
  }

  return { width, height, source, palette, alphaThreshold, output, errR, errG, errB, scanOrder };
}

/** 按需构造某像素的完整证据（距离表、四去向），全部由最终误差账重新算出。 */
export function getPixelEvidence(result: DitherResult, index: number): PixelEvidence {
  const { width, height, source, palette, alphaThreshold, errR, errG, errB } = result;
  if (index < 0 || index >= width * height) throw new DitherError(`像素下标越界: ${index}`);

  const x = index % width;
  const y = Math.floor(index / width);
  const reversed = (y & 1) === 1;
  const p = index * 4;
  const sr = source[p];
  const sg = source[p + 1];
  const sb = source[p + 2];
  const sa = source[p + 3];
  const incoming16 = { r: errR[index], g: errG[index], b: errB[index] };

  const base = {
    index,
    x,
    y,
    reversed,
    source: { r: sr, g: sg, b: sb, a: sa },
    incoming16,
  };

  if (sa < alphaThreshold) {
    return {
      ...base,
      adjusted16: { r: sr * 16, g: sg * 16, b: sb * 16 },
      rounded: [sr, sg, sb],
      transparent: true,
      chosen: -1,
      quantError: { r: 0, g: 0, b: 0 },
      candidates: palette.map((c, ci) => ({ index: ci, r: c.r, g: c.g, b: c.b, dist2: 0, chosen: false })),
      spread: [],
    };
  }

  const nR = clampInt(sr * 16 + errR[index], 0, 255 * 16);
  const nG = clampInt(sg * 16 + errG[index], 0, 255 * 16);
  const nB = clampInt(sb * 16 + errB[index], 0, 255 * 16);
  const rr = roundHalfUp(nR);
  const rg = roundHalfUp(nG);
  const rb = roundHalfUp(nB);

  let chosen = 0;
  let best = Infinity;
  const candidates: CandidateEvidence[] = palette.map((c, ci) => {
    const dr = rr - c.r;
    const dg = rg - c.g;
    const db = rb - c.b;
    const dist2 = dr * dr + dg * dg + db * db;
    if (dist2 < best) {
      best = dist2;
      chosen = ci;
    }
    return { index: ci, r: c.r, g: c.g, b: c.b, dist2, chosen: false };
  });
  candidates[chosen].chosen = true;

  const pc = palette[chosen];
  const eR = rr - pc.r;
  const eG = rg - pc.g;
  const eB = rb - pc.b;

  const spread: SpreadEvidence[] = offsetsFor(reversed).map(([dx, dy, num, dir]) => {
    const tx = x + dx;
    const ty = y + dy;
    let targetIndex = -1;
    let kept = false;
    let reason: string;
    let q16 = { r: 0, g: 0, b: 0 };

    if (tx < 0 || tx >= width || ty < 0 || ty >= height) {
      reason = '邻点越界，误差丢弃';
    } else {
      targetIndex = ty * width + tx;
      const ta = source[targetIndex * 4 + 3];
      if (ta < alphaThreshold) {
        reason = `邻点透明（alpha=${ta} < 阈值=${alphaThreshold}），误差丢弃`;
      } else {
        kept = true;
        q16 = {
          r: shareRoundAwayZero(eR, num),
          g: shareRoundAwayZero(eG, num),
          b: shareRoundAwayZero(eB, num),
        };
        reason = `记账 +(${q16.r}, ${q16.g}, ${q16.b})/16 至像素 #${targetIndex}`;
      }
    }
    return { dir, dx, dy, targetIndex, weightNum: num, weightDen: 16, q16, kept, reason };
  });

  return {
    ...base,
    adjusted16: { r: nR, g: nG, b: nB },
    rounded: [rr, rg, rb],
    transparent: false,
    chosen,
    quantError: { r: eR, g: eG, b: eB },
    candidates,
    spread,
  };
}

export interface RecomputeVerdict {
  matches: boolean;
  differences: string[];
  chosen: number;
  transparent: boolean;
  rounded: [number, number, number];
  spread: SpreadEvidence[];
}

/**
 * 独立复算：仅凭证据中记录的「源像素 + 累计误差账」与同一套规则，
 * 重走夹取 → 四舍五入 → 平方距离 → 等距取前者 → 四向传播去向，
 * 与引擎即时构造的证据逐项比对，列出全部不一致。
 */
export function recomputeFromEvidence(
  ev: PixelEvidence,
  ctx: { palette: RGB[]; width: number; height: number; source: Uint8ClampedArray; alphaThreshold: number },
): RecomputeVerdict {
  const { palette, width, height, source, alphaThreshold } = ctx;
  const differences: string[] = [];
  const { x, y } = ev;

  const transparent = ev.source.a < alphaThreshold;
  if (transparent !== ev.transparent) differences.push(`透明判定不一致：复算=${transparent}`);
  if (transparent && (ev.incoming16.r !== 0 || ev.incoming16.g !== 0 || ev.incoming16.b !== 0)) {
    differences.push('透明像素不应接收误差');
  }

  let rounded: [number, number, number] = [ev.source.r, ev.source.g, ev.source.b];
  let chosen = -1;
  let eR = 0;
  let eG = 0;
  let eB = 0;

  if (!transparent) {
    const nR = clampInt(ev.source.r * 16 + ev.incoming16.r, 0, 255 * 16);
    const nG = clampInt(ev.source.g * 16 + ev.incoming16.g, 0, 255 * 16);
    const nB = clampInt(ev.source.b * 16 + ev.incoming16.b, 0, 255 * 16);
    rounded = [roundHalfUp(nR), roundHalfUp(nG), roundHalfUp(nB)];

    (['R', 'G', 'B'] as const).forEach((k, ci) => {
      if (rounded[ci] !== ev.rounded[ci]) {
        differences.push(`通道 ${k} 四舍五入不一致：复算=${rounded[ci]}，记录=${ev.rounded[ci]}`);
      }
      const nAdj = [nR, nG, nB][ci];
      const recAdj = [ev.adjusted16.r, ev.adjusted16.g, ev.adjusted16.b][ci];
      if (nAdj !== recAdj) differences.push(`通道 ${k} 调整值不一致：复算=${nAdj}/16，记录=${recAdj}/16`);
    });

    let best = Infinity;
    for (let ci = 0; ci < palette.length; ci++) {
      const c = palette[ci];
      const d = (rounded[0] - c.r) ** 2 + (rounded[1] - c.g) ** 2 + (rounded[2] - c.b) ** 2;
      if (d < best) {
        best = d;
        chosen = ci;
      }
    }
    if (chosen !== ev.chosen) differences.push(`选色不一致：复算=第 ${chosen + 1} 色，记录=第 ${ev.chosen + 1} 色`);

    ev.candidates.forEach((cand) => {
      const c = palette[cand.index];
      const d = (rounded[0] - c.r) ** 2 + (rounded[1] - c.g) ** 2 + (rounded[2] - c.b) ** 2;
      if (d !== cand.dist2) differences.push(`第 ${cand.index + 1} 色距离不一致：复算=${d}，记录=${cand.dist2}`);
      if (cand.chosen !== (cand.index === chosen)) {
        differences.push(`第 ${cand.index + 1} 色选中标记不一致`);
      }
    });

    eR = rounded[0] - palette[chosen].r;
    eG = rounded[1] - palette[chosen].g;
    eB = rounded[2] - palette[chosen].b;
    if (eR !== ev.quantError.r || eG !== ev.quantError.g || eB !== ev.quantError.b) {
      differences.push(
        `量化误差不一致：复算=(${eR},${eG},${eB})，记录=(${ev.quantError.r},${ev.quantError.g},${ev.quantError.b})`,
      );
    }
  }

  const spread: SpreadEvidence[] = offsetsFor(ev.reversed).map(([dx, dy, num, dir], k) => {
    const tx = x + dx;
    const ty = y + dy;
    let targetIndex = -1;
    let kept = false;
    let reason: string;
    let q16 = { r: 0, g: 0, b: 0 };

    if (tx < 0 || tx >= width || ty < 0 || ty >= height) {
      reason = '邻点越界，误差丢弃';
    } else {
      targetIndex = ty * width + tx;
      const ta = source[targetIndex * 4 + 3];
      if (ta < alphaThreshold) {
        reason = `邻点透明（alpha=${ta} < 阈值=${alphaThreshold}），误差丢弃`;
      } else if (transparent) {
        reason = '当前像素透明，不传播';
      } else {
        kept = true;
        q16 = {
          r: shareRoundAwayZero(eR, num),
          g: shareRoundAwayZero(eG, num),
          b: shareRoundAwayZero(eB, num),
        };
        reason = `记账 +(${q16.r}, ${q16.g}, ${q16.b})/16 至像素 #${targetIndex}`;
      }
    }

    const rec = ev.spread[k];
    if (transparent) {
      if (rec) differences.push(`方向 ${dir}：透明像素不应有传播记录`);
    } else if (!rec) {
      differences.push(`方向 ${dir} 缺少传播记录`);
    } else {
      if (rec.kept !== kept) differences.push(`方向 ${dir} 去留不一致：复算=${kept}，记录=${rec.kept}`);
      if (rec.targetIndex !== targetIndex) {
        differences.push(`方向 ${dir} 目标不一致：复算=#${targetIndex}，记录=#${rec.targetIndex}`);
      }
      if (kept && (rec.q16.r !== q16.r || rec.q16.g !== q16.g || rec.q16.b !== q16.b)) {
        differences.push(`方向 ${dir} 记账误差不一致：复算=(${q16.r},${q16.g},${q16.b})/16，记录=(${rec.q16.r},${rec.q16.g},${rec.q16.b})/16`);
      }
    }
    return { dir, dx, dy, targetIndex, weightNum: num, weightDen: 16, q16, kept, reason };
  });

  return { matches: differences.length === 0, differences, chosen, transparent, rounded, spread };
}
