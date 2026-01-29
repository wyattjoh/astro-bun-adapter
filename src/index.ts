import type { AstroAdapter, AstroConfig, AstroIntegration } from "astro";
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

export default function bunAdapter(): AstroIntegration {
  let config: AstroConfig | undefined;

  return {
    name: "@wyattjoh/astro-bun-adapter",
    hooks: {
      "astro:config:setup": ({ updateConfig, config: currentConfig }) => {
        updateConfig({
          build: {
            redirects: false,
          },
          image: {
            endpoint: {
              route: currentConfig.image.endpoint.route ?? "_image",
              // Bun is Node-compatible, so the Node image endpoint works here.
              entrypoint:
                currentConfig.image.endpoint.entrypoint ??
                "astro/assets/endpoint/node",
            },
          },
        });
      },
      "astro:config:done": ({ setAdapter, config: doneConfig }) => {
        config = doneConfig;
        setAdapter(
          getAdapter({
            host: doneConfig.server.host,
            port: doneConfig.server.port,
            client: doneConfig.build.client.toString(),
            server: doneConfig.build.server.toString(),
          })
        );
      },
      "astro:build:done": async () => {
        if (!config) return;

        const clientDir = new URL(config.build.client, config.outDir);
        const serverDir = new URL(config.build.server, config.outDir);
        await generateStaticManifest(clientDir.pathname, serverDir.pathname);
      },
    },
  };
}
