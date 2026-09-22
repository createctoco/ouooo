import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const minProducts = Number(process.env.OUOOO_D1_MIN_PRODUCTS || 4000);
const restoreAgeSeconds = Math.max(300, Number(process.env.OUOOO_D1_RESTORE_AGE_SECONDS || 3600));

function run(args) {
  const call =
    process.platform !== 'win32' || !npx.endsWith('.cmd')
      ? { command: npx, args }
      : { command: process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/s', '/c', npx, ...args] };
  return spawnSync(call.command, call.args, { cwd: root, encoding: 'utf8', env: process.env, shell: false });
}

function queryCount(sql) {
  const r = run(['wrangler', 'd1', 'execute', 'ouooo-catalog', '--remote', '--json', '--command', sql]);
  if (r.status !== 0) throw new Error(`D1 query failed: ${r.stderr || r.stdout || r.error}`);
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const start = out.indexOf('[');
  const end = out.lastIndexOf(']');
  if (start < 0 || end < 0) throw new Error(`Unexpected wrangler output: ${out.slice(0, 200)}`);
  return Number(JSON.parse(out.slice(start, end + 1))?.[0]?.results?.[0]?.total || 0);
}

function healthy() {
  const products = queryCount('SELECT COUNT(*) AS total FROM products;');
  const uncategorized = queryCount("SELECT COUNT(*) AS c FROM product_categories WHERE category_slug='uncategorized';");
  const ok = products >= minProducts && uncategorized === 0;
  process.stdout.write(
    `D1 health: products=${products} (min ${minProducts}), uncategorized=${uncategorized} (expected 0)\n`
  );
  return ok;
}

// Two independent checks before restoring, to avoid acting on a transient blip.
// `true` = queried successfully and the data looks healthy, `false` = queried
// successfully but the data is wrong, `null` = the query itself failed.
const check = (label) => {
  try {
    return healthy() ? true : false;
  } catch (error) {
    process.stderr.write(`${label} health check error: ${error instanceof Error ? error.message : String(error)}\n`);
    return null;
  }
};

const first = check('First');
const second = check('Second');

if (first === true && second === true) {
  process.stdout.write('D1 is healthy; no action needed.\n');
  process.exit(0);
}

if (first === null || second === null) {
  // We could not read the database at all (API/quota/network error). That is no
  // evidence of corruption, and a Time Travel restore REWINDS the database, so
  // it can destroy good data. On 2026-09-21 a free-tier row read limit error
  // (code 7500) was misread as corruption and triggered four destructive
  // restores. Never restore when the health signal is unreadable.
  process.stderr.write('D1 health could not be determined (query failed); skipping auto-restore.\n');
  process.exit(1);
}

// D1 is unhealthy: auto-restore to a recent known-good point (Time Travel),
// then re-verify. Non-destructive (same database id), so the running Workers
// keep their binding and the site recovers without a redeploy.
const timestamp = new Date(Date.now() - restoreAgeSeconds * 1000).toISOString();
process.stdout.write(`D1 unhealthy; restoring to ${timestamp} (${restoreAgeSeconds}s ago)\n`);
const info = run(['wrangler', 'd1', 'time-travel', 'info', 'ouooo-catalog', '--timestamp', timestamp, '--json']);
if (info.status !== 0) {
  process.stderr.write(`Time Travel info failed: ${info.stderr || info.stdout || info.error}\n`);
  process.exit(1);
}
const infoOut = `${info.stdout || ''}${info.stderr || ''}`;
const bmStart = infoOut.indexOf('{');
const bookmark = bmStart >= 0 ? JSON.parse(infoOut.slice(bmStart)).bookmark : '';
if (!bookmark) {
  process.stderr.write(`No Time Travel bookmark for ${timestamp}; manual recovery required (see runbook).\n`);
  process.exit(1);
}
const restore = run(['wrangler', 'd1', 'time-travel', 'restore', 'ouooo-catalog', '--bookmark', bookmark]);
if (restore.status !== 0) {
  process.stderr.write(`Time Travel restore failed: ${restore.stderr || restore.stdout || restore.error}\n`);
  process.stderr.write('Deep recovery required: recreate D1 from the latest backup (see runbook).\n');
  process.exit(1);
}

try {
  if (healthy()) {
    process.stdout.write('D1 restored and healthy.\n');
    process.exit(0);
  }
} catch (error) {
  process.stderr.write(`Post-restore health check error: ${error instanceof Error ? error.message : String(error)}\n`);
}
process.stderr.write('D1 still unhealthy after restore; deep recovery required (see runbook).\n');
process.exit(1);
