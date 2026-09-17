import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { decodePng, PngDecodeError } from './lib/png';
import { parsePaletteEntries, parseThreshold, type RGB } from './lib/validation';
import {
  getPixelEvidence,
  MAX_PIXELS,
  recomputeFromEvidence,
  runDither,
  type DitherResult,
} from './lib/dither';

interface LoadedImage {
  name: string;
  bytes: number;
  width: number;
  height: number;
  source: Uint8ClampedArray;
}

const DEFAULT_PALETTE = ['000000', 'FFFFFF', 'E30613', 'FFDD00'];

function hex(c: RGB): string {
  const h = (n: number) => n.toString(16).padStart(2, '0').toUpperCase();
  return `${h(c.r)}${h(c.g)}${h(c.b)}`;
}

function frac16(n: number): string {
  const sign = n < 0 ? '-' : '';
  const v = Math.abs(n);
  const whole = Math.floor(v / 16);
  const rem = v % 16;
  return `${sign}${whole}.${(rem / 16).toFixed(4).slice(2)}（${sign}${v}/16）`;
}

export default function App() {
  const [image, setImage] = useState<LoadedImage | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [entries, setEntries] = useState<string[]>(DEFAULT_PALETTE);
  const [thresholdText, setThresholdText] = useState('128');
  const [pinned, setPinned] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const paletteParsed = useMemo(() => parsePaletteEntries(entries), [entries]);
  const thresholdParsed = useMemo(() => parseThreshold(thresholdText), [thresholdText]);
  const paramsValid = !paletteParsed.error && !thresholdParsed.error;

  const loadFile = useCallback(async (file: File) => {
    setFileError(null);
    if (!/\.png$/i.test(file.name)) {
      setFileError('仅支持 PNG 文件（.png）');
      setImage(null);
      setPinned(null);
      return;
    }
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const decoded = await decodePng(buf);
      if (decoded.width * decoded.height > MAX_PIXELS) {
        setFileError(`图像像素数 ${decoded.width * decoded.height} 超过上限 ${MAX_PIXELS}，请缩小后重试`);
        setImage(null);
        setPinned(null);
        return;
      }
      setImage({ name: file.name, bytes: buf.length, width: decoded.width, height: decoded.height, source: decoded.data });
      setPinned(null);
      setHovered(null);
    } catch (err) {
      const msg = err instanceof PngDecodeError ? err.message : `解码失败：${(err as Error).message}`;
      setFileError(`PNG 解码失败：${msg}`);
      setImage(null);
      setPinned(null);
    }
  }, []);

  // 解码 / 参数任一非法时，结果为 null（无效输出被清空）
  const result: DitherResult | null = useMemo(() => {
    if (!image || !paramsValid) return null;
    return runDither(image.source, image.width, image.height, paletteParsed.colors, thresholdParsed.value);
  }, [image, paramsValid, paletteParsed, thresholdParsed]);

  const pixelCount = result ? result.width * result.height : 0;
  // 换图在 loadFile 中把 pinned 清空；参数微调时保留钉选，仅钳制到合法范围
  const currentIndex = result
      ? Math.min(hovered ?? pinned ?? 0, pixelCount - 1)
      : 0;

  return (
    <>
      <header className="app-header">
        <h1>专色稿蛇行抖动 · 逐像素复核工作台</h1>
        <p>
          纯前端 / 离线：PNG 自行解码，蛇形 Floyd–Steinberg（7/3/5/1，奇行镜像）整数记账；
          点击结果中任一像素即可复算该像素的调整值、平方距离、等距裁决与误差传播去向。
        </p>
      </header>

      <main>
        <section className="panel" data-testid="controls">
          <h2>1. 输入与专色参数</h2>
          <div className="controls-grid">
            <div>
              <div
                className={`drop-zone${dragging ? ' dragover' : ''}`}
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  const f = e.dataTransfer.files?.[0];
                  if (f) void loadFile(f);
                }}
                data-testid="dropzone"
              >
                <strong>点击选择 PNG</strong> 或拖拽到此处
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,.png"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void loadFile(f);
                    e.target.value = '';
                  }}
                />
                {image && (
                  <div className="file-meta">
                    {image.name} · {image.width}×{image.height} · {image.bytes} 字节
                  </div>
                )}
              </div>
              {fileError && (
                <div className="error-text" role="alert" data-testid="file-error">
                  {fileError}
                </div>
              )}
              {image && !fileError && (
                <div className="hint ok-text" data-testid="decode-ok">
                  PNG 解码成功：{image.width}×{image.height} RGBA
                </div>
              )}
            </div>

            <div>
              {entries.map((v, i) => (
                <div className="palette-row" key={i}>
                  <span className="idx">#{i + 1}</span>
                  <span
                    className="swatch"
                    style={{ background: /^[0-9a-fA-F]{6}$/.test(v.trim()) ? `#${v.trim()}` : 'transparent' }}
                  />
                  <input
                    type="text"
                    value={v}
                    maxLength={6}
                    aria-label={`专色 ${i + 1}`}
                    data-testid={`palette-input-${i}`}
                    className={paletteParsed.fieldErrors[i] ? 'invalid' : ''}
                    onChange={(e) => {
                      const next = [...entries];
                      next[i] = e.target.value;
                      setEntries(next);
                    }}
                  />
                  <span className="hint" style={{ marginTop: 0 }}>
                    {paletteParsed.fieldErrors[i]}
                  </span>
                  <button
                    type="button"
                    disabled={entries.length <= 2}
                    onClick={() => setEntries(entries.filter((_, j) => j !== i))}
                    aria-label={`删除专色 ${i + 1}`}
                  >
                    删除
                  </button>
                </div>
              ))}
              <div className="palette-actions">
                <button
                  type="button"
                  disabled={entries.length >= 8}
                  onClick={() => setEntries([...entries, '000000'])}
                  data-testid="add-color"
                >
                  + 增加专色
                </button>
                <span className="hint" style={{ marginTop: 0 }}>
                  {entries.length} / 2~8 个，六位 RGB，不可重复（顺序即等距裁决优先级）
                </span>
              </div>
              {paletteParsed.error && (
                <div className="error-text" role="alert" data-testid="palette-error">
                  {paletteParsed.error}
                </div>
              )}
            </div>

            <div>
              <div className="threshold-row">
                <label htmlFor="threshold">透明阈值</label>
                <input
                  id="threshold"
                  type="number"
                  min={0}
                  max={255}
                  value={thresholdText}
                  className={thresholdParsed.error ? 'invalid' : ''}
                  onChange={(e) => setThresholdText(e.target.value)}
                />
                <span className="hint" style={{ marginTop: 0 }}>
                  0~255
                </span>
              </div>
              <div className="hint">
                源像素 alpha 严格小于阈值即输出透明：不接收误差，也不传播；投向它的误差在源头直接丢弃。
              </div>
              {thresholdParsed.error && (
                <div className="error-text" role="alert" data-testid="threshold-error">
                  {thresholdParsed.error}
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="panel">
          <h2>2. 原图 / 结果 / 像素证据</h2>
          {!image && <div className="empty-hint">请先上传 PNG。</div>}
          {image && !paramsValid && (
            <div className="empty-hint" data-testid="output-cleared">
              参数非法，结果输出已清空；修正上方红色错误后自动重新量化。
            </div>
          )}
          {image && fileError && !result && (
            <div className="empty-hint">解码失败，无任何输出。</div>
          )}
          {result && (
            <div className="stages">
              <div className="stage">
                <h3>原图（PNG 解码后 RGBA）</h3>
                <div className="canvas-wrap checkerboard">
                  <ImageCanvas result={result} mode="source" marker={currentIndex} />
                </div>
                <PixelCounts result={result} />
              </div>

              <div className="stage">
                <h3>量化结果（仅专色 + 透明）— 点击任一像素复核</h3>
                <div className="canvas-wrap checkerboard">
                  <ImageCanvas
                    result={result}
                    mode="output"
                    marker={currentIndex}
                    onPick={(idx) => setPinned(idx)}
                    onHover={setHovered}
                  />
                </div>
                <div className="hint">
                  角点快查：
                  {[
                    [0, 0],
                    [result.width - 1, 0],
                    [0, result.height - 1],
                    [result.width - 1, result.height - 1],
                  ]
                    // 1 像素宽/高时四个角会退化为更少的唯一点，去重避免重复 testid
                    .filter(([x, y], k, arr) => arr.findIndex(([a, b]) => a === x && b === y) === k)
                    .map(([x, y]) => (
                      <button
                        key={`${x}-${y}`}
                        type="button"
                        style={{ marginLeft: 6 }}
                        onClick={() => setPinned(y * result.width + x)}
                        data-testid={`corner-${x}-${y}`}
                      >
                        ({x},{y})
                      </button>
                    ))}
                </div>
              </div>

              <div className="stage evidence" data-testid="evidence-panel">
                <Evidence result={result} index={currentIndex} onJump={(i) => setPinned(i)} />
              </div>
            </div>
          )}
        </section>
      </main>
    </>
  );
}

