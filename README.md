# @wyattjoh/astro-bun-adapter

An Astro adapter that runs your SSR site on Bun using `Bun.serve`.

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

## Features

- **All output modes** — `static`, `server`, and `hybrid` are all supported.
- **Optimized static serving** — Pre-rendered pages and static assets are served directly from a build-time manifest with ETag/304 support. Vite-hashed assets (`/_astro/*`) get immutable 1-year cache headers. Pre-rendered HTML pages are accessible via clean URLs (e.g. `/about` serves `/about/index.html`).
- **Route-level headers** — When Astro's `experimentalStaticHeaders` is enabled, per-route headers (e.g. `Content-Security-Policy`) are included in static responses.
- **ISR (Incremental Static Regeneration)** — Optional two-tier cache for SSR responses. See [ISR](#isr-incremental-static-regeneration-1) below.

## ISR (Incremental Static Regeneration)

Enable ISR to cache SSR responses using an in-memory LRU backed by persistent disk storage. Cached responses are served according to `Cache-Control` semantics (`s-maxage` and `stale-while-revalidate`).

```js
// astro.config.mjs
import { defineConfig } from "astro/config";
import bun from "@wyattjoh/astro-bun-adapter";

export default defineConfig({
  output: "server",
  adapter: bun({ isr: true }),
});
```

To customize ISR options:

```js
adapter: bun({
  isr: {
    maxByteSize: 100 * 1024 * 1024, // In-memory budget (default: 50 MB)
    cacheDir: "/tmp/my-cache",       // Disk cache directory (default: dist/server/.astro-bun-adapter/isr-cache)
    preFillMemoryCache: false,       // Load disk cache into memory on startup (default: false)
  },
}),
```

- Responses must include `Cache-Control: s-maxage=N` to be cached. Stale entries within the `stale-while-revalidate` window are served immediately while revalidating in the background.
- Concurrent requests for the same path are deduplicated — only one SSR render runs at a time.
- Image endpoint responses are automatically ISR-cacheable (the adapter adds `s-maxage` to Astro's image `Cache-Control`).
- The cache survives restarts: evicted entries stay on disk and reload on demand. Each build gets its own cache namespace, and old caches are cleaned up automatically.
- Responses include an `x-astro-cache` header: `HIT`, `STALE`, `MISS`, or `BYPASS`.

### On-Demand Cache Expiration (Experimental)

> **Note:** This API is unstable and experimental. The function names and behavior may change in a future release without following semver.

You can expire individual ISR cache entries on demand using `unstable_expirePath`. The entry is deleted from the cache and will be lazily re-rendered on the next request.

```ts
import { unstable_expirePath, unstable_expireAll } from "@wyattjoh/astro-bun-adapter/cache";

// Expire a single path:
await unstable_expirePath("/blog/my-post");

// Expire all cached paths:
await unstable_expireAll();
```

Both functions are no-ops when ISR is not enabled, so they're safe to call unconditionally.

## Environment Variables

- `PORT` — Override the server port (default: from Astro config or `4321`)
- `HOST` — Override the server hostname
- `DEBUG` — Enable debug logging via the [`debug`](https://www.npmjs.com/package/debug) package. Use `DEBUG=@wyattjoh/astro-bun-adapter:*` for all adapter logs, or target specific subsystems:
  - `@wyattjoh/astro-bun-adapter:isr` — ISR cache hits, misses, revalidations, and bypasses
  - `@wyattjoh/astro-bun-adapter:cache` — LRU cache internals (evictions, disk persistence, restore)
  - `@wyattjoh/astro-bun-adapter:expire` — On-demand cache expiration via `unstable_expirePath` / `unstable_expireAll`

## Acknowledgements

Inspired by [astro-bun-adapter](https://github.com/ido-pluto/astro-bun-adapter) by [@ido-pluto](https://github.com/ido-pluto).

## License

MIT
