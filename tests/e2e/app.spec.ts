import { expect, test } from '@playwright/test';
import { makePng } from '../fixtures/png';

/** 纯前端铁律：除本机预览服务外，不允许任何对外请求。 */
const externalRequests: string[] = [];

test.beforeEach(async ({ page }) => {
  externalRequests.length = 0;
  page.on('request', (req) => {
    const host = new URL(req.url()).hostname;
    if (host !== '127.0.0.1' && host !== 'localhost') externalRequests.push(req.url());
  });
  await page.goto('/');
});

test.afterEach(() => {
  expect(externalRequests, `检测到外部请求: ${externalRequests.join(', ')}`).toEqual([]);
});

async function reducePaletteToTwo(page: import('@playwright/test').Page, c1: string, c2: string) {
  await page.getByLabel('删除专色 4').click();
  await page.getByLabel('删除专色 3').click();
  await page.getByTestId('palette-input-0').fill(c1);
  await page.getByTestId('palette-input-1').fill(c2);
}

async function readOutput(page: import('@playwright/test').Page, w: number, h: number) {
  return page.evaluate(
    ([w, h]) => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="output-canvas"]')!;
      return Array.from(canvas.getContext('2d')!.getImageData(0, 0, w, h).data);
    },
    [w, h] as [number, number],
  );
}

test('合法 PNG：双画布渲染、像素计数、像素 0 证据复算一致', async ({ page }) => {
  const png = makePng(4, 3, (x, y) => [40 + x * 50, 80 + y * 40, (x + y) * 30, 255]);
  await page.setInputFiles('input[type=file]', { name: 'sample.png', mimeType: 'image/png', buffer: png });

  await expect(page.getByTestId('decode-ok')).toContainText('PNG 解码成功：4×3');
  await expect(page.getByTestId('source-canvas')).toBeVisible();
  await expect(page.getByTestId('output-canvas')).toBeVisible();
  await expect(page.getByTestId('recompute-verdict')).toContainText('复算一致');

  const counts = await page.getByTestId('pixel-counts').textContent();
  expect(counts).toContain('透明 ×0');
});

test('手算样例 1×2：上灰128→白、下黑受误差仍黑，正下逐份记账 −40/16 可复核', async ({ page }) => {
  await reducePaletteToTwo(page, '000000', 'FFFFFF');
  const png = makePng(1, 2, (_x, y) => (y === 0 ? [128, 128, 128, 255] : [0, 0, 0, 255]));
  await page.setInputFiles('input[type=file]', { name: 'g.png', mimeType: 'image/png', buffer: png });

  const data = await readOutput(page, 1, 2);
  expect(data.slice(0, 4)).toEqual([255, 255, 255, 255]);
  expect(data.slice(4, 8)).toEqual([0, 0, 0, 255]);

  // 用角点按钮选中下方像素，证据中应显示正下传播的 −40/16（|−127×5|/16 半数远离零）与夹取
  await page.getByTestId('corner-0-1').click();
  const panel = page.getByTestId('evidence-panel');
  await expect(panel).toContainText('像素 (0, 1)');
  await expect(panel).toContainText('-40');
  await expect(panel).toContainText('已夹取');
  await expect(page.getByTestId('recompute-verdict')).toContainText('复算一致');
});

test('回归：灰度图第二行左侧像素逐份取整后必须落黑（不能翻白）', async ({ page }) => {
  await reducePaletteToTwo(page, '000000', 'FFFFFF');
  // 2×1 列布局（宽 1 高 2 即上下两像素），灰 100：
  // 上像素取整 100 → 黑，误差 +100；正下 5/16 份 floor((500+8)/16)=31 记账；
  // 下像素调整 100+31/16=101.94 → 102，距黑 10404 < 距白 23409 → 必须黑。
  const png = makePng(1, 2, () => [100, 100, 100, 255]);
  await page.setInputFiles('input[type=file]', { name: 'gray100.png', mimeType: 'image/png', buffer: png });

  const data = await readOutput(page, 1, 2);
  expect(data.slice(0, 4)).toEqual([0, 0, 0, 255]);
  expect(data.slice(4, 8)).toEqual([0, 0, 0, 255]);

  await page.getByTestId('corner-0-1').click();
  const panel = page.getByTestId('evidence-panel');
  await expect(panel).toContainText('像素 (0, 1)');
  await expect(panel).toContainText('102');
  await expect(page.getByTestId('recompute-verdict')).toContainText('复算一致');
});

