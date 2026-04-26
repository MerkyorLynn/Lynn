import { defineConfig } from "vite";
import { builtinModules } from "module";

const nodeBuiltins = builtinModules.flatMap((m) => [m, `node:${m}`]);

export default defineConfig({
  build: {
    lib: {
      entry: "server/index.js",
      formats: ["es"],
      fileName: () => "index.js",
    },
    outDir: "dist-server-bundle",
    rollupOptions: {
      external: [
        ...nodeBuiltins,
        "better-sqlite3",

        // ws: CJS package, Rollup's CJS→ESM interop loses WebSocketServer
        // named export. Keep external — available as PI SDK transitive dep.
        "ws",
        /^@mariozechner\//,
        "@silvia-odwyer/photon-node",
        "@larksuiteoapi/node-sdk",
        "node-telegram-bot-api",
        "exceljs",
        "mammoth",
        "pptxgenjs",
        "fsevents",

        // qrcode: 有 browser/node 双入口，Vite 会选 browser 版（期望 DOM canvas）。
        // 服务端需要 Node.js 版（纯 JS 渲染），必须走 npm 原生解析。
        "qrcode",

        // [v0.78] hono: server bundle 内联了一份，但 plugin 子模块(plugins/*/routes/*.js)是动态 import，
        // Node 从 plugin 文件位置向上搜 node_modules，server bundle 内联版本对 plugin 不可见。
        // 必须把 hono 列为 external 走 npm install，确保 .app/.../server/node_modules/hono 存在，
        // 否则 plugin 的 `import { Hono } from "hono"` 会 ERR_MODULE_NOT_FOUND，整个 plugin 加载失败。
        "hono",
      ],
      output: {
        // 所有源码模块全部合并到一个文件。
        // 这个项目 shared/core/lib/hub 之间交叉引用太多，
        // 任何 chunk 拆分都会导致循环依赖的 TDZ ReferenceError。
        inlineDynamicImports: true,
      },
    },
    target: "node22",
    minify: false,
    sourcemap: false,
  },
  logLevel: "info",
});
