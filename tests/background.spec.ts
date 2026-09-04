import { test, expect } from '@playwright/test';
import { launchApp, closeApp, type AppHandle } from './helpers';

let app: AppHandle;
/** --test 未隔离 userData，先快照再还原，避免污染真实配置 */
let originalBackground: string | null = null;

test.beforeAll(async () => {
  app = await launchApp();
  originalBackground = await app.window.evaluate(() => localStorage.getItem('typewren.background'));
});

test.afterAll(async () => {
  if (app) {
    await app.window.evaluate((saved) => {
      if (saved === null) {
        localStorage.removeItem('typewren.background');
      } else {
        localStorage.setItem('typewren.background', saved);
      }
    }, originalBackground);
  }
  await closeApp(app);
});

/** 400×400 方图：cover 下垂直方向有溢出（横向恰好贴合），便于验证单轴拖动 */
const DATA_URL =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#000"/></svg>'
  );

const openPanel = async (): Promise<void> => {
  const visible = (await app.window.locator('.bg-settings-panel.visible').count()) > 0;
  if (!visible) {
    await app.window.click('#status-bar button[title="背景图片设置"]');
  }
  await app.window.waitForSelector('.bg-settings-panel.visible');
};

const readBgPosition = (): Promise<string> =>
  app.window.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--bg-image-position').trim()
  );

const setBackground = async (position = '50% 100%'): Promise<void> => {
  await app.window.evaluate(
    ({ url, pos }) => {
      localStorage.setItem(
        'typewren.background',
        JSON.stringify({ imageUrl: url, opacity: 0.5, blur: 2.5, size: 'cover', position: pos })
      );
    },
    { url: DATA_URL, pos: position }
  );
  await app.window.reload();
  await app.window.waitForSelector('.ProseMirror', { timeout: 15000 });
  await app.window.waitForTimeout(500);
};

const readStoredPosition = (): Promise<string> =>
  app.window.evaluate(
    () =>
      (JSON.parse(localStorage.getItem('typewren.background') ?? '{}') as { position?: string })
        .position ?? ''
  );

/** 读取预览框/图的应用内布局与当前百分比（client/offset 为应用实际使用的整数尺寸） */
const readDragState = (): Promise<{
  pos: string;
  top: number;
  innerH: number;
  imgH: number;
}> =>
  app.window.evaluate(() => {
    const box = document.querySelector<HTMLElement>('.bg-settings-drag-box')!;
    const img = document.querySelector<HTMLImageElement>('.bg-settings-drag-img')!;
    return {
      pos: getComputedStyle(document.documentElement)
        .getPropertyValue('--bg-image-position')
        .trim(),
      top: parseFloat(getComputedStyle(img).top),
      innerH: box.clientHeight,
      imgH: img.offsetHeight
    };
  });

