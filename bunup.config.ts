import type { BunPlugin } from "bun";
import { defineConfig } from "bunup";

const virtualModulePlugin: BunPlugin = {
  name: "externalize-virtual-modules",
  setup(build) {
    build.onResolve({ filter: /^virtual:/ }, (args) => ({
      path: args.path,
      external: true,
    }));
  },
};

export default defineConfig({
  entry: ["src/index.ts", "src/server.ts", "src/cache.ts"],
  target: "bun",
  format: "esm",
  dts: true,
  sourcemap: true,
  clean: true,
  packages: "external",
  plugins: [virtualModulePlugin],
});
