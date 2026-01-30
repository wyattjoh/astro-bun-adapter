import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { decode, encode } from "cbor2";
import debug from "debug";
import type { ISRCacheEntry } from "../types.ts";

const log = debug("@wyattjoh/astro-bun-adapter:cache");

/**
 * A node within the doubly-linked list that tracks access recency.
 * Stores the cached value alongside its computed byte cost.
 */
class CacheNode {
  public readonly key: string;
  public value: ISRCacheEntry;
  public size: number;
  public older: CacheNode | BoundaryNode | null = null;
  public newer: CacheNode | BoundaryNode | null = null;

  constructor(key: string, value: ISRCacheEntry, size: number) {
    this.key = key;
    this.value = value;
    this.size = size;
  }
}

/**
 * Placeholder node at each end of the linked list.
 * Eliminates null-checks when inserting or removing real nodes.
 */
class BoundaryNode {
  public older: CacheNode | BoundaryNode | null = null;
  public newer: CacheNode | BoundaryNode | null = null;
}

interface PersistentLRUCacheOptions {
  maxByteSize: number;
  cacheDir: string;
  buildId: string;
}

/**
 * Two-tier byte-limited LRU cache. L1 is an in-memory LRU backed by a
 * doubly-linked list. L2 is per-entry CBOR files on disk. When the LRU evicts
 * entries due to byte budget pressure, they remain on disk and can be loaded
 * back on a subsequent `get()` miss.
 *
 * Layout: FRONT (newest) <-> ... <-> BACK (oldest)
 */
export class PersistentLRUCache {
  private readonly entries = new Map<string, CacheNode>();
  private readonly front: BoundaryNode;
  private readonly back: BoundaryNode;
  private currentBytes = 0;
  private ready: Promise<void> | true;

  private readonly maxByteSize: number;
  private readonly cacheDir: string;
  private readonly buildId: string;
  private readonly entriesDir: string;
  private readonly indexPath: string;

  /** Pathnames known to exist on disk. */
  private readonly diskKeys = new Set<string>();
  /** pathname → SHA-256 hex hash (avoids recomputing). */
  private readonly hashIndex = new Map<string, string>();

  /** Whether the entries directory has been created. */
  private dirReady = false;
  /** Debounce timer for index writes. */
  private indexTimer: ReturnType<typeof setTimeout> | undefined;
  /** In-flight disk writes (drained by `save()`). */
  private readonly pendingWrites = new Set<Promise<void>>();
  /** In-flight disk reads keyed by pathname (deduplicates concurrent `get()` calls). */
  private readonly pendingLoads = new Map<
    string,
    Promise<ISRCacheEntry | undefined>
  >();

  /** @param options - Cache configuration (byte limit, cache dir, build ID). */
  constructor(options: PersistentLRUCacheOptions) {
    this.maxByteSize = options.maxByteSize;
    this.cacheDir = options.cacheDir;
    this.buildId = options.buildId;
    this.entriesDir = join(options.cacheDir, options.buildId, "entries");
    this.indexPath = join(options.cacheDir, options.buildId, "index.json");

    // Wire up boundary nodes: FRONT <-> BACK (empty list).
    this.front = new BoundaryNode();
    this.back = new BoundaryNode();
    this.front.newer = this.back;
    this.back.older = this.front;

    this.ready = this.load();
  }

  /**
   * Retrieve an entry by key, promoting it to the most-recently-used position.
   * Falls back to disk when the key is not in memory but exists on disk.
   * @param key - Cache key to look up.
   * @returns The cached entry, or `undefined` if the key is not present.
   */
  async get(key: string): Promise<ISRCacheEntry | undefined> {
    if (this.ready !== true) await this.ready;

    // L1: in-memory lookup.
    const node = this.entries.get(key);
    if (node) {
      log(`L1 cache hit: ${key}`);
      this.promote(node);
      return node.value;
    }

    // L2: check for an in-flight disk read first (deduplicates concurrent calls).
    const inflight = this.pendingLoads.get(key);
    if (inflight) return inflight;

    // No disk entry known — nothing to load.
    if (!this.diskKeys.has(key)) return undefined;

    // Start a disk load and register it so concurrent callers piggyback.
    const load = this.loadFromDisk(key);
    this.pendingLoads.set(key, load);
    return load;
  }

