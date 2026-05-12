import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Helpers for building a temp adapter dir with the files server.ts reads at
// import time (static-manifest.json and build-id).
// ---------------------------------------------------------------------------

function makeTempAdapterDir(
  manifestEntries: Record<string, unknown> = {},
  buildId = "test-build-id"
) {
  const base = join(
    tmpdir(),
    `server-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  const serverDir = join(base, "server");
  const adapterSubDir = join(serverDir, ".astro-bun-adapter");
  mkdirSync(adapterSubDir, { recursive: true });
  mkdirSync(join(base, "client"), { recursive: true });

  writeFileSync(
    join(adapterSubDir, "static-manifest.json"),
    JSON.stringify(manifestEntries)
  );
  writeFileSync(join(adapterSubDir, "build-id"), buildId);

  return { base, serverDir, adapterSubDir };
}

// ---------------------------------------------------------------------------
// Set up mocks before any server.ts import.
// mock.module calls are hoisted by Bun's test runner so they run before
// module-level code in this file.
// ---------------------------------------------------------------------------

const { serverDir } = makeTempAdapterDir(
  {
    "/index.html": {
      headers: {
        // Headers are canonicalized to lowercase by generateStaticManifest.
        etag: '"abc123"',
        "content-type": "text/html",
        "content-length": "4",
        "cache-control": "public, max-age=86400, must-revalidate",
      },
      filePath: "index.html",
    },
  },
  "test-build-id"
);

const mockLogger = {
  info: mock((_msg: string) => {}),
  error: mock((_msg: string) => {}),
  warn: mock((_msg: string) => {}),
  debug: mock((_msg: string) => {}),
};

const mockApp = {
  adapterLogger: mockLogger,
  manifest: {
    buildClientDir: pathToFileURL(`${join(serverDir, "..", "client")}/`),
    buildServerDir: pathToFileURL(`${serverDir}/`),
    base: "/",
  },
  match: mock((_request: Request) => undefined),
  render: mock(async (_request: Request) => new Response("rendered")),
};

mock.module("virtual:@wyattjoh/astro-bun-adapter/config", () => ({
  adapterDir: ".astro-bun-adapter",
  host: "localhost",
  port: 4321,
  imageEndpointRoute: "/_image",
  isr: false,
}));

mock.module("astro/app/entrypoint", () => ({
  createApp: () => mockApp,
}));

mock.module("astro/env/setup", () => ({
  setGetEnv: mock((_fn: (key: string) => string | undefined) => {}),
}));

// ---------------------------------------------------------------------------
// Capture Bun.serve config without starting a real server.
// ---------------------------------------------------------------------------

let capturedServeConfig: Parameters<typeof Bun.serve>[0] | undefined;
const originalServe = Bun.serve.bind(Bun);
(Bun as { serve: unknown }).serve = (
  config: Parameters<typeof Bun.serve>[0]
) => {
  capturedServeConfig = config;
  return {
    stop: mock(() => Promise.resolve()),
    port: 4321,
    hostname: "localhost",
    development: false,
    id: "test-server",
    pendingRequests: 0,
    pendingWebSockets: 0,
    upgrade: mock(() => false),
    publish: mock(() => 0),
    reload: mock(() => {}),
    ref: mock(() => {}),
    unref: mock(() => {}),
    requestIP: mock(() => null),
    timeout: mock(() => {}),
  } as unknown as ReturnType<typeof Bun.serve>;
};

// ---------------------------------------------------------------------------
// Import server.ts after mocks are in place.
// ---------------------------------------------------------------------------

const serverModule = await import("./server.ts");

// Restore Bun.serve after import so other tests are unaffected.
(Bun as { serve: unknown }).serve = originalServe;

// ---------------------------------------------------------------------------
// Tests for buildImageCacheKey (pure function)
// ---------------------------------------------------------------------------

describe("buildImageCacheKey", () => {
  test("returns pathname when no known params present", () => {
    const params = new URLSearchParams("unknown=value&also=ignored");
    expect(serverModule.buildImageCacheKey("/_image", params)).toBe("/_image");
  });

  test("keeps known image params in sorted order", () => {
    const params = new URLSearchParams("w=800&href=photo.jpg&f=webp&q=80");
    expect(serverModule.buildImageCacheKey("/_image", params)).toBe(
      "/_image?f=webp&href=photo.jpg&q=80&w=800"
    );
  });

  test("filters out unknown params alongside known ones", () => {
    const params = new URLSearchParams("w=100&token=secret&h=200");
    expect(serverModule.buildImageCacheKey("/_image", params)).toBe(
      "/_image?h=200&w=100"
    );
  });

  test("returns just pathname when params is empty", () => {
    const params = new URLSearchParams();
    expect(serverModule.buildImageCacheKey("/path", params)).toBe("/path");
  });

  test("handles all known params", () => {
    const params = new URLSearchParams(
      "background=white&f=png&fit=cover&h=400&href=img.jpg&position=center&q=90&w=800"
    );
    const key = serverModule.buildImageCacheKey("/_image", params);
    expect(key).toBe(
      "/_image?background=white&f=png&fit=cover&h=400&href=img.jpg&position=center&q=90&w=800"
    );
  });
});

// ---------------------------------------------------------------------------
// Tests for computeServerIslandsPrefix
// ---------------------------------------------------------------------------

describe("computeServerIslandsPrefix", () => {
  test("returns root prefix when base is '/'", () => {
    expect(serverModule.computeServerIslandsPrefix("/")).toBe(
      "/_server-islands/"
    );
  });

  test("inserts slash when base has no trailing slash (trailingSlash: 'never')", () => {
    // e.g. `base: "/docs"` with `trailingSlash: "never"` (or default "ignore")
    expect(serverModule.computeServerIslandsPrefix("/docs")).toBe(
      "/docs/_server-islands/"
    );
  });

  test("does not double the slash when base has a trailing slash (trailingSlash: 'always')", () => {
    expect(serverModule.computeServerIslandsPrefix("/docs/")).toBe(
      "/docs/_server-islands/"
    );
  });

  test("matches the URL that Astro actually emits", () => {
    // Astro's runtime: `${base}${slash}_server-islands/${componentId}`
    // where `slash = base.endsWith("/") ? "" : "/"`.
    // Regression test: incoming request pathname must startWith the prefix.
    const prefix = serverModule.computeServerIslandsPrefix("/docs");
    expect("/docs/_server-islands/MyComponent.abc123".startsWith(prefix)).toBe(
      true
    );
  });
});

// ---------------------------------------------------------------------------
// Tests for computeImageEndpointPath
// ---------------------------------------------------------------------------

describe("computeImageEndpointPath", () => {
  test("returns the route unchanged when base is '/'", () => {
    expect(serverModule.computeImageEndpointPath("/", "/_image")).toBe(
      "/_image"
    );
  });

  test("prepends base without a trailing slash", () => {
    expect(serverModule.computeImageEndpointPath("/docs", "/_image")).toBe(
      "/docs/_image"
    );
  });

  test("prepends base with a trailing slash without doubling", () => {
    expect(serverModule.computeImageEndpointPath("/docs/", "/_image")).toBe(
      "/docs/_image"
    );
  });

  test("tolerates a route missing a leading slash", () => {
    expect(serverModule.computeImageEndpointPath("/docs", "_image")).toBe(
      "/docs/_image"
    );
  });

  test("matches the URL that Astro actually emits", () => {
    // Astro's service: joinPaths(BASE_URL, image.endpoint.route) -> `/docs/_image`
    const path = serverModule.computeImageEndpointPath("/docs", "/_image");
    expect("/docs/_image?href=photo.jpg&w=800".startsWith(path)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests for server module exports and Bun.serve invocation
// ---------------------------------------------------------------------------

describe("server module", () => {
  afterAll(() => {
    mock.restore();
  });

  test("exports handler function", () => {
    expect(typeof serverModule.handler).toBe("function");
  });

  test("default export equals handler", () => {
    expect(serverModule.default).toBe(serverModule.handler);
  });

  test("Bun.serve was called during import", () => {
    expect(capturedServeConfig).toBeDefined();
  });

  test("Bun.serve config includes a fetch function", () => {
    expect(typeof (capturedServeConfig as { fetch?: unknown })?.fetch).toBe(
      "function"
    );
  });
});
