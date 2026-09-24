/* ============================================================
 * 文件树面板内容：列出当前文档同目录的 Markdown 文件与子目录。
 * - 点击文档 → 经 onOpen 在当前窗口打开（脏流程由 FileService 保护）；
 * - 点击目录 → 进入（主进程校验必须位于文档目录子树内，防越权）；
 * - 提供「↑ 返回上级」、「↻ 刷新」。
 * 外层容器（tab 头 / 收起按钮）由侧边栏统一管理，这里只管内容清单。
 * ============================================================ */

const MAX_DEPTH = 32;

export interface FileTreePanelDeps {
  root: HTMLElement;
  /** 当前文档路径（null=未命名文档不显示文件树内容） */
  getDocPath(): string | null;
  /** 点击文档文件（文件树内打开） */
  onOpen(path: string): void;
}

export interface FileTreePanel {
  refresh(): void;
}

export function createFileTreePanel(deps: FileTreePanelDeps): FileTreePanel {
  const { root, getDocPath, onOpen } = deps;

  const treeEl = root.querySelector<HTMLElement>('#filetree-items') ?? root;

  /** 当前显示的目录（相对文档根目录的路径片段栈） */
  let dirStack: string[] = [];
  /** render 请求序号：过期 listDir 响应不得覆盖新目录的清单（并发防护） */
  let renderSeq = 0;

  /** 文档所在目录的绝对路径（正斜杠归一；名副其实——是绝对目录不是相对片段） */
  const currentDirAbs = (): string | null => {
    const docPath = getDocPath();
    if (!docPath) return null;
    const normalized = docPath.replace(/\\/g, '/');
    return normalized.slice(0, normalized.lastIndexOf('/'));
  };

  const targetDirPath = (): string | null => {
    const base = currentDirAbs();
    if (base === null) return null;
    // 直接字符串拼接：盘符（C:/x）、POSIX 根（/home/x）、UNC（//server/share）
    // 三种形态的 base 都已是合法绝对目录——旧实现按 '/' 切段后只认
    // `^[A-Za-z]:$` 盘符段，POSIX/UNC 路径一律返回 null 且文案误导成
    // "保存文档后显示同目录文件"。目录校验（文档目录子树内）仍在主进程。
    return dirStack.length > 0 ? `${base}/${dirStack.join('/')}` : base;
  };

  const render = async (): Promise<void> => {
    const seq = ++renderSeq;
    treeEl.textContent = '';
    const docPath = getDocPath();
    const dirPath = targetDirPath();

    // 文档根目录（面包屑/返回用的基准）
    const base = currentDirAbs() ?? '';

    if (!docPath || !dirPath) {
      const empty = document.createElement('div');
      empty.className = 'filetree-empty';
      empty.textContent = '保存文档后显示同目录文件';
      treeEl.appendChild(empty);
      return;
    }

    const entries = await window.typewren.listDir({ docPath, dirPath }).catch(() => []);
    // 过期响应（期间用户已进入其它目录/换了文档）直接丢弃，
    // 否则慢的旧 listDir 回来会把新目录的清单整个覆盖掉
    if (seq !== renderSeq) return;

    if (dirStack.length > 0) {
      const up = document.createElement('button');
      up.type = 'button';
      up.className = 'filetree-nav';
      up.textContent = '↑ 返回上级';
      up.addEventListener('click', () => {
        dirStack.pop();
        void render();
      });
      treeEl.appendChild(up);
    }
    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'filetree-nav';
    refreshBtn.textContent = '↻ 刷新';
    refreshBtn.addEventListener('click', () => void render());
    treeEl.appendChild(refreshBtn);

    // 面包屑：文档目录名 / 子路径
    const crumb = document.createElement('div');
    crumb.className = 'filetree-crumb';
    crumb.textContent =
      (base.split('/').filter(Boolean).pop() ?? '') + dirStack.map((d) => ` / ${d}`).join('');
    treeEl.appendChild(crumb);

    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'filetree-empty';
      empty.textContent = '此处暂无 Markdown 文件';
      treeEl.appendChild(empty);
      return;
    }

    const currentName = docPath.replace(/\\/g, '/').split('/').pop();

    for (const entry of entries) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'filetree-item';
      btn.title = entry.isMarkdown ? entry.fullPath : entry.name;
      btn.textContent = entry.isDir ? `📁 ${entry.name}` : entry.name;
      if (!entry.isDir && entry.name === currentName && dirStack.length === 0) {
        btn.classList.add('current');
      }
      btn.addEventListener('click', () => {
        if (entry.isDir) {
          if (dirStack.length < MAX_DEPTH) {
            dirStack.push(entry.name);
            void render();
          }
        } else {
          // 子目录中的文档：打开后文件树回到其所在目录
          const openedInto = entry.fullPath.replace(/\\/g, '/');
          const openedDir = openedInto.slice(0, openedInto.lastIndexOf('/'));
          dirStack =
            openedDir.startsWith(base) && openedDir !== base
              ? openedDir.slice(base.length + 1).split('/')
              : [];
          onOpen(entry.fullPath);
        }
      });
      treeEl.appendChild(btn);
    }
  };

  return {
    refresh: (): void => void render()
  };
}
