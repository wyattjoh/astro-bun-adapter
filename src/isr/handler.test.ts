import { afterEach, describe, expect, mock, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createISRHandler } from "./handler.ts";

function makeHandler(
  headers: Record<string, string> = {},
  body = "ok",
  status = 200
) {
  const fn = mock(async (_request: Request) => {
    return new Response(body, { status, headers });
  });
  return fn;
}

function request(path: string) {
  return new Request(`http://localhost${path}`);
}

let testDir: string;

afterEach(() => {
  if (testDir) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

function cacheDir() {
  testDir = join(
    tmpdir(),
    `isr-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  return testDir;
}

const BUILD_ID = "test-build-id";

describe("createISRHandler", () => {
  test("cache miss — calls handler, returns SSR response", async () => {
    const handler = makeHandler();
    const isr = createISRHandler(handler, 1024 * 1024, cacheDir(), BUILD_ID);

    const res = await isr(request("/page"), "/page");

    expect(handler).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  test("cacheable response populates cache (fresh hit)", async () => {
    const handler = makeHandler({ "cache-control": "s-maxage=60" }, "cached");
    const isr = createISRHandler(handler, 1024 * 1024, cacheDir(), BUILD_ID);

    const first = await isr(request("/page"), "/page");
    // Consume the body so the cache entry is fully built.
    await first.text();

    const second = await isr(request("/page"), "/page");

    expect(handler).toHaveBeenCalledTimes(1);
    expect(second.status).toBe(200);
    expect(await second.text()).toBe("cached");
  });

  test("non-cacheable response (no s-maxage) — no caching", async () => {
    const handler = makeHandler(
      { "cache-control": "max-age=60" },
      "not cached"
    );
    const isr = createISRHandler(handler, 1024 * 1024, cacheDir(), BUILD_ID);

    await (await isr(request("/page"), "/page")).text();
    await (await isr(request("/page"), "/page")).text();

    expect(handler).toHaveBeenCalledTimes(2);
  });

  test("s-maxage=0 — not cached", async () => {
    const handler = makeHandler(
      { "cache-control": "s-maxage=0" },
      "zero maxage"
    );
    const isr = createISRHandler(handler, 1024 * 1024, cacheDir(), BUILD_ID);

    await (await isr(request("/page"), "/page")).text();
    await (await isr(request("/page"), "/page")).text();

    expect(handler).toHaveBeenCalledTimes(2);
  });

  test("stale-while-revalidate — serves stale + background revalidation", async () => {
    let callCount = 0;
    const handler = mock(async (_request: Request) => {
      callCount++;
      return new Response(`response-${callCount}`, {
        status: 200,
        headers: {
          "cache-control": "s-maxage=1, stale-while-revalidate=10",
        },
      });
    });
    const isr = createISRHandler(handler, 1024 * 1024, cacheDir(), BUILD_ID);

    // Populate cache.
    const first = await isr(request("/page"), "/page");
    await first.text();

    // Wait just past the s-maxage window so the entry is stale but within SWR.
    await new Promise((r) => setTimeout(r, 1100));

    // Should serve stale and trigger background revalidation.
    const second = await isr(request("/page"), "/page");
    expect(await second.text()).toBe("response-1");
    expect(handler).toHaveBeenCalledTimes(2);

    // Allow background revalidation to complete.
    await new Promise((r) => setTimeout(r, 50));

    // Next request should serve the revalidated entry.
    const third = await isr(request("/page"), "/page");
    expect(await third.text()).toBe("response-2");
    // No additional handler call — served from refreshed cache.
    expect(handler).toHaveBeenCalledTimes(2);
  });

  test("expired beyond SWR window — full re-render", async () => {
    const handler = makeHandler(
      { "cache-control": "s-maxage=1, stale-while-revalidate=1" },
      "body"
    );
    const isr = createISRHandler(handler, 1024 * 1024, cacheDir(), BUILD_ID);

    const first = await isr(request("/page"), "/page");
    await first.text();

    // Wait past both s-maxage + swr (2s total).
    await new Promise((r) => setTimeout(r, 2100));

    await (await isr(request("/page"), "/page")).text();

    expect(handler).toHaveBeenCalledTimes(2);
  });

  test("concurrent request deduplication (cache miss)", async () => {
    let callCount = 0;
    const handler = mock(async (_request: Request) => {
      callCount++;
      return new Response(`response-${callCount}`, {
        status: 200,
        headers: { "cache-control": "s-maxage=60" },
      });
    });
    const isr = createISRHandler(handler, 1024 * 1024, cacheDir(), BUILD_ID);

    // Fire two concurrent requests to the same path.
    const [first, second] = await Promise.all([
      isr(request("/page"), "/page"),
      isr(request("/page"), "/page"),
    ]);

    expect(handler).toHaveBeenCalledTimes(1);

    // First caller gets the streaming response.
    expect(await first.text()).toBe("response-1");
    // Second caller gets the cached response (same body).
    expect(await second.text()).toBe("response-1");
  });

  test("SWR revalidation deduplication", async () => {
    let callCount = 0;
    const handler = mock(async (_request: Request) => {
      callCount++;
      return new Response(`response-${callCount}`, {
        status: 200,
        headers: {
          "cache-control": "s-maxage=1, stale-while-revalidate=10",
        },
      });
    });
    const isr = createISRHandler(handler, 1024 * 1024, cacheDir(), BUILD_ID);

    // Populate cache.
    const first = await isr(request("/page"), "/page");
    await first.text();

    // Move into SWR window.
    await new Promise((r) => setTimeout(r, 1100));

    // Multiple requests during SWR — only one revalidation should fire.
    await Promise.all([
      isr(request("/page"), "/page").then((r) => r.text()),
      isr(request("/page"), "/page").then((r) => r.text()),
      isr(request("/page"), "/page").then((r) => r.text()),
    ]);

    // 1 initial + 1 background revalidation = 2 total.
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
