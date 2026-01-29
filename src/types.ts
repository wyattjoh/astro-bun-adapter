export interface AdapterOptions {
  host: string | boolean;
  port: number;
  // Absolute file:// URLs to dist/client/ and dist/server/. Passed through
  // adapter args so the server entrypoint can resolve paths at runtime. We
  // can't use import.meta.url in server.ts because Astro bundles it into a
  // chunk under dist/server/chunks/, making relative URL resolution unreliable.
  client: string;
  server: string;
}

export interface ManifestEntry {
  contentType: string | undefined;
  cacheControl: string;
  etag: string;
  size: number;
}

export type StaticManifest = Record<string, ManifestEntry>;