  /**
   * Insert or update an entry. Updates the in-memory LRU synchronously and
   * persists to disk in the background (fire-and-forget).
   * @param key - Cache key to store under.
   * @param value - The ISR cache entry to store.
   */
  async set(key: string, value: ISRCacheEntry): Promise<void> {
    if (this.ready !== true) await this.ready;
    const size = value.body.byteLength;

    // Update in-memory LRU.
    const existing = this.entries.get(key);
    if (existing) {
      existing.value = value;
      this.currentBytes = this.currentBytes - existing.size + size;
      existing.size = size;
      this.promote(existing);
    } else {
      const node = new CacheNode(key, value, size);
      this.entries.set(key, node);
      this.insertAfterFront(node);
      this.currentBytes += size;
    }

    this.evictOverBudget();

    // Background disk persistence (tracked for `save()` drain).
    this.diskKeys.add(key);
    const write = this.persistEntry(key, value)
      .catch(() => {})
      .finally(() => this.pendingWrites.delete(write));
    this.pendingWrites.add(write);
  }

  /**
   * Remove a single entry from both memory and disk.
   * @param key - Cache key to remove.
   */
  async delete(key: string): Promise<void> {
    if (this.ready !== true) await this.ready;
    log(`Cache delete: ${key}`);

    // Remove from in-memory LRU.
    const node = this.entries.get(key);
    if (node) {
      this.detach(node);
      this.entries.delete(key);
      this.currentBytes -= node.size;
    }

    // Remove from disk.
    if (this.diskKeys.has(key)) {
      const hash = this.hashPathname(key);
      this.diskKeys.delete(key);
      this.hashIndex.delete(key);
      rm(this.entryPath(hash), { force: true }).catch(() => {});
      this.scheduleIndexWrite();
    }
  }

  /** Drain pending writes and flush the index to disk. */
  async save(): Promise<void> {
    await Promise.all(this.pendingWrites);
    this.clearIndexTimer();
    await this.writeIndex();
  }

  /** Cancel pending timers and best-effort index flush. */
  destroy(): void {
    this.clearIndexTimer();
    this.writeIndex().catch(() => {});
  }

  /**
   * Read a single entry from disk, insert it into the in-memory LRU, and
   * remove the in-flight promise from `pendingLoads` when done.
   */
  private async loadFromDisk(key: string): Promise<ISRCacheEntry | undefined> {
    try {
      log(`L2 disk load: ${key}`);
      const hash = this.hashPathname(key);
      const path = this.entryPath(hash);
      const raw = new Uint8Array(await Bun.file(path).arrayBuffer());
      const entry = decode(raw) as ISRCacheEntry;

      // Insert into in-memory LRU (may evict others — they stay on disk).
      const size = entry.body.byteLength;
      const node = new CacheNode(key, entry, size);
      this.entries.set(key, node);
      this.insertAfterFront(node);
      this.currentBytes += size;
      this.evictOverBudget();

      return entry;
    } catch {
      // File missing or corrupted — remove from disk index.
      this.diskKeys.delete(key);
      this.hashIndex.delete(key);
      return undefined;
    } finally {
      this.pendingLoads.delete(key);
    }
  }

  /** Compute or retrieve the cached SHA-256 hex hash for a pathname. */
  private hashPathname(pathname: string): string {
    const cached = this.hashIndex.get(pathname);
    if (cached) return cached;

    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(pathname);
    const hex = hasher.digest("hex");
    this.hashIndex.set(pathname, hex);
    return hex;
  }

  /** Resolve the disk path for an entry by its hash. */
  private entryPath(hash: string): string {
    return join(this.entriesDir, `${hash}.cbor`);
  }

  /** Encode and write a single entry to disk, then schedule an index write. */
  private async persistEntry(key: string, value: ISRCacheEntry): Promise<void> {
    const hash = this.hashPathname(key);
    const encoded = encode(value);
    await this.ensureDir();
    await Bun.write(this.entryPath(hash), encoded);
    log(`Persisted to disk: ${key}`);
    this.scheduleIndexWrite();
  }

  /** Create the entries directory if it hasn't been created yet. */
  private async ensureDir(): Promise<void> {
    if (this.dirReady) return;
    await mkdir(this.entriesDir, { recursive: true });
    this.dirReady = true;
  }

  /** Schedule a debounced index write (coalesces rapid mutations). */
  private scheduleIndexWrite(): void {
    if (this.indexTimer) return;
    this.indexTimer = setTimeout(() => {
      this.indexTimer = undefined;
      this.writeIndex().catch(() => {});
    }, 1000);
    // Let the process exit without waiting for this timer.
    this.indexTimer.unref();
  }

  /** Cancel a pending debounced index write. */
  private clearIndexTimer(): void {
    if (this.indexTimer) {
      clearTimeout(this.indexTimer);
      this.indexTimer = undefined;
    }
  }

  /** Write the hash → pathname index to disk. */
  private async writeIndex(): Promise<void> {
    const index: Record<string, string> = {};
    for (const [pathname, hash] of this.hashIndex) {
      if (this.diskKeys.has(pathname)) {
        index[hash] = pathname;
      }
    }
    await Bun.write(this.indexPath, JSON.stringify(index));
  }

