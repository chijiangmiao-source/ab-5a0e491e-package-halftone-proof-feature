import { describe, expect, it } from 'vitest';
import {
  getPixelEvidence,
  recomputeFromEvidence,
  roundHalfUp,
  runDither,
  shareRoundAwayZero,
  type DitherResult,
} from './dither';
import type { RGB } from './validation';

const BLACK: RGB = { r: 0, g: 0, b: 0 };
const WHITE: RGB = { r: 255, g: 255, b: 255 };

/** 构造 RGBA 源图。fill 给每个像素返回 [r,g,b,a]。 */
function makeImage(w: number, h: number, fill: (x: number, y: number) => [number, number, number, number]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = fill(x, y);
      const i = (y * w + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return data;
}

describe('roundHalfUp（四舍五入，半数向上）', () => {
  it('边界与夹取相关值', () => {
    expect(roundHalfUp(0)).toBe(0);
    expect(roundHalfUp(8)).toBe(1); // 0.5
    expect(roundHalfUp(24)).toBe(2); // 1.5
    expect(roundHalfUp(7)).toBe(0); // 0.4375
    expect(roundHalfUp(2048)).toBe(128);
    expect(roundHalfUp(4080)).toBe(255);
  });
});

describe('shareRoundAwayZero（单份贡献半数远离零）', () => {
  it('半数向远离零方向取整', () => {
    expect(shareRoundAwayZero(8, 7)).toBe(4); // 8×7/16 = 3.5
    expect(shareRoundAwayZero(-8, 7)).toBe(-4);
    expect(shareRoundAwayZero(8, 3)).toBe(2); // 8×3/16 = 1.5
    expect(shareRoundAwayZero(-8, 3)).toBe(-2);
    expect(shareRoundAwayZero(8, 1)).toBe(1); // 8×1/16 = 0.5
    expect(shareRoundAwayZero(-8, 1)).toBe(-1);
  });

  it('普通值按远离零四舍五入', () => {
    expect(shareRoundAwayZero(7, 7)).toBe(3); // 49/16 = 3.0625
    expect(shareRoundAwayZero(-7, 7)).toBe(-3);
    expect(shareRoundAwayZero(0, 7)).toBe(0);
    expect(shareRoundAwayZero(127, 5)).toBe(40); // 635/16 = 39.6875 → 40
    expect(shareRoundAwayZero(-127, 5)).toBe(-40);
  });
});

describe('手算用例：1×2 灰度（黑/白两色，阈值 0）', () => {
  // 像素0 灰128：取整 128 → 白（127² < 128²）；整数量化误差 128−255 = −127；
  // 右、左下、右下越界丢弃；正下 5/16 份：|−127×5|=635，floor((635+8)/16)=40 → −40 进入像素1。
  // 像素1 灰0：0 + (−40/16) 夹到 0 → 黑。
  const src = makeImage(1, 2, (_x, y) => (y === 0 ? [128, 128, 128, 255] : [0, 0, 0, 255]));
  const r = runDither(src, 1, 2, [BLACK, WHITE], 0);

  it('输出与账面误差', () => {
    expect([r.output[0], r.output[1], r.output[2], r.output[3]]).toEqual([255, 255, 255, 255]);
    expect([r.output[4], r.output[5], r.output[6], r.output[7]]).toEqual([0, 0, 0, 255]);
    expect(r.errR[1]).toBe(-40);
    expect(r.errG[1]).toBe(-40);
    expect(r.errB[1]).toBe(-40);
  });

  it('像素0证据：仅正下保留，其余三向越界丢弃', () => {
    const ev = getPixelEvidence(r, 0);
    expect(ev.chosen).toBe(1);
    expect(ev.quantError.r).toBe(-127);
    const byDir = Object.fromEntries(ev.spread.map((s) => [s.dir, s]));
    expect(byDir['右（扫描前方）'].kept).toBe(false);
    expect(byDir['左下'].kept).toBe(false);
    expect(byDir['右下'].kept).toBe(false);
    expect(byDir['正下'].kept).toBe(true);
    expect(byDir['正下'].q16.r).toBe(-40);
    expect(byDir['正下'].targetIndex).toBe(1);
  });

  it('像素1证据：负误差被夹到 0 后选黑', () => {
    const ev = getPixelEvidence(r, 1);
    expect(ev.incoming16.r).toBe(-40);
    expect(ev.adjusted16.r).toBe(0); // 夹取
    expect(ev.rounded).toEqual([0, 0, 0]);
    expect(ev.chosen).toBe(0);
    const v = recomputeFromEvidence(ev, { palette: r.palette, width: 1, height: 2, source: src, alphaThreshold: 0 });
    expect(v.matches).toBe(true);
  });
});

describe('单份贡献半数远离零取整：误差 8 的四份贡献恰为 3.5/1.5/2.5/0.5', () => {
  it('3×2 手工布局下记账值逐份正确', () => {
    // 构造调整取整后为 8、且黑色最近的源：源灰 8，无外来误差 → 取整 8，选黑，e=8
    const src = makeImage(3, 2, (x, y) => (x === 1 && y === 0 ? [8, 8, 8, 255] : [0, 0, 0, 255]));
    const r = runDither(src, 3, 2, [BLACK, WHITE], 0);
    const ev = getPixelEvidence(r, 1);
    expect(ev.rounded).toEqual([8, 8, 8]);
    expect(ev.quantError.r).toBe(8);
    const share = (dir: string) => ev.spread.find((s) => s.dir.startsWith(dir))!.q16.r;
    expect(share('右')).toBe(4); // 8×7/16 = 3.5 → 4
    expect(share('左下')).toBe(2); // 8×3/16 = 1.5 → 2
    expect(share('正下')).toBe(3); // 8×5/16 = 2.5 → 3
    expect(share('右下')).toBe(1); // 8×1/16 = 0.5 → 1
  });

  it('真实随机图中半数份额大量出现，且每份额都是远离零四舍五入', () => {
    let seed = 20260915;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const w = 24;
    const h = 17;
    const src = makeImage(w, h, () => {
      const g = Math.floor(rand() * 256);
      return [g, g, g, 255];
    });
    const palette: RGB[] = [BLACK, { r: 90, g: 90, b: 90 }, { r: 180, g: 180, b: 180 }, WHITE];
    const r = runDither(src, w, h, palette, 0);

    let halfCases = 0;
    for (let i = 0; i < w * h; i++) {
      const ev = getPixelEvidence(r, i);
      if (ev.transparent) continue;
      for (const s of ev.spread) {
        if (!s.kept) continue;
        for (const [q, e] of [
          [s.q16.r, ev.quantError.r],
          [s.q16.g, ev.quantError.g],
          [s.q16.b, ev.quantError.b],
        ] as Array<[number, number]>) {
          const raw = (e * s.weightNum) / 16; // 未取整的 1/16 份额
          if (Math.abs(e * s.weightNum) % 16 === 8) {
            halfCases++;
            expect(q).toBe(raw < 0 ? Math.floor(raw) : Math.ceil(raw));
            expect(Math.abs(q)).toBe(Math.floor(Math.abs(raw)) + 1);
          } else {
            expect(q).toBe(shareRoundAwayZero(e, s.weightNum));
          }
        }
      }
      const v = recomputeFromEvidence(ev, { palette, width: w, height: h, source: src, alphaThreshold: 0 });
      expect(v.matches, v.differences.join('; ')).toBe(true);
    }
    expect(halfCases).toBeGreaterThan(20); // 误差 ±8 真实出现，半数规则不是空转
  });
});

describe('等距裁决：色板靠前者胜出', () => {
  it('两色等距时取色板中靠前的一色', () => {
  // 调整值 (0,0,1) 与黑、与(0,0,2) 的平方距离都是 1
  const src = makeImage(1, 1, () => [0, 0, 1, 255]);
  const palette: RGB[] = [BLACK, { r: 0, g: 0, b: 2 }];
  const r = runDither(src, 1, 1, palette, 0);
  const ev = getPixelEvidence(r, 0);
  expect(ev.candidates.map((c) => c.dist2)).toEqual([1, 1]);
  expect(ev.chosen).toBe(0);
  expect(ev.candidates[0].chosen).toBe(true);
  expect(ev.candidates[1].chosen).toBe(false);

  // 调换色板顺序后应选另一个
  const r2 = runDither(src, 1, 1, [palette[1], palette[0]], 0);
  expect(getPixelEvidence(r2, 0).chosen).toBe(0);
  });
});

describe('回归：灰度图第二行左侧像素按逐份取整必须落黑', () => {
  it('1×2 灰 100：正下 5/16 份 = 31/16，第二行调整值 102，黑比白近', () => {
    // 手算：(0,0) 灰100 取整100 → 黑（100² < 155²），误差 +100；
    //   正下 5/16：|100×5|=500 → floor(508/16)=31 记账；
    //   (0,1) 调整 100+31/16=101.9375 → 102；黑距 102²=10404 < 白距 153²=23409 → 黑。
    // 若误用「取整前误差」，正下会记 500/16=31.25，使第二行取整 131 而错误翻白。
    const src = makeImage(1, 2, () => [100, 100, 100, 255]);
    const r = runDither(src, 1, 2, [BLACK, WHITE], 0);
    expect(r.errR[1]).toBe(31);
    expect([r.output[0], r.output[1], r.output[2]]).toEqual([0, 0, 0]);
    expect([r.output[4], r.output[5], r.output[6]]).toEqual([0, 0, 0]);

    const ev = getPixelEvidence(r, 1);
    expect(ev.rounded).toEqual([102, 102, 102]);
    expect(ev.chosen).toBe(0);
    const v = recomputeFromEvidence(ev, { palette: r.palette, width: 1, height: 2, source: src, alphaThreshold: 0 });
    expect(v.matches, v.differences.join('; ')).toBe(true);
  });
});

describe('蛇形：奇数行右→左，7/16 先流向左侧', () => {
  it('奇数行先处理右侧像素，误差向左传播', () => {
  // 2×2：第 0 行用纯白（对黑白色板零误差），第 1 行两个灰 128；
  // 奇数行先处理 (1,1)，其 7/16 误差流向 (0,1)，下行三向全部越界。
  const src = makeImage(2, 2, (_x, y) => (y === 0 ? [255, 255, 255, 255] : [128, 128, 128, 255]));
  const r = runDither(src, 2, 2, [BLACK, WHITE], 0);
  expect(r.scanOrder[3]).toBe(2); // (1,1) 是第 3 个扫描像素
  expect(r.scanOrder[2]).toBe(3); // (0,1) 是第 4 个

  const ev1 = getPixelEvidence(r, 3);
  expect(ev1.reversed).toBe(true);
  const right = ev1.spread.find((s) => s.dir === '左（扫描前方）')!;
  expect(right.dx).toBe(-1);
  expect(right.targetIndex).toBe(2);
  expect(right.kept).toBe(true);
  expect(right.q16.r).toBe(-56); // −127×7/16 = −55.5625 → 半数远离零 −56

  const ev0 = getPixelEvidence(r, 2);
  expect(ev0.incoming16.r).toBe(-56);
  // 下行三个方向全部越界丢弃
  expect(ev0.spread.every((s) => !s.kept)).toBe(true);
  });
});

describe('透明阈值：边界严格小于、不接收不传播、邻点误差丢弃', () => {
  it('alpha == 阈值 时仍按不透明处理', () => {
    const src = makeImage(1, 1, () => [128, 128, 128, 128]);
    const r = runDither(src, 1, 1, [BLACK, WHITE], 128);
    expect(r.output[3]).toBe(255);
  });

  it('alpha 严格小于阈值 → 透明；投向它的误差直接丢弃', () => {
    const src = makeImage(1, 2, (_x, y) => (y === 0 ? [128, 128, 128, 255] : [200, 200, 200, 127]));
    const r = runDither(src, 1, 2, [BLACK, WHITE], 128);
    expect([r.output[0], r.output[1], r.output[2], r.output[3]]).toEqual([255, 255, 255, 255]);
    expect(r.output[7]).toBe(0);
    expect(r.errR[1]).toBe(0); // 正下贡献被丢弃

    const evTransparent = getPixelEvidence(r, 1);
    expect(evTransparent.transparent).toBe(true);
    expect(evTransparent.spread).toEqual([]);
    expect(evTransparent.chosen).toBe(-1);

    const evTop = getPixelEvidence(r, 0);
    const down = evTop.spread.find((s) => s.dir === '正下')!;
    expect(down.kept).toBe(false);
    expect(down.reason).toMatch(/透明/);

    const v = recomputeFromEvidence(evTransparent, { palette: r.palette, width: 1, height: 2, source: src, alphaThreshold: 128 });
    expect(v.matches).toBe(true);
  });
});

describe('四个角点都能得到唯一、无 NaN 的证据', () => {
  it('四角均有唯一选色且复算一致', () => {
  const src = makeImage(3, 2, (x, y) => [(x * 80) % 256, (y * 120 + 30) % 256, (x + y) * 51, 255]);
  const r = runDither(src, 3, 2, [BLACK, WHITE, { r: 230, g: 0, b: 128 }], 0);
  for (const idx of [0, 2, 3, 5]) {
    const ev = getPixelEvidence(r, idx);
    expect(Number.isFinite(ev.incoming16.r)).toBe(true);
    expect(ev.spread).toHaveLength(4);
    expect(ev.chosen).toBeGreaterThanOrEqual(0);
    const v = recomputeFromEvidence(ev, { palette: r.palette, width: 3, height: 2, source: src, alphaThreshold: 0 });
    expect(v.matches).toBe(true);
    }
  });
});

describe('篡改证据必须被独立复算发现', () => {
  it('改选色结果会被发现', () => {
  const src = makeImage(2, 2, () => [100, 100, 100, 255]);
  const r = runDither(src, 2, 2, [BLACK, WHITE], 0);
  const ev = getPixelEvidence(r, 0);
  const tampered = { ...ev, chosen: ev.chosen === 0 ? 1 : 0 };
  const v = recomputeFromEvidence(tampered, { palette: r.palette, width: 2, height: 2, source: src, alphaThreshold: 0 });
  expect(v.matches).toBe(false);
  expect(v.differences.join(' ')).toMatch(/选色/);
  });
});

/**
 * 独立参照实现：用普通数组按扫描顺序重写同一套规则（不共享引擎代码路径），
 * 用于全量交叉验证输出、误差账与每个像素的证据。
 */
function referenceRun(
  source: Uint8ClampedArray,
  w: number,
  h: number,
  palette: RGB[],
  threshold: number,
): { output: number[]; err: number[][] } {
  const n = w * h;
  const err: number[][] = Array.from({ length: n }, () => [0, 0, 0]);
  const output = new Array<number>(n * 4).fill(0);

  for (let y = 0; y < h; y++) {
    const rev = y % 2 === 1;
    for (let step = 0; step < w; step++) {
      const x = rev ? w - 1 - step : step;
      const i = y * w + x;
      const p = i * 4;
      if (source[p + 3] < threshold) {
        output[p + 3] = 0;
        continue;
      }
      const adj = [0, 1, 2].map((c) => {
        let v = source[p + c] * 16 + err[i][c];
        if (v < 0) v = 0;
        if (v > 4080) v = 4080;
        return v;
      });
      const rounded = adj.map((v) => Math.floor((v + 8) / 16));
      let best = -1;
      let bestD = Infinity;
      for (let k = 0; k < palette.length; k++) {
        const pc = [palette[k].r, palette[k].g, palette[k].b];
        const d = rounded.reduce((acc, q, c) => acc + (q - pc[c]) ** 2, 0);
        if (d < bestD) {
          bestD = d;
          best = k;
        }
      }
      const pc = palette[best];
      output[p] = pc.r;
      output[p + 1] = pc.g;
      output[p + 2] = pc.b;
      output[p + 3] = 255;
      // 整数量化误差 = 取整 RGB − 专色
      const e = [rounded[0] - pc.r, rounded[1] - pc.g, rounded[2] - pc.b];
      const slots: Array<[number, number, number]> = rev
        ? [[-1, 0, 7], [1, 1, 3], [0, 1, 5], [-1, 1, 1]]
        : [[1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]];
      for (const [dx, dy, num] of slots) {
        const tx = x + dx;
        const ty = y + dy;
        if (tx < 0 || tx >= w || ty < 0 || ty >= h) continue;
        const ti = ty * w + tx;
        if (source[ti * 4 + 3] < threshold) continue;
        for (let c = 0; c < 3; c++) {
          const q = e[c] * num;
          const add = (q < 0 ? -1 : 1) * Math.floor((Math.abs(q) + 8) / 16);
          err[ti][c] += add;
        }
      }
    }
  }
  return { output, err };
}

describe('随机图与独立参照全量交叉验证', () => {
  function mulberry32(seed: number) {
    return () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const cases: Array<{ w: number; h: number; colors: number; threshold: number; seed: number }> = [
    { w: 7, h: 5, colors: 2, threshold: 0, seed: 1 },
    { w: 8, h: 8, colors: 3, threshold: 128, seed: 2 },
    { w: 13, h: 3, colors: 5, threshold: 200, seed: 3 },
    { w: 4, h: 11, colors: 8, threshold: 64, seed: 4 },
    { w: 1, h: 1, colors: 2, threshold: 0, seed: 5 },
  ];

  for (const tc of cases) {
    it(`${tc.w}×${tc.h} / ${tc.colors} 色 / 阈值 ${tc.threshold}（seed ${tc.seed}）`, () => {
      const rand = mulberry32(tc.seed);
      const palette: RGB[] = [];
      const used = new Set<string>();
      while (palette.length < tc.colors) {
        const c = {
          r: Math.floor(rand() * 256),
          g: Math.floor(rand() * 256),
          b: Math.floor(rand() * 256),
        };
        const key = `${c.r}-${c.g}-${c.b}`;
        if (!used.has(key)) {
          used.add(key);
          palette.push(c);
        }
      }
      const src = makeImage(tc.w, tc.h, () => [
        Math.floor(rand() * 256),
        Math.floor(rand() * 256),
        Math.floor(rand() * 256),
        Math.floor(rand() * 256),
      ]);

      const r: DitherResult = runDither(src, tc.w, tc.h, palette, tc.threshold);
      const ref = referenceRun(src, tc.w, tc.h, palette, tc.threshold);

      expect(Array.from(r.output)).toEqual(ref.output);
      for (let i = 0; i < tc.w * tc.h; i++) {
        expect([r.errR[i], r.errG[i], r.errB[i]]).toEqual(ref.err[i]);
      }

      // 输出值只可能是色板之一或透明
      for (let i = 0; i < tc.w * tc.h; i++) {
        const p = i * 4;
        if (r.output[p + 3] === 0) {
          expect([r.output[p], r.output[p + 1], r.output[p + 2]]).toEqual([0, 0, 0]);
        } else {
          expect(r.output[p + 3]).toBe(255);
          const hit = palette.some((c) => c.r === r.output[p] && c.g === r.output[p + 1] && c.b === r.output[p + 2]);
          expect(hit).toBe(true);
        }
        // 每个像素证据都可独立复算通过（含角点与透明边界）
        const ev = getPixelEvidence(r, i);
        const verdict = recomputeFromEvidence(ev, {
          palette,
          width: tc.w,
          height: tc.h,
          source: src,
          alphaThreshold: tc.threshold,
        });
        expect(verdict.matches, verdict.differences.join('; ')).toBe(true);
      }
    });
  }
});
