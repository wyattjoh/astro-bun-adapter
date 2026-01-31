import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
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
  return `${pathname}?${normalized.toString()}`;
}

// Internal helper — creates a single App instance and derives both the
// request handler and the app reference from it.
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

// Called by the generated entry.mjs to extract the SSR request handler.
// Uses the Web-standard App (not NodeApp) since Bun natively supports the
// Fetch API — no Node http.IncomingMessage/ServerResponse conversion needed.
export function createExports(ssrManifest: SSRManifest): ServerExports {
  const { handler } = createApp(ssrManifest);
  return { handler };
}

// Called by entry.mjs with the adapter args (see index.ts).
// Owns the full server — static file serving + SSR fallback.
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
    const cacheDir = isAbsolute(options.isr.cacheDir)
      ? options.isr.cacheDir
      : join(adapterDir, options.isr.cacheDir);
    isr = createISRHandler(
      handler,
      options.isr.maxByteSize,
      cacheDir,
      buildId,
      options.isr.preFillMemoryCache,
      options.imageEndpointRoute
    );
  }

  // Graceful shutdown — flush ISR cache to disk before exit.
  if (isr) {
    const shutdown = () => {
      isr.shutdown().finally(() => process.exit(0));
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
      const meta = staticManifest.get(pathname);

      if (meta) {
        if (request.headers.get("if-none-match") === meta.headers.ETag) {
          return new Response(null, { status: 304 });
        }

        return new Response(Bun.file(join(clientDir, pathname.slice(1))), {
          status: 200,
          headers: meta.headers,
        });
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
