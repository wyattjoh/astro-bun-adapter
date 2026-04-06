# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Astro adapter for Bun (`@wyattjoh/astro-bun-adapter`). Enables Astro SSR sites to run on `Bun.serve` with optimized static file serving via a pre-computed manifest and ISR (Incremental Static Regeneration) support.

## Commands

- **Build**: `bun run build` — runs `bunup` to bundle `src/index.ts`, `src/server.ts`, and `src/cache.ts` (target: bun, format: esm, with declarations, sourcemaps, all packages external)
- **Test**: `bun run test` — runs Bun's built-in test runner concurrently on `src/`
- **Single test**: `bun test src/path/to/file.test.ts`
- **Typecheck**: `bun run typecheck` — runs `tsc --noEmit`
- **Lint**: `bun run lint` — runs Biome (`biome check .`)
- **Lint fix**: `bun run lint:fix` — runs Biome with auto-fix
- **Format**: `bun run format` — runs Biome formatter

Pre-commit hook (via Husky) runs lint, test, and typecheck automatically.

## Architecture

Source files in `src/`:

- **`index.ts`** — The Astro integration entry point. Exports `bun()` which hooks into Astro's build lifecycle: configures build settings at `astro:config:setup` (including a Vite virtual module plugin for config injection and `entrypointResolution: "auto"`), registers the adapter with `staticHeaders` and `middlewareMode` adapter features at `astro:config:done`, generates the static manifest and build ID at `astro:build:done`.
- **`vite-plugin-config.ts`** — Vite 7 virtual module plugin factory. Exposes adapter config (ISR options, static cache control, etc.) to the server entrypoint at runtime via a virtual import (`virtual:@wyattjoh/astro-bun-adapter/config`), avoiding the need to serialize args into the entry file.
- **`virtual.d.ts`** — TypeScript declarations for the `virtual:@wyattjoh/astro-bun-adapter/config` virtual module.
- **`server.ts`** — The runtime server entrypoint. Imports adapter config from the virtual module (`virtual:@wyattjoh/astro-bun-adapter/config`) and creates the Astro app via `createApp()` from `astro/app/entrypoint`. Boots `Bun.serve` at the top level (no `start()` function). Looks up requests against the static manifest for direct file serving with ETag/304 support and `x-astro-cache: STATIC` headers, falls back to SSR. Wires `clientAddress` from `Bun.serve`'s `requestIP()`. Bypasses ISR for server island requests. Integrates ISR when enabled. Normalizes image endpoint query params into deterministic cache keys. Registers `SIGTERM`/`SIGINT` handlers for graceful shutdown (flushes ISR cache to disk).
- **`isr/handler.ts`** — ISR request handler. Wraps SSR origin with cache lookup/store logic. Respects `s-maxage` and `stale-while-revalidate` from `Cache-Control` headers. Deduplicates concurrent requests for the same path. Overrides Astro's image endpoint `Cache-Control` to add `s-maxage` so image responses are ISR-cacheable. Tags responses with `x-astro-cache` header (`HIT`/`STALE`/`MISS`/`BYPASS`).
- **`isr/cache.ts`** — `PersistentLRUCache`: two-tier byte-limited LRU cache. L1 is an in-memory doubly-linked list; L2 is per-entry CBOR files on disk (`{cacheDir}/{buildId}/entries/{hash}.cbor`). Evicted entries remain on disk and reload on demand. Debounced index writes, concurrent disk-read deduplication, optional memory pre-fill on startup, and automatic vacuuming of old build cache directories.
- **`manifest.ts`** — Build-time utility. Walks `dist/client/`, hashes files (SHA-256, truncated), and writes `dist/server/.astro-bun-adapter/static-manifest.json`. Generates clean URL route aliases for pre-rendered HTML pages (e.g. `/about` → `/about/index.html`). Merges `staticHeaders` route-level headers into manifest entries. Uses `node:fs/promises` and `node:crypto` because Astro build hooks run under Node, not Bun.
- **`cache.ts`** — Public API module for on-demand ISR cache expiration. Exports `unstable_expirePath(pathname)` (deletes a cached entry so it is lazily re-rendered on the next request) and `unstable_expireAll()` (clears all cached entries). Also exports `registerCache()` (internal, called by `server.ts` at startup). Uses `Symbol.for()` on `globalThis` to share the cache reference across module boundaries regardless of bundling.
- **`types.ts`** — Shared types (`AdapterOptions`, `ISROptions`, `ISRCache`, `ISRHandler`, `ManifestEntry`, `StaticManifest`, `ISRCacheEntry`).

## Key Design Decisions

