import { resolve } from 'node:path';

import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: {},
  preload: {},
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
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        }
      }
    }
  }
});
