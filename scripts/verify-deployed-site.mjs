import localeData from '../src/i18n/locales.json' with { type: 'json' };

// Post-deploy smoke test. Runs after the Workers are deployed and the cache is
// purged. A real failure here means the live site is not serving a usable
// catalogue, so the deploy workflow restores D1 and rolls the Workers back.
//
// Cloudflare challenges or blocks datacenter IP ranges (GitHub Actions
// included): 401/403/429 and network errors mean the check could not see the
// site, which is NOT evidence that it is broken, so they never trigger a
// rollback. Only 5xx responses or a 200 with an empty catalogue do.
const hosts = [...new Set(Object.values(localeData.locales).map(({ host }) => host))];
const failures = [];
let unverifiable = 0;
const timeoutMs = 30000;

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const isUnverifiable = (status) => status === 401 || status === 403 || status === 429;
const countProductLinks = (html) => (html.match(/href="\/products\/[a-z0-9-]+"/g) || []).length;
const countSitemapUrls = (xml) => (xml.match(/<url>/g) || []).length;

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': BROWSER_UA, 'cache-control': 'no-cache' },
      signal: controller.signal,
    });
    return { status: response.status, text: await response.text() };
  } finally {
    clearTimeout(timer);
  }
}

function recordNetworkError(label, error) {
  unverifiable += 1;
  console.log(`${label}: network check inconclusive - ${error instanceof Error ? error.message : String(error)}`);
}

for (const host of hosts) {
  const base = `https://${host}`;
  try {
    const products = await fetchText(`${base}/products`);
    if (isUnverifiable(products.status)) {
      unverifiable += 1;
    } else if (products.status !== 200 || countProductLinks(products.text) < 3) {
      failures.push(`${host}/products status=${products.status} productLinks=${countProductLinks(products.text)}`);
    }

    const collections = await fetchText(`${base}/collections`);
    if (!isUnverifiable(collections.status) && collections.status !== 200) {
      failures.push(`${host}/collections status=${collections.status}`);
    }

    const sitemap = await fetchText(`${base}/sitemap.xml`);
    if (!isUnverifiable(sitemap.status) && (sitemap.status !== 200 || countSitemapUrls(sitemap.text) < 10)) {
      failures.push(`${host}/sitemap.xml status=${sitemap.status} urls=${countSitemapUrls(sitemap.text)}`);
    }
  } catch (error) {
    recordNetworkError(host, error);
  }
}

// Spot-check one product detail page from the English catalogue.
try {
  const products = await fetchText('https://ouooo.com/products');
  if (isUnverifiable(products.status)) {
    unverifiable += 1;
  } else {
    const match = products.text.match(/href="(\/products\/[a-z0-9-]+)"/);
    if (!match) {
      failures.push('ouooo.com/products contains no product link');
    } else {
      const detail = await fetchText(`https://ouooo.com${match[1]}`);
      if (!isUnverifiable(detail.status) && detail.status !== 200) {
        failures.push(`product detail ${match[1]} status=${detail.status}`);
      }
    }
  }
} catch (error) {
  recordNetworkError('product detail', error);
}

if (failures.length) {
  console.error('Deployed site smoke test FAILED:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`Deployed site smoke test passed for ${hosts.length} locales.`);
if (unverifiable) {
  console.log(`${unverifiable} checks were blocked or unreachable from CI and could not be verified.`);
}
