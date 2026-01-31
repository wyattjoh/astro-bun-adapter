import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { lookup } from "mrmime";
import type { ManifestEntry, StaticManifest } from "./types.ts";

/** Return the appropriate Cache-Control header — immutable for Vite-hashed assets, 24h otherwise. */
function getCacheControl(pathname: string, assetsPrefix: string): string {
  if (pathname.startsWith(`/${assetsPrefix}/`)) {
    return "public, max-age=31536000, immutable";
  }
  return "public, max-age=86400, must-revalidate";
}

/** Recursively collect all file paths under a directory. */
async function walk(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  const tasks: Promise<string[]>[] = [];

  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      tasks.push(walk(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }

  const nested = await Promise.all(tasks);
  for (const list of nested) {
    for (const f of list) {
      files.push(f);
    }
  }

  return files;
}

/**
 * Derive the route pathname from a static file path.
 * e.g. `/about/index.html` → `/about`, `/index.html` → `/`, `/about.html` → `/about`
 */
function filePathToRoute(filePath: string): string {
  if (filePath.endsWith("/index.html")) {
    const route = filePath.slice(0, -"/index.html".length);
    return route || "/";
  }
  if (filePath.endsWith(".html")) {
    return filePath.slice(0, -".html".length);
  }
  return filePath;
}

/**
 * Walk the client build directory and write a static manifest with pre-computed
 * headers for each file. Must use `node:fs/promises` since build hooks run under Node.
 */
export async function generateStaticManifest(
  clientDir: string,
  outDir: string,
  assetsPrefix: string,
  routeHeaders?: Record<string, Record<string, string>>
): Promise<void> {
  const files = await walk(clientDir);
  const manifest: StaticManifest = {};

  const entries = await Promise.all(
    files.map(async (filePath) => {
      const content = await readFile(filePath);
      const hash = createHash("sha256")
        .update(content)
        .digest("hex")
        .slice(0, 16);
      const pathname = `/${relative(clientDir, filePath)}`;
      const contentType = lookup(filePath);
      const headers: Record<string, string> = {
        // Adapter defaults (can be overridden by route-level headers).
        "Cache-Control": getCacheControl(pathname, assetsPrefix),
        // Route-level headers (e.g. CSP, CORS) take precedence over defaults.
        ...routeHeaders?.[filePathToRoute(pathname)],
        // Content-derived headers — always set by the adapter.
        ETag: `"${hash}"`,
        "Content-Length": String(content.byteLength),
      };
      if (contentType) headers["Content-Type"] = contentType;
      const entry: ManifestEntry = {
        headers,
        filePath: relative(clientDir, filePath),
      };
      return [pathname, entry] as const;
    })
  );

  for (const [pathname, entry] of entries) {
    manifest[pathname] = entry;

    // Add a route alias for HTML files so clean URLs (e.g. /about) resolve
    // to the static file (e.g. /about/index.html) without falling through to SSR.
    const route = filePathToRoute(pathname);
    if (route !== pathname) {
      manifest[route] = { ...entry, filePath: pathname.slice(1) };
    }
  }

  const manifestPath = join(outDir, "static-manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
}
