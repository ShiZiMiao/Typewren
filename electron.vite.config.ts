import { resolve } from 'node:path';

import { defineConfig } from 'electron-vite';

// 覆盖率采集构建（TW_COV=1）：sourcemap 把 V8 覆盖映射回 src/**/*.ts；
// 正式构建不开（避免 sourcemap 进安装包）
const sourcemap = !!process.env.TW_COV;

export default defineConfig({
  main: {
    build: { sourcemap }
  },
  preload: {
    build: { sourcemap }
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src')
      }
    },
    plugins: [
      {
        // CSP 收紧：dev HMR 需要 connect-src 的 localhost/ws 条目，生产构建剔除
        name: 'csp-dev-connect-extra',
        transformIndexHtml(html, ctx) {
          const extra = ctx.server ? ' ws://localhost:* http://localhost:*' : '';
          return html.replace('__CSP_CONNECT_EXTRA__', extra);
        }
      }
    ],
    build: {
      sourcemap,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        }
      }
    }
  }
});
