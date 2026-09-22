import { env } from 'cloudflare:workers';

import type { Product, ProductCategory } from '~/data/products';
import type { SupportedLocale } from '~/i18n/config';

type ProductRow = { content_json: string };
type CollectionRow = ProductCategory & { productCount: number; featuredProductJson: string };

type CatalogIndexRow = {
  product_count: number;
  order_json: string;
  collections_json: string;
  briefs_json: string;
  sitemap_json: string;
  categories_json: string;
};

type ParsedIndex = {
  productCount: number;
  order: Array<{ id: string; slug: string; updatedAt: string }>;
  collections: Array<{ slug: string; name: string; count: number; featuredProductId: string }>;
  briefs: Array<{ slug: string; title: string; summary: string }>;
  sitemap: { products: string[]; collections: string[] };
  categories: Record<string, string[]>;
};

const database = () => env.DB;
const parseProduct = (row: ProductRow | null): Product | undefined =>
  row ? (JSON.parse(row.content_json) as Product) : undefined;

const parseJson = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

// D1 bills per ROW read, so the listing pages used to cost 600-1,200 row reads
// each (COUNT(*), GROUP BY, MIN(content_json) over ~640 products) and crawler
// traffic could push the account past its free daily row read limit. Everything
// those pages need is precomputed into one `catalog_index` row per locale, so a
// render now reads 1-2 rows instead. The row changes only on deploy, so a warm
// isolate keeps the parsed copy in module scope and answers from memory.
const INDEX_TTL_MS = 5 * 60 * 1000;
const indexCache = new Map<string, { at: number; value: ParsedIndex | null }>();

async function loadIndex(locale: SupportedLocale | string): Promise<ParsedIndex | null> {
  const key = String(locale);
  const cached = indexCache.get(key);
  const now = Date.now();
  if (cached && now - cached.at < INDEX_TTL_MS) return cached.value;

  let value: ParsedIndex | null = null;
  try {
    const row = await database()
      .prepare(
        'SELECT product_count, order_json, collections_json, briefs_json, sitemap_json, categories_json FROM catalog_index WHERE locale = ? LIMIT 1'
      )
      .bind(key)
      .first<CatalogIndexRow>();
    if (row) {
      value = {
        productCount: Number(row.product_count) || 0,
        order: parseJson(row.order_json, []),
        collections: parseJson(row.collections_json, []),
        briefs: parseJson(row.briefs_json, []),
        sitemap: parseJson(row.sitemap_json, { products: [], collections: [] }),
        categories: parseJson(row.categories_json, {}),
      };
    }
  } catch {
    // Index missing or unreadable: fall back to the original queries below.
    value = null;
  }
  indexCache.set(key, { at: now, value });
  return value;
}

async function fetchProductsByIds(locale: string, ids: string[]): Promise<Product[]> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return [];
  const placeholders = unique.map(() => '?').join(',');
  const result = await database()
    .prepare(`SELECT content_json FROM products WHERE locale = ? AND product_id IN (${placeholders})`)
    .bind(locale, ...unique)
    .all<ProductRow>();
  return (result.results as ProductRow[]).map((row) => JSON.parse(row.content_json) as Product);
}

const orderByIds = (ids: string[], products: Product[]): Product[] => {
  const byId = new Map(products.map((product) => [String(product.productId), product]));
  return ids.map((id) => byId.get(id)).filter((product): product is Product => Boolean(product));
};

export async function getProductBySlug(locale: SupportedLocale, slug: string): Promise<Product | undefined> {
  const row = await database()
    .prepare('SELECT content_json FROM products WHERE locale = ? AND slug = ? LIMIT 1')
    .bind(locale, slug)
    .first<ProductRow>();
  return parseProduct(row);
}

export async function listProducts(
  locale: SupportedLocale,
  page = 1,
  pageSize = 24
): Promise<{ products: Product[]; total: number; page: number; pageSize: number }> {
  const safePage = Math.max(1, Math.trunc(page));
  const safePageSize = Math.min(48, Math.max(1, Math.trunc(pageSize)));
  const offset = (safePage - 1) * safePageSize;

  const index = await loadIndex(locale);
  if (index) {
    const slice = index.order.slice(offset, offset + safePageSize);
    const products = await fetchProductsByIds(
      locale,
      slice.map((entry) => entry.id)
    );
    return {
      products: orderByIds(
        slice.map((entry) => entry.id),
        products
      ),
      total: index.productCount,
      page: safePage,
      pageSize: safePageSize,
    };
  }

  const [rows, total] = await database().batch([
    database()
      .prepare(
        'SELECT content_json FROM products WHERE locale = ? ORDER BY updated_at DESC, product_id DESC LIMIT ? OFFSET ?'
      )
      .bind(locale, safePageSize, offset),
    database().prepare('SELECT COUNT(*) AS count FROM products WHERE locale = ?').bind(locale),
  ]);
  return {
    products: (rows.results as ProductRow[]).map((row) => JSON.parse(row.content_json) as Product),
    total: Number((total.results[0] as { count?: number } | undefined)?.count || 0),
    page: safePage,
    pageSize: safePageSize,
  };
}

