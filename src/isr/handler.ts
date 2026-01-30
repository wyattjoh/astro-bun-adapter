import { parse as parseCacheControl } from "cache-control-parser";
import debug from "debug";
import type { ISRCacheEntry, ISRHandler } from "../types.ts";
import { PersistentLRUCache } from "./cache.ts";

const log = debug("@wyattjoh/astro-bun-adapter:isr");

function buildCacheEntry(
  response: Response,
  body: Uint8Array
): ISRCacheEntry | undefined {
  const cc = parseCacheControl(response.headers.get("cache-control") ?? "");
  const sMaxAge = cc["s-maxage"];
  if (!sMaxAge || sMaxAge <= 0) return undefined;

  const swr = cc["stale-while-revalidate"] ?? 0;
  const headers: [string, string][] = Array.from(response.headers.entries());

  return {
    body,
    headers,
    status: response.status,
    cachedAt: Date.now(),
    sMaxAge,
    swr,
  };
}

type CacheStatus = "HIT" | "STALE" | "MISS" | "BYPASS";

function responseFromEntry(
  entry: ISRCacheEntry,
  cacheStatus: CacheStatus
): Response {
  const response = new Response(entry.body, {
    status: entry.status,
    headers: entry.headers,
  });
  response.headers.set("x-astro-cache", cacheStatus);
  return response;
}

interface RenderResult {
  streaming: Promise<Response>;
  entry: Promise<ISRCacheEntry | undefined>;
}

function renderToEntry(
  request: Request,
  handler: (request: Request) => Promise<Response>,
  cache: PersistentLRUCache,
  pathname: string,
  cacheStatus: CacheStatus
): RenderResult {
  const done = handler(request).then((response) => {
    response.headers.set("x-astro-cache", cacheStatus);
    const clone = response.clone();
    const entryPromise = clone.arrayBuffer().then(async (buf) => {
      const body = new Uint8Array(buf);
      const entry = buildCacheEntry(response, body);
      if (entry) {
        log(
          `ISR cached ${pathname} (s-maxage=${entry.sMaxAge}, swr=${entry.swr})`
        );
        await cache.set(pathname, entry);
      }
      return entry;
    });
    return { response, entryPromise };
  });

  return {
    streaming: done.then(({ response }) => response),
    entry: done.then(({ entryPromise }) => entryPromise),
  };
}

export function createISRHandler(
  handler: (request: Request) => Promise<Response>,
  maxByteSize: number,
  cacheDir: string,
  buildId: string
): ISRHandler {
  const cache = new PersistentLRUCache({
    maxByteSize,
    cacheDir,
    buildId,
  });
  const revalidating = new Set<string>();
  const inflight = new Map<string, Promise<ISRCacheEntry | undefined>>();

  return async (request, pathname) => {
    const entry = await cache.get(pathname);
    if (entry) {
      const elapsed = Date.now() - entry.cachedAt;

      // Fresh — within s-maxage, serve directly from cache.
      if (elapsed < entry.sMaxAge * 1000) {
        log(`ISR cache HIT for ${pathname}`);
        return responseFromEntry(entry, "HIT");
      }

      // Stale — within the stale-while-revalidate window. Serve the
      // cached response immediately and kick off a background revalidation
      // (at most one per path at a time).
      if (elapsed < (entry.sMaxAge + entry.swr) * 1000) {
        log(`ISR cache STALE for ${pathname}, serving stale`);
        if (!revalidating.has(pathname)) {
          revalidating.add(pathname);
          log(`ISR revalidating ${pathname}`);
          const result = renderToEntry(
            new Request(request.url, request),
            handler,
            cache,
            pathname,
            "STALE"
          );
          result.entry
            .catch(() => {})
            .finally(() => revalidating.delete(pathname));
        }
        return responseFromEntry(entry, "STALE");
      }

      // Beyond the SWR window — discard the stale entry and fall through
      // to a full re-render below.
      log(`ISR expired entry evicted for ${pathname}`);
      await cache.delete(pathname);
    }

    // Cache miss — render via SSR, deduplicating concurrent requests for
    // the same pathname so only one render is in-flight at a time.
    log(`ISR cache MISS for ${pathname}`);
    const pending = inflight.get(pathname);
    if (!pending) {
      const result = renderToEntry(request, handler, cache, pathname, "MISS");
      inflight.set(pathname, result.entry);
      result.entry.finally(() => inflight.delete(pathname));

      // First caller gets the streaming response.
      return result.streaming;
    }

    // Subsequent callers wait for the cache entry.
    const cached = await pending;
    if (cached) return responseFromEntry(cached, "MISS");

    // Not cacheable — fall through to direct SSR.
    log(`ISR BYPASS for ${pathname} (not cacheable)`);
    const response = await handler(request);
    response.headers.set("x-astro-cache", "BYPASS");
    return response;
  };
}
