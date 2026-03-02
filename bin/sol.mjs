#!/usr/bin/env node
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const srcEntry = join(root, 'src', 'index.ts');

if (existsSync(srcEntry)) {
  // Dev mode: src/ exists → run TypeScript directly via tsx
  const { execFileSync } = await import('node:child_process');
  const tsx = join(root, 'node_modules', '.bin', 'tsx');
  if (!existsSync(tsx)) {
    console.error('Dev mode requires tsx. Run: npm install');
    process.exit(1);
  }
  try {
    execFileSync(tsx, [
      '--tsconfig', join(root, 'tsconfig.dev.json'),
      srcEntry,
      ...process.argv.slice(2)
    ], { stdio: 'inherit', cwd: root });
  } catch (e) {
    process.exitCode = e.status ?? 1;
  }
} else {
  // Production: src/ absent → load compiled dist/
  await import(pathToFileURL(join(root, 'dist', 'index.js')).href);
}
