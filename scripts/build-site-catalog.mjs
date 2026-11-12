import { createHash } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const inputFile = resolve(process.env.OUOOO_ENRICHED_OUTPUT || 'src/data/enriched-catalog.json');
const outputFile = resolve(process.env.OUOOO_SITE_CATALOG_OUTPUT || 'src/data/site-catalog.json');
const aliasesFile = resolve(
  process.env.OUOOO_SLUG_ALIASES_OUTPUT || 'src/data/catalog-slug-aliases.json'
);
const accents = ['#8b6b4a', '#6f7c72', '#9a6b63', '#7a6d92', '#8a7b55', '#6d7887'];
// Curated category fixes applied at build time, keyed by the stable site slug
// (product AAHJTG7BAOVioqqEY6e0b9PP). The MECRT source assigns this product to
// "Uncategorized"; we move it into the existing Jewelry Packaging collection.
// Keeping the id/name/slug identical to the target collection makes the product
// merge into it. Because this runs during every catalog build, the fix survives
// source-data syncs instead of being overwritten by the next sync.
const CATEGORY_OVERRIDES = {
  'knitted-coin-pouch-backpack-charm-e0b9pp': [{ id: '122', name: 'Jewelry Packaging', slug: 'jewelry-packaging' }],
  'wholesale-knitted-creative-pendant-coin-storage-pouch-party-gift-square-cartoon-backpack-charm': [
    { id: '122', name: 'Jewelry Packaging', slug: 'jewelry-packaging' },
  ],
};

// Products to remove from the published site entirely (stale rows were left in
// D1 after the source catalog dropped them). Keyed by source id; enforced on
// every catalog build so a source re-add cannot resurrect them, and folded
// into sync.deletedProductIds so D1 imports delete their rows.
const DELETED_PRODUCT_IDS = new Set([
  'AAHyTG7BAOVioqqEY6eonUzd',
  'AAHcTG7BAOVioqqEY6eepIEV',
  'AAHuTG7BAOVioqqEY6eehhWx',
]);
const unsuitableClaim =
  /\b(bless(?:ed|ing)?|consecrat(?:e|ed|ion)|miracul(?:ous|ously)|spiritual protection|church approv(?:al|ed))\b/i;
const replaceSourceBrand = (value = '') => {
  const text = String(value);
  return /^https?:\/\//i.test(text) ? text : text.replace(/\bmecrt(?:\.com)?\b/gi, 'OUOOO');
};
function sanitizeSourceBrand(value) {
  if (typeof value === 'string') return replaceSourceBrand(value);
  if (Array.isArray(value)) return value.map(sanitizeSourceBrand);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeSourceBrand(item)]));
  }
  return value;
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
}

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sourceContentHash(product) {
  const content = {
    title: product.ai.title,
    productType: product.ai.product_type,
    summary: product.ai.short_description,
    description: product.ai.description,
    catholicContext: product.ai.catholic_context,
    catholicRelevance: product.ai.catholic_relevance,
    categories: product.categories,
    features: product.ai.key_features,
    specifications: product.ai.specifications,
    applications: product.ai.applications,
    faq: product.ai.faq,
  };
  return createHash('sha256').update(stableSerialize(content)).digest('hex');
}

function imageList(product) {
  return (product.images || [])
    .map((image) => ({ url: image.url || image.source_url || '', alt: image.alt || product.ai.title }))
    .filter(({ url }) => Boolean(url));
}

function variantImageList(product) {
  const seen = new Set();
  return (product.variations || []).flatMap((variation) => {
    const url = variation.image?.url || variation.image?.source_url || '';
    if (!url || seen.has(url)) return [];
    seen.add(url);
    const label =
      Object.values(variation.attributes || {})
        .filter(Boolean)
        .join(' / ') ||
      variation.sku ||
      'Variant';
    return [{ url, alt: `${product.ai.title} - ${label}`, label, sku: variation.sku || '' }];
  });
}

function buyerFaq(items) {
  return (items || []).filter(({ question = '', answer = '' }) => !unsuitableClaim.test(`${question} ${answer}`));
}

