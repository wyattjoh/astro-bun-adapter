import { describe, expect, mock, test } from "bun:test";
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

function testCacheDir() {
  return join(
    tmpdir(),
    `isr-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

const BUILD_ID = "test-build-id";

describe("createISRHandler", () => {
  test("cache miss — calls handler, returns SSR response", async () => {
    const handler = makeHandler();
    const isr = createISRHandler({
      origin: handler,
      maxByteSize: 1024 * 1024,
      cacheDir: testCacheDir(),
      buildId: BUILD_ID,
      preFillMemoryCache: false,
      imageEndpointRoute: "/_image",
    });

    const res = await isr(request("/page"), "/page");

    expect(handler).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  test("cacheable response populates cache (fresh hit)", async () => {
    const handler = makeHandler({ "cache-control": "s-maxage=60" }, "cached");
    const isr = createISRHandler({
      origin: handler,
      maxByteSize: 1024 * 1024,
      cacheDir: testCacheDir(),
      buildId: BUILD_ID,
      preFillMemoryCache: false,
      imageEndpointRoute: "/_image",
    });

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
    const isr = createISRHandler({
      origin: handler,
      maxByteSize: 1024 * 1024,
      cacheDir: testCacheDir(),
      buildId: BUILD_ID,
      preFillMemoryCache: false,
      imageEndpointRoute: "/_image",
    });

    await (await isr(request("/page"), "/page")).text();
    await (await isr(request("/page"), "/page")).text();

    expect(handler).toHaveBeenCalledTimes(2);
  });

  test("s-maxage=0 — not cached", async () => {
    const handler = makeHandler(
      { "cache-control": "s-maxage=0" },
      "zero maxage"
    );
    const isr = createISRHandler({
      origin: handler,
      maxByteSize: 1024 * 1024,
      cacheDir: testCacheDir(),
      buildId: BUILD_ID,
      preFillMemoryCache: false,
      imageEndpointRoute: "/_image",
    });

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
    const isr = createISRHandler({
      origin: handler,
      maxByteSize: 1024 * 1024,
      cacheDir: testCacheDir(),
      buildId: BUILD_ID,
      preFillMemoryCache: false,
      imageEndpointRoute: "/_image",
    });

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
    const isr = createISRHandler({
      origin: handler,
      maxByteSize: 1024 * 1024,
      cacheDir: testCacheDir(),
      buildId: BUILD_ID,
      preFillMemoryCache: false,
      imageEndpointRoute: "/_image",
    });

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
    const isr = createISRHandler({
      origin: handler,
      maxByteSize: 1024 * 1024,
      cacheDir: testCacheDir(),
      buildId: BUILD_ID,
      preFillMemoryCache: false,
      imageEndpointRoute: "/_image",
    });

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
    const isr = createISRHandler({
      origin: handler,
      maxByteSize: 1024 * 1024,
      cacheDir: testCacheDir(),
      buildId: BUILD_ID,
      preFillMemoryCache: false,
      imageEndpointRoute: "/_image",
    });

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

  test("image endpoint response with only max-age gets cached via override", async () => {
    const handler = makeHandler(
      { "cache-control": "public, max-age=31536000" },
      "image-data"
    );
    const isr = createISRHandler({
      origin: handler,
      maxByteSize: 1024 * 1024,
      cacheDir: testCacheDir(),
      buildId: BUILD_ID,
      preFillMemoryCache: false,
      imageEndpointRoute: "/_image",
    });

    const first = await isr(
      request("/_image?href=foo.png&w=100"),
      "/_image?href=foo.png&w=100"
    );
    await first.text();

    const second = await isr(
      request("/_image?href=foo.png&w=100"),
      "/_image?href=foo.png&w=100"
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(second.headers.get("x-astro-cache")).toBe("HIT");
    expect(await second.text()).toBe("image-data");
  });

  test("non-image path with only max-age still bypasses cache", async () => {
    const handler = makeHandler(
      { "cache-control": "public, max-age=31536000" },
      "not cached"
    );
    const isr = createISRHandler({
      origin: handler,
      maxByteSize: 1024 * 1024,
      cacheDir: testCacheDir(),
      buildId: BUILD_ID,
      preFillMemoryCache: false,
      imageEndpointRoute: "/_image",
    });

    await (await isr(request("/page"), "/page")).text();
    await (await isr(request("/page"), "/page")).text();

    expect(handler).toHaveBeenCalledTimes(2);
  });

  test("expireAll removes page entries but preserves image cache", async () => {
    let callCount = 0;
    const handler = mock(async (_request: Request) => {
      callCount++;
      return new Response(`response-${callCount}`, {
        status: 200,
        headers: { "cache-control": "s-maxage=60" },
      });
    });
    const imageHandler = mock(async (_request: Request) => {
      return new Response("image-data", {
        status: 200,
        headers: { "cache-control": "public, max-age=31536000" },
      });
    });
    const origin = mock(async (req: Request) => {
      const url = new URL(req.url);
      if (url.pathname === "/_image" || url.pathname.startsWith("/_image?")) {
        return imageHandler(req);
      }
      return handler(req);
    });
    const isr = createISRHandler({
      origin,
      maxByteSize: 1024 * 1024,
      cacheDir: testCacheDir(),
      buildId: BUILD_ID,
      preFillMemoryCache: false,
      imageEndpointRoute: "/_image",
    });

    // Populate page cache.
    await (await isr(request("/page"), "/page")).text();
    // Populate image cache.
    await (
      await isr(
        request("/_image?href=foo.png&w=100"),
        "/_image?href=foo.png&w=100"
      )
    ).text();

    // Both should be cached.
    expect(
      (await isr(request("/page"), "/page")).headers.get("x-astro-cache")
    ).toBe("HIT");
    expect(
      (
        await isr(
          request("/_image?href=foo.png&w=100"),
          "/_image?href=foo.png&w=100"
        )
      ).headers.get("x-astro-cache")
    ).toBe("HIT");

    // Expire all non-image entries.
    await isr.cache.expireAll();

    // Page should be a miss now.
    const pageAfter = await isr(request("/page"), "/page");
    expect(pageAfter.headers.get("x-astro-cache")).toBe("MISS");

    // Image should still be a hit.
    const imageAfter = await isr(
      request("/_image?href=foo.png&w=100"),
      "/_image?href=foo.png&w=100"
    );
    expect(imageAfter.headers.get("x-astro-cache")).toBe("HIT");
  });

  test("different image query strings produce separate cache entries", async () => {
    let callCount = 0;
    const handler = mock(async (_request: Request) => {
      callCount++;
      return new Response(`image-${callCount}`, {
        status: 200,
        headers: { "cache-control": "public, max-age=31536000" },
      });
    });
    const isr = createISRHandler({
      origin: handler,
      maxByteSize: 1024 * 1024,
      cacheDir: testCacheDir(),
      buildId: BUILD_ID,
      preFillMemoryCache: false,
      imageEndpointRoute: "/_image",
    });

    const first = await isr(
      request("/_image?href=a.png&w=100"),
      "/_image?href=a.png&w=100"
    );
    await first.text();

    const second = await isr(
      request("/_image?href=b.png&w=200"),
      "/_image?href=b.png&w=200"
    );
    await second.text();

    // Two different image queries — handler should be called twice.
    expect(handler).toHaveBeenCalledTimes(2);

    // Each should now be cached independently.
    const hitA = await isr(
      request("/_image?href=a.png&w=100"),
      "/_image?href=a.png&w=100"
    );
    expect(hitA.headers.get("x-astro-cache")).toBe("HIT");
    expect(await hitA.text()).toBe("image-1");

    const hitB = await isr(
      request("/_image?href=b.png&w=200"),
      "/_image?href=b.png&w=200"
    );
    expect(hitB.headers.get("x-astro-cache")).toBe("HIT");
    expect(await hitB.text()).toBe("image-2");

    // No additional handler calls.
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
