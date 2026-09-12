// Temporary diagnostic: print Cloudflare D1 usage (rows read/written) per day.
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !token) throw new Error('CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN required');

const days = Number(process.env.OUOOO_REPORT_DAYS || 12);
const end = new Date();
const start = new Date(end.getTime() - days * 86400000);
const fmt = (d) => d.toISOString().slice(0, 10);

const query = `
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

const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ query, variables: { accountTag: account, start: fmt(start), end: fmt(end) } }),
});
const json = await res.json();
if (json.errors) {
  console.log('GRAPHQL ERRORS:', JSON.stringify(json.errors));
  process.exit(0);
}
const groups = json?.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups;
if (!groups) {
  console.log('RAW:', JSON.stringify(json).slice(0, 1500));
  process.exit(0);
}
console.log('date        rowsRead      rowsWritten');
let tr = 0, tw = 0;
for (const g of groups) {
  tr += g.sum.rowsRead;
  tw += g.sum.rowsWritten;
  console.log(`${g.dimensions.date}  ${String(g.sum.rowsRead).padStart(10)}  ${String(g.sum.rowsWritten).padStart(10)}`);
}
console.log(`TOTAL ${days}d   ${String(tr).padStart(10)}  ${String(tw).padStart(10)}`);
console.log(`AVG/day      ${String(Math.round(tr / Math.max(1, groups.length))).padStart(10)}  ${String(Math.round(tw / Math.max(1, groups.length))).padStart(10)}`);
