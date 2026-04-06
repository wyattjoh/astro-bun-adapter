import type { AdapterOptions } from "./types.ts";

const VIRTUAL_MODULE_ID = "virtual:@wyattjoh/astro-bun-adapter/config";
const RESOLVED_VIRTUAL_MODULE_ID = `\0${VIRTUAL_MODULE_ID}`;

const SERVER_ENVIRONMENTS = ["ssr", "prerender", "astro"];

/** Create a Vite plugin that exposes adapter options as a virtual module. */
export function createConfigPlugin(): {
  plugin: NonNullable<import("astro").AstroConfig["vite"]["plugins"]>[number];
  setConfig: (config: AdapterOptions) => void;
} {
  let config: AdapterOptions | undefined;

  const plugin = {
    name: "virtual:@wyattjoh/astro-bun-adapter/config",
    configEnvironment(environmentName: string) {
      if (SERVER_ENVIRONMENTS.includes(environmentName)) {
        return {
          resolve: {
            noExternal: ["@wyattjoh/astro-bun-adapter"],
          },
        };
      }
    },
    resolveId: {
      filter: {
        id: new RegExp(
          `^${VIRTUAL_MODULE_ID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`
        ),
      },
      handler() {
        return RESOLVED_VIRTUAL_MODULE_ID;
      },
    },
    load: {
      filter: {
        id: new RegExp(
          `^${RESOLVED_VIRTUAL_MODULE_ID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`
        ),
      },
      handler() {
        if (!config) {
          throw new Error(
            "@wyattjoh/astro-bun-adapter: config not initialized — load() called before astro:config:done"
          );
        }
        return Object.entries(config)
          .map(([k, v]) => `export const ${k} = ${JSON.stringify(v)};`)
          .join("\n");
      },
    },
  };

  return {
    plugin,
    setConfig: (c: AdapterOptions) => {
      config = c;
    },
  };
}