function cleanEditorialText(value) {
  return String(value || '')
    .split(/\n+/)
    .map((paragraph) =>
      paragraph
        .split(/(?<=[.!?])\s+/)
        .filter((sentence) => !unsuitableClaim.test(sentence))
        .join(' ')
    )
    .filter(Boolean)
    .join('\n\n');
}

function structuredData(product, faq, pricing) {
  const data = structuredClone(product.structured_data || {});
  if (data.product) {
    data.product.name = product.ai.title;
    data.product.description = product.ai.meta_description || product.ai.short_description;
    if (pricing) {
      const offer = {
        '@type': 'Offer',
        price: pricing.price,
        priceCurrency: pricing.currency,
        availability: 'https://schema.org/InStock',
      };
      if (pricing.priceRange) {
        offer.priceSpecification = {
          '@type': 'PriceSpecification',
          minPrice: pricing.priceRange.min,
          maxPrice: pricing.priceRange.max,
          priceCurrency: pricing.currency,
        };
      }
      data.product.offers = offer;
    }
  }
  if (faq.length) {
    data.faq = {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: faq.map(({ question, answer }) => ({
        '@type': 'Question',
        name: question,
        acceptedAnswer: { '@type': 'Answer', text: answer },
      })),
    };
  } else {
    delete data.faq;
  }
  return data;
}

function categoryList(product) {
  const seen = new Set();
  const categories = (product.categories || []).flatMap((category) => {
    const name = String(category?.name || '').trim();
    if (!name) return [];
    const slug = slugify(category.slug || name);
    if (!slug || seen.has(slug)) return [];
    seen.add(slug);
    return [{ id: String(category.id || slug), name, slug }];
  });
  return categories.length
    ? categories
    : [{ id: 'uncategorized', name: 'Other Catholic Gifts', slug: 'other-catholic-gifts' }];
}

function extractPricing(product) {
  const numericPrice = (value) => {
    const text = String(value ?? '').trim();
    if (!text) return undefined;
    const number = Number(text);
    return Number.isFinite(number) && number > 0 ? number : undefined;
  };

  const sourcePricing = product.pricing && typeof product.pricing === 'object' ? product.pricing : {};
  const parentPrice = numericPrice(sourcePricing.price ?? product.price ?? product._price);
  const regularPrice = numericPrice(sourcePricing.regular_price ?? product.regular_price ?? product._regular_price);
  const salePrice = numericPrice(sourcePricing.sale_price ?? product.sale_price ?? product._sale_price);
  const variationPrices = (product.variations || [])
    .map((variation) => numericPrice(variation.price ?? variation.sale_price ?? variation.regular_price))
    .filter((price) => price !== undefined);
  const tierPrices = [
    ...(sourcePricing.tiers || []),
    ...(product.variations || []).flatMap((variation) => variation.price_tiers || []),
  ]
    .map((tier) => numericPrice(tier?.price))
    .filter((price) => price !== undefined);
  const availablePrices = [...variationPrices, ...tierPrices];

  if (parentPrice === undefined && availablePrices.length === 0) return undefined;

  const minimumVariationPrice = availablePrices.length ? Math.min(...availablePrices) : undefined;
  const maximumVariationPrice = availablePrices.length ? Math.max(...availablePrices) : undefined;
  const effectivePrice = parentPrice ?? minimumVariationPrice;
  const currency = String(sourcePricing.currency || product.currency || product.currency_code || 'USD')
    .trim()
    .toUpperCase();
  const onSale = salePrice !== undefined && regularPrice !== undefined && salePrice < regularPrice;

  const priceRange =
    minimumVariationPrice !== undefined &&
    maximumVariationPrice !== undefined &&
    minimumVariationPrice !== maximumVariationPrice
      ? {
          min: minimumVariationPrice.toFixed(2),
          max: maximumVariationPrice.toFixed(2),
        }
      : undefined;

  return {
    price: effectivePrice.toFixed(2),
    regularPrice: regularPrice?.toFixed(2),
    currency,
    onSale,
    priceRange,
  };
}