test.describe('背景图片-拖动选择显示区域', () => {
  test('旧关键字位置（center）迁移为默认百分比', async () => {
    await setBackground('center');
    await openPanel();
    await expect.poll(readBgPosition).toBe('50% 100%');
  });

  test('拖动预览图选择区域并同步编辑器与持久化', async () => {
    await setBackground();
    await openPanel();

    const img = app.window.locator('.bg-settings-drag-img');
    await expect(img).toBeVisible();
    const s0 = await readDragState();
    expect(s0.pos).toBe('50% 100%');
    expect(s0.imgH - s0.innerH).toBeGreaterThan(0); // cover 垂直溢出，可拖动

    // 预览框中心必然落在图片可见区域内（cover 铺满整框）
    const boxBox = await app.window.locator('.bg-settings-drag-box').boundingBox();
    expect(boxBox).toBeTruthy();
    const cx = boxBox!.x + boxBox!.width / 2;
    const cy = boxBox!.y + boxBox!.height / 2;

    const dy = 40; // 向下拖 40px
    await app.window.mouse.move(cx, cy);
    await app.window.mouse.down();
    await app.window.mouse.move(cx, cy + dy, { steps: 4 });
    await app.window.mouse.up();

    const s1 = await readDragState();
    // 像素偏移精确跟随拖动
    expect(Math.abs(s1.top - (s0.top + dy))).toBeLessThan(0.01);
    // y 从 100 减小（图片下移），x 保持 50（横向无溢出）
    const [x1, y1] = s1.pos.split(' ').map((v) => parseFloat(v));
    expect(x1).toBe(50);
    expect(y1).toBeLessThan(100);
    expect(y1).toBeGreaterThan(0);
    // 已持久化且与当前应用值一致
    expect(await readStoredPosition()).toBe(s1.pos);
  });

  test('滚轮缩放预览图并同步编辑器与持久化', async () => {
    await setBackground();
    await openPanel();
    await expect(app.window.locator('.bg-settings-drag-img')).toBeVisible();
    const boxBox = await app.window.locator('.bg-settings-drag-box').boundingBox();
    expect(boxBox).toBeTruthy();

    const readState = () =>
      app.window.evaluate(() => {
        const img = document.querySelector<HTMLImageElement>('.bg-settings-drag-img');
        return {
          imgH: img ? img.offsetHeight : 0,
          imgW: img ? img.offsetWidth : 0,
          bgSize: getComputedStyle(document.documentElement)
            .getPropertyValue('--bg-image-size')
            .trim(),
          pos: getComputedStyle(document.documentElement)
            .getPropertyValue('--bg-image-position')
            .trim()
        };
      });
    const readStoredZoom = (): Promise<number> =>
      app.window.evaluate(
        () =>
          (JSON.parse(localStorage.getItem('typewren.background') ?? '{}') as { zoom?: number })
            .zoom ?? 0
      );

    await app.window.mouse.move(boxBox!.x + boxBox!.width / 2, boxBox!.y + boxBox!.height / 2);
    const s0 = await readState();

    // 上滚放大 3 次
    for (let i = 0; i < 3; i++) await app.window.mouse.wheel(0, -120);
    await app.window.waitForTimeout(200);
    const s1 = await readState();
    expect(s1.imgH).toBeGreaterThan(s0.imgH);
    expect(s1.imgW).toBeGreaterThan(s0.imgW);
    expect(s1.bgSize).not.toBe('cover');
    expect(s1.bgSize).toMatch(/px$/);
    expect(await readStoredZoom()).toBeGreaterThan(1);
    expect(s1.pos).toBe('50% 100%'); // 缩放不改变位置百分比

    // 下滚 8 次回到最小 1 倍
    for (let i = 0; i < 8; i++) await app.window.mouse.wheel(0, 120);
    await app.window.waitForTimeout(200);
    const s2 = await readState();
    expect(await readStoredZoom()).toBe(1);
    expect(Math.abs(s2.imgH - s0.imgH)).toBeLessThan(1);
    await expect(app.window.locator('.bg-settings-zoom-value')).toHaveText('×1.0');
  });

  test('重载后拖动位置保留且预览图按百分比还原', async () => {
    await setBackground();
    await openPanel();
    const img = app.window.locator('.bg-settings-drag-img');
    await expect(img).toBeVisible();

    const boxBox = await app.window.locator('.bg-settings-drag-box').boundingBox();
    expect(boxBox).toBeTruthy();
    const cx = boxBox!.x + boxBox!.width / 2;
    const cy = boxBox!.y + boxBox!.height / 2;
    await app.window.mouse.move(cx, cy);
    await app.window.mouse.down();
    await app.window.mouse.move(cx, cy + 40, { steps: 4 });
    await app.window.mouse.up();

    const before = await readDragState();
    const [, y] = before.pos.split(' ').map((v) => parseFloat(v));

    await app.window.reload();
    await app.window.waitForSelector('.ProseMirror', { timeout: 15000 });
    await app.window.waitForTimeout(500);
    await openPanel();

    // 位置变量与持久化一致
    const after = await readDragState();
    expect(after.pos).toBe(before.pos);
    expect(await readStoredPosition()).toBe(before.pos);
    // 预览图按同一百分比反算像素偏移（±0.5px，layoutDragImage 用同样的 client/offset 值）
    const expectedTop = (after.innerH - after.imgH) * (y / 100);
    expect(Math.abs(after.top - expectedTop)).toBeLessThan(0.5);
  });

  test('重置为默认并清空预览', async () => {
    await setBackground();
    await openPanel();
    await app.window.click('.bg-settings-reset');

    expect(await readStoredPosition()).toBe('50% 100%');
    await expect(app.window.locator('.bg-settings-drag-hint')).toHaveText('请先选择背景图片');
    const hasBg = await app.window.evaluate(() =>
      document.getElementById('app')!.classList.contains('has-background')
    );
    expect(hasBg).toBe(false);
  });
});
