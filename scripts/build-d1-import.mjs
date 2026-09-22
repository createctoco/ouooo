import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const locale = String(process.env.OUOOO_LOCALE || 'en')
  .trim()
  .toLowerCase();
const inputFile = resolve(
  process.env.OUOOO_D1_CATALOG_INPUT ||
    (locale === 'en' ? 'src/data/site-catalog.json' : `src/data/i18n/${locale}/site-catalog.json`)
);
const outputFile = resolve(process.env.OUOOO_D1_IMPORT_OUTPUT || `.d1/import-${locale}.sql`);
const quote = (value) => `'${String(value ?? '').replaceAll("'", "''")}'`;

const catalog = JSON.parse(await readFile(inputFile, 'utf8'));
if (!Array.isArray(catalog.products)) throw new Error(`Invalid catalog: ${inputFile}`);

// Always import the full catalog (minus translation-skipped products) so D1
// can never drift from the committed catalog: every product and its category
// rows are upserted on every deploy. Deploy race conditions or partial batches
// therefore cannot leave products/categories missing.
const skippedIds = new Set((catalog.translationSummary?.skippedProductIds || []).map(String));
const products = catalog.products.filter((product) => !skippedIds.has(String(product.productId)));
const productsById = new Map();
const productIdsBySlug = new Map();
let duplicateProductIds = 0;
for (const product of products) {
  const productId = String(product.productId || '').trim();
  const sourceId = String(product.sourceId || productId).trim();
  const slug = String(product.slug || '').trim();
  if (!productId) throw new Error(`Catalog product is missing productId: ${inputFile}`);
  if (sourceId !== productId) {
    throw new Error(`Catalog identity mismatch: productId ${productId} does not match sourceId ${sourceId}.`);
  }
  if (!slug) throw new Error(`Catalog product ${productId} is missing a slug.`);
  if (productsById.has(productId)) duplicateProductIds += 1;
  productsById.set(productId, product);
  const slugOwner = productIdsBySlug.get(slug);
  if (slugOwner && slugOwner !== productId) {
    throw new Error(`Catalog slug collision for ${locale}: ${slug} belongs to both ${slugOwner} and ${productId}.`);
  }
  productIdsBySlug.set(slug, productId);
}
const uniqueProducts = [...productsById.values()];
const batchSize = Math.max(1, Math.min(100, Number(process.env.OUOOO_D1_BATCH_SIZE || 25)));
const header = ['PRAGMA foreign_keys = ON;'];

// Precompute everything the listing pages need into a single row per locale, so
// those pages read 1-2 rows instead of scanning every product row for the
// locale. D1 bills per row read, and scanning ~640 rows per page render is what
// let crawler traffic blow the free daily row read limit (2026-09-21).
const updatedAtOf = (product) => String(product.localization?.translations?.en?.updatedAt || catalog.generatedAt || '');
const contentOf = (product) => JSON.stringify(product);

const ordered = [...uniqueProducts].sort((a, b) => {
  const left = updatedAtOf(a);
  const right = updatedAtOf(b);
  if (left !== right) return left < right ? 1 : -1;
  return String(a.productId) < String(b.productId) ? 1 : -1;
});

const orderRows = ordered.map((product) => ({
  id: String(product.productId),
  slug: String(product.slug),
  updatedAt: updatedAtOf(product),
}));
const briefRows = ordered.map((product) => ({
  slug: String(product.slug),
  title: String(product.title || ''),
  summary: String(product.summary || ''),
}));

const categoriesById = {};
const collectionMap = new Map();
for (const product of ordered) {
  const productId = String(product.productId);
  const slugs = [];
  const content = contentOf(product);
  for (const category of product.categories || []) {
    if (!category?.slug) continue;
    const slug = String(category.slug);
    slugs.push(slug);
    const entry = collectionMap.get(slug) || {
      slug,
      name: String(category.name || slug),
      count: 0,
      featuredProductId: productId,
      featuredContent: content,
    };
    entry.count += 1;
    // Mirror the old SQL (MIN(p.content_json)) so collection tiles keep showing
    // the same featured product as before.
    if (content < entry.featuredContent) {
      entry.featuredContent = content;
      entry.featuredProductId = productId;
    }
    collectionMap.set(slug, entry);
  }
  categoriesById[productId] = slugs;
}
const collections = [...collectionMap.values()]
  .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.slug < b.slug ? -1 : 1))
  .map(({ slug, name, count, featuredProductId }) => ({ slug, name, count, featuredProductId }));
const sitemapIndex = {
  products: ordered.map((product) => String(product.slug)),
  collections: collections.map((entry) => entry.slug),
};

