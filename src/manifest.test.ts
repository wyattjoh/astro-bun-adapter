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

    await generateStaticManifest(clientDir, outDir, "_astro", {
      "/about": { "Cache-Control": "no-cache" },
    });

    const manifest = readManifest(outDir);
    expect(manifest["/about/index.html"].headers["Cache-Control"]).toBe(
      "no-cache"
    );
  });

  test("route headers do not override ETag or Content-Length", async () => {
    const clientDir = testDir();
    const outDir = testDir();

    writeFileSync(join(clientDir, "index.html"), "home page");

    await generateStaticManifest(clientDir, outDir, "_astro", {
      "/": { ETag: "bogus", "Content-Length": "9999" },
    });

    const manifest = readManifest(outDir);
    const headers = manifest["/index.html"].headers;

    // Content-derived values must win over route headers.
    expect(headers.ETag).not.toBe("bogus");
    expect(headers["Content-Length"]).toBe(String("home page".length));
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

    await generateStaticManifest(clientDir, outDir, "_astro");

    const manifest = readManifest(outDir);

    // /about/index.html → route alias at /about
    expect(manifest["/about"]).toBeDefined();
    expect(manifest["/about"].filePath).toBe("about/index.html");
    expect(manifest["/about"].headers.ETag).toBe(
      manifest["/about/index.html"].headers.ETag
    );
    expect(manifest["/about/index.html"].filePath).toBe("about/index.html");

    // /index.html → route alias at /
    expect(manifest["/"]).toBeDefined();
    expect(manifest["/"].filePath).toBe("index.html");
    expect(manifest["/"].headers.ETag).toBe(
      manifest["/index.html"].headers.ETag
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

    await generateStaticManifest(clientDir, outDir, "_astro", {
      "/": { "Content-Security-Policy": "default-src 'self'" },
    });

    const manifest = readManifest(outDir);
    expect(manifest["/index.html"].headers["Content-Security-Policy"]).toBe(
      "default-src 'self'"
    );
  });
});