function ImageCanvas({
  result,
  mode,
  marker,
  onPick,
  onHover,
}: {
  result: DitherResult;
  mode: 'source' | 'output';
  marker: number;
  onPick?: (index: number) => void;
  onHover?: (index: number | null) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  // 只画纯像素数据；任何 UI 标记都放到覆盖层，绝不污染可读取的画布
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    canvas.width = result.width;
    canvas.height = result.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = new ImageData(
      mode === 'source' ? new Uint8ClampedArray(result.source) : new Uint8ClampedArray(result.output),
      result.width,
      result.height,
    );
    ctx.putImageData(img, 0, 0);
  }, [result, mode]);

  const eventToIndex = (e: React.MouseEvent<HTMLDivElement>): number => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.min(result.width - 1, Math.max(0, Math.floor(((e.clientX - rect.left) / rect.width) * result.width)));
    const y = Math.min(result.height - 1, Math.max(0, Math.floor(((e.clientY - rect.top) / rect.height) * result.height)));
    return y * result.width + x;
  };

  const mx = marker % result.width;
  const my = Math.floor(marker / result.width);

  return (
    <div
      style={{ position: 'relative', width: '100%', maxWidth: 520, margin: '0 auto' }}
      onClick={onPick ? (e) => onPick(eventToIndex(e)) : undefined}
      onMouseMove={onHover ? (e) => onHover(eventToIndex(e)) : undefined}
      onMouseLeave={onHover ? () => onHover(null) : undefined}
    >
      <canvas
        ref={ref}
        className={onPick ? 'clickable' : ''}
        data-testid={mode === 'source' ? 'source-canvas' : 'output-canvas'}
        style={{ width: '100%', height: 'auto', display: 'block' }}
      />
      <div
        aria-hidden
        style={{
          position: 'absolute',
          left: `${(mx / result.width) * 100}%`,
          top: `${(my / result.height) * 100}%`,
          width: `${100 / result.width}%`,
          height: `${100 / result.height}%`,
          outline: '2px solid #5ec8ff',
          outlineOffset: '-1px',
          pointerEvents: 'none',
        }}
      />
    </div>
  );
}

