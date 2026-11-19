// Node 20 does not expand test globs on Windows. Enumerate our own suites,
// excluding node_modules, optional Electron smoke and the separate kits.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const files = ['.', 'avatar-core', 'audio', 'desktop'].flatMap((dir) =>
  readdirSync(path.join(root, dir)).filter((name) => name.endsWith('.test.js')).sort().map((name) => path.join(dir, name)),
);
const run = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit' });
if (run.error) throw run.error;
process.exitCode = run.status ?? 1;
