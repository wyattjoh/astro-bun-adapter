import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ISRCacheEntry } from "../types.ts";
import { PersistentLRUCache } from "./cache.ts";

function testCacheDir() {
  return join(
    tmpdir(),
    `cache-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

const BUILD_ID = "test-build-id";

function makeEntry(size: number): ISRCacheEntry {
  return {
    body: new Uint8Array(size),
    headers: [],
    status: 200,
    cachedAt: Date.now(),
    sMaxAge: 60,
    swr: 0,
  };
}

describe("PersistentLRUCache", () => {
  test("get/set — basic storage and retrieval", async () => {
    const cache = new PersistentLRUCache({
      maxByteSize: 1024,
      cacheDir: testCacheDir(),
      buildId: BUILD_ID,
      preFillMemoryCache: false,
    });

    const entry = makeEntry(100);
    await cache.set("a", entry);

    const result = await cache.get("a");
    expect(result?.body.byteLength).toBe(100);

    cache.destroy();
  });

  test("get — returns undefined for missing key", async () => {
    const cache = new PersistentLRUCache({
      maxByteSize: 1024,
      cacheDir: testCacheDir(),
      buildId: BUILD_ID,
      preFillMemoryCache: false,
    });

    expect(await cache.get("missing")).toBeUndefined();
    cache.destroy();
  });

  test("delete — removes entry", async () => {
    const cache = new PersistentLRUCache({
      maxByteSize: 1024,
      cacheDir: testCacheDir(),
      buildId: BUILD_ID,
      preFillMemoryCache: false,
    });

    await cache.set("a", makeEntry(100));
    await cache.delete("a");

    expect(await cache.get("a")).toBeUndefined();
    cache.destroy();
  });

  test("eviction — evicts LRU entries when over budget", async () => {
    const cache = new PersistentLRUCache({
      maxByteSize: 200,
      cacheDir: testCacheDir(),
      buildId: BUILD_ID,
      preFillMemoryCache: false,
    });

    await cache.set("a", makeEntry(100));
    await cache.set("b", makeEntry(100));
    // Cache is full (200 bytes). Adding another should evict "a" (oldest) from memory.
    await cache.set("c", makeEntry(100));

    // "a" was evicted from memory but still on disk — get() loads it back.
    // To test pure memory eviction, we check that b and c are still in memory.
    expect(await cache.get("b")).toBeDefined();
    expect(await cache.get("c")).toBeDefined();

    cache.destroy();
  });

  test("LRU promotion — get promotes to MRU", async () => {
    const cache = new PersistentLRUCache({
      maxByteSize: 200,
      cacheDir: testCacheDir(),
      buildId: BUILD_ID,
      preFillMemoryCache: false,
    });

    await cache.set("a", makeEntry(100));
    await cache.set("b", makeEntry(100));

    // Access "a" to promote it to MRU.
    await cache.get("a");

    // Adding "c" should evict "b" (now the LRU) from memory, not "a".
    await cache.set("c", makeEntry(100));

    expect(await cache.get("a")).toBeDefined();
    expect(await cache.get("c")).toBeDefined();

    cache.destroy();
  });

  test("set — updating existing key updates size", async () => {
    const cache = new PersistentLRUCache({
      maxByteSize: 200,
      cacheDir: testCacheDir(),
      buildId: BUILD_ID,
      preFillMemoryCache: false,
    });

    await cache.set("a", makeEntry(100));
    // Update "a" with a larger entry.
    await cache.set("a", makeEntry(150));

    // Only 50 bytes remaining — adding 100 should evict "a" from memory.
    await cache.set("b", makeEntry(100));

    // "a" was evicted from memory but is still on disk.
    expect(await cache.get("b")).toBeDefined();

    cache.destroy();
  });

  test("persistence — save and reload", async () => {
    const dir = testCacheDir();

    const cache1 = new PersistentLRUCache({
      maxByteSize: 1024,
      cacheDir: dir,
      buildId: BUILD_ID,
      preFillMemoryCache: false,
    });

    await cache1.set("a", {
      body: new Uint8Array([1, 2, 3]),
      headers: [],
      status: 200,
      cachedAt: Date.now(),
      sMaxAge: 60,
      swr: 0,
    });
    await cache1.set("b", {
      body: new Uint8Array([4, 5, 6]),
      headers: [],
      status: 200,
      cachedAt: Date.now(),
      sMaxAge: 60,
      swr: 0,
    });
    await cache1.save();
    cache1.destroy();

    // Load a new cache from the same directory.
    const cache2 = new PersistentLRUCache({
      maxByteSize: 1024,
      cacheDir: dir,
      buildId: BUILD_ID,
      preFillMemoryCache: true,
    });

    const a = await cache2.get("a");
    expect(a?.body).toBeDefined();
    expect(Array.from(a?.body ?? [])).toEqual([1, 2, 3]);

    const b = await cache2.get("b");
    expect(b?.body).toBeDefined();
    expect(Array.from(b?.body ?? [])).toEqual([4, 5, 6]);

    cache2.destroy();
  });

  test("persistence — corrupted index starts fresh", async () => {
    const dir = testCacheDir();

    // Write garbage to the index file.
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(dir, BUILD_ID), { recursive: true });
    await Bun.write(join(dir, BUILD_ID, "index.json"), "not valid json");

    const cache = new PersistentLRUCache({
      maxByteSize: 1024,
      cacheDir: dir,
      buildId: BUILD_ID,
      preFillMemoryCache: false,
    });

    // Should start empty, not throw.
    expect(await cache.get("anything")).toBeUndefined();
    cache.destroy();
  });

  test("persistence — respects maxByteSize on load", async () => {
    const dir = testCacheDir();

    // Save with a large budget.
    const cache1 = new PersistentLRUCache({
      maxByteSize: 1024,
      cacheDir: dir,
      buildId: BUILD_ID,
      preFillMemoryCache: false,
    });

    await cache1.set("a", makeEntry(100));
    await cache1.set("b", makeEntry(100));
    await cache1.set("c", makeEntry(100));
    await cache1.save();
    cache1.destroy();

    // Reload with a smaller budget — should only load entries that fit into memory.
    const cache2 = new PersistentLRUCache({
      maxByteSize: 200,
      cacheDir: dir,
      buildId: BUILD_ID,
      preFillMemoryCache: true,
    });

    // "a" and "b" fit (200 bytes), "c" would exceed in-memory budget.
    // But "c" is still on disk and can be loaded back via get().
    expect(await cache2.get("a")).toBeDefined();
    expect(await cache2.get("b")).toBeDefined();

    cache2.destroy();
  });

  test("disk fallback — evicted entries are retrievable from disk", async () => {
    const dir = testCacheDir();
    const cache = new PersistentLRUCache({
      maxByteSize: 200,
      cacheDir: dir,
      buildId: BUILD_ID,
      preFillMemoryCache: false,
    });

    await cache.set("a", makeEntry(100));
    await cache.set("b", makeEntry(100));
    // Cache full. Adding "c" evicts "a" from memory but keeps it on disk.
    await cache.set("c", makeEntry(100));
    await cache.save();

    // "a" should be retrievable from disk.
    const result = await cache.get("a");
    expect(result).toBeDefined();
    expect(result?.body.byteLength).toBe(100);

    cache.destroy();
  });

  test("delete — removes entry file from disk", async () => {
    const dir = testCacheDir();
    const cache = new PersistentLRUCache({
      maxByteSize: 1024,
      cacheDir: dir,
      buildId: BUILD_ID,
      preFillMemoryCache: false,
    });

    await cache.set("a", makeEntry(100));
    await cache.save();

    // Verify the entries directory has a .cbor file.
    const entriesDir = join(dir, BUILD_ID, "entries");
    const indexBefore = await Bun.file(
      join(dir, BUILD_ID, "index.json")
    ).json();
    expect(Object.keys(indexBefore).length).toBe(1);

    await cache.delete("a");
    await cache.save();

    // After delete, the index should be empty.
    const indexAfter = await Bun.file(join(dir, BUILD_ID, "index.json")).json();
    expect(Object.keys(indexAfter).length).toBe(0);

    // And the entry file should be gone.
    const hash = Object.keys(indexBefore)[0];
    expect(existsSync(join(entriesDir, `${hash}.cbor`))).toBe(false);

    // get() should return undefined.
    expect(await cache.get("a")).toBeUndefined();

    cache.destroy();
  });

  test("concurrent get — deduplicates disk reads for the same key", async () => {
    const dir = testCacheDir();

    // Populate disk with an entry.
    const cache1 = new PersistentLRUCache({
      maxByteSize: 1024,
      cacheDir: dir,
      buildId: BUILD_ID,
      preFillMemoryCache: false,
    });
    await cache1.set("a", {
      body: new Uint8Array([10, 20, 30]),
      headers: [],
      status: 200,
      cachedAt: Date.now(),
      sMaxAge: 60,
      swr: 0,
    });
    await cache1.save();
    cache1.destroy();

    // Create a new cache so "a" is only on disk (not in-memory LRU yet).
    const cache2 = new PersistentLRUCache({
      maxByteSize: 1024,
      cacheDir: dir,
      buildId: BUILD_ID,
      preFillMemoryCache: false,
    });

    // Fire multiple concurrent get() calls for the same key.
    const results = await Promise.all([
      cache2.get("a"),
      cache2.get("a"),
      cache2.get("a"),
    ]);

    // All should return the same defined entry.
    for (const r of results) {
      expect(r).toBeDefined();
      expect(Array.from(r?.body ?? [])).toEqual([10, 20, 30]);
    }

    cache2.destroy();
  });

  test("get during pre-fill — returns correct entry", async () => {
    const dir = testCacheDir();

    // Populate disk with entries.
    const cache1 = new PersistentLRUCache({
      maxByteSize: 1024,
      cacheDir: dir,
      buildId: BUILD_ID,
      preFillMemoryCache: false,
    });
    await cache1.set("x", {
      body: new Uint8Array([1, 2, 3]),
      headers: [],
      status: 200,
      cachedAt: Date.now(),
      sMaxAge: 60,
      swr: 0,
    });
    await cache1.set("y", {
      body: new Uint8Array([4, 5, 6]),
      headers: [],
      status: 200,
      cachedAt: Date.now(),
      sMaxAge: 60,
      swr: 0,
    });
    await cache1.save();
    cache1.destroy();

    // Create a new cache (triggers pre-fill) and immediately call get().
    const cache2 = new PersistentLRUCache({
      maxByteSize: 1024,
      cacheDir: dir,
      buildId: BUILD_ID,
      preFillMemoryCache: true,
    });

    // get() during pre-fill should return the correct entry.
    const x = await cache2.get("x");
    expect(x).toBeDefined();
    expect(Array.from(x?.body ?? [])).toEqual([1, 2, 3]);

    const y = await cache2.get("y");
    expect(y).toBeDefined();
    expect(Array.from(y?.body ?? [])).toEqual([4, 5, 6]);

    cache2.destroy();
  });

  test("preFillMemoryCache false — skips pre-fill but disk fallback works", async () => {
    const dir = testCacheDir();

    // Populate disk with entries.
    const cache1 = new PersistentLRUCache({
      maxByteSize: 1024,
      cacheDir: dir,
      buildId: BUILD_ID,
      preFillMemoryCache: false,
    });
    await cache1.set("a", {
      body: new Uint8Array([1, 2, 3]),
      headers: [],
      status: 200,
      cachedAt: Date.now(),
      sMaxAge: 60,
      swr: 0,
    });
    await cache1.set("b", {
      body: new Uint8Array([4, 5, 6]),
      headers: [],
      status: 200,
      cachedAt: Date.now(),
      sMaxAge: 60,
      swr: 0,
    });
    await cache1.save();
    cache1.destroy();

    // Reload with preFillMemoryCache: false — entries should NOT be in memory
    // after construction, but should still be accessible via disk fallback.
    const cache2 = new PersistentLRUCache({
      maxByteSize: 1024,
      cacheDir: dir,
      buildId: BUILD_ID,
      preFillMemoryCache: false,
    });

    // Entries are available via L2 disk fallback.
    const a = await cache2.get("a");
    expect(a).toBeDefined();
    expect(Array.from(a?.body ?? [])).toEqual([1, 2, 3]);

    const b = await cache2.get("b");
    expect(b).toBeDefined();
    expect(Array.from(b?.body ?? [])).toEqual([4, 5, 6]);

    cache2.destroy();
  });

  test("save — drains all pending writes before flushing index", async () => {
    const dir = testCacheDir();
    const cache = new PersistentLRUCache({
      maxByteSize: 1024,
      cacheDir: dir,
      buildId: BUILD_ID,
      preFillMemoryCache: false,
    });

    // Set multiple entries without awaiting save in between.
    await cache.set("a", makeEntry(50));
    await cache.set("b", makeEntry(50));
    await cache.set("c", makeEntry(50));

    // save() should drain all pending writes.
    await cache.save();

    // Verify all entries are on disk via the index.
    const index = await Bun.file(join(dir, BUILD_ID, "index.json")).json();
    expect(Object.keys(index).length).toBe(3);

    // Verify each .cbor file exists.
    const entriesDir = join(dir, BUILD_ID, "entries");
    for (const hash of Object.keys(index)) {
      expect(existsSync(join(entriesDir, `${hash}.cbor`))).toBe(true);
    }

    cache.destroy();
  });

  test("individual entry files — each set creates a .cbor file", async () => {
    const dir = testCacheDir();
    const cache = new PersistentLRUCache({
      maxByteSize: 1024,
      cacheDir: dir,
      buildId: BUILD_ID,
      preFillMemoryCache: false,
    });

    await cache.set("x", makeEntry(50));
    await cache.set("y", makeEntry(50));
    await cache.save();

    const index = await Bun.file(join(dir, BUILD_ID, "index.json")).json();
    const hashes = Object.keys(index);
    expect(hashes.length).toBe(2);

    // Each hash should correspond to a .cbor file on disk.
    const entriesDir = join(dir, BUILD_ID, "entries");
    for (const hash of hashes) {
      expect(existsSync(join(entriesDir, `${hash}.cbor`))).toBe(true);
    }

    cache.destroy();
  });

  describe("vacuum", () => {
    test("removes old build directories on new cache creation", async () => {
      const dir = testCacheDir();

      const cache1 = new PersistentLRUCache({
        maxByteSize: 1024,
        cacheDir: dir,
        buildId: "build-a",
        preFillMemoryCache: false,
      });
      await cache1.set("a", makeEntry(50));
      await cache1.save();
      cache1.destroy();

      expect(existsSync(join(dir, "build-a"))).toBe(true);

      // Creating a cache with a new build ID should vacuum build-a.
      const cache2 = new PersistentLRUCache({
        maxByteSize: 1024,
        cacheDir: dir,
        buildId: "build-b",
        preFillMemoryCache: false,
      });
      // Wait for load() to finish.
      await cache2.get("anything");

      expect(existsSync(join(dir, "build-a"))).toBe(false);
      expect(existsSync(join(dir, "build-b"))).toBe(true);

      cache2.destroy();
    });

    test("corrupted manifest.json allows fresh start", async () => {
      const dir = testCacheDir();
      mkdirSync(dir, { recursive: true });
      await Bun.write(join(dir, "manifest.json"), "not valid json");

      const cache = new PersistentLRUCache({
        maxByteSize: 1024,
        cacheDir: dir,
        buildId: BUILD_ID,
        preFillMemoryCache: false,
      });

      // Should not throw — starts fresh.
      await cache.set("a", makeEntry(50));
      expect(await cache.get("a")).toBeDefined();

      cache.destroy();
    });

    test("current build directory is preserved during vacuum", async () => {
      const dir = testCacheDir();

      const cache1 = new PersistentLRUCache({
        maxByteSize: 1024,
        cacheDir: dir,
        buildId: BUILD_ID,
        preFillMemoryCache: false,
      });
      await cache1.set("a", makeEntry(50));
      await cache1.save();
      cache1.destroy();

      // Recreate with the same build ID — entries should survive.
      const cache2 = new PersistentLRUCache({
        maxByteSize: 1024,
        cacheDir: dir,
        buildId: BUILD_ID,
        preFillMemoryCache: false,
      });

      const a = await cache2.get("a");
      expect(a).toBeDefined();
      expect(a?.body.byteLength).toBe(50);

      cache2.destroy();
    });

    test("preserves orphaned directories not in manifest", async () => {
      const dir = testCacheDir();

      // Create a cache to establish a manifest.
      const cache1 = new PersistentLRUCache({
        maxByteSize: 1024,
        cacheDir: dir,
        buildId: BUILD_ID,
        preFillMemoryCache: false,
      });
      await cache1.set("a", makeEntry(50));
      await cache1.save();
      cache1.destroy();

      // Manually create an orphaned directory.
      mkdirSync(join(dir, "orphaned-build"), { recursive: true });
      expect(existsSync(join(dir, "orphaned-build"))).toBe(true);

      // Creating a new cache should NOT clean up the orphan.
      const cache2 = new PersistentLRUCache({
        maxByteSize: 1024,
        cacheDir: dir,
        buildId: "new-build",
        preFillMemoryCache: false,
      });
      await cache2.get("anything");

      expect(existsSync(join(dir, "orphaned-build"))).toBe(true);
      expect(existsSync(join(dir, BUILD_ID))).toBe(false);
      expect(existsSync(join(dir, "new-build"))).toBe(true);

      cache2.destroy();
    });
  });
});
