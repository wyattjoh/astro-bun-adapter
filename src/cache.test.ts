import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  registerCache,
  unstable_expireAll,
  unstable_expirePath,
} from "./cache.ts";

const CACHE_KEY = Symbol.for("@wyattjoh/astro-bun-adapter:isr-cache");

afterEach(() => {
  // Clean up the global cache reference between tests.
  delete (globalThis as Record<symbol, unknown>)[CACHE_KEY];
});

describe("unstable_expirePath", () => {
  test("no-op when no cache is registered", async () => {
    // Should resolve without throwing.
    await unstable_expirePath("/some/path");
  });

  test("calls cache.expire with the given pathname", async () => {
    const expireFn = mock(async (_key: string) => {});
    registerCache({ expire: expireFn, expireAll: async () => {} });

    await unstable_expirePath("/blog/my-post");

    expect(expireFn).toHaveBeenCalledTimes(1);
    expect(expireFn).toHaveBeenCalledWith("/blog/my-post");
  });

  test("propagates errors from cache.expire", async () => {
    const error = new Error("disk failure");
    registerCache({
      expire: async () => {
        throw error;
      },
      expireAll: async () => {},
    });

    await expect(unstable_expirePath("/fail")).rejects.toThrow("disk failure");
  });
});

describe("unstable_expireAll", () => {
  test("no-op when no cache is registered", async () => {
    // Should resolve without throwing.
    await unstable_expireAll();
  });

  test("calls cache.expireAll", async () => {
    const expireAllFn = mock(async () => {});
    registerCache({ expire: async () => {}, expireAll: expireAllFn });

    await unstable_expireAll();

    expect(expireAllFn).toHaveBeenCalledTimes(1);
  });

  test("propagates errors from cache.expireAll", async () => {
    const error = new Error("disk failure");
    registerCache({
      expire: async () => {},
      expireAll: async () => {
        throw error;
      },
    });

    await expect(unstable_expireAll()).rejects.toThrow("disk failure");
  });
});
