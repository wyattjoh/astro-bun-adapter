# @wyattjoh/astro-bun-adapter

An Astro adapter that runs your SSR site on Bun using `Bun.serve`. Serves static files from a pre-built manifest with ETag caching and falls back to Astro SSR for dynamic routes.

## Installation

```bash
bun add @wyattjoh/astro-bun-adapter
```

## Usage

```js
// astro.config.mjs
import { defineConfig } from "astro/config";
import bun from "@wyattjoh/astro-bun-adapter";

export default defineConfig({
  output: "server",
  adapter: bun(),
});
```

Build and run:

```bash
bun run build
bun run ./dist/server/entry.mjs
```

## How It Works

1. **Build time**: Walks `dist/client/` and generates `dist/server/static-manifest.json` with pre-computed ETags, MIME types, and cache headers for every static file.
2. **Runtime**: `Bun.serve` checks incoming requests against the manifest. Static files are served directly with proper caching (`/_astro/*` gets immutable 1-year headers). Everything else falls through to Astro's SSR handler.

## Environment Variables

- `PORT` — Override the server port (default: from Astro config or `4321`)
- `HOST` — Override the server hostname

## Acknowledgements

Inspired by [astro-bun-adapter](https://github.com/ido-pluto/astro-bun-adapter) by [@ido-pluto](https://github.com/ido-pluto).

## License

MIT
