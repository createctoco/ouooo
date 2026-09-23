import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const bookmarkFile = resolve(root, '.d1/restore-bookmark.txt');
const minProducts = Number(process.env.OUOOO_D1_MIN_PRODUCTS || 500);
const minLocales = Number(process.env.OUOOO_D1_MIN_LOCALES || 14);

function run(args) {
  const call =
    process.platform !== 'win32' || !npx.endsWith('.cmd')
      ? { command: npx, args }
      : { command: process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/s', '/c', npx, ...args] };
  return spawnSync(call.command, call.args, { cwd: root, encoding: 'utf8', env: process.env, shell: false });
}

function query(sql) {
  const result = run(['wrangler', 'd1', 'execute', 'ouooo-catalog', '--remote', '--json', '--command', sql]);
  if (result.status !== 0) throw new Error(`D1 query failed: ${result.stderr || result.stdout || result.error}`);
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const start = output.indexOf('[');
  const end = output.lastIndexOf(']');
  if (start < 0 || end < 0) throw new Error(`Unexpected wrangler output: ${output.slice(0, 200)}`);
  const parsed = JSON.parse(output.slice(start, end + 1));
  return parsed?.[0]?.results || [];
}

function restoreBookmark() {
  let bookmark = '';
  try {
    bookmark = readFileSync(bookmarkFile, 'utf8').trim();
  } catch {
    // No bookmark captured (e.g. recovery deploy with skip_d1_import): fail loudly.
  }
  if (!bookmark) return false;
  const result = run(['wrangler', 'd1', 'time-travel', 'restore', 'ouooo-catalog', '--bookmark', bookmark]);
  if (result.status !== 0) {
    process.stderr.write(`D1 restore failed: ${result.stderr || result.stdout || result.error}\n`);
  }
  return result.status === 0;
}

let failed = false;
try {
  // Indexed checks only: the previous full-table COUNT(*) pairs read ~17,800
  // rows per deploy. Counting the English source catalogue uses the covering
  // index on (locale, ...) and costs ~700 rows; the uncategorized lookup is
  // served entirely from the (locale, category_slug) index.
  const products = Number(query("SELECT COUNT(*) AS total FROM products WHERE locale='en';")[0]?.total || 0);
  const uncategorized = Number(
    query("SELECT COUNT(*) AS c FROM product_categories WHERE locale='en' AND category_slug='uncategorized';")[0]?.c ||
      0
  );
  const locales = (() => {
    try {
      return Number(query('SELECT COUNT(DISTINCT locale) AS locales FROM catalog_index;')[0]?.locales || 0);
    } catch {
      return null;
    }
  })();
  process.stdout.write(
    `D1 health: en products=${products} (min ${minProducts}), en uncategorized=${uncategorized} (expected 0), indexed locales=${locales ?? 'n/a'} (min ${minLocales})\n`
  );
  if (products < minProducts) {
    process.stderr.write(`D1 health check failed: English products=${products} below minimum ${minProducts}.\n`);
    failed = true;
  }
  if (uncategorized !== 0) {
    process.stderr.write(`D1 health check failed: English uncategorized=${uncategorized} (expected 0).\n`);
    failed = true;
  }
  if (locales !== null && locales < minLocales) {
    process.stderr.write(
      `D1 health check failed: only ${locales} locales present in catalog_index (min ${minLocales}).\n`
    );
    failed = true;
  }
} catch (error) {
  process.stderr.write(`D1 health check error: ${error instanceof Error ? error.message : String(error)}\n`);
  failed = true;
}

if (failed) {
  if (restoreBookmark()) {
    process.stderr.write('D1 restored to the pre-import bookmark. Failing the deploy so it can be retried safely.\n');
  } else {
    process.stderr.write('No D1 restore point available; failing the deploy. Restore D1 manually before retrying.\n');
  }
  process.exit(1);
}
process.stdout.write('D1 catalog is healthy.\n');
