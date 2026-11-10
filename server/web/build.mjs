// Bundles the device page (target: Chrome 108 WebView) and the Mac editor into public/assets.
import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');
import fs from 'node:fs';
const BUILD = String(Date.now());
fs.mkdirSync(path.join(root, '../public/assets'), { recursive: true });
fs.writeFileSync(path.join(root, '../public/assets/build.json'), JSON.stringify({ build: BUILD }));
const common = {
  external: ['/fonts/*'], bundle: true, minify: !watch, sourcemap: watch ? 'inline' : false, format: 'iife', jsx: 'automatic', jsxImportSource: 'preact',
  logLevel: 'info', legalComments: 'none', define: { 'process.env.NODE_ENV': '"production"', __BUILD__: JSON.stringify(BUILD) },
};
const builds = [
  { ...common, entryPoints: { device: path.join(root, 'src/device/main.tsx') }, outdir: path.join(root, '../public/assets'), target: ['chrome108'] },
  { ...common, entryPoints: { admin: path.join(root, 'src/admin/main.tsx') }, outdir: path.join(root, '../public/assets'), target: ['chrome120', 'safari16'] },
  { ...common, entryPoints: { capture: path.join(root, 'src/capture/main.tsx') }, outdir: path.join(root, '../public/assets'), target: ['chrome100', 'safari15'] },
  { ...common, entryPoints: { money: path.join(root, 'src/money/main.tsx') }, outdir: path.join(root, '../public/assets'), target: ['chrome100', 'safari15'] },
];
if (watch) {
  for (const b of builds) (await esbuild.context(b)).watch();
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
