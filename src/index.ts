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
import type { AdapterOptions } from "./types.ts";

export type { AdapterOptions } from "./types.ts";

/** Build the Astro adapter descriptor with supported features and serialized options. */
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
  isr?:
    | boolean
    | {
        maxByteSize?: number;
        cacheDir?: string;
        preFillMemoryCache?: boolean;
      };
}

/** Create the Astro integration that configures and registers the Bun adapter. */
export default function bunAdapter(
  adapterConfig?: BunAdapterConfig
): AstroIntegration {
  let config: AstroConfig | undefined;
  let command: string | undefined;
  let adapterDir: string | undefined;
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
        type ISRConfig = NonNullable<Exclude<BunAdapterConfig["isr"], boolean>>;
        const isrConfig: ISRConfig =
          typeof adapterConfig?.isr === "object" ? adapterConfig.isr : {};
        const relativeAdapterDir = ".astro-bun-adapter";
        adapterDir = join(
          fileURLToPath(new URL(doneConfig.build.server)),
          relativeAdapterDir
        );
        setAdapter(
          getAdapter({
            host: doneConfig.server.host,
            port: doneConfig.server.port,
            client: doneConfig.build.client.toString(),
            server: doneConfig.build.server.toString(),
            adapterDir: relativeAdapterDir,
            assets: doneConfig.build.assets,
            imageEndpointRoute: doneConfig.image.endpoint.route.startsWith("/")
              ? doneConfig.image.endpoint.route
              : `/${doneConfig.image.endpoint.route}`,
            // ISR is disabled in dev mode — it only applies to production builds
            // where SSR responses can be cached based on s-maxage / stale-while-revalidate.
            isr:
              !isDevMode && adapterConfig?.isr
                ? {
                    maxByteSize: isrConfig.maxByteSize ?? 50 * 1024 * 1024,
                    cacheDir: isrConfig.cacheDir ?? "isr-cache",
                    preFillMemoryCache: isrConfig.preFillMemoryCache ?? false,
                  }
                : false,
          })
        );
      },
      "astro:build:generated": ({ experimentalRouteToHeaders }) => {
        routeToHeaders = experimentalRouteToHeaders;
      },
      "astro:build:done": async () => {
        if (!config || !adapterDir) return;

        const clientDir = new URL(config.build.client, config.outDir);
        await mkdir(adapterDir, { recursive: true });

        // Serialize routeToHeaders (e.g. CSP) so the manifest can attach
        // extra headers directly to matching static file entries.
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
          serializedRouteHeaders
        );

        // Write a unique build ID so the server can namespace its ISR cache
        // per build, allowing old caches to be vacuumed on mounted volumes.
        const buildId = randomUUID();
        await writeFile(join(adapterDir, "build-id"), buildId);
      },
    },
  };
}