- Build hooks run under **Node**, so `manifest.ts` must use `node:` APIs, not Bun APIs.
- The runtime server uses the **Web-standard `App`** (not `NodeApp`) since Bun natively supports the Fetch API.
- Adapter config is injected into the server entrypoint via a Vite virtual module (`virtual:@wyattjoh/astro-bun-adapter/config`) instead of the deprecated `args` mechanism. The config is JSON-serialized into `export const` statements at build time. At runtime, `app.manifest` provides `buildClientDir`, `buildServerDir`, and `base`.
- `/_astro/*` paths get immutable 1-year cache headers; everything else defaults to 24-hour must-revalidate (configurable via the `staticCacheControl` adapter option). Route-level `staticHeaders` take precedence over `staticCacheControl`.
- ISR caching uses `s-maxage` / `stale-while-revalidate` from response `Cache-Control` headers, with background revalidation and request coalescing.
- ISR uses a two-tier cache — entries evicted from memory (L1) remain on disk (L2) and are loaded back on demand, so memory pressure doesn't lose cached data.
- Each build writes a unique build ID; ISR cache directories are namespaced by build ID, and old build caches are vacuumed on startup.
- Image endpoint responses get an `s-maxage` override because Astro hardcodes `max-age` without `s-maxage`, which would otherwise bypass ISR.
- The production image endpoint entrypoint is pinned to `astro/assets/endpoint/node` (instead of Astro 6's default `astro/assets/endpoint/generic`) because Bun implements the `node:fs/promises` APIs the `node` endpoint uses, and the `generic` endpoint cannot read locally bundled images. Keep this override unless Astro ships a Bun-aware endpoint.
- Server-island and image endpoint URLs are emitted by Astro with `base` prepended (e.g. `base: "/docs"` yields `/docs/_server-islands/...` and `/docs/_image?...`). The server entrypoint must compute base-prefixed match paths using `computeServerIslandsPrefix()` and `computeImageEndpointPath()` in `src/server.ts`, because `manifest.base` is not guaranteed to end with `/` (it depends on `trailingSlash` config). These helpers mirror Astro's own `${base}${slash}...` pattern and are unit-tested.
- The `./server.js` package export is **internal**. It exists only so Astro can resolve it as the adapter's `serverEntrypoint` via the `@wyattjoh/astro-bun-adapter/server.js` specifier. Importing it directly starts `Bun.serve` as an import-time side effect and is not a supported API.
- Pre-rendered HTML pages get route aliases in the static manifest (e.g. `/about` → `/about/index.html`) so they're served as static files without SSR fallthrough.
- `staticHeaders` merges per-route headers (e.g. CSP) into manifest entries at build time.
- On-demand expiration (`unstable_expirePath` / `unstable_expireAll`) deletes cache entries lazily — the page is re-rendered on the next request rather than eagerly. Uses a `Symbol.for()` global singleton to share the ISR cache reference between `server.ts` and the user-imported `cache.ts` module, resilient to bundling producing separate chunks.
- `Astro.clientAddress` is available for non-ISR requests (extracted via `Bun.serve`'s `requestIP()`). ISR-cached responses do not have access to `clientAddress` because the ISR handler's origin callback runs outside the `Bun.serve` fetch context. Accessing `Astro.clientAddress` during an ISR render will throw.

## Code Style

- Biome handles both linting and formatting (spaces, 2-width indent, double quotes, semicolons, ES5 trailing commas, LF line endings).
- `useImportType` is enforced — use `import type` for type-only imports.

## Commit Messages

This project uses `release-please` (via GitHub Actions) for automated versioning. Releases are created automatically; there is no local release command.

release-please uses conventional commit semantics for version bumps:

| Type / Pattern | Release |
|---|---|
| `feat:` | **minor** |
| `fix:` | **patch** |
| `BREAKING CHANGE` footer or `!` suffix (e.g. `feat!:`) | **major** |
| `refactor`, `style`, `types`, `revert`, `docs`, `chore`, `ci`, `test`, `build`, `perf` | included in next release if one is triggered, but do not trigger a release on their own |

Choose the commit type carefully. Only `feat` and `fix` (plus breaking changes) trigger version bumps.

## Dependencies

- **`cache-control-parser`** — Parses `Cache-Control` headers for ISR
- **`cbor2`** — CBOR serialization for ISR disk persistence
- **`debug`** — Structured debug logging (namespace: `@wyattjoh/astro-bun-adapter:*`)
- **`mrmime`** — MIME type lookup for static file serving

## Build Output

- `dist/` contains TypeScript declarations and bundled JS (from `bunup`)
- Package exports: `.` → `dist/index.js`, `./server.js` → `dist/server.js`, `./cache` → `dist/cache.js`

## Keeping Docs in Sync

When making changes that add, remove, or alter user-facing behavior (new options, new features, changed defaults, new environment variables, architectural changes, etc.), **always** update:

- **`README.md`** — Features list, ISR section, environment variables, or any other section affected by the change.
- **`CLAUDE.md`** — Architecture descriptions, key design decisions, types list, dependencies, or any other section affected by the change.

Do this in the same commit as the code change, not as a follow-up.
