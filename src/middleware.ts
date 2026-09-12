import { defineMiddleware } from 'astro:middleware';

import { BUILD_LOCALE, DEFAULT_LOCALE } from '~/i18n/config';
import { HAS_SITE_COPY, localizeHtml } from '~/i18n/site-copy';

// Cloudflare does NOT put Worker-generated responses in the edge cache by
// default, even when the route declares `s-maxage`. Every crawler hit on
// /products, /collections, /collections/<slug>, /sitemap.xml and /llms.txt was
// therefore re-running the full per-locale D1 catalog query, which pushed the
// account past the daily "rows read" free-tier limit.
//
// The dynamic catalog routes already declare `s-maxage`; we honour it here by
// storing the finished response in the zone cache. Deploys purge every zone
// (`purge_everything`), so the cached copy is dropped on each release.
type EdgeCache = {
  match: (request: Request) => Promise<Response | undefined>;
  put: (request: Request, response: Response) => Promise<void>;
};

const edgeCache = (): EdgeCache | undefined => {
  const globalCaches = (globalThis as { caches?: { default?: EdgeCache } }).caches;
  return globalCaches?.default;
};

// Only cache complete, public, successful responses. `set-cookie` means the
// response is per-visitor, so it must never be shared through the edge cache.
const sharedMaxAge = (response: Response): number => {
  if (response.status !== 200) return 0;
  if (response.headers.has('set-cookie')) return 0;
  const match = /(?:^|,\s*)s-maxage=(\d+)/i.exec(response.headers.get('cache-control') || '');
  return match ? Number(match[1]) : 0;
};

const localize = async (response: Response): Promise<Response> => {
  if (BUILD_LOCALE === DEFAULT_LOCALE || !HAS_SITE_COPY) return response;
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('text/html')) return response;

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(localizeHtml(await response.text()), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

export const onRequest = defineMiddleware(async (context, next) => {
  const request = context.request;
  const cache = request.method === 'GET' ? edgeCache() : undefined;
  const cacheKey = cache ? new Request(request.url, { method: 'GET' }) : null;

  if (cache && cacheKey) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    } catch {
      /* cache reads are best effort and must never break a request */
    }
  }

  const response = await localize(await next());

  if (cache && cacheKey) {
    const ttl = sharedMaxAge(response);
    if (ttl > 0) {
      const headers = new Headers(response.headers);
      // Edge copies live for the full s-maxage the route declares (crawlers keep
      // hitting the edge instead of D1), but browsers revalidate hourly so buyers
      // still pick up catalogue edits quickly.
      const browserMaxAge = Math.min(ttl, 3600);
      headers.set('cache-control', `public, max-age=${browserMaxAge}, s-maxage=${ttl}, stale-while-revalidate=86400`);
      try {
        await cache.put(
          cacheKey,
          new Response(response.clone().body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          })
        );
      } catch {
        /* cache writes are best effort and must never break a request */
      }
    }
  }

  return response;
});
