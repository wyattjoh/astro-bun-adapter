# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Astro adapter for Bun (`@wyattjoh/astro-bun-adapter`). Enables Astro SSR sites to run on `Bun.serve` with optimized static file serving via a pre-computed manifest.

## Commands

- **Build**: `bun run build` — runs `tsc` (declarations only) then `bun build` with externalized `astro` and `mrmime`
- **Release**: `bun run release` — runs semantic-release (CI only, uses `.releaserc.cjs`)

No test suite or linter is configured.

## Architecture

Four source files in `src/`:

- **`index.ts`** — The Astro integration entry point. Exports `bunAdapter()` which hooks into Astro's build lifecycle: configures build settings at `astro:config:setup`, registers the adapter at `astro:config:done`, and generates the static manifest at `astro:build:done`.
- **`server.ts`** — The runtime server entrypoint (referenced by `serverEntrypoint` in the adapter). `createExports()` provides the SSR `handler` using Astro's Web-standard `App` (not `NodeApp`). `start()` boots `Bun.serve` — looks up requests against the static manifest for direct file serving with ETag/304 support, falls back to SSR.
- **`manifest.ts`** — Build-time utility. Walks `dist/client/`, hashes files (SHA-256, truncated), and writes `dist/server/static-manifest.json`. Uses `node:fs/promises` and `node:crypto` because Astro build hooks run under Node, not Bun.
- **`types.ts`** — Shared types (`AdapterOptions`, `ManifestEntry`, `StaticManifest`).

## Key Design Decisions

- Build hooks run under **Node**, so `manifest.ts` must use `node:` APIs, not Bun APIs.
- The runtime server uses the **Web-standard `App`** (not `NodeApp`) since Bun natively supports the Fetch API.
- Adapter args are serialized as JSON into `entry.mjs` at build time, so only config-derived values can be passed — not build artifacts.
- `/_astro/*` paths get immutable 1-year cache headers; everything else gets 24-hour must-revalidate.

## Build Output

- `dist/` contains TypeScript declarations (from `tsc`) and bundled JS (from `bun build`)
- Package exports: `.` → `dist/index.js`, `./server.js` → `dist/server.js`
