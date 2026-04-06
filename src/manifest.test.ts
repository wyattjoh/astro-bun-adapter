import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateStaticManifest } from "./manifest.ts";
import type { StaticManifest } from "./types.ts";

function testDir() {
  const dir = join(
    tmpdir(),
    `manifest-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function readManifest(outDir: string): StaticManifest {
  return JSON.parse(
    readFileSync(join(outDir, "static-manifest.json"), "utf-8")
  );
}

describe("generateStaticManifest", () => {
  test("route headers override Cache-Control", async () => {
    const clientDir = testDir();
    const outDir = testDir();

    // Create a static file at /about/index.html → route /about
    mkdirSync(join(clientDir, "about"), { recursive: true });
    writeFileSync(join(clientDir, "about", "index.html"), "about page");

    await generateStaticManifest(
      clientDir,
      outDir,
      "_astro",
      { "/about": { "Cache-Control": "no-cache" } },
      "public, max-age=86400, must-revalidate"
    );

    const manifest = readManifest(outDir);
    // Headers are canonicalized to lowercase on write.
    expect(manifest["/about/index.html"].headers["cache-control"]).toBe(
      "no-cache"
    );
  });

  test("route headers do not override ETag or Content-Length", async () => {
    const clientDir = testDir();
    const outDir = testDir();

    writeFileSync(join(clientDir, "index.html"), "home page");

    await generateStaticManifest(
      clientDir,
      outDir,
      "_astro",
      { "/": { ETag: "bogus", "Content-Length": "9999" } },
      "public, max-age=86400, must-revalidate"
    );

    const manifest = readManifest(outDir);
    const headers = manifest["/index.html"].headers;

    // Content-derived values must win over route headers.
    expect(headers.etag).not.toBe("bogus");
    expect(headers["content-length"]).toBe(String("home page".length));
  });

  test("HTML files produce route alias entries with filePath", async () => {
    const clientDir = testDir();
    const outDir = testDir();

    // /about/index.html → route alias /about
    mkdirSync(join(clientDir, "about"), { recursive: true });
    writeFileSync(join(clientDir, "about", "index.html"), "about page");

    // /index.html → route alias /
    writeFileSync(join(clientDir, "index.html"), "home page");

    // /docs.html → route alias /docs
    writeFileSync(join(clientDir, "docs.html"), "docs page");

    // Non-HTML file should NOT get a route alias
    mkdirSync(join(clientDir, "_astro"), { recursive: true });
    writeFileSync(join(clientDir, "_astro", "main.js"), "console.log()");

    await generateStaticManifest(
      clientDir,
      outDir,
      "_astro",
      undefined,
      "public, max-age=86400, must-revalidate"
    );

    const manifest = readManifest(outDir);

    // /about/index.html → route alias at /about
    expect(manifest["/about"]).toBeDefined();
    expect(manifest["/about"].filePath).toBe("about/index.html");
    expect(manifest["/about"].headers.etag).toBe(
      manifest["/about/index.html"].headers.etag
    );
    expect(manifest["/about/index.html"].filePath).toBe("about/index.html");

    // /index.html → route alias at /
    expect(manifest["/"]).toBeDefined();
    expect(manifest["/"].filePath).toBe("index.html");
    expect(manifest["/"].headers.etag).toBe(
      manifest["/index.html"].headers.etag
    );

    // /docs.html → route alias at /docs
    expect(manifest["/docs"]).toBeDefined();
    expect(manifest["/docs"].filePath).toBe("docs.html");

    // Non-HTML: no alias
    expect(manifest["/_astro/main.js"]).toBeDefined();
    expect(manifest["/_astro/main"]).toBeUndefined();
  });

  test("route headers like CSP pass through", async () => {
    const clientDir = testDir();
    const outDir = testDir();

    writeFileSync(join(clientDir, "index.html"), "page");

    await generateStaticManifest(
      clientDir,
      outDir,
      "_astro",
      { "/": { "Content-Security-Policy": "default-src 'self'" } },
      "public, max-age=86400, must-revalidate"
    );

    const manifest = readManifest(outDir);
    expect(manifest["/index.html"].headers["content-security-policy"]).toBe(
      "default-src 'self'"
    );
  });

  test("route-level Content-Type does not duplicate the mrmime-derived one", async () => {
    // Regression: Astro 6 emits a lowercase `content-type` in routeHeaders for
    // prerendered HTML routes. Combined with the uppercase `Content-Type` the
    // adapter sets from mrmime, this used to produce two header entries on the
    // wire (e.g. `Content-Type: text/html, text/html`).
    const clientDir = testDir();
    const outDir = testDir();

    writeFileSync(join(clientDir, "index.html"), "home page");

    await generateStaticManifest(
      clientDir,
      outDir,
      "_astro",
      { "/": { "content-type": "text/html" } },
      "public, max-age=86400, must-revalidate"
    );

    const manifest = readManifest(outDir);
    const headers = manifest["/index.html"].headers;

    // Exactly one canonical Content-Type key, no case variants.
    const contentTypeKeys = Object.keys(headers).filter(
      (k) => k.toLowerCase() === "content-type"
    );
    expect(contentTypeKeys).toEqual(["content-type"]);
    expect(headers["content-type"]).toBe("text/html");

    // Loading into a Headers object should also yield a single value.
    const h = new Headers(headers);
    const values: string[] = [];
    for (const [key, value] of h as unknown as Iterable<[string, string]>) {
      if (key === "content-type") values.push(value);
    }
    expect(values).toEqual(["text/html"]);
  });
});
