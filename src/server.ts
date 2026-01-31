import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SSRManifest } from "astro";
import { App } from "astro/app";
import { setGetEnv } from "astro/env/setup";
import { createISRHandler } from "./isr/handler.ts";
import type {
  AdapterOptions,
  ISRHandler,
  ManifestEntry,
  ServerExports,
} from "./types.ts";

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
 * query parameters — only known image params are kept, in sorted order.
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

/** Create a single App instance and derive both the request handler and the app reference from it. */
function createApp(ssrManifest: SSRManifest) {
  const app = new App(ssrManifest);

  const handler = async (request: Request): Promise<Response> => {
    const routeData = app.match(request);
    if (!routeData) {
      return app.render(request, { addCookieHeader: true });
    }
    return app.render(request, { addCookieHeader: true, routeData });
  };

  return { app, handler };
}

/**
 * Called by the generated `entry.mjs` to extract the SSR request handler.
 * Uses the Web-standard App (not NodeApp) since Bun natively supports the Fetch API.
 */
export function createExports(ssrManifest: SSRManifest): ServerExports {
  const { handler } = createApp(ssrManifest);
  return { handler };
}

/** Boot `Bun.serve` with static file serving, ETag/304 support, and optional ISR. */
export function start(ssrManifest: SSRManifest, options: AdapterOptions): void {
  const { app, handler } = createApp(ssrManifest);
  const logger = app.getAdapterLogger();

  // Resolve dirs from the file:// URLs passed through adapter args.
  const clientDir = fileURLToPath(new URL(options.client));
  const serverDir = fileURLToPath(new URL(options.server));
  const adapterDir = join(serverDir, options.adapterDir);
  const manifestPath = join(adapterDir, "static-manifest.json");
  const staticManifest = new Map<string, ManifestEntry>(
    Object.entries(JSON.parse(readFileSync(manifestPath, "utf-8")))
  );

  // ISR handler — only allocated when enabled.
  let isr: ISRHandler | undefined;
  if (options.isr) {
    const buildId = readFileSync(join(adapterDir, "build-id"), "utf-8").trim();
    const cacheDir = options.isr.cacheDir ?? join(adapterDir, "isr-cache");
    isr = createISRHandler({
      origin: handler,
      maxByteSize: options.isr.maxByteSize,
      cacheDir,
      buildId,
      preFillMemoryCache: options.isr.preFillMemoryCache,
      imageEndpointRoute: options.imageEndpointRoute,
    });
  }

  // Graceful shutdown — flush ISR cache to disk before exit.
  if (isr) {
    const shutdown = () => {
      isr
        .shutdown()
        .catch((err: unknown) => {
          console.error("ISR cache flush failed during shutdown:", err);
        })
        .finally(() => process.exit(0));
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  }

  const port = Number(process.env.PORT || options.port || 4321);
  const host =
    process.env.HOST ??
    (typeof options.host === "boolean"
      ? options.host
        ? "0.0.0.0"
        : "localhost"
      : options.host);

  Bun.serve({
    port,
    hostname: host,
    async fetch(request) {
      const url = new URL(request.url);
      const pathname = decodeURIComponent(url.pathname);

      if (request.method === "GET" || request.method === "HEAD") {
        const meta = staticManifest.get(pathname);

        if (meta) {
          if (request.headers.get("if-none-match") === meta.headers.ETag) {
            const headers = new Headers(meta.headers);
            headers.delete("Content-Length");
            headers.delete("Content-Type");
            return new Response(null, { status: 304, headers });
          }

          return new Response(Bun.file(join(clientDir, meta.filePath)), {
            status: 200,
            headers: meta.headers,
          });
        }
      }

      // ISR disabled or non-GET — passthrough to SSR.
      if (!isr || request.method !== "GET") {
        return handler(request);
      }

      const cacheKey = pathname.startsWith(options.imageEndpointRoute)
        ? buildImageCacheKey(pathname, url.searchParams)
        : pathname;
      return isr(request, cacheKey);
    },
  });

  logger.info(`Server listening on http://${host}:${port}`);
}