test('等距：像素 (0,0,1) 对黑与 (0,0,2) 等距，取色板靠前者', async ({ page }) => {
  await reducePaletteToTwo(page, '000000', '000002');
  const png = makePng(1, 1, () => [0, 0, 1, 255]);
  await page.setInputFiles('input[type=file]', { name: 'tie.png', mimeType: 'image/png', buffer: png });

  const data = await readOutput(page, 1, 1);
  expect(data.slice(0, 4)).toEqual([0, 0, 0, 255]); // 靠前者黑
  await expect(page.getByTestId('distance-table')).toContainText('等距·靠前者');
});

test('透明阈值：alpha<128 透明且不传播，投向透明邻点的误差在源头丢弃', async ({ page }) => {
  await reducePaletteToTwo(page, '000000', 'FFFFFF');
  await page.locator('#threshold').fill('128');
  // 2×2：(0,0) 与 (0,1) 透明；(1,0) 灰128，其 3/16 左下贡献投向透明的 (0,1) 被丢弃
  const png = makePng(2, 2, (x) => (x === 0 ? [200, 0, 0, 0] : [128, 128, 128, 255]));
  await page.setInputFiles('input[type=file]', { name: 'alpha.png', mimeType: 'image/png', buffer: png });

  const data = await readOutput(page, 2, 2);
  expect(data[3]).toBe(0); // (0,0) 透明
  expect(data[7]).toBe(255); // (1,0) 不透明
  expect(data.slice(4, 7)).toEqual([255, 255, 255]); // (1,0) 灰128 量化为白

  await page.getByTestId('corner-0-0').click();
  const panel = page.getByTestId('evidence-panel');
  await expect(panel).toContainText('透明像素');
  await expect(panel).toContainText('输出 (0,0,0,0)');

  await page.getByTestId('corner-1-0').click();
  await expect(panel).toContainText('邻点透明');
  await expect(panel).toContainText('误差丢弃');
  await expect(page.getByTestId('recompute-verdict')).toContainText('复算一致');
});

test('点击输出中部任意像素：坐标、扫描方向、距离表与传播表联动', async ({ page }) => {
  await reducePaletteToTwo(page, '000000', 'FFFFFF');
  const png = makePng(8, 5, (x, y) => [(x * 31 + y * 17) % 256, (x * 11 + y * 47) % 256, (x * 53 + y * 7) % 256, 255]);
  await page.setInputFiles('input[type=file]', { name: 'grid.png', mimeType: 'image/png', buffer: png });

  const canvas = page.getByTestId('output-canvas');
  const box = await canvas.boundingBox();
  // 点击奇数行 (3,3)：扫描方向应为右 → 左
  await page.mouse.click(box!.x + (box!.width * (3 + 0.5)) / 8, box!.y + (box!.height * (3 + 0.5)) / 5);
  const panel = page.getByTestId('evidence-panel');
  await expect(panel).toContainText('像素 (3, 3)');
  await expect(panel).toContainText('奇数行：右 → 左');
  await expect(page.getByTestId('distance-table')).toContainText('选中');
  await expect(page.getByTestId('spread-table')).toContainText('正下');
  await expect(page.getByTestId('spread-table')).toContainText('记账');
  await expect(page.getByTestId('recompute-verdict')).toContainText('复算一致');
});

test('四角快查按钮：每个角落都有唯一网点与完整证据', async ({ page }) => {
  const png = makePng(3, 2, () => [123, 200, 50, 255]);
  await page.setInputFiles('input[type=file]', { name: 'corners.png', mimeType: 'image/png', buffer: png });

  for (const [x, y] of [
    [0, 0],
    [2, 0],
    [0, 1],
    [2, 1],
  ] as const) {
    await page.getByTestId(`corner-${x}-${y}`).click();
    await expect(page.getByTestId('evidence-panel')).toContainText(`像素 (${x}, ${y})`);
    await expect(page.getByTestId('recompute-verdict')).toContainText('复算一致');
  }
});

