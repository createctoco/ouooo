import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import localeData from '../src/i18n/locales.json' with { type: 'json' };

// Automatic rollback, run only when the post-deploy smoke test fails. It puts
// the database back to the bookmark captured before the imports and rolls every
// Worker back to its previous version, so production returns to the state that
// was serving before this deploy.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const failures = [];

function run(command, args) {
  const call =
    process.platform !== 'win32' || !command.endsWith('.cmd')
      ? { command, args }
      : {
          command: process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
          args: ['/d', '/s', '/c', command, ...args],
        };
  return spawnSync(call.command, call.args, {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
    shell: false,
    stdio: 'inherit',
  });
}

// 1) Restore D1 to the pre-import bookmark captured at the start of the deploy.
let bookmark = '';
try {
  bookmark = readFileSync(resolve(root, '.d1/restore-bookmark.txt'), 'utf8').trim();
} catch {
  // no bookmark captured
}
if (!bookmark) {
  failures.push('no D1 restore bookmark was captured; database left untouched');
} else {
  const result = run(npx, ['wrangler', 'd1', 'time-travel', 'restore', 'ouooo-catalog', '--bookmark', bookmark]);
  if (result.status !== 0) failures.push('D1 time-travel restore failed');
  else process.stdout.write(`D1 restored to pre-deploy bookmark ${bookmark}\n`);
}

// 2) Roll back every locale Worker to its previous deployment.
for (const locale of Object.keys(localeData.locales)) {
  const worker = locale === localeData.defaultLocale ? 'ouooo-catalog' : `ouooo-${locale}`;
  const result = run(npx, [
    'wrangler',
    'rollback',
    '--name',
    worker,
    '--message',
    'Automatic rollback after failed post-deploy smoke test',
    '--yes',
  ]);
  if (result.status !== 0) failures.push(`rollback failed for ${worker}`);
  else process.stdout.write(`Rolled back ${worker}\n`);
}

// 3) Purge the edge cache so the restored site is served immediately.
run('node', ['scripts/purge-cloudflare-cache.mjs']);

if (failures.length) {
  console.error('Automatic rollback finished with problems:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('Automatic rollback completed: D1 restored and all locale Workers rolled back.');
