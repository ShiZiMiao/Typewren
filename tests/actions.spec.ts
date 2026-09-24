import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  launchApp,
  closeApp,
  loadContent,
  readSource,
  sendCommand,
  setDialog,
  type AppHandle
} from './helpers';
import { pngBuffer } from './fixtures/png';

let app: AppHandle;

test.beforeAll(async () => {
  app = await launchApp();
});

test.afterAll(async () => {
  await closeApp(app);
});

test.describe('格式命令（cmd 通道直达 actions）', () => {
  /**
   * 全选编辑器内容：直接设置 DOM 选区（PM 经 selectionchange 同步 state.selection）。
   * 不用键盘 Ctrl+A——CI 无焦点窗口下键盘事件不可靠（偶发空选区导致 format:* 空操作）。
   */
  async function selectAll(): Promise<void> {
    await app.window.evaluate(() => {
      const pm = document.querySelector('.ProseMirror') as HTMLElement;
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(pm);
      sel?.removeAllRanges();
      sel?.addRange(range);
    });
    await app.window.waitForFunction(() => (window.getSelection()?.toString().length ?? 0) > 0);
  }

  test('加粗切换：全选→加粗→取消', async () => {
    await loadContent(app, '需要加粗的文字内容');
    await selectAll();
    await app.window.waitForTimeout(200);
    await sendCommand(app, 'format:bold');
    await expect(app.window.locator('.ProseMirror strong')).toHaveCount(1);

    await sendCommand(app, 'format:bold');
    await expect(app.window.locator('.ProseMirror strong')).toHaveCount(0);
  });

  test('斜体 / 删除线 / 行内代码切换', async () => {
    await loadContent(app, '待格式化内容');
    await selectAll();

    await sendCommand(app, 'format:italic');
    await expect(app.window.locator('.ProseMirror em')).toHaveCount(1);

    await sendCommand(app, 'format:strike');
    await expect(app.window.locator('.ProseMirror del')).toHaveCount(1);

    await sendCommand(app, 'format:inline-code');
    await expect(app.window.locator('.ProseMirror code')).toHaveCount(1);
  });

  test('Ctrl+` 触发行内代码（Electron 不认反引号加速器，渲染层 keydown 兜底）', async () => {
    await loadContent(app, '快捷键测试内容');
    await selectAll();
    await app.window.waitForTimeout(200);

    await app.window.keyboard.press('Control+`');
    await expect(app.window.locator('.ProseMirror code')).toHaveCount(1, { timeout: 5000 });

    // 再按一次取消（toggleMark 语义）
    await app.window.keyboard.press('Control+`');
    await expect(app.window.locator('.ProseMirror code')).toHaveCount(0, { timeout: 5000 });
  });

  test('标题层级设置与还原正文', async () => {
    await loadContent(app, '普通段落');
    await app.window.locator('.ProseMirror').click();

    for (const level of [1, 2, 3, 4, 5, 6]) {
      await sendCommand(app, 'heading', level);
      await expect(app.window.locator(`.ProseMirror h${level}`)).toHaveCount(1);
      await sendCommand(app, 'heading', 0);
      await expect(
        app.window.locator(
          '.ProseMirror h1, .ProseMirror h2, .ProseMirror h3, .ProseMirror h4, .ProseMirror h5, .ProseMirror h6'
        )
      ).toHaveCount(0);
    }
  });

  test('无序列表包裹', async () => {
    await loadContent(app, '列表项内容');
    await app.window.locator('.ProseMirror').click();

    await sendCommand(app, 'list:bullet');
    await expect(app.window.locator('.ProseMirror ul')).toHaveCount(1);
  });

  test('有序列表包裹', async () => {
    await loadContent(app, '列表项内容');
    await app.window.locator('.ProseMirror').click();

    await sendCommand(app, 'list:number');
    await expect(app.window.locator('.ProseMirror ol')).toHaveCount(1);
  });

  test('插入任务列表', async () => {
    await loadContent(app, '');
    await app.window.locator('.ProseMirror').click();
    await sendCommand(app, 'list:task');
    await expect(app.window.locator('.ProseMirror li[data-item-type="task"]')).toHaveCount(1, {
      timeout: 5000
    });
  });

  test('引用块包裹', async () => {
    await loadContent(app, '引用内容');
    await app.window.locator('.ProseMirror').click();
    await sendCommand(app, 'block:quote');
    await expect(app.window.locator('.ProseMirror blockquote')).toHaveCount(1);
    await expect(app.window.locator('.ProseMirror blockquote')).toContainText('引用内容');
  });

  test('已有引用块上再次包裹会嵌套一层', async () => {
    await loadContent(app, '引用内容');
    await app.window.locator('.ProseMirror').click();
    await sendCommand(app, 'block:quote');
    await sendCommand(app, 'block:quote');
    await expect(app.window.locator('.ProseMirror blockquote')).toHaveCount(2);
  });

  test('插入代码块（无语言）', async () => {
    await loadContent(app, '');
    await app.window.locator('.ProseMirror').click();
    await sendCommand(app, 'block:code');
    const pre = app.window.locator('.ProseMirror pre');
    await expect(pre).toHaveCount(1, { timeout: 5000 });
  });

  test('插入水平线', async () => {
    await loadContent(app, '');
    await app.window.locator('.ProseMirror').click();
    await sendCommand(app, 'insert:hr');
    await expect(app.window.locator('.ProseMirror hr')).toHaveCount(1, { timeout: 5000 });
  });

  test('插入链接（模态对话框）', async () => {
    await loadContent(app, '');
    await app.window.locator('.ProseMirror').click();
    await sendCommand(app, 'format:link');

    const dialog = app.window.locator('#prompt-dialog');
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await app.window.locator('#prompt-input').fill('https://example.com/doc');
    await app.window.locator('#prompt-ok').click();

    // 第二问：链接文字（容器复用同 id，按 aria-label 区分等待）
    const second = app.window.locator('#prompt-dialog[aria-label="链接文字"]');
    await expect(second).toBeVisible({ timeout: 5000 });
    await second.locator('#prompt-input').fill('示例文档');
    await second.locator('#prompt-ok').click();

    await expect(app.window.locator('.ProseMirror a[href="https://example.com/doc"]')).toHaveCount(
      1,
      { timeout: 5000 }
    );
  });

  test('插入链接：拒绝不安全协议', async () => {
    await loadContent(app, '');
    await app.window.locator('.ProseMirror').click();
    await sendCommand(app, 'format:link');

    const dialog = app.window.locator('#prompt-dialog');
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await app.window.locator('#prompt-input').fill('javascript:alert(1)');
    await app.window.locator('#prompt-ok').click();

    // 无效提示出现后关闭，回到链接地址输入；取消则不产生任何链接
    const error = app.window.locator('#prompt-dialog[aria-label="链接地址无效"]');
    await expect(error).toBeVisible({ timeout: 5000 });
    await error.locator('#prompt-ok').click();

    await expect(dialog).toBeVisible({ timeout: 5000 });
    await app.window.locator('#prompt-cancel').click();

    await expect(app.window.locator('.ProseMirror a')).toHaveCount(0);
  });

  test('选中文本加链接', async () => {
    await loadContent(app, '这里有个链接');
    await selectAll();
    await sendCommand(app, 'format:link');
    const dialog = app.window.locator('#prompt-dialog');
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await app.window.locator('#prompt-input').fill('https://example.com/link');
    await app.window.locator('#prompt-ok').click();
    await expect(app.window.locator('.ProseMirror a[href="https://example.com/link"]')).toHaveCount(
      1
    );
  });

  test('插入图片：原生文件选择框插入本地图片并真实加载', async () => {
    await loadContent(app, '');
    await app.window.locator('.ProseMirror').click();

    // 对话框桩返回预置 PNG（文档未保存 → 落盘 userData/images，Markdown 为绝对路径）
    const pngDir = join(tmpdir(), 'typewren-actions-img');
    mkdirSync(pngDir, { recursive: true });
    const png = join(pngDir, 'insert-me.png');
    writeFileSync(png, pngBuffer());
    await setDialog(app, { open: png });
    await sendCommand(app, 'format:image');

    const img = app.window.locator('.ProseMirror img[src^="typewren-img://local/"]');
    await expect(img).toHaveCount(1, { timeout: 8000 });
    // 未保存文档的绝对路径引用也经本地协议解析——真实加载成功才算通过
    await expect
      .poll(
        () =>
          img.evaluate((el) => {
            const image = el as HTMLImageElement;
            return image.complete && image.naturalWidth > 0;
          }),
        { timeout: 8000 }
      )
      .toBe(true);
  });

  test('源码模式插入图片：落进源码视图，退出源码后仍在（fix 回归）', async () => {
    await loadContent(app, '段落文字');
    await sendCommand(app, 'view:source');
    await app.window.waitForTimeout(200);

    const pngDir = join(tmpdir(), 'typewren-actions-img');
    mkdirSync(pngDir, { recursive: true });
    const png = join(pngDir, 'source-insert.png');
    writeFileSync(png, pngBuffer());
    await setDialog(app, { open: png });
    await sendCommand(app, 'format:image');

    // 插入必须落进源码视图（insertMarkdown 源码分支）——写渲染视图会被
    // 退出源码的 setMarkdown 写回整段覆盖丢失
    await expect.poll(() => readSource(app), { timeout: 8000 }).toContain('![](');

    // 退出源码（写回）后图片仍在文档里并真实加载
    await sendCommand(app, 'view:source');
    await app.window.waitForTimeout(400);
    const img = app.window.locator('.ProseMirror img[src^="typewren-img://local/"]');
    await expect(img).toHaveCount(1, { timeout: 8000 });
    await expect
      .poll(
        () =>
          img.evaluate((el) => {
            const image = el as HTMLImageElement;
            return image.complete && image.naturalWidth > 0;
          }),
        { timeout: 8000 }
      )
      .toBe(true);
  });

  test('撤销（history 插件）', async () => {
    await loadContent(app, '撤销测试文本');
    await selectAll();
    await sendCommand(app, 'format:bold');
    await expect(app.window.locator('.ProseMirror strong')).toHaveCount(1);

    await app.window.locator('.ProseMirror').click();
    await app.window.keyboard.press('Control+z');
    await app.window.waitForTimeout(200);
    await expect(app.window.locator('.ProseMirror strong')).toHaveCount(0);
  });

  test('重做（Ctrl+Shift+Z）', async () => {
    await loadContent(app, '初始文本');
    await app.window.locator('.ProseMirror').click();
    await app.window.keyboard.type(' 追加内容');
    await app.window.waitForTimeout(300);
    await expect(app.window.locator('.ProseMirror')).toContainText('追加内容');

    await app.window.locator('.ProseMirror').click();
    await app.window.waitForTimeout(200);
    await app.window.keyboard.press('Control+z');
    await app.window.waitForTimeout(300);
    await expect(app.window.locator('.ProseMirror')).not.toContainText('追加内容');

    await app.window.locator('.ProseMirror').click();
    await app.window.waitForTimeout(200);
    await app.window.keyboard.press('Control+Shift+z');
    await app.window.waitForTimeout(800);
    await expect(app.window.locator('.ProseMirror')).toContainText('追加内容', {
      timeout: 8000
    });
  });
});
