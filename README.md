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

All Astro output modes are supported: `static`, `server`, and `hybrid`. Prerendered pages are served directly from the static manifest, while dynamic routes fall through to Astro's SSR handler.

Build and run:

```bash
bun run build
bun run ./dist/server/entry.mjs
```

## How It Works

1. **Build time**: Walks `dist/client/` and generates `dist/server/static-manifest.json` with pre-computed ETags, MIME types, and cache headers for every static file.
2. **Runtime**: `Bun.serve` checks incoming requests against the manifest. Static files are served directly with proper caching (`/_astro/*` gets immutable 1-year headers). Everything else falls through to Astro's SSR handler.

## ISR (Incremental Static Regeneration)

Enable ISR to cache SSR responses in-memory using an LRU cache. Cached responses are served according to standard `Cache-Control` semantics (`s-maxage` and `stale-while-revalidate`).

```js
// astro.config.mjs
import { defineConfig } from "astro/config";
import bun from "@wyattjoh/astro-bun-adapter";

export default defineConfig({
  output: "server",
  adapter: bun({ isr: true }),
});
```

To customize the maximum cache byte size (default: 50 MB):

```js
adapter: bun({ isr: { maxByteSize: 100 * 1024 * 1024 } }), // 100 MB
```

ISR only applies to `GET` requests whose responses include an `s-maxage` directive in their `Cache-Control` header. When a cached entry enters the `stale-while-revalidate` window, the stale response is served immediately while a background revalidation runs. Concurrent requests for the same path are deduplicated so only one SSR render is in-flight at a time.

## Environment Variables

- `PORT` — Override the server port (default: from Astro config or `4321`)
- `HOST` — Override the server hostname
- `DEBUG` — Enable debug logging via the [`debug`](https://www.npmjs.com/package/debug) package. Use `DEBUG=@wyattjoh/astro-bun-adapter:*` to enable all adapter logs, or target specific subsystems:
  - `@wyattjoh/astro-bun-adapter:isr` — ISR cache hits, misses, revalidations, and bypasses
  - `@wyattjoh/astro-bun-adapter:cache` — LRU cache internals (evictions, disk persistence, restore)

## Acknowledgements

Inspired by [astro-bun-adapter](https://github.com/ido-pluto/astro-bun-adapter) by [@ido-pluto](https://github.com/ido-pluto).

## License

MIT
