import { createHmac, randomBytes } from 'node:crypto';

// Read-only diagnostic for the Mecrt catalogue bridge. Mirrors the signing
// used by scripts/catalog-client.mjs and reports what each page returns, so a
// partial source response can be distinguished from a genuine catalogue.
const baseUrl = (process.env.MECRT_CATALOG_URL || '').replace(/\/$/, '');
const secret = process.env.MECRT_CATALOG_BRIDGE_SECRET || '';
const route = '/wp-json/mecrt-catalog/v1/products';

if (!baseUrl || secret.length < 32) {
  console.error('MECRT_CATALOG_URL and a 32+ character MECRT_CATALOG_BRIDGE_SECRET are required.');
  process.exit(1);
}

async function call(page, pageSize, modifiedAfter) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(24).toString('hex');
  const payload = `${page}\n${pageSize}\n${modifiedAfter}`;
  const signature = createHmac('sha256', secret)
    .update(`POST\n${route}\n${timestamp}\n${nonce}\n${payload}`)
    .digest('hex');
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-mecrt-timestamp': timestamp,
      'x-mecrt-nonce': nonce,
      'x-mecrt-signature': signature,
    },
    body: JSON.stringify({ page, page_size: pageSize, modified_after: modifiedAfter }),
  });
  const raw = await response.text();
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    // non-JSON response
  }
  return { status: response.status, data, raw };
}

function summarise(label, result) {
  if (!result.data) {
    console.log(`${label}: HTTP ${result.status} — non-JSON response: ${result.raw.slice(0, 300)}`);
    return;
  }
  const d = result.data;
  const bag = d.data && typeof d.data === 'object' ? d.data : d;
  console.log(
    `${label}: HTTP ${result.status} | success=${d.success} | total=${bag.total ?? d.total ?? '?'} | source_total=${bag.source_total ?? '?'} | total_pages=${bag.total_pages ?? '?'} | products=${Array.isArray(bag.products) ? bag.products.length : '?'} | deleted=${Array.isArray(bag.deleted_source_ids) ? bag.deleted_source_ids.length : '?'}`
  );
  if (!d.success || result.status !== 200 || bag.message) {
    console.log(`  message: ${String(d.message || bag.message || '').slice(0, 300)}`);
  }
}

console.log(`Probing ${baseUrl}${route}\n`);
for (const [page, size] of [
  [1, 10],
  [1, 100],
  [2, 100],
  [3, 100],
  [10, 100],
]) {
  try {
    const result = await call(page, size, '');
    summarise(`page=${page} size=${size}`, result);
  } catch (error) {
    console.log(`page=${page} size=${size}: ERROR ${error instanceof Error ? error.message : String(error)}`);
  }
}