  /**
   * Place a node directly after the front boundary (newest position).
   * @param node - The node to insert.
   */
  private insertAfterFront(node: CacheNode): void {
    node.older = this.front;
    node.newer = this.front.newer;
    (this.front.newer as CacheNode | BoundaryNode).older = node;
    this.front.newer = node;
  }

  /**
   * Unlink a node from its neighbors without removing it from the map.
   * @param node - The node to detach.
   */
  private detach(node: CacheNode): void {
    (node.older as CacheNode | BoundaryNode).newer = node.newer;
    (node.newer as CacheNode | BoundaryNode).older = node.older;
  }

  /**
   * Move an existing node to the newest position.
   * @param node - The node to promote.
   */
  private promote(node: CacheNode): void {
    this.detach(node);
    this.insertAfterFront(node);
  }

  /**
   * Remove and return the oldest node (the one just before the back boundary).
   * @returns The evicted node.
   */
  private evictLast(): CacheNode {
    const oldest = this.back.older as CacheNode;
    this.detach(oldest);
    return oldest;
  }

  /** Drop oldest entries from memory until within byte budget. They remain on disk. */
  private evictOverBudget(): void {
    while (this.currentBytes > this.maxByteSize && this.entries.size > 0) {
      const evicted = this.evictLast();
      log(`LRU evicted from memory: ${evicted.key} (${evicted.size} bytes)`);
      this.entries.delete(evicted.key);
      this.currentBytes -= evicted.size;
      // Entry stays on disk — do NOT remove from diskKeys.
    }
  }

  /**
   * Cleans up cache directories from previous builds and records the current build.
   * Only directories tracked in the manifest are removed — unrelated files are untouched.
   */
  private async vacuum(): Promise<void> {
    const manifestPath = join(this.cacheDir, "manifest.json");

    let manifest: { buildIds: string[] } = { buildIds: [] };
    const manifestFile = Bun.file(manifestPath);
    if (await manifestFile.exists()) {
      try {
        manifest = await manifestFile.json();
      } catch {
        // Unreadable manifest — start from scratch.
      }
    }

    for (const oldId of manifest.buildIds) {
      if (oldId === this.buildId) continue;
      log(`Vacuuming old build: ${oldId}`);
      await rm(join(this.cacheDir, oldId), { recursive: true, force: true });
    }

    await mkdir(this.cacheDir, { recursive: true });
    await Bun.write(manifestPath, JSON.stringify({ buildIds: [this.buildId] }));
  }

  /**
   * Restore cache state from persisted entry files. Resolves `ready` after
   * the index is restored (so `get()` can fall back to disk), then pre-fills
   * the in-memory LRU in the background via `loadFromDisk()` — any concurrent
   * `get()` call for a pre-filling key piggybacks on the in-flight promise.
   */
  private async load(): Promise<void> {
    await this.vacuum();
    await this.ensureDir();

    // Load the index if it exists.
    const indexFile = Bun.file(this.indexPath);
    if (!(await indexFile.exists())) {
      this.ready = true;
      return;
    }

    let index: Record<string, string>;
    try {
      index = await indexFile.json();
    } catch {
      // Damaged index — begin with an empty cache.
      this.ready = true;
      return;
    }

    // Populate diskKeys and hashIndex from the persisted index.
    // Index format: { hash: pathname }
    const entries = Object.entries(index);
    log(`Restoring ${entries.length} entries from disk index`);
    for (const [hash, pathname] of entries) {
      this.diskKeys.add(pathname);
      this.hashIndex.set(pathname, hash);
    }

    // Mark ready — get() can now serve disk fallback requests while
    // pre-fill proceeds in the background.
    this.ready = true;

    // Pre-fill in-memory LRU from disk entries up to maxByteSize.
    // Uses loadFromDisk() so concurrent get() calls deduplicate.
    let preFilled = 0;
    for (const pathname of Object.values(index)) {
      // Already loaded by a concurrent get() — skip.
      if (this.entries.has(pathname)) continue;

      // Check if loading this entry would exceed budget (approximate — the
      // actual size isn't known until decoded, but we stop once we hit the
      // limit inside loadFromDisk → evictOverBudget).
      if (this.currentBytes >= this.maxByteSize) break;

      // Kick off a load. If a get() already started one, piggyback on it.
      const inflight = this.pendingLoads.get(pathname);
      if (inflight) {
        await inflight;
        continue;
      }

      const load = this.loadFromDisk(pathname);
      this.pendingLoads.set(pathname, load);
      await load;
      preFilled++;
    }

    log(`Pre-filled ${preFilled} entries into memory`);
  }
}
