import type {
  AstroAdapter,
  AstroConfig,
  AstroIntegration,
  RouteToHeaders,
} from "astro";
import { generateStaticManifest } from "./manifest.ts";
import type { AdapterOptions } from "./types.ts";

export type { AdapterOptions } from "./types.ts";

function getAdapter(options: AdapterOptions): AstroAdapter {
  return {
    name: "@wyattjoh/astro-bun-adapter",
    serverEntrypoint: "@wyattjoh/astro-bun-adapter/server.js",
    exports: ["handler"],
    // Serialized as a JSON literal into dist/server/entry.mjs at build time.
    // This happens during server entrypoint bundling (before client build),
    // so only config-derived values can go here — not build artifacts like
    // the static manifest which doesn't exist yet.
    args: options,
    adapterFeatures: {
      buildOutput: "server",
      edgeMiddleware: false,
      experimentalStaticHeaders: true,
    },
    supportedAstroFeatures: {
      hybridOutput: "stable",
      staticOutput: "stable",
      serverOutput: "stable",
      sharpImageService: "stable",
      envGetSecret: "stable",
    },
  };
}

/** User-facing configuration for the Bun adapter. */
interface BunAdapterConfig {
  /**
   * Enable ISR (Incremental Static Regeneration). When `true`, SSR responses
   * with `s-maxage` and optional `stale-while-revalidate` Cache-Control
   * directives are cached in-memory (up to 50 MB by default) and served
   * according to standard cache semantics. Pass an object to customize the
   * maximum cache byte size. Disabled by default — zero overhead when off.
   *
   * @default false
   *
   * @example
   * // Use defaults (maxByteSize: 50 MB)
   * bunAdapter({ isr: true })
   *
   * @example
   * // Custom cache byte size (100 MB)
   * bunAdapter({ isr: { maxByteSize: 100 * 1024 * 1024 } })
   */
  isr?: boolean | { maxByteSize?: number };
}

export default function bunAdapter(
  adapterConfig?: BunAdapterConfig
): AstroIntegration {
  let config: AstroConfig | undefined;
  let command: string | undefined;
  let routeToHeaders: RouteToHeaders | undefined;

  return {
    name: "@wyattjoh/astro-bun-adapter",
    hooks: {
      "astro:config:setup": (options) => {
        command = options.command;
        const { updateConfig, config: currentConfig } = options;
        updateConfig({
          build: {
            redirects: false,
          },
          image: {
            endpoint: {
              route: currentConfig.image.endpoint.route ?? "_image",
              entrypoint:
                currentConfig.image.endpoint.entrypoint ??
                (options.command === "dev"
                  ? "astro/assets/endpoint/dev"
                  : "astro/assets/endpoint/node"),
            },
          },
          session: {
            driver: currentConfig.session?.driver ?? "fs-lite",
          },
          vite: {
            ssr: {
              noExternal: ["@wyattjoh/astro-bun-adapter"],
            },
          },
        });
      },
      "astro:config:done": ({ setAdapter, config: doneConfig }) => {
        config = doneConfig;
        const isDevMode = command === "dev";
        setAdapter(
          getAdapter({
            host: doneConfig.server.host,
            port: doneConfig.server.port,
            client: doneConfig.build.client.toString(),
            server: doneConfig.build.server.toString(),
            assets: doneConfig.build.assets,
            // ISR is disabled in dev mode — it only applies to production builds
            // where SSR responses can be cached based on s-maxage / stale-while-revalidate.
            isr:
              !isDevMode && adapterConfig?.isr
                ? {
                    maxByteSize:
                      (typeof adapterConfig.isr === "object"
                        ? adapterConfig.isr.maxByteSize
                        : undefined) ?? 50 * 1024 * 1024, // 50 MB
                  }
                : false,
          })
        );
      },
      "astro:build:generated": ({ experimentalRouteToHeaders }) => {
        routeToHeaders = experimentalRouteToHeaders;
      },
      "astro:build:done": async () => {
        if (!config) return;

        const clientDir = new URL(config.build.client, config.outDir);
        const serverDir = new URL(config.build.server, config.outDir);
        await generateStaticManifest(
          clientDir.pathname,
          serverDir.pathname,
          config.build.assets
        );

        if (routeToHeaders && routeToHeaders.size > 0) {
          const { writeFile } = await import("node:fs/promises");
          const { join } = await import("node:path");
          const headersPath = join(serverDir.pathname, "_static-headers.json");
          // Serialize the Map<string, HeaderPayload> to a JSON-friendly format.
          const serialized: Record<string, Record<string, string>> = {};
          for (const [route, payload] of routeToHeaders) {
            const headers: Record<string, string> = {};
            payload.headers.forEach((value, key) => {
              headers[key] = value;
            });
            serialized[route] = headers;
          }
          await writeFile(headersPath, JSON.stringify(serialized));
        }
      },
    },
  };
}