export async function listCollections(locale: SupportedLocale): Promise<CollectionRow[]> {
  const index = await loadIndex(locale);
  if (index) {
    const featured = await fetchProductsByIds(
      locale,
      index.collections.map((entry) => entry.featuredProductId)
    );
    const byId = new Map(featured.map((product) => [String(product.productId), product]));
    return index.collections.map((entry) => ({
      id: entry.slug,
      slug: entry.slug,
      name: entry.name,
      productCount: entry.count,
      featuredProductJson: byId.has(entry.featuredProductId) ? JSON.stringify(byId.get(entry.featuredProductId)) : '',
    }));
  }

  const result = await database()
    .prepare(
      `SELECT pc.category_slug AS slug, pc.category_name AS name, pc.category_slug AS id,
              COUNT(*) AS productCount, MIN(p.content_json) AS featuredProductJson
       FROM product_categories pc
       JOIN products p ON p.product_id = pc.product_id AND p.locale = pc.locale
       WHERE pc.locale = ?
       GROUP BY pc.category_slug, pc.category_name
       ORDER BY pc.category_name`
    )
    .bind(locale)
    .all<CollectionRow>();
  return result.results;
}

export async function getCollection(
  locale: SupportedLocale,
  slug: string,
  page = 1,
  pageSize = 24
): Promise<{ name: string; products: Product[]; total: number; page: number; pageSize: number } | undefined> {
  const safePage = Math.max(1, Math.trunc(page));
  const safePageSize = Math.min(48, Math.max(1, Math.trunc(pageSize)));
  const offset = (safePage - 1) * safePageSize;

  const index = await loadIndex(locale);
  if (index) {
    const named = index.collections.find((entry) => entry.slug === slug);
    if (!named) return undefined;
    const ids = index.order.map((entry) => entry.id).filter((id) => (index.categories[id] || []).includes(slug));
    const slice = ids.slice(offset, offset + safePageSize);
    const products = await fetchProductsByIds(locale, slice);
    return {
      name: named.name,
      products: orderByIds(slice, products),
      total: ids.length,
      page: safePage,
      pageSize: safePageSize,
    };
  }

  const [rows, summary] = await database().batch([
    database()
      .prepare(
        `SELECT p.content_json FROM product_categories pc
         JOIN products p ON p.product_id = pc.product_id AND p.locale = pc.locale
         WHERE pc.locale = ? AND pc.category_slug = ?
         ORDER BY p.updated_at DESC, p.product_id DESC LIMIT ? OFFSET ?`
      )
      .bind(locale, slug, safePageSize, offset),
    database()
      .prepare(
        'SELECT MIN(category_name) AS name, COUNT(*) AS count FROM product_categories WHERE locale = ? AND category_slug = ?'
      )
      .bind(locale, slug),
  ]);
  const data = summary.results[0] as { name?: string; count?: number } | undefined;
  if (!data?.name) return undefined;
  return {
    name: data.name,
    products: (rows.results as ProductRow[]).map((row) => JSON.parse(row.content_json) as Product),
    total: Number(data.count || 0),
    page: safePage,
    pageSize: safePageSize,
  };
}

export async function getRelatedProducts(product: Product, limit = 4): Promise<Product[]> {
  const categorySlugs = product.categories.map(({ slug }) => slug).slice(0, 8);
  if (!categorySlugs.length) return [];

  const index = await loadIndex(product.locale);
  if (index) {
    const wanted = new Set(categorySlugs);
    const scored: Array<{ id: string; relevance: number }> = [];
    for (const entry of index.order) {
      if (entry.id === String(product.productId)) continue;
      let relevance = 0;
      for (const slug of index.categories[entry.id] || []) if (wanted.has(slug)) relevance += 1;
      if (relevance > 0) scored.push({ id: entry.id, relevance });
    }
    scored.sort((a, b) => b.relevance - a.relevance || (a.id < b.id ? 1 : -1));
    const top = scored.slice(0, limit).map((entry) => entry.id);
    const products = await fetchProductsByIds(product.locale, top);
    return orderByIds(top, products);
  }

  const placeholders = categorySlugs.map(() => '?').join(',');
  const result = await database()
    .prepare(
      `SELECT p.content_json, COUNT(*) AS relevance FROM product_categories pc
       JOIN products p ON p.product_id = pc.product_id AND p.locale = pc.locale
       WHERE pc.locale = ? AND pc.category_slug IN (${placeholders}) AND p.product_id != ?
       GROUP BY p.product_id, p.locale, p.content_json
       ORDER BY relevance DESC, p.product_id DESC LIMIT ?`
    )
    .bind(product.locale, ...categorySlugs, product.productId, limit)
    .all<ProductRow>();
  return result.results.map((row) => JSON.parse(row.content_json) as Product);
}

export async function listSitemapSlugs(
  locale: SupportedLocale
): Promise<{ products: string[]; collections: string[] }> {
  const index = await loadIndex(locale);
  if (index) {
    return {
      products: index.sitemap.products || [],
      collections: index.sitemap.collections || [],
    };
  }

  const [products, collections] = await database().batch([
    database().prepare('SELECT slug FROM products WHERE locale = ?').bind(locale),
    database().prepare('SELECT DISTINCT category_slug AS slug FROM product_categories WHERE locale = ?').bind(locale),
  ]);
  return {
    products: (products.results as { slug?: string }[]).map((row) => String(row.slug || '')).filter(Boolean),
    collections: (collections.results as { slug?: string }[]).map((row) => String(row.slug || '')).filter(Boolean),
  };
}

export async function listProductsBrief(
  locale: SupportedLocale
): Promise<Array<{ slug: string; title: string; summary: string }>> {
  const index = await loadIndex(locale);
  if (index) return index.briefs;

  const result = await database()
    .prepare('SELECT content_json FROM products WHERE locale = ? ORDER BY updated_at DESC')
    .bind(locale)
    .all<ProductRow>();
  return (result.results as ProductRow[]).map((row) => {
    const product = JSON.parse(row.content_json) as Product;
    return { slug: product.slug, title: product.title, summary: product.summary || '' };
  });
}
