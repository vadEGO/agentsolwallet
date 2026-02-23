#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = join(__dirname, '..', 'src', 'index.ts');

// Use tsx via --import flag (Node.js >=20.6)
try {
  execFileSync(process.execPath, [
    '--import', 'tsx',
    entry,
    ...process.argv.slice(2),
  ], { stdio: 'inherit' });
} catch (e) {
  process.exitCode = e.status || 1;
}
