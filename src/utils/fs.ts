import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getSolDir } from '../core/config-manager.js';

const WALLETS_DIR = join(getSolDir(), 'wallets');

export function getWalletsDir(): string {
  return WALLETS_DIR;
}

export function ensureWalletsDir(): void {
  if (!existsSync(WALLETS_DIR)) {
    mkdirSync(WALLETS_DIR, { recursive: true });
  }
}

export function writeKeyFile(name: string, keypairBytes: Uint8Array): string {
  ensureWalletsDir();
  const filePath = join(WALLETS_DIR, `${name}.json`);
  const jsonArray = JSON.stringify(Array.from(keypairBytes));
  writeFileSync(filePath, jsonArray, { mode: 0o600 });
  return filePath;
}

export function readKeyFile(filePath: string): Uint8Array {
  const raw = readFileSync(filePath, 'utf-8');
  const arr: number[] = JSON.parse(raw);
  return new Uint8Array(arr);
}

export function softDeleteKeyFile(filePath: string): void {
  if (existsSync(filePath)) {
    renameSync(filePath, filePath + '.deleted');
  }
}

export function keyFileExists(name: string): boolean {
  return existsSync(join(WALLETS_DIR, `${name}.json`));
}

export function listKeyFiles(): string[] {
  ensureWalletsDir();
  return readdirSync(WALLETS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''));
}
