import fs from 'fs';
import path from 'path';
import type { Plugin } from 'vite';

export function preserveLegacyCss(): Plugin {
  return {
    name: 'hana-preserve-legacy-css',
    enforce: 'pre',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        return html.replace(
          /<link\s+rel="stylesheet"\s+href="([^"]+)"([^>]*)>/g,
          (_match, href, rest) => `<!--HANA_CSS:${href}${rest}-->`
        );
      },
    },
  };
}

export function restoreLegacyCss(): Plugin {
  return {
    name: 'hana-restore-legacy-css',
    enforce: 'post',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        return html.replace(
          /<!--HANA_CSS:(.*?)-->/g,
          (_match, content) => {
            const parts = content.split(/\s+/);
            const href = parts[0];
            const rest = parts.slice(1).join(' ');
            return `<link rel="stylesheet" href="${href}"${rest ? ' ' + rest : ''}>`;
          }
        );
      },
    },
  };
}

export function copyLegacyFiles(rootDir: string): Plugin {
  return {
    name: 'hana-copy-legacy-files',
    closeBundle() {
      const srcDir = path.resolve(rootDir, 'desktop/src');
      const outDir = path.resolve(rootDir, 'desktop/dist-renderer');

      const dirs = ['lib', 'modules', 'themes', 'locales'];
      const files = ['styles.css'];
      const assets = [
        'Butter-1600.jpg',
        'Hanako-1600.jpg',
        'Kong.png',
        'Lynn-512-opt.png',
        'kong-banner.jpg',
      ];

      const copyEntry = (src: string, dest: string, recursive = false) => {
        if (!fs.existsSync(src)) return;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.cpSync(src, dest, recursive ? { recursive: true } : undefined);
      };

      for (const dir of dirs) {
        copyEntry(path.join(srcDir, dir), path.join(outDir, dir), true);
      }

      copyEntry(
        path.resolve(rootDir, 'desktop/public/workers'),
        path.join(outDir, 'workers'),
        true,
      );

      for (const file of files) {
        copyEntry(path.join(srcDir, file), path.join(outDir, file));
      }

      for (const asset of assets) {
        copyEntry(
          path.join(srcDir, 'assets', asset),
          path.join(outDir, 'assets', asset),
        );
      }
    },
  };
}
