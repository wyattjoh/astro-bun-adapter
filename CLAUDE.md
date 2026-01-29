# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Astro adapter for Bun (`@wyattjoh/astro-bun-adapter`). Enables Astro SSR sites to run on `Bun.serve` with optimized static file serving via a pre-computed manifest and ISR (Incremental Static Regeneration) support.

## Commands

- **Build**: `bun run build` — runs `tsc` (declarations only) then `bun build` with externalized `astro` and `mrmime`
- **Test**: `bun run test` — runs Bun's built-in test runner
- **Typecheck**: `bun run typecheck` — runs `tsc --noEmit`
- **Lint**: `bun run lint` — runs Biome (`biome check .`)
- **Lint fix**: `bun run lint:fix` — runs Biome with auto-fix
- **Format**: `bun run format` — runs Biome formatter
- **Release**: `bun run release` — runs semantic-release (CI only, uses `.releaserc.cjs`)

Pre-commit hook (via Husky) runs lint, test, and typecheck automatically.

## Architecture

Source files in `src/`:

- **`index.ts`** — The Astro integration entry point. Exports `bunAdapter()` which hooks into Astro's build lifecycle: configures build settings at `astro:config:setup`, registers the adapter at `astro:config:done`, and generates the static manifest at `astro:build:done`.
- **`server.ts`** — The runtime server entrypoint (referenced by `serverEntrypoint` in the adapter). `createExports()` provides the SSR `handler` using Astro's Web-standard `App` (not `NodeApp`). `start()` boots `Bun.serve` — looks up requests against the static manifest for direct file serving with ETag/304 support, falls back to SSR. Integrates ISR when enabled.
- **`isr.ts`** — ISR (Incremental Static Regeneration) runtime. Uses an LRU cache keyed by pathname. Respects `s-maxage` and `stale-while-revalidate` from `Cache-Control` headers. Deduplicates concurrent requests for the same path.
- **`manifest.ts`** — Build-time utility. Walks `dist/client/`, hashes files (SHA-256, truncated), and writes `dist/server/static-manifest.json`. Uses `node:fs/promises` and `node:crypto` because Astro build hooks run under Node, not Bun.
- **`types.ts`** — Shared types (`AdapterOptions`, `ManifestEntry`, `StaticManifest`, `ISRCacheEntry`).

## Key Design Decisions

- Build hooks run under **Node**, so `manifest.ts` must use `node:` APIs, not Bun APIs.
- The runtime server uses the **Web-standard `App`** (not `NodeApp`) since Bun natively supports the Fetch API.
- Adapter args are serialized as JSON into `entry.mjs` at build time, so only config-derived values can be passed — not build artifacts.
- `/_astro/*` paths get immutable 1-year cache headers; everything else gets 24-hour must-revalidate.
- ISR caching uses `s-maxage` / `stale-while-revalidate` from response `Cache-Control` headers, with background revalidation and request coalescing.

## Code Style

- Biome handles both linting and formatting (spaces, 2-width indent, double quotes, semicolons, ES5 trailing commas, LF line endings).
- `useImportType` is enforced — use `import type` for type-only imports.

## Commit Messages

This project uses `semantic-release` with the Angular preset (`.releaserc.cjs`), so commit message types directly control versioning:

| Type / Pattern | Release |
|---|---|
| `feat:` | **minor** |
| `fix:` | **patch** |
| `refactor:` | **patch** |
| `style:` | **patch** |
| `types:` | **patch** |
| `docs(README):` | **patch** |
| `revert:` (reverts) | **patch** |
| `BREAKING CHANGE` footer or `!` suffix (e.g. `feat!:`) | **major** |
| `chore`, `ci`, `test`, `build`, `perf`, `docs` (without `README` scope) | no release |

Choose the commit type carefully — it determines whether a release is triggered and what kind of version bump occurs.

## Build Output

- `dist/` contains TypeScript declarations (from `tsc`) and bundled JS (from `bun build`)
- Package exports: `.` → `dist/index.js`, `./server.js` → `dist/server.js`
