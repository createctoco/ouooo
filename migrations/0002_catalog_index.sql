-- Precomputed per-locale index so catalogue pages read one row instead of
-- scanning every product row for that locale.
--
-- D1 bills per *row* read, so "SELECT ... ORDER BY / COUNT(*) / GROUP BY" over
-- ~640 products cost 600-1,200 row reads per page render and let crawler traffic
-- push the account past its daily row read limit (2026-09-21). Everything the
-- listing pages need is precomputed here into a single row per locale.
CREATE TABLE IF NOT EXISTS catalog_index (
  locale TEXT PRIMARY KEY,
  product_count INTEGER NOT NULL DEFAULT 0,
  -- [{ id, slug, updatedAt }] in the same order the listing pages use.
  order_json TEXT NOT NULL DEFAULT '[]',
  -- [{ slug, name, count, featuredProductId }]
  collections_json TEXT NOT NULL DEFAULT '[]',
  -- [{ slug, title, summary }] for llms.txt
  briefs_json TEXT NOT NULL DEFAULT '[]',
  -- { products: [slug], collections: [slug] } for sitemap.xml
  sitemap_json TEXT NOT NULL DEFAULT '{}',
  -- { productId: [categorySlug] } so related products can be scored in memory
  categories_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT ''
);
