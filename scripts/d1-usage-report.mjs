// Temporary diagnostic: report Cloudflare D1 usage per day plus zone HTTP
// requests broken down by cache status, so we can tell a traffic surge apart
// from a broken edge cache.
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !token) throw new Error('CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN required');

const days = Number(process.env.OUOOO_REPORT_DAYS || 12);
const end = new Date();
const start = new Date(end.getTime() - days * 86400000);
const fmt = (d) => d.toISOString().slice(0, 10);
const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

async function graphql(query, variables) {
  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

// --- D1 rows read / written -------------------------------------------------
const d1Query = `
query D1Usage($accountTag: String!, $start: Date!, $end: Date!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      d1AnalyticsAdaptiveGroups(
        limit: 1000
        filter: { date_geq: $start, date_leq: $end }
        orderBy: [date_ASC]
      ) {
        dimensions { date }
        sum { rowsRead rowsWritten }
      }
    }
  }
}`;
const d1 = await graphql(d1Query, { accountTag: account, start: fmt(start), end: fmt(end) });
if (d1.errors) console.log('D1 GRAPHQL ERRORS:', JSON.stringify(d1.errors));
const d1Groups = d1?.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups || [];

// --- zone HTTP requests by cache status -------------------------------------
let zoneId = '';
try {
  const zones = await (
    await fetch(`https://api.cloudflare.com/client/v4/zones?name=ouooo.com`, { headers: auth })
  ).json();
  zoneId = zones?.result?.[0]?.id || '';
} catch (error) {
  console.log('zone lookup failed:', error instanceof Error ? error.message : String(error));
}
console.log('zone id:', zoneId || '(none)');

const cacheByDate = new Map();
if (zoneId) {
  const reqQuery = `
  query HttpRequests($zoneTag: String!, $start: Date!, $end: Date!) {
    viewer {
      zones(filter: { zoneTag: $zoneTag }) {
        httpRequestsAdaptiveGroups(
          limit: 5000
          filter: { date_geq: $start, date_leq: $end }
          orderBy: [date_ASC]
        ) {
          count
          dimensions { date cacheStatus }
        }
      }
    }
  }`;
  const req = await graphql(reqQuery, { zoneTag: zoneId, start: fmt(start), end: fmt(end) });
  if (req.errors) console.log('HTTP GRAPHQL ERRORS:', JSON.stringify(req.errors).slice(0, 600));
  const groups = req?.data?.viewer?.zones?.[0]?.httpRequestsAdaptiveGroups || [];
  for (const g of groups) {
    const date = g.dimensions.date;
    if (!cacheByDate.has(date)) cacheByDate.set(date, { total: 0, hit: 0, miss: 0, other: 0 });
    const bucket = cacheByDate.get(date);
    const status = String(g.dimensions.cacheStatus || '').toLowerCase();
    bucket.total += g.count;
    if (status.includes('hit')) bucket.hit += g.count;
    else if (status.includes('miss')) bucket.miss += g.count;
    else bucket.other += g.count;
  }
}

const d1ByDate = new Map(d1Groups.map((g) => [g.dimensions.date, g.sum]));
const dates = [...new Set([...d1ByDate.keys(), ...cacheByDate.keys()])].sort();

console.log('');
console.log('date        rowsRead   rowsWritten   requests      hits      miss   hit%   read/req');
for (const date of dates) {
  const sum = d1ByDate.get(date) || { rowsRead: 0, rowsWritten: 0 };
  const c = cacheByDate.get(date) || { total: 0, hit: 0, miss: 0, other: 0 };
  const hitPct = c.total ? ((c.hit / c.total) * 100).toFixed(1) : '-';
  const readPerReq = c.total ? (sum.rowsRead / c.total).toFixed(1) : '-';
  console.log(
    `${date}  ${String(sum.rowsRead).padStart(9)}  ${String(sum.rowsWritten).padStart(11)}  ${String(c.total).padStart(9)}  ${String(c.hit).padStart(8)}  ${String(c.miss).padStart(8)}  ${String(hitPct).padStart(5)}  ${String(readPerReq).padStart(8)}`
  );
}