function PixelCounts({ result }: { result: DitherResult }) {
  const counts = useMemo(() => {
    const c = new Array<number>(result.palette.length).fill(0);
    let transparent = 0;
    for (let i = 0; i < result.width * result.height; i++) {
      const a = result.output[i * 4 + 3];
      if (a === 0) transparent++;
      else {
        // 输出像素必为色板之一；按相等匹配统计
        outer: for (let k = 0; k < result.palette.length; k++) {
          const pc = result.palette[k];
          if (
            result.output[i * 4] === pc.r &&
            result.output[i * 4 + 1] === pc.g &&
            result.output[i * 4 + 2] === pc.b
          ) {
            c[k]++;
            break outer;
          }
        }
      }
    }
    return { c, transparent };
  }, [result]);

  return (
    <div className="counts" data-testid="pixel-counts">
      {result.palette.map((p, i) => (
        <span key={i}>
          <span className="dot" style={{ background: `rgb(${p.r},${p.g},${p.b})` }} />
          #{i + 1} {hex(p)} ×{counts.c[i]}
        </span>
      ))}
      <span>
        <span className="dot" style={{ background: 'transparent' }} />
        透明 ×{counts.transparent}
      </span>
    </div>
  );
}

function Evidence({ result, index, onJump }: { result: DitherResult; index: number; onJump: (i: number) => void }) {
  const ev = useMemo(() => getPixelEvidence(result, index), [result, index]);
  const verdict = useMemo(
    () =>
      recomputeFromEvidence(ev, {
        palette: result.palette,
        width: result.width,
        height: result.height,
        source: result.source,
        alphaThreshold: result.alphaThreshold,
      }),
    [ev, result],
  );

  const minDist = ev.transparent ? -1 : Math.min(...ev.candidates.map((c) => c.dist2));
  const tieCount = ev.transparent ? 0 : ev.candidates.filter((c) => c.dist2 === minDist).length;
  const scanNo = result.scanOrder[index];

  return (
    <div>
      <h3 style={{ margin: '0 0 8px' }}>
        像素 ({ev.x}, {ev.y}) · #{ev.index} · 扫描第 {scanNo} 个 ·{' '}
        {ev.reversed ? '奇数行：右 → 左（镜像）' : '偶数行：左 → 右'}
      </h3>

      <div className="kv">
        <div>
          <span className="k">源 RGBA</span>
          ({ev.source.r}, {ev.source.g}, {ev.source.b}, {ev.source.a})
        </div>
        <div>
          <span className="k">透明阈值</span>
          {result.alphaThreshold}（alpha {ev.source.a} {ev.source.a < result.alphaThreshold ? '<' : '≥'} 阈值 →{' '}
          {ev.transparent ? '透明' : '不透明'}）
        </div>
      </div>

      {ev.transparent ? (
        <>
          <h4>透明像素</h4>
          <div className="kv">
            输出 (0,0,0,0)；不接收累计误差（账面 {ev.incoming16.r},{ev.incoming16.g},{ev.incoming16.b}/16
            {ev.incoming16.r === 0 && ev.incoming16.g === 0 && ev.incoming16.b === 0 ? '，确为 0' : ''}），也不传播。
          </div>
        </>
      ) : (
        <>
          <h4>① 累计误差与调整值</h4>
          <table data-testid="adjust-table">
            <thead>
              <tr>
                <th>通道</th>
                <th>源</th>
                <th>累计误差/16</th>
                <th>调整值（夹取后）</th>
                <th>四舍五入</th>
              </tr>
            </thead>
            <tbody>
              {(['R', 'G', 'B'] as const).map((k, ci) => {
                const src = [ev.source.r, ev.source.g, ev.source.b][ci];
                const inc = [ev.incoming16.r, ev.incoming16.g, ev.incoming16.b][ci];
                const adj = [ev.adjusted16.r, ev.adjusted16.g, ev.adjusted16.b][ci];
                const rounded = ev.rounded[ci];
                const rawAdj16 = src * 16 + inc;
                const clamped = rawAdj16 !== adj;
                return (
                  <tr key={k}>
                    <td>{k}</td>
                    <td>{src}</td>
                    <td>{frac16(inc)}</td>
                    <td>
                      {frac16(adj)}
                      {clamped && <span className="badge tie" style={{ marginLeft: 6 }}>已夹取</span>}
                    </td>
                    <td>{rounded}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <h4>② 平方距离选色（等距取色板靠前者）</h4>
          <table data-testid="distance-table">
            <thead>
              <tr>
                <th>#</th>
                <th>色值</th>
                <th>R</th>
                <th>G</th>
                <th>B</th>
                <th>ΔR²+ΔG²+ΔB²</th>
                <th>结果</th>
              </tr>
            </thead>
            <tbody>
              {ev.candidates.map((c) => (
                <tr key={c.index} className={c.chosen ? 'chosen' : ''}>
                  <td>
                    #{c.index + 1}
                    <span
                      className="dot"
                      style={{ background: `rgb(${c.r},${c.g},${c.b})`, marginLeft: 6 }}
                    />
                  </td>
                  <td>{hex(c)}</td>
                  <td>{c.r}</td>
                  <td>{c.g}</td>
                  <td>{c.b}</td>
                  <td>{c.dist2}</td>
                  <td>
                    {c.chosen && <span className="badge ok">选中</span>}
                    {c.chosen && tieCount > 1 && <span className="badge tie" style={{ marginLeft: 4 }}>等距·靠前者</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h4>③ 量化误差（取整后调整值 − 专色）</h4>
          <div className="kv">
            <span className="k">量化误差</span>
            ({ev.quantError.r}, {ev.quantError.g}, {ev.quantError.b})
            ＝ 取整 RGB ({ev.rounded[0]}, {ev.rounded[1]}, {ev.rounded[2]}) − 专色
            ({ev.candidates[ev.chosen].r}, {ev.candidates[ev.chosen].g}, {ev.candidates[ev.chosen].b})
          </div>

          <h4>④ Floyd–Steinberg 传播（蛇形镜像，逐贡献半数远离零取整）</h4>
          <table data-testid="spread-table">
            <thead>
              <tr>
                <th>方向</th>
                <th>权重</th>
                <th>目标 (x,y)#</th>
                <th>贡献 R/16</th>
                <th>贡献 G/16</th>
                <th>贡献 B/16</th>
                <th>去向</th>
              </tr>
            </thead>
            <tbody>
              {ev.spread.map((s, k) => (
                <tr key={k} className={s.kept ? '' : 'discarded'}>
                  <td>
                    {s.dir}（{s.dx >= 0 ? `+${s.dx}` : s.dx}, {s.dy >= 0 ? `+${s.dy}` : s.dy}）
                  </td>
                  <td>
                    {s.weightNum}/{s.weightDen}
                  </td>
                  <td>
                    {s.kept || s.targetIndex >= 0
                      ? (() => {
                          const tx = s.targetIndex % result.width;
                          const ty = Math.floor(s.targetIndex / result.width);
                          return (
                            <button type="button" onClick={() => onJump(s.targetIndex)}>
                              ({tx},{ty}) #{s.targetIndex}
                            </button>
                          );
                        })()
                      : '—'}
                  </td>
                  <td>{s.q16.r}</td>
                  <td>{s.q16.g}</td>
                  <td>{s.q16.b}</td>
                  <td>{s.kept ? '记账' : '丢弃'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="hint">
            {ev.spread.map((s, k) => (
              <div key={k}>
                {s.dir}：{s.reason}
              </div>
            ))}
          </div>
        </>
      )}

      <h4>⑤ 独立复算</h4>
      <div data-testid="recompute-verdict">
        {verdict.matches ? (
          <span className="badge ok">复算一致：调整值、距离、选色与传播去向全部可复核</span>
        ) : (
          <span className="badge err">复算不一致</span>
        )}
        {!verdict.matches && (
          <div className="error-text">
            {verdict.differences.map((d, k) => (
              <div key={k}>· {d}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
