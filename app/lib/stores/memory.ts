/**
 * Active project memory (mnemo-cortex-inspired).
 *
 * A lightweight, local-first memory: after every completed assistant response
 * a compact summary is stored locally; later chats recall the most recent
 * memories so the assistant keeps continuity across sessions.
 *
 * Storage is localStorage (main thread only — dedicated workers have no DOM
 * storage); the chat worker receives the recalled entries through the request
 * payload and injects them into the system prompt (<project_memory>).
 */

import { useStore } from '@nanostores/react';
import { atom } from 'nanostores';

const MEMORY_KEY = 'bolt_project_memory';
const MAX_ENTRIES = 50;

export interface MemoryEntry {
  chatId?: string;
  timestamp: string;
  summary: string;
}

function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

const memoryVersion = atom<number>(0);

function loadEntries(): MemoryEntry[] {
  if (!isBrowser()) {
    return [];
  }

  try {
    const raw = localStorage.getItem(MEMORY_KEY);
    const parsed = raw ? (JSON.parse(raw) as MemoryEntry[]) : [];

    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persist(entries: MemoryEntry[]) {
  if (isBrowser()) {
    localStorage.setItem(MEMORY_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  }

  memoryVersion.set(memoryVersion.get() + 1);
}

/**
 * Record a memory for a completed assistant response. Empty/trivial text is
 * ignored. Returns true when a memory was stored.
 */
export function recordMemory(input: { chatId?: string; text: string }): boolean {
  const summary = (input.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 400);

  if (summary.length < 20) {
    return false;
  }

  const entries = loadEntries();

  // Avoid duplicates when the same turn finishes twice (regenerate etc.).
  if (entries[0]?.chatId === input.chatId && entries[0]?.summary === summary) {
    return false;
  }

  entries.unshift({
    chatId: input.chatId,
    timestamp: new Date().toISOString().slice(0, 16).replace('T', ' '),
    summary,
  });

  persist(entries);

  return true;
}

/**
 * Recall the most recent memories, optionally excluding the active chat (its
 * own context is already present in the conversation).
 */
export function recallMemories(excludeChatId?: string, limit: number = 8): MemoryEntry[] {
  return loadEntries()
    .filter((entry) => !excludeChatId || entry.chatId !== excludeChatId)
    .slice(0, limit);
}

export function clearMemories() {
  persist([]);
}

export function getAllMemories(): MemoryEntry[] {
  return loadEntries();
}

/** React hook for memory UI (e.g. a settings section). */
export function useMemories() {
  const version = useStore(memoryVersion);

  return {
    memories: version >= 0 ? loadEntries() : [],
    recordMemory,
    recallMemories,
    clearMemories,
  };
}
