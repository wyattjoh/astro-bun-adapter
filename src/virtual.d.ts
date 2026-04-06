declare module "virtual:@wyattjoh/astro-bun-adapter/config" {
  import type { ISROptions } from "./types.ts";

  export const host: string | boolean;
  export const port: number;
  export const adapterDir: string;
  export const staticCacheControl: string;
  export const imageEndpointRoute: string;
  export const isr: false | ISROptions;
}
