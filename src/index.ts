import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AstroAdapter,
  AstroConfig,
  AstroIntegration,
  RouteToHeaders,
} from "astro";
import { generateStaticManifest } from "./manifest.ts";
import { createConfigPlugin } from "./vite-plugin-config.ts";

export type { AdapterOptions } from "./types.ts";

/** Build the Astro adapter descriptor with supported features. */
function getAdapter(): AstroAdapter {
  return {
    name: "@wyattjoh/astro-bun-adapter",
    serverEntrypoint: "@wyattjoh/astro-bun-adapter/server.js",
    entrypointResolution: "auto",
    adapterFeatures: {
      buildOutput: "server",
      middlewareMode: "classic",
      staticHeaders: true,
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

/**
 * User-facing ISR (Incremental Static Regeneration) configuration options.
 * All properties are optional — omitted values use their documented defaults.
 */
export interface ISRConfig {
  /**
   * Maximum byte size of the in-memory LRU cache. Entries evicted from memory
   * are persisted to disk and reloaded on demand.
   *
   * @default 50 * 1024 * 1024 // (50 MB)
   */
  maxByteSize?: number;

  /**
   * Absolute path to the directory for persistent ISR cache storage.
   *
   * @default "<server directory>/.astro-bun-adapter/isr-cache"
   */
  cacheDir?: string;

  /**
   * Whether to pre-fill the in-memory LRU cache from disk at startup. When
   * `false`, the disk index is restored for L2 fallback but entries are only
   * loaded into memory on first access.
   *
   * @default false
   */
  preFillMemoryCache?: boolean;
}

/** User-facing configuration for the Bun adapter. */
interface BunAdapterConfig {
  /**
   * Override the default `Cache-Control` header for non-hashed static assets.
   * Hashed assets under `/_astro/` always use
   * `public, max-age=31536000, immutable`. Route-level
   * `staticHeaders` still take precedence over this value.
   *
   * @default "public, max-age=86400, must-revalidate"
   */
  staticCacheControl?: string;

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
   * bun({ isr: true })
   *
   * @example
   * // Custom cache byte size (100 MB)
   * bun({ isr: { maxByteSize: 100 * 1024 * 1024 } })
   */
  isr?: boolean | ISRConfig;
}

/** Create the Astro integration that configures and registers the Bun adapter. */
export default function bun(
  adapterConfig?: BunAdapterConfig
): AstroIntegration {
  const staticCacheControl =
    adapterConfig?.staticCacheControl ??
    "public, max-age=86400, must-revalidate";

  let config: AstroConfig | undefined;
  let command: string | undefined;
  let adapterDir: string | undefined;
  let routeToHeaders: RouteToHeaders | undefined;

  const { plugin: configPlugin, setConfig } = createConfigPlugin();

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
            plugins: [configPlugin],
          },
        });
      },
      "astro:config:done": ({ setAdapter, config: doneConfig }) => {
        config = doneConfig;
        const isDevMode = command === "dev";
        const isrConfig: ISRConfig =
          typeof adapterConfig?.isr === "object" ? adapterConfig.isr : {};
        const relativeAdapterDir = ".astro-bun-adapter";
        adapterDir = join(
          fileURLToPath(new URL(doneConfig.build.server)),
          relativeAdapterDir
        );

        setConfig({
          host: doneConfig.server.host,
          port: doneConfig.server.port,
          adapterDir: relativeAdapterDir,
          staticCacheControl,
          imageEndpointRoute: doneConfig.image.endpoint.route.startsWith("/")
            ? doneConfig.image.endpoint.route
            : `/${doneConfig.image.endpoint.route}`,
          isr:
            !isDevMode && adapterConfig?.isr
              ? {
                  maxByteSize: isrConfig.maxByteSize ?? 50 * 1024 * 1024,
                  cacheDir: isrConfig.cacheDir,
                  preFillMemoryCache: isrConfig.preFillMemoryCache ?? false,
                }
              : false,
        });

        setAdapter(getAdapter());
      },
      "astro:build:generated": ({ routeToHeaders: rth }) => {
        routeToHeaders = rth;
      },
      "astro:build:done": async () => {
        if (!config || !adapterDir) return;

        const clientDir = new URL(config.build.client, config.outDir);
        await mkdir(adapterDir, { recursive: true });

        let serializedRouteHeaders:
          | Record<string, Record<string, string>>
          | undefined;
        if (routeToHeaders && routeToHeaders.size > 0) {
          serializedRouteHeaders = {};
          for (const [route, payload] of routeToHeaders) {
            const headers: Record<string, string> = {};
            payload.headers.forEach((value, key) => {
              headers[key] = value;
            });
            serializedRouteHeaders[route] = headers;
          }
        }

        await generateStaticManifest(
          clientDir.pathname,
          adapterDir,
          config.build.assets,
          serializedRouteHeaders,
          staticCacheControl
        );

        const buildId = randomUUID();
        await writeFile(join(adapterDir, "build-id"), buildId);
      },
    },
  };
}