function mapProduct(product, index, existingSlugs) {
  const gallery = imageList(product);
  const variantImages = variantImageList(product);
  const faq = buyerFaq(product.ai.faq);
  const suffix = String(product.source_id).slice(-6).toLowerCase();
  const productId = String(product.source_id);
  // Prefer the stored slug so a source-id re-key never changes a published URL.
  const slug =
    existingSlugs.get(productId) ||
    (product.sku ? existingSlugs.get('sku:' + product.sku) : undefined) ||
    product.slug ||
    `${slugify(product.ai.title)}-${suffix}`;
  const categoryOverride = CATEGORY_OVERRIDES[slug];
  const sourceHash = sourceContentHash(product);
  const updatedAt = product.ai.generated_at || new Date().toISOString();
  const pricing = extractPricing(product);
  return sanitizeSourceBrand({
    productId,
    sourceId: productId,
    sourceFingerprint: product.ai.source_fingerprint || '',
    locale: 'en',
    slug,
    title: product.ai.title,
    eyebrow: product.ai.product_type,
    summary: product.ai.short_description,
    description: cleanEditorialText(product.ai.description),
    catholicContext: product.ai.catholic_context,
    catholicRelevance: product.ai.catholic_relevance,
    categories: categoryOverride || categoryList(product),
    sku: product.sku || `OUO-${suffix.toUpperCase()}`,
    imageUrl: gallery[0]?.url || '',
    imageAlt: gallery[0]?.alt || product.ai.title,
    gallery,
    variantImages,
    accent: accents[index % accents.length],
    features: product.ai.key_features || [],
    specifications: (product.ai.specifications || []).map(({ name, value }) => ({ name, value })),
    applications: product.ai.applications || [],
    faq,
    pricing,
    structuredData: structuredData(product, faq, pricing),
    localization: {
      sourceLocale: 'en',
      sourceHash,
      translations: {
        en: {
          status: 'source',
          sourceHash,
          contentHash: sourceHash,
          attempts: 0,
          updatedAt,
          model: product.ai.model || 'source',
        },
      },
    },
  });
}

