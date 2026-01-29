import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SSRManifest } from "astro";
import { App } from "astro/app";
import { setGetEnv } from "astro/env/setup";
import { createISRHandler } from "./isr.ts";
import type { AdapterOptions, ManifestEntry } from "./types.ts";

// Required for astro:env/server to resolve env vars at runtime.
setGetEnv((key) => process.env[key]);

// Called by the generated entry.mjs to extract the SSR request handler.
// Uses the Web-standard App (not NodeApp) since Bun natively supports the
// Fetch API — no Node http.IncomingMessage/ServerResponse conversion needed.
export function createExports(ssrManifest: SSRManifest) {
  const app = new App(ssrManifest);

  const handler = async (request: Request): Promise<Response> => {
    const routeData = app.match(request);
    if (!routeData) {
      return app.render(request, { addCookieHeader: true });
    }
    return app.render(request, { addCookieHeader: true, routeData });
  };

  return { handler };
}

// Called by entry.mjs with the adapter args (see index.ts).
// Owns the full server — static file serving + SSR fallback.
export function start(ssrManifest: SSRManifest, options: AdapterOptions) {
  const { handler } = createExports(ssrManifest);

  // Resolve dirs from the file:// URLs passed through adapter args.
  const clientDir = fileURLToPath(new URL(options.client));
  const serverDir = fileURLToPath(new URL(options.server));
  const manifestPath = join(serverDir, "static-manifest.json");
  const staticManifest = new Map<string, ManifestEntry>(
    Object.entries(JSON.parse(readFileSync(manifestPath, "utf-8")))
  );

  // ISR handler — only allocated when enabled.
  const isr = options.isr
    ? createISRHandler(handler, options.isr.maxByteSize)
    : undefined;

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
        if (request.headers.get("if-none-match") === meta.etag) {
          return new Response(null, { status: 304 });
        }

        const headers: Record<string, string> = {
          "Cache-Control": meta.cacheControl,
          ETag: meta.etag,
          "Content-Length": String(meta.size),
        };
        if (meta.contentType) headers["Content-Type"] = meta.contentType;

        return new Response(Bun.file(join(clientDir, pathname.slice(1))), {
          status: 200,
          headers,
        });
      }

      // ISR disabled or non-GET — passthrough to SSR.
      if (!isr || request.method !== "GET") {
        return handler(request);
      }

      return isr(request, pathname);
    },
  });

  console.log(`Server listening on http://${host}:${port}`);
}