// D1 rejects very long SQL statements ("statement too long: SQLITE_TOOBIG"), so
// the payload is stored as ~32 KB chunks and reassembled by the reader.
const indexPayload = JSON.stringify({
  productCount: ordered.length,
  order: orderRows,
  collections,
  briefs: briefRows,
  sitemap: sitemapIndex,
  categories: categoriesById,
});
const INDEX_CHUNK_SIZE = 32000;
const indexStatements = [`DELETE FROM catalog_index WHERE locale=${quote(locale)};`];
for (let offset = 0, index = 0; offset < indexPayload.length; offset += INDEX_CHUNK_SIZE, index += 1) {
  indexStatements.push(
    `INSERT INTO catalog_index (locale, chunk, payload) VALUES (${quote(locale)}, ${index}, ${quote(
      indexPayload.slice(offset, offset + INDEX_CHUNK_SIZE)
    )});`
  );
}
const productBlocks = uniqueProducts.map((product) => {
  const productId = String(product.productId);
  // Guarded upsert: when the stored row is already identical
  // (content_json IS excluded.content_json), the conflict-update is skipped so
  // the row writes 0 rows. Missing rows still insert and stale rows still
  // update, so D1 stays self-healing while a deploy only writes products whose
  // content actually changed (~10/day x 14 locales instead of a full rewrite).
  // updated_at now only advances when content really changes, so
  // "recently updated first" ordering reflects real edits.
  const block = [
    `INSERT INTO products (product_id, locale, slug, source_hash, updated_at, content_json) VALUES (${quote(productId)}, ${quote(locale)}, ${quote(product.slug)}, ${quote(product.localization?.sourceHash || '')}, ${quote(product.localization?.translations?.en?.updatedAt || catalog.generatedAt || new Date().toISOString())}, ${quote(JSON.stringify(product))}) ON CONFLICT(product_id, locale) DO UPDATE SET slug=excluded.slug, source_hash=excluded.source_hash, updated_at=excluded.updated_at, content_json=excluded.content_json WHERE products.content_json IS NOT excluded.content_json;`,
  ];
  const categoriesBySlug = new Map(
    (product.categories || []).filter((category) => category?.slug).map((category) => [String(category.slug), category])
  );
  if (categoriesBySlug.size === 0) {
    // No target categories: remove any rows left over from a previous import.
    block.push(`DELETE FROM product_categories WHERE product_id=${quote(productId)} AND locale=${quote(locale)};`);
  } else {
    // Conditional category diff instead of delete-all + reinsert: unchanged
    // category rows are never touched (0 rows written).
    const keptSlugs = [...categoriesBySlug.keys()].map(quote).join(',');
    block.push(
      `DELETE FROM product_categories WHERE product_id=${quote(productId)} AND locale=${quote(locale)} AND category_slug NOT IN (${keptSlugs});`
    );
    for (const [slug, category] of categoriesBySlug) {
      block.push(
        `UPDATE product_categories SET category_name=${quote(category.name)} WHERE product_id=${quote(productId)} AND locale=${quote(locale)} AND category_slug=${quote(slug)} AND category_name IS NOT ${quote(category.name)};`,
        `INSERT INTO product_categories (product_id, locale, category_slug, category_name) SELECT ${quote(productId)}, ${quote(locale)}, ${quote(slug)}, ${quote(category.name)} WHERE NOT EXISTS (SELECT 1 FROM product_categories WHERE product_id=${quote(productId)} AND locale=${quote(locale)} AND category_slug=${quote(slug)});`
      );
    }
  }
  return block;
});

const deletedProductIds = [...new Set((catalog.sync?.deletedProductIds || []).map(String))];
const deleteStatements = deletedProductIds.flatMap((productId) => [
  `DELETE FROM product_categories WHERE product_id=${quote(productId)} AND locale=${quote(locale)};`,
  `DELETE FROM products WHERE product_id=${quote(productId)} AND locale=${quote(locale)};`,
]);

await mkdir(dirname(outputFile), { recursive: true });

// Full single-file import (kept for reconcile-d1 which executes the whole file).
await writeFile(
  outputFile,
  `${[...header, ...indexStatements, ...productBlocks.flat(), ...deleteStatements].join('\n')}\n`,
  'utf8'
);

// Small batch files (used by the deploy to keep each D1 request small).
let batchCount = 0;
for (let index = 0; index < productBlocks.length; index += batchSize) {
  batchCount += 1;
  const chunk = productBlocks.slice(index, index + batchSize);
  const batchStatements = [
    ...header,
    ...(batchCount === 1 ? [...indexStatements, ...deleteStatements] : []),
    ...chunk.flat(),
  ];
  const batchBase = outputFile.endsWith('.sql') ? outputFile.slice(0, -4) : outputFile;
  const batchFile = `${batchBase}-${String(batchCount).padStart(3, '0')}.sql`;
  await writeFile(batchFile, `${batchStatements.join('\n')}\n`, 'utf8');
}

process.stdout.write(
  `D1 import prepared for ${locale}: ${uniqueProducts.length} unique upserts in ${batchCount} batches of ${batchSize}, ${deletedProductIds.length} deletes, ${duplicateProductIds} duplicate input rows collapsed.\n`
);
