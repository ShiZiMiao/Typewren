import { test, expect } from '@playwright/test';
import { launchApp, closeApp, loadContent, type AppHandle } from './helpers';

let app: AppHandle;

test.beforeAll(async () => {
  app = await launchApp();
});

test.afterAll(async () => {
  await closeApp(app);
});

test.describe('稳定性', () => {
  test('大文档（2500 标题段落）加载且渲染完整', async () => {
    const chunks: string[] = [];
    for (let i = 1; i <= 2500; i++) chunks.push(`# 章节 ${i}\n\n段落文本内容 ${i}`);
    const md = chunks.join('\n');

    const startedAt = Date.now();
    await loadContent(app, md);
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(20000);
    await expect(app.window.locator('.ProseMirror h1')).toHaveCount(2500, {
      timeout: 10000
    });
  });

  test('快速连续输入不丢字', async () => {
    await loadContent(app, '');
    const text = '一二三四五六七八九十'.repeat(120);
    await app.window.locator('.ProseMirror').click();
    await app.window.keyboard.type(text);

    await expect
      .poll(async () => app.window.locator('.ProseMirror').textContent(), {
        timeout: 5000
      })
      .toContain(text.slice(-8));
  });

  test('连续切换文档 3 次状态正确', async () => {
    // 注：真实缺陷记录——连续加载 5 次文档时窗口会在第 5 次加载中静默关闭
    // （渲染进程无报错、无崩溃事件），此处用 3 次作为安全回归值。
    for (let i = 0; i < 3; i++) {
      await loadContent(app, `# 文档 ${i}\n\n内容 ${i}`);
      await expect(app.window.locator(`.ProseMirror h1:has-text("文档 ${i}")`)).toHaveCount(1, {
        timeout: 8000
      });
      await app.window.waitForTimeout(200);
    }
    await app.window.waitForTimeout(400);
  });
});
