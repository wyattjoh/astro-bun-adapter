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
  public older!: CacheNode | BoundaryNode;
  public newer!: CacheNode | BoundaryNode;

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
  public older: CacheNode | BoundaryNode;
  public newer: CacheNode | BoundaryNode;

  constructor() {
    this.older = this;
    this.newer = this;
  }
}

interface PersistentLRUCacheOptions {
  maxByteSize: number;
  cacheDir: string;
  buildId: string;
  preFillMemoryCache: boolean;
}

/**
 * Two-tier byte-limited LRU cache. L1 is an in-memory LRU backed by a
 * doubly-linked list. L2 is per-entry CBOR files on disk. When the LRU evicts
 * entries due to byte budget pressure, they remain on disk and can be loaded
 * back on a subsequent `get()` miss.
 *
 * Note: The cache does not enforce TTL. Expiration is handled externally by the
 * ISR handler, which checks `cachedAt + sMaxAge` on every read.
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
  private readonly preFillMemoryCache: boolean;
  private readonly entriesDir: string;
  private readonly indexPath: string;

  /** Pathnames known to exist on disk. */
  private readonly diskKeys = new Set<string>();
  /**
   * pathname → SHA-256 hex hash (avoids recomputing).
   * Note: the on-disk index inverts this mapping (hash → pathname) for
   * human-readable JSON. See {@link writeIndex} and {@link load}.
   */
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
    this.preFillMemoryCache = options.preFillMemoryCache;
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

    // Skip entries that exceed the entire budget — they'd be evicted immediately.
    if (size > this.maxByteSize) {
      log(`Skipping oversized entry: ${key} (${size} > ${this.maxByteSize})`);
      return;
    }

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
    const write = this.persistEntry(key, value).catch(() => {});
    this.pendingWrites.add(write);
    void write.finally(() => this.pendingWrites.delete(write));
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
      const removal = rm(this.entryPath(hash), { force: true }).catch(() => {});
      this.pendingWrites.add(removal);
      void removal.finally(() => this.pendingWrites.delete(removal));
      this.scheduleIndexWrite();
    }
  }

  /** Drain pending writes and flush the index to disk. */
  async save(): Promise<void> {
    await Promise.all(this.pendingWrites);
    this.clearIndexTimer();
    await this.writeIndex();
  }

  /** Drain pending writes, cancel timers, and flush the index. */
  async destroy(): Promise<void> {
    await Promise.all(this.pendingWrites);
    this.clearIndexTimer();
    await this.writeIndex().catch(() => {});
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

      // A concurrent set() may have inserted this key while we were reading
      // from disk — if so, promote the existing node and return its value.
      const existing = this.entries.get(key);
      if (existing) {
        this.promote(existing);
        return existing.value;
      }

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
    this.front.newer.older = node;
    this.front.newer = node;
  }

  /**
   * Unlink a node from its neighbors without removing it from the map.
   * @param node - The node to detach.
   */
  private detach(node: CacheNode): void {
    node.older.newer = node.newer;
    node.newer.older = node.older;
  }

  /**
   * Move an existing node to the newest position.
   * @param node - The node to promote.
   */
  private promote(node: CacheNode): void {
    this.detach(node);
    this.insertAfterFront(node);
  }

  /** Drop oldest entries from memory until within byte budget. They remain on disk. */
  private evictOverBudget(): void {
    while (this.currentBytes > this.maxByteSize && this.entries.size > 0) {
      const oldest = this.back.older;
      if (oldest instanceof BoundaryNode) break;
      this.detach(oldest);
      log(`LRU evicted from memory: ${oldest.key} (${oldest.size} bytes)`);
      this.entries.delete(oldest.key);
      this.currentBytes -= oldest.size;
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

    const trackedIds = new Set(manifest.buildIds);

    for (const oldId of trackedIds) {
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

    if (this.preFillMemoryCache) {
      void this.preFill(index);
    }
  }

  /**
   * Pre-fill the in-memory LRU from disk entries up to maxByteSize.
   * Runs in the background after `load()` resolves so it doesn't block callers.
   * Uses `loadFromDisk()` so concurrent `get()` calls deduplicate.
   */
  private async preFill(index: Record<string, string>): Promise<void> {
    const BATCH_SIZE = 8;
    const pathnames = Object.values(index);
    let preFilled = 0;

    for (let i = 0; i < pathnames.length; i += BATCH_SIZE) {
      if (this.currentBytes >= this.maxByteSize) break;

      const batch: Promise<ISRCacheEntry | undefined>[] = [];
      for (let j = i; j < Math.min(i + BATCH_SIZE, pathnames.length); j++) {
        const pathname = pathnames[j];

        // Already loaded by a concurrent get() — skip.
        if (this.entries.has(pathname)) continue;

        // Budget exceeded — stop adding to this batch.
        if (this.currentBytes >= this.maxByteSize) break;

        // Piggyback on an in-flight load if one exists.
        const inflight = this.pendingLoads.get(pathname);
        if (inflight) {
          batch.push(inflight);
          continue;
        }

        const load = this.loadFromDisk(pathname);
        this.pendingLoads.set(pathname, load);
        batch.push(load);
      }

      const results = await Promise.all(batch);
      preFilled += results.filter((entry) => entry !== undefined).length;
    }

    log(`Pre-filled ${preFilled} entries into memory`);
  }
}
