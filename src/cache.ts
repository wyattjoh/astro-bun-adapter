import debug from "debug";
import type { ISRCache } from "./types.ts";

const log = debug("@wyattjoh/astro-bun-adapter:expire");

const CACHE_KEY = Symbol.for("@wyattjoh/astro-bun-adapter:isr-cache");

/** @internal Register the ISR cache instance on globalThis for cross-module access. */
export function registerCache(instance: ISRCache): void {
  (globalThis as Record<symbol, unknown>)[CACHE_KEY] = instance;
}

function getCache(): ISRCache | undefined {
  return (globalThis as Record<symbol, unknown>)[CACHE_KEY] as
    | ISRCache
    | undefined;
}

/**
 * Expire an ISR cache entry by its pathname. The entry is deleted from the
 * cache and will be re-rendered on the next request (lazy revalidation).
 *
 * No-op when ISR is not enabled — safe to call unconditionally.
 *
 * @example
 * ```ts
 * import { unstable_expirePath } from "@wyattjoh/astro-bun-adapter/cache";
 *
 * // In an API route or middleware:
 * await unstable_expirePath("/blog/my-post");
 * ```
 */
export async function unstable_expirePath(pathname: string): Promise<void> {
  const cache = getCache();
  if (!cache) {
    log(
      "unstable_expirePath(%s) — no ISR cache registered, skipping",
      pathname
    );
    return;
  }
  log("unstable_expirePath(%s) — expiring cache entry", pathname);
  await cache.expire(pathname);
}

/**
 * Expire all ISR cache entries. Every cached page is deleted and will be
 * re-rendered on the next request (lazy revalidation).
 *
 * No-op when ISR is not enabled — safe to call unconditionally.
 *
 * @example
 * ```ts
 * import { unstable_expireAll } from "@wyattjoh/astro-bun-adapter/cache";
 *
 * // In an API route or middleware:
 * await unstable_expireAll();
 * ```
 */
export async function unstable_expireAll(): Promise<void> {
  const cache = getCache();
  if (!cache) {
    log("unstable_expireAll() — no ISR cache registered, skipping");
    return;
  }
  log("unstable_expireAll() — expiring all cache entries");
  await cache.expireAll();
}
