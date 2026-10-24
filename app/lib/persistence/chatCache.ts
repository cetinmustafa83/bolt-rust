import { getMessages, getSnapshot } from './db';
import type { Snapshot } from './types';

type ChatHistoryItem = Awaited<ReturnType<typeof getMessages>>;

/*
 * Message and snapshot caches keep resolved promises so hover-prefetch and
 * chat switches never re-read IndexedDB. Snapshots hold whole project file
 * trees, so an unbounded cache would accumulate every visited chat for the
 * lifetime of the tab — the maps are therefore LRU-capped.
 */
const MAX_CACHED_CHATS = 12;

const messageCache = new Map<string, Promise<ChatHistoryItem>>();
const snapshotCache = new Map<string, Promise<Snapshot | undefined>>();

/**
 * Insert with recency bump and LRU eviction: re-inserting moves the key to
 * the tail (Map iteration order), and the oldest entry is dropped once the
 * cap is exceeded. Evicting only drops the cached promise — a later access
 * simply re-reads from IndexedDB.
 */
function setLru<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);

  while (map.size > MAX_CACHED_CHATS) {
    const oldest = map.keys().next().value;

    if (oldest === undefined) {
      break;
    }

    map.delete(oldest);
  }
}

/** Touch a key so it counts as recently used without changing its value. */
function touchLru<V>(map: Map<string, V>, key: string): void {
  const value = map.get(key);

  if (value !== undefined) {
    map.delete(key);
    map.set(key, value);
  }
}

/**
 * Prefetch chat messages and snapshot from IndexedDB on hover.
 * This primes the in-memory cache before the user clicks to switch chats.
 */
export function prefetchChat(database: IDBDatabase | undefined, id: string) {
  if (!database || !id) {
    return;
  }

  const messages = messageCache.get(id) ?? getMessages(database, id);
  setLru(messageCache, id, messages);

  void messages
    .then((chat) => {
      if (chat && !snapshotCache.has(chat.id)) {
        setLru(snapshotCache, chat.id, getSnapshot(database, chat.id));
      }
    })
    .catch(() => undefined);
}

/**
 * Get messages, using the cached promise if available from prefetch.
 */
export async function getCachedMessages(database: IDBDatabase, id: string): Promise<ChatHistoryItem> {
  const cached = messageCache.get(id);

  if (cached) {
    touchLru(messageCache, id);

    return cached;
  }

  const promise = getMessages(database, id);
  setLru(messageCache, id, promise);

  return promise;
}

/**
 * Get snapshot, using the cached promise if available from prefetch.
 */
export async function getCachedSnapshot(database: IDBDatabase, id: string): Promise<Snapshot | undefined> {
  const cached = snapshotCache.get(id);

  if (cached) {
    touchLru(snapshotCache, id);

    return cached;
  }

  const promise = getSnapshot(database, id);
  setLru(snapshotCache, id, promise);

  return promise;
}

/**
 * Invalidate cache entry when chat or snapshot is saved/updated.
 */
export function invalidateChatCache(id?: string) {
  if (id) {
    messageCache.delete(id);
    snapshotCache.delete(id);
  } else {
    messageCache.clear();
    snapshotCache.clear();
  }
}