const temporaryFile = `${outputFile}.tmp-${process.pid}`;
try {
  const catalog = JSON.parse(await readFile(inputFile, 'utf8'));
  if (!Array.isArray(catalog.products) || catalog.products.length < 1) throw new Error('Enriched catalog is empty.');
  const existingCatalog = await readFile(outputFile, 'utf8')
    .then(JSON.parse)
    .catch(() => ({ products: [] }));
  const previousById = new Map();
  const previousBySku = new Map();
  const previousByTitle = new Map();
  const existingSlugs = new Map();
  for (const product of existingCatalog.products || []) {
    const key = String(product.productId || product.sourceId);
    if (key) {
      previousById.set(key, product);
      existingSlugs.set(key, product.slug);
    }
    // Also index by sku: a source-id re-key changes the id but not the sku, and
    // this keeps every published product URL stable through the migration.
    if (product.sku) {
      previousBySku.set(String(product.sku), product);
      existingSlugs.set(`sku:${product.sku}`, product.slug);
    }
    if (product.title) {
      previousByTitle.set(String(product.title).trim().toLowerCase(), product);
    }
  }
  const sourceSlugById = new Map(
    catalog.products.map((product) => [
      String(product.source_id || product.product_id),
      String(product.slug || '').trim(),
    ])
  );
  const products = catalog.products
    .filter((product) => !DELETED_PRODUCT_IDS.has(String(product.source_id || product.product_id)))
    .map((product, index) => mapProduct(product, index, existingSlugs));

  // One catalogue entry per source product. The product identity is the source
  // id (site productId === sourceId, enforced again at D1 import), so a repeated
  // source id here would publish the same product twice.
  const seenSourceIds = new Set();
  for (const product of products) {
    const sourceId = String(product.sourceId || product.productId || '').trim();
    if (!sourceId) throw new Error('Catalogue product is missing a source id.');
    if (seenSourceIds.has(sourceId)) {
      throw new Error(`Duplicate source id ${sourceId} in the catalogue; refusing to publish duplicates.`);
    }
    seenSourceIds.add(sourceId);
  }

  // Preserve every previously published slug as a permanent alias. If a
  // product title or source identity changes, old customer and search-engine
  // links redirect to the current product instead of becoming 404s. The tiny
  // alias file is bundled with the Worker and needs no D1 table or row reads.
  const aliases = await readFile(aliasesFile, 'utf8')
    .then(JSON.parse)
    .catch(() => ({}));
  for (const product of products) {
    const previous =
      previousById.get(String(product.productId)) ||
      (product.sku ? previousBySku.get(String(product.sku)) : undefined) ||
      previousByTitle.get(String(product.title).trim().toLowerCase());
    if (previous?.slug && previous.slug !== product.slug) {
      aliases[String(previous.slug)] = String(product.slug);
    }
    const sourceSlug = sourceSlugById.get(String(product.productId));
    if (sourceSlug && sourceSlug !== product.slug) {
      aliases[sourceSlug] = String(product.slug);
    }
  }
  const currentSlugs = new Set(products.map((product) => String(product.slug)));
  const resolveAlias = (slug) => {
    const visited = new Set();
    let target = String(aliases[slug] || '');
    while (target && target !== slug && !visited.has(target)) {
      visited.add(target);
      const next = String(aliases[target] || '');
      if (!next) break;
      target = next;
    }
    return target === slug ? '' : target;
  };
  const activeAliases = Object.fromEntries(
    Object.keys(aliases)
      .sort()
      .flatMap((oldSlug) => {
        const currentSlug = resolveAlias(oldSlug);
        return currentSlug && currentSlugs.has(currentSlug) && oldSlug !== currentSlug
          ? [[oldSlug, currentSlug]]
          : [];
      })
  );
  // Guard against a partial source response being mistaken for mass deletion.
  // On 2026-10-31 the bridge returned only 10 products, reconciliation marked
  // the other 1,060 as deleted, and the next deploy removed almost every row
  // from D1. Refuse to publish a catalogue that shrinks by more than 50% in a
  // single sync unless the operator explicitly allows it.
  const previousProductCount = (existingCatalog.products || []).length;
  const minimumRetainedRatio = Math.min(
    0.95,
    Math.max(0.1, Number(process.env.OUOOO_CATALOG_MIN_RETAINED_RATIO || 0.5))
  );
  const allowShrink = /^(1|true|yes)$/i.test(process.env.OUOOO_ALLOW_CATALOG_SHRINK || '');
  if (
    !allowShrink &&
    previousProductCount >= 50 &&
    products.length < Math.floor(previousProductCount * minimumRetainedRatio)
  ) {
    throw new Error(
      `Refusing to publish a catalogue that dropped from ${previousProductCount} to ${products.length} products ` +
        `(more than ${Math.round((1 - minimumRetainedRatio) * 100)}% removed in one sync). ` +
        'This usually means the source returned a partial list. If the shrink is intentional, set OUOOO_ALLOW_CATALOG_SHRINK=1.'
    );
  }

  await writeFile(
    temporaryFile,

    `${JSON.stringify(sanitizeSourceBrand({ schemaVersion: 3, locale: 'en', generatedAt: new Date().toISOString(), selection: catalog.selection, sync: { mode: catalog.sync_mode, cursor: catalog.sync_cursor, modifiedAfter: catalog.modified_after, changedProductIds: catalog.changed_source_ids || [], deletedProductIds: [...new Set([...(catalog.deleted_source_ids || []), ...DELETED_PRODUCT_IDS])] }, enrichmentSummary: catalog.enrichment_summary, products }), null, 2)}\n`,
    'utf8'
  );
  await rename(temporaryFile, outputFile);
  const temporaryAliasesFile = `${aliasesFile}.tmp-${process.pid}`;
  await writeFile(temporaryAliasesFile, `${JSON.stringify(activeAliases, null, 2)}\n`, 'utf8');
  await rename(temporaryAliasesFile, aliasesFile);
  process.stdout.write(`Site catalog prepared: ${products.length} products.\n`);
  process.stdout.write(`Preserved ${Object.keys(activeAliases).length} historical product URLs.\n`);
} catch (error) {
  await rm(temporaryFile, { force: true });
  throw error;
}
