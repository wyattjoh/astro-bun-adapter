/**
 * Internal adapter options serialized as JSON into the generated entry.mjs at
 * build time. These are passed to the server entrypoint's `start()` function.
 */
export interface AdapterOptions {
  /** Hostname or boolean (`true` = `"0.0.0.0"`, `false` = `"localhost"`). */
  host: string | boolean;
  /** Port the server listens on. */
  port: number;
  /**
   * Absolute `file://` URL to `dist/client/`. Passed through adapter args so
   * the server entrypoint can resolve paths at runtime — `import.meta.url` is
   * unreliable because Astro bundles the entrypoint into a chunk.
   */
  client: string;
  /**
   * Absolute `file://` URL to `dist/server/`. Same rationale as {@link client}.
   */
  server: string;
  /** Name of the assets directory (default `_astro`). */
  assets: string;
  /**
   * ISR (Incremental Static Regeneration) caching configuration.
   * `false` disables ISR; otherwise holds the resolved ISR options.
   */
  isr: false | ISROptions;
}

/**
 * A cached SSR response stored in the ISR LRU cache. Holds the buffered body,
 * serialized headers, and timing metadata used for fresh/stale/expired checks.
 */
export interface ISRCacheEntry {
  /** Buffered response body. */
  body: Uint8Array;
  /** Response headers as key-value tuples. */
  headers: [string, string][];
  /** HTTP status code of the cached response. */
  status: number;
  /** Timestamp (`Date.now()`) when this entry was cached. */
  cachedAt: number;
  /** `s-maxage` value in seconds — defines the fresh window. */
  sMaxAge: number;
  /** `stale-while-revalidate` value in seconds — defines the stale window. */
  swr: number;
}

/** Resolved ISR configuration passed to the server entrypoint. */
export interface ISROptions {
  /** Maximum byte size of the LRU cache (based on cached response body sizes). */
  maxByteSize: number;
}

export interface ManifestEntry {
  contentType: string | undefined;
  cacheControl: string;
  etag: string;
  size: number;
}

export type StaticManifest = Record<string, ManifestEntry>;