test('非法色值：就地报错并清空结果；改回后自动恢复', async ({ page }) => {
  const png = makePng(2, 2, () => [128, 128, 128, 255]);
  await page.setInputFiles('input[type=file]', { name: 'p.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByTestId('output-canvas')).toBeVisible();

  await page.getByTestId('palette-input-1').fill('xyz');
  await expect(page.getByTestId('palette-error')).toContainText('第 2 个色值格式非法');
  await expect(page.getByTestId('output-cleared')).toBeVisible();
  expect(await page.getByTestId('output-canvas').count()).toBe(0);

  await page.getByTestId('palette-input-1').fill('FFFFFF');
  await expect(page.getByTestId('output-canvas')).toBeVisible();
});

test('重复色值与非法阈值：分别就地报错并清空结果', async ({ page }) => {
  const png = makePng(2, 2, () => [128, 128, 128, 255]);
  await page.setInputFiles('input[type=file]', { name: 'p.png', mimeType: 'image/png', buffer: png });

  await page.getByTestId('palette-input-2').fill('000000');
  await expect(page.getByTestId('palette-error')).toContainText('重复');
  await expect(page.getByTestId('output-cleared')).toBeVisible();
  await page.getByTestId('palette-input-2').fill('00FF88');

  await page.locator('#threshold').fill('256');
  await expect(page.getByTestId('threshold-error')).toContainText('0~255');
  await expect(page.getByTestId('output-cleared')).toBeVisible();
  await page.locator('#threshold').fill('128');
  await expect(page.getByTestId('output-canvas')).toBeVisible();
});

test('非 PNG 文件与损坏 PNG：就地报错且无输出', async ({ page }) => {
  await page.setInputFiles('input[type=file]', {
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('this is not a png'),
  });
  await expect(page.getByTestId('file-error')).toContainText('仅支持 PNG');
  expect(await page.getByTestId('source-canvas').count()).toBe(0);

  const good = makePng(2, 2, () => [10, 20, 30, 255]);
  const corrupted = Buffer.from(good);
  // 翻转 IHDR 之后某处的 IDAT 载荷字节，CRC 必须拦下
  corrupted[corrupted.length - 30] ^= 0xff;
  await page.setInputFiles('input[type=file]', { name: 'broken.png', mimeType: 'image/png', buffer: corrupted });
  await expect(page.getByTestId('file-error')).toContainText('PNG 解码失败');
  expect(await page.getByTestId('source-canvas').count()).toBe(0);
});

test('缺少 IEND 结束块的截断 PNG：就地报错并清空输出', async ({ page }) => {
  const good = makePng(3, 3, () => [50, 100, 150, 255]);
  // 先上传一张合法图，确认有结果
  await page.setInputFiles('input[type=file]', { name: 'ok.png', mimeType: 'image/png', buffer: good });
  await expect(page.getByTestId('output-canvas')).toBeVisible();

  // 末尾 IEND 块固定 12 字节，截掉后属于缺少结束块的损坏 PNG
  const truncated = good.subarray(0, good.length - 12);
  await page.setInputFiles('input[type=file]', { name: 'no-iend.png', mimeType: 'image/png', buffer: truncated });
  await expect(page.getByTestId('file-error')).toContainText('IEND');
  expect(await page.getByTestId('source-canvas').count()).toBe(0);
  expect(await page.getByTestId('output-canvas').count()).toBe(0);
});

test('色板增删按钮边界：2 个为下限、8 个为上限', async ({ page }) => {
  await page.getByTestId('add-color').click();
  await page.getByTestId('add-color').click();
  await page.getByTestId('add-color').click();
  await page.getByTestId('add-color').click();
  await expect(page.getByTestId('add-color')).toBeDisabled();
  expect(await page.locator('[data-testid^="palette-input-"]').count()).toBe(8);

  await page.getByLabel('删除专色 8').click();
  await expect(page.getByTestId('add-color')).toBeEnabled();
});
