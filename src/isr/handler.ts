import { parse as parseCacheControl } from "cache-control-parser";
import debug from "debug";
import type { ISRCacheEntry, ISRHandler } from "../types.ts";
import { PersistentLRUCache } from "./cache.ts";

const log = debug("@wyattjoh/astro-bun-adapter:isr");

/**
 * Cache-Control header applied to image endpoint responses. Astro's image
 * endpoint hardcodes `public, max-age=31536000` without `s-maxage`, so
 * without this override image responses would always bypass ISR.
 */
const IMAGE_CACHE_CONTROL =
  "public, max-age=31536000, s-maxage=31536000, stale-while-revalidate=86400";

/** Parse `Cache-Control` from response headers and build an ISR cache entry if `s-maxage` is set. */
function buildCacheEntry(
  headers: [string, string][],
  status: number,
  body: Uint8Array
): ISRCacheEntry | undefined {
  const ccHeader =
    headers.find(([name]) => name === "cache-control")?.[1] ?? "";
  const cc = parseCacheControl(ccHeader);
  const sMaxAge = cc["s-maxage"];
  if (!sMaxAge || sMaxAge <= 0) return undefined;

  const swr = cc["stale-while-revalidate"] ?? 0;

  return {
    body,
    headers,
    status,
    cachedAt: Date.now(),
    sMaxAge,
    swr,
  };
}

/** Possible ISR cache states attached to responses via the `x-astro-cache` header. */
type CacheStatus = "HIT" | "STALE" | "MISS" | "BYPASS";

/** Reconstruct a `Response` from a cached entry, attaching the `x-astro-cache` header. */
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

/** The dual-promise result of an SSR render: a streaming response and a cache entry. */
interface RenderResult {
  streaming: Promise<Response>;
  entry: Promise<ISRCacheEntry | undefined>;
}

/** Render a request via SSR, cache the result if eligible, and return both a streaming response and the cache entry promise. */
function renderToEntry(
  request: Request,
  handler: (request: Request) => Promise<Response>,
  cache: PersistentLRUCache,
  cacheKey: string,
  cacheStatus: CacheStatus,
  imageEndpointRoute: string
): RenderResult {
  const done = handler(request).then((response) => {
    const clone = response.clone();
    // Capture clean headers and status before mutating the response with x-astro-cache.
    const headers: [string, string][] = Array.from(clone.headers.entries());

    // When this is the image endpoint, override the cache-control header to ensure that
    // it is cacheable by ISR.
    if (
      cacheKey === imageEndpointRoute ||
      cacheKey.startsWith(`${imageEndpointRoute}?`)
    ) {
      for (let i = 0; i < headers.length; i++) {
        if (headers[i][0] === "cache-control") {
          headers[i] = [headers[i][0], IMAGE_CACHE_CONTROL];
          break;
        }
      }
    }
    const { status } = clone;

    const entryPromise = clone.arrayBuffer().then(async (buf) => {
      const body = new Uint8Array(buf);
      const entry = buildCacheEntry(headers, status, body);
      if (entry) {
        log(
          `ISR cached ${cacheKey} (s-maxage=${entry.sMaxAge}, swr=${entry.swr})`
        );
        await cache.set(cacheKey, entry);
      }
      return entry;
    });

    // Add the cache status header to the original response.
    response.headers.set("x-astro-cache", cacheStatus);

    return { response, entryPromise };
  });

  return {
    streaming: done.then(({ response }) => response),
    entry: done.then(({ entryPromise }) => entryPromise),
  };
}

/** Options for creating an ISR handler. */
interface ISRHandlerOptions {
  origin: (request: Request) => Promise<Response>;
  maxByteSize: number;
  cacheDir: string;
  buildId: string;
  preFillMemoryCache: boolean;
  imageEndpointRoute: string;
}

/** Create an ISR handler with LRU caching, stale-while-revalidate, and request coalescing. */
export function createISRHandler(options: ISRHandlerOptions): ISRHandler {
  const {
    origin,
    maxByteSize,
    cacheDir,
    buildId,
    preFillMemoryCache,
    imageEndpointRoute,
  } = options;
  const cache = new PersistentLRUCache({
    maxByteSize,
    cacheDir,
    buildId,
    preFillMemoryCache,
  });
  const revalidating = new Set<string>();
  const inflight = new Map<string, Promise<ISRCacheEntry | undefined>>();

  const handler = (async (request, cacheKey) => {
    const entry = await cache.get(cacheKey);
    if (entry) {
      const elapsed = Date.now() - entry.cachedAt;

      // Fresh — within s-maxage, serve directly from cache.
      if (elapsed < entry.sMaxAge * 1000) {
        log(`ISR cache HIT for ${cacheKey}`);
        return responseFromEntry(entry, "HIT");
      }

      // Stale — within the stale-while-revalidate window. Serve the
      // cached response immediately and kick off a background revalidation
      // (at most one per key at a time).
      if (elapsed < (entry.sMaxAge + entry.swr) * 1000) {
        log(`ISR cache STALE for ${cacheKey}, serving stale`);
        if (!revalidating.has(cacheKey)) {
          revalidating.add(cacheKey);
          log(`ISR revalidating ${cacheKey}`);
          const result = renderToEntry(
            new Request(request.url, request),
            origin,
            cache,
            cacheKey,
            "STALE",
            imageEndpointRoute
          );
          result.entry
            .catch(() => {})
            .finally(() => revalidating.delete(cacheKey));
        }
        return responseFromEntry(entry, "STALE");
      }

      // Beyond the SWR window — discard the stale entry and fall through
      // to a full re-render below.
      log(`ISR expired entry evicted for ${cacheKey}`);
      await cache.delete(cacheKey);
    }

    // Cache miss — render via SSR, deduplicating concurrent requests for
    // the same cache key so only one render is in-flight at a time.
    log(`ISR cache MISS for ${cacheKey}`);
    const pending = inflight.get(cacheKey);
    if (!pending) {
      const result = renderToEntry(
        request,
        origin,
        cache,
        cacheKey,
        "MISS",
        imageEndpointRoute
      );
      inflight.set(cacheKey, result.entry);
      result.entry.finally(() => inflight.delete(cacheKey));

      // First caller gets the streaming response.
      return result.streaming;
    }

    // Subsequent callers wait for the cache entry.
    const cached = await pending;
    if (cached) return responseFromEntry(cached, "MISS");

    // Not cacheable — fall through to direct SSR.
    log(`ISR BYPASS for ${cacheKey} (not cacheable)`);
    const response = await origin(request);
    response.headers.set("x-astro-cache", "BYPASS");
    return response;
  }) as ISRHandler;

  handler.shutdown = () => cache.save();

  return handler;
}
