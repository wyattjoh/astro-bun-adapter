import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  adapterDir as adapterDirRelative,
  host as configHost,
  port as configPort,
  imageEndpointRoute,
  isr as isrConfig,
} from "virtual:@wyattjoh/astro-bun-adapter/config";
import { createApp } from "astro/app/entrypoint";
import { setGetEnv } from "astro/env/setup";
import { registerCache } from "./cache.ts";
import { CACHE_HEADER } from "./constants.ts";
import { createISRHandler } from "./isr/handler.ts";
import type { ISRHandler, ManifestEntry } from "./types.ts";

// Required for astro:env/server to resolve env vars at runtime.
setGetEnv((key) => process.env[key]);

/** Known Astro image endpoint query parameters, pre-sorted for deterministic output. */
const IMAGE_PARAMS = [
  "background",
  "f",
  "fit",
  "h",
  "href",
  "position",
  "q",
  "w",
];

/**
 * Build a deterministic cache key for image endpoint requests by normalizing
 * query parameters -- only known image params are kept, in sorted order.
 */
export function buildImageCacheKey(
  pathname: string,
  params: URLSearchParams
): string {
  const normalized = new URLSearchParams();
  for (const key of IMAGE_PARAMS) {
    const value = params.get(key);
    if (value !== null) normalized.set(key, value);
  }
  const qs = normalized.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

/**
 * Compute the server-islands URL prefix for a given `base`. Astro emits
 * island URLs as `${base}${slash}_server-islands/...` where `slash` is
 * empty when `base` already ends with `/`. `base` is not guaranteed to end
 * with a slash -- it depends on `trailingSlash` config.
 */
export function computeServerIslandsPrefix(base: string): string {
  const slash = base.endsWith("/") ? "" : "/";
  return `${base}${slash}_server-islands/`;
}

/**
 * Compute the runtime image endpoint path by joining `base` with the
 * image endpoint route. Astro emits image URLs as
 * `joinPaths(BASE_URL, image.endpoint.route)`, so the incoming pathname
 * is base-prefixed and must be matched against the same.
 */
export function computeImageEndpointPath(base: string, route: string): string {
  const baseWithoutTrailing = base.endsWith("/") ? base.slice(0, -1) : base;
  const routeWithLeadingSlash = route.startsWith("/") ? route : `/${route}`;
  return `${baseWithoutTrailing}${routeWithLeadingSlash}`;
}

const app = createApp();
const logger = app.adapterLogger;
const { manifest } = app;

// Resolve dirs from the manifest URL objects.
const clientDir = fileURLToPath(manifest.buildClientDir);
const serverDir = fileURLToPath(manifest.buildServerDir);
const adapterDir = join(serverDir, adapterDirRelative);
const base = manifest.base;

const manifestPath = join(adapterDir, "static-manifest.json");
const staticManifest = new Map<string, ManifestEntry>(
  Object.entries(JSON.parse(readFileSync(manifestPath, "utf-8")))
);

// Base-prefixed paths used for request routing. `base` may or may not
// end with `/` depending on `trailingSlash` config, and Astro emits
// both server-island and image endpoint URLs with `base` prepended.
const serverIslandsPrefix = computeServerIslandsPrefix(base);
const imageEndpointPath = computeImageEndpointPath(base, imageEndpointRoute);

/** SSR request handler. */
export const handler = async (request: Request): Promise<Response> => {
  const routeData = app.match(request);
  if (!routeData) {
    return app.render(request, { addCookieHeader: true });
  }
  return app.render(request, { addCookieHeader: true, routeData });
};

export default handler;

// ISR handler -- only allocated when enabled.
let isr: ISRHandler | undefined;
if (isrConfig) {
  const buildId = readFileSync(join(adapterDir, "build-id"), "utf-8").trim();
  const cacheDir = isrConfig.cacheDir ?? join(adapterDir, "isr-cache");
  isr = createISRHandler({
    origin: handler,
    maxByteSize: isrConfig.maxByteSize,
    cacheDir,
    buildId,
    preFillMemoryCache: isrConfig.preFillMemoryCache,
    imageEndpointRoute: imageEndpointPath,
  });
  registerCache(isr.cache);
}

// Graceful shutdown -- flush ISR cache to disk before exit.
if (isr) {
  const shutdown = () => {
    isr
      ?.shutdown()
      .catch((err: unknown) => {
        console.error("ISR cache flush failed during shutdown:", err);
      })
      .finally(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

const port = Number(process.env.PORT || configPort || 4321);
const host =
  process.env.HOST ??
  (typeof configHost === "boolean"
    ? configHost
      ? "0.0.0.0"
      : "localhost"
    : configHost);

Bun.serve({
  port,
  hostname: host,
  async fetch(request, server) {
    const url = new URL(request.url);
    const pathname = decodeURIComponent(url.pathname);

    if (request.method === "GET" || request.method === "HEAD") {
      const meta = staticManifest.get(pathname);

      if (meta) {
        const headers = new Headers(meta.headers);
        headers.set(CACHE_HEADER, "STATIC");

        if (request.headers.get("if-none-match") === headers.get("etag")) {
          headers.delete("Content-Length");
          headers.delete("Content-Type");
          return new Response(null, { status: 304, headers });
        }

        return new Response(Bun.file(join(clientDir, meta.filePath)), {
          status: 200,
          headers,
        });
      }
    }

    // Extract client address from Bun's server API.
    const socketAddress = server.requestIP(request);
    const clientAddress = socketAddress?.address;

    // Server island requests bypass ISR (encrypted query params are unique per request).
    if (pathname.startsWith(serverIslandsPrefix)) {
      const response = await app.render(request, {
        addCookieHeader: true,
        routeData: app.match(request),
        clientAddress,
      });
      response.headers.set(CACHE_HEADER, "BYPASS");
      return response;
    }

    // ISR disabled or non-GET -- passthrough to SSR.
    if (!isr || request.method !== "GET") {
      const routeData = app.match(request);
      const response = await app.render(request, {
        addCookieHeader: true,
        routeData,
        clientAddress,
      });
      response.headers.set(CACHE_HEADER, "BYPASS");
      return response;
    }

    const cacheKey = pathname.startsWith(imageEndpointPath)
      ? buildImageCacheKey(pathname, url.searchParams)
      : pathname;
    return isr(request, cacheKey);
  },
});

logger.info(`Server listening on http://${host}:${port}`);
