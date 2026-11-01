import localeData from '../src/i18n/locales.json' with { type: 'json' };

// Post-deploy smoke test. Runs after the Workers are deployed and the cache is
// purged; a failure here means the live site is not serving a usable catalogue,
// so the deploy workflow rolls D1 and the Workers back.
const hosts = [...new Set(Object.values(localeData.locales).map(({ host }) => host))];
const failures = [];
const timeoutMs = 30000;

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'cache-control': 'no-cache',
      },
      signal: controller.signal,
    });
    return { status: response.status, text: await response.text() };
  } finally {
    clearTimeout(timer);
  }
}

const countProductLinks = (html) => (html.match(/href="\/products\/[a-z0-9-]+"/g) || []).length;
const countSitemapUrls = (xml) => (xml.match(/<url>/g) || []).length;

for (const host of hosts) {
  const base = `https://${host}`;
  try {
    const products = await fetchText(`${base}/products`);
    const links = countProductLinks(products.text);
    if (products.status !== 200 || links < 3) {
      failures.push(`${host}/products status=${products.status} productLinks=${links}`);
    }

    const collections = await fetchText(`${base}/collections`);
    if (collections.status !== 200) {
      failures.push(`${host}/collections status=${collections.status}`);
    }

    const sitemap = await fetchText(`${base}/sitemap.xml`);
    const urls = countSitemapUrls(sitemap.text);
    if (sitemap.status !== 200 || urls < 10) {
      failures.push(`${host}/sitemap.xml status=${sitemap.status} urls=${urls}`);
    }
  } catch (error) {
    failures.push(`${host}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Spot-check one product detail page from the English catalogue.
try {
  const products = await fetchText('https://ouooo.com/products');
  const match = products.text.match(/href="(\/products\/[a-z0-9-]+)"/);
  if (!match) {
    failures.push('ouooo.com/products contains no product link');
  } else {
    const detail = await fetchText(`https://ouooo.com${match[1]}`);
    if (detail.status !== 200) failures.push(`product detail ${match[1]} status=${detail.status}`);
  }
} catch (error) {
  failures.push(`product detail: ${error instanceof Error ? error.message : String(error)}`);
}

if (failures.length) {
  console.error('Deployed site smoke test FAILED:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`Deployed site smoke test passed for ${hosts.length} locales.`);
