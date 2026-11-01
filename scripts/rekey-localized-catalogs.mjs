import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Deterministically re-key the localized catalogues to the new source ids.
// The English catalogue is authoritative: match each localized product by sku,
// then slug, then title, and copy the new productId/sourceId. No AI is
// involved, so this costs no tokens and finishes in seconds.
const root = process.cwd();
const en = JSON.parse(await readFile(resolve(root, 'src/data/site-catalog.json'), 'utf8'));

const bySku = new Map();
const bySlug = new Map();
const byTitle = new Map();
for (const product of en.products || []) {
  const id = String(product.productId);
  if (product.sku) bySku.set(String(product.sku), id);
  if (product.slug) bySlug.set(String(product.slug), id);
  if (product.title) byTitle.set(String(product.title).trim().toLowerCase(), id);
}

const localeDirs = (await readdir(resolve(root, 'src/data/i18n'), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

let totalRekeyed = 0;
let totalDropped = 0;

for (const locale of localeDirs) {
  const file = resolve(root, `src/data/i18n/${locale}/site-catalog.json`);
  let catalog;
  try {
    catalog = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    continue;
  }

  const next = [];
  const seen = new Set();
  let changed = 0;
  let dropped = 0;

  for (const product of catalog.products || []) {
    const newId =
      (product.sku ? bySku.get(String(product.sku)) : undefined) ||
      (product.slug ? bySlug.get(String(product.slug)) : undefined) ||
      (product.title ? byTitle.get(String(product.title).trim().toLowerCase()) : undefined) ||
      null;

    if (!newId) {
      dropped += 1;
      continue;
    }
    if (seen.has(String(newId))) {
      dropped += 1;
      continue;
    }
    seen.add(String(newId));

    if (String(product.productId) !== String(newId) || String(product.sourceId) !== String(newId)) changed += 1;
    next.push({ ...product, productId: newId, sourceId: newId });
  }

  await writeFile(file, `${JSON.stringify({ ...catalog, products: next }, null, 2)}\n`, 'utf8');
  totalRekeyed += changed;
  totalDropped += dropped;
  console.log(`${locale}: kept ${next.length}, re-keyed ${changed}, dropped ${dropped}`);
}

console.log(`Re-key complete: ${totalRekeyed} products updated, ${totalDropped} unmatched/duplicate dropped.`);
