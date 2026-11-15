import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'lake-govern-config:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

/** 取最新数据并重置内存缓存：事务开始前调用，避免跨标签页读到旧缓存。 */
export function latestRows(key: string): EntryRow[] {
  reloadFromStorage()
  return listRows(key)
}

/** 丢弃内存缓存重新读 localStorage。 */
export function reloadFromStorage(): void {
  cache = null
}

/**
 * 监听其它标签页的写入：一旦 `entries` 或目标路径锁变化就丢缓存，
 * 页面下次读取能拿到最新数据。返回取消订阅函数。
 */
export function subscribeStorage(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    return () => undefined
  }
  const handler = (event: Event) => {
    const key = (event as StorageEvent).key
    if (key === null || key === STORAGE_KEY || key.startsWith('lake-govern-config:target-lock:')) {
      reloadFromStorage()
      onChange()
    }
  }
  window.addEventListener('storage', handler)
  return () => window.removeEventListener('storage', handler)
}

export function saveRows(key: string, rows: EntryRow[]): void {
  commitRows({ [key]: rows })
}

/**
 * 跨模块原子写入：一次序列化、一次 setItem。原始表和版本快照必须同时落盘，
 * 任何一步抛错都把内存缓存回滚到写入前，避免只写其中一边。
 */
export function commitRows(changes: Record<string, EntryRow[]>): void {
  const next = { ...allRows(), ...changes }
  const previous = cache
  cache = next
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    }
  } catch (error) {
    cache = previous
    throw error
  }
}

/** 写入前的内存快照，事务失败时用作回滚点。 */
export function checkpoint(): Record<string, EntryRow[]> {
  return clone(allRows())
}

/**
 * 回滚到事务开始前的快照。即使持久化这一步也失败，内存缓存也先回到回滚点，
 * 保证页面上不会看到「只写了一半」的数据。
 */
export function restoreCheckpoint(snapshot: Record<string, EntryRow[]>): void {
  cache = clone(snapshot)
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cache))
  } catch {
    // 持久化失败时 localStorage 仍是事务前的数据，内存缓存已回到回滚点。
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
