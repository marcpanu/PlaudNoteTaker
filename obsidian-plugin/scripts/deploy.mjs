// Copy built main.js + manifest.json into the user's Obsidian vault plugin dir.
// Does NOT touch data.json — plugin settings survive rebuilds.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SOURCE_DIR = new URL('..', import.meta.url).pathname;
const VAULT_PLUGIN_DIR = join(
  homedir(),
  'obsidian-vault/.obsidian/plugins/ai-notetaker',
);

if (!existsSync(VAULT_PLUGIN_DIR)) {
  mkdirSync(VAULT_PLUGIN_DIR, { recursive: true });
}

for (const file of ['main.js', 'manifest.json']) {
  const src = join(SOURCE_DIR, file);
  const dst = join(VAULT_PLUGIN_DIR, file);
  if (!existsSync(src)) {
    console.error(`[deploy] missing source: ${src}`);
    process.exit(1);
  }
  copyFileSync(src, dst);
  console.log(`[deploy] ${file} → ${dst}`);
}
console.log('[deploy] done — reload the plugin in Obsidian to pick up changes.');
