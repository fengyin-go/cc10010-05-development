import {
  PASS_PREFIX,
  SNAPSHOT_SOURCE_FIELD,
  SNAPSHOT_TOKEN_FIELD,
  SNAPSHOT_VALIDATION_FIELD,
  evaluateBronzeEligibility,
  normalizeTargetPath,
  normalizeText,
} from '@/data/eligibility'
import { MODULE_BY_KEY } from '@/data/modules'
import {
  allRows,
  checkpoint,
  commitRows,
  latestRows,
  listRows,
  resetRows,
  restoreCheckpoint,
  saveRows,
} from '@/data/local-store'
import type {
  ActionResult,
  CheckItem,
  EligibilityResult,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

/** 目标路径锁：同一路径同时只允许一个启用事务。 */
const LOCK_PREFIX = 'lake-govern-config:target-lock:'
const LOCK_TTL_MS = 15_000
const inProcessLocks = new Set<string>()

const BRONZE_ENABLE_ACTION = '启用同步'
const SNAPSHOT_TARGET_STATUS = '待创建'
const BRONZE_ENABLED_STATUS = '已启用'

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

/** 页面用来预览启用资格，不写数据。 */
export function inspectBronzeEligibility(id: number): EligibilityResult {
  const rows = listRows('bronze')
  const row = rows.find((entry) => Number(entry.id) === id)
  if (!row) {
    throw new Error(`没有找到编号为 ${id} 的原始表`)
  }
  return evaluateBronzeEligibility(row, rows, listRows('ingest'))
}

function checkItemDetail(items: CheckItem[]): string[] {
  return items.map((item) => `${item.ok ? '✓' : '✗'} ${item.label}：${item.message}`)
}

function snapshotCodeFor(rows: EntryRow[]): string {
  const max = rows.reduce((current, row) => {
    const value = normalizeText(row['快照编号']).match(/(\d+)$/)
    return value ? Math.max(current, Number(value[1])) : current
  }, 0)
  return `SNAP-${String(max + 1).padStart(4, '0')}`
}

function todayText(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function lockOwner(): string {
  const cryptoApi = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

type LockHandle = { key: string; owner: string }

function acquireTargetLock(targetPath: string): { ok: true; handle: LockHandle } | { ok: false; message: string } {
  const key = `${LOCK_PREFIX}${targetPath}`
  const owner = lockOwner()
  if (inProcessLocks.has(key)) {
    return { ok: false, message: `目标路径「${targetPath}」正在由另一次启用操作处理，请稍后重试` }
  }
  if (typeof window !== 'undefined' && window.localStorage) {
    const raw = window.localStorage.getItem(key)
    if (raw) {
      try {
        const existing = JSON.parse(raw) as { owner?: string; expiresAt?: number }
        if (existing.expiresAt && existing.expiresAt > Date.now()) {
          return {
            ok: false,
            message: `目标路径「${targetPath}」已被另一个启用事务锁定（${existing.owner ?? '未知'}），请稍后重试`,
          }
        }
      } catch {
        // 锁内容损坏视为过期锁，直接覆盖。
      }
    }
    window.localStorage.setItem(
      key,
      JSON.stringify({ owner, expiresAt: Date.now() + LOCK_TTL_MS, path: targetPath }),
    )
  }
  inProcessLocks.add(key)
  return { ok: true, handle: { key, owner } }
}

function releaseTargetLock(handle: LockHandle): void {
  inProcessLocks.delete(handle.key)
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  try {
    const raw = window.localStorage.getItem(handle.key)
    if (!raw) {
      return
    }
    const existing = JSON.parse(raw) as { owner?: string }
    if (existing.owner === handle.owner) {
      window.localStorage.removeItem(handle.key)
    }
  } catch {
    window.localStorage.removeItem(handle.key)
  }
}

/**
 * 启用同步事务：
 * 1. 四项启用资格全部通过；
 * 2. 拿到目标路径锁后重新读取数据、重新判定冲突；
 * 3. 原始表状态与待创建快照在同一次持久化提交里写入；
 * 4. 任一步失败回滚到写入前快照，两边一起撤回。
 */
export function enableBronzeTable(id: number): ActionResult {
  const initialRows = latestRows('bronze')
  const row = initialRows.find((entry) => Number(entry.id) === id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的原始表` }
  }
  if (normalizeText(row.status) === BRONZE_ENABLED_STATUS) {
    return { ok: false, message: `原始表已经是「${BRONZE_ENABLED_STATUS}」，不用重复启用` }
  }

  const initialResult = evaluateBronzeEligibility(row, initialRows, latestRows('ingest'))
  if (!initialResult.ok) {
    return {
      ok: false,
      message: `原始表不满足启用资格，未进入启用事务：${initialResult.items
        .filter((item) => !item.ok)
        .map((item) => item.message)
        .join('；')}`,
      detail: checkItemDetail(initialResult.items),
    }
  }

  const normalizedPath = normalizeTargetPath(row['目标路径'])
  if (!normalizedPath) {
    return { ok: false, message: '目标路径为空，无法启用同步' }
  }

  const lock = acquireTargetLock(normalizedPath)
  if (!lock.ok) {
    return { ok: false, message: lock.message }
  }

  // 回滚点取在「拿到锁并刷新最新数据」之后，失败时能准确撤回本次事务写入。
  let rollbackPoint: Record<string, EntryRow[]> | null = null
  try {
    // 拿到锁后从 localStorage 重新读取最新数据再判定：
    // 两个标签页都通过前置检查时，只有先进入事务的能成功。
    const freshBronze = latestRows('bronze')
    const freshRow = freshBronze.find((entry) => Number(entry.id) === id)
    if (!freshRow) {
      throw new Error(`启用过程中原始表 ${id} 已不存在`)
    }
    if (normalizeText(freshRow.status) === BRONZE_ENABLED_STATUS) {
      return {
        ok: false,
        message: `原始表已由另一个启用事务置为「${BRONZE_ENABLED_STATUS}」，本次启用未生效`,
      }
    }
    const freshResult = evaluateBronzeEligibility(freshRow, freshBronze, latestRows('ingest'))
    if (!freshResult.ok) {
      return {
        ok: false,
        message: `启用事务重新校验未通过，原始层状态与待创建快照均未写入：${freshResult.items
          .filter((item) => !item.ok)
          .map((item) => item.message)
          .join('；')}`,
        detail: checkItemDetail(freshResult.items),
      }
    }

    // 写入前的回滚点：基于刚刷新过的最新数据，失败时能准确撤回本次事务写入。
    rollbackPoint = checkpoint()
    const snapshotRows = latestRows('snapshot')
    const snapshotCode = snapshotCodeFor(snapshotRows)
    const snapshotId =
      snapshotRows.reduce((max, entry) => Math.max(max, Number(entry.id) || 0), 0) + 1
    const validationText = `${PASS_PREFIX}｜${freshResult.items.map((item) => item.message).join('；')}`
    const targetTableName = normalizeText(freshRow['目标路径'])
    const token = `${normalizeText(freshRow['表编号']) || `BRON-#${id}`}@${snapshotCode}`

    const updatedBronze: EntryRow = {
      ...freshRow,
      status: BRONZE_ENABLED_STATUS,
      pending: false,
      abnormal: false,
      '数据校验': validationText,
    }

    const pendingSnapshot: EntryRow = {
      id: snapshotId,
      status: SNAPSHOT_TARGET_STATUS,
      pending: true,
      abnormal: false,
      '快照编号': snapshotCode,
      '目标表名': targetTableName,
      '快照时间': todayText(),
      '快照大小': '待计算',
      '存储介质': '对象存储',
      '过期策略': freshResult.partition
        ? `保留 ${freshResult.partition.retentionDays} 天`
        : '按原始表保留策略',
      '恢复校验': '待生效校验',
      '依赖快照': '',
      [SNAPSHOT_SOURCE_FIELD]: normalizeText(freshRow['表编号']),
      [SNAPSHOT_VALIDATION_FIELD]: validationText,
      [SNAPSHOT_TOKEN_FIELD]: token,
    }

    const nextBronze = freshBronze.map((entry) => (Number(entry.id) === id ? updatedBronze : entry))
    const nextSnapshot = [...snapshotRows, pendingSnapshot]

    // 同一次提交写两个模块：要么两边都落盘，要么两边都不落盘。
    commitRows({ bronze: nextBronze, snapshot: nextSnapshot })

    return {
      ok: true,
      message: `原始表已启用同步，当前状态「${BRONZE_ENABLED_STATUS}」；已生成待创建快照 ${snapshotCode}（目标表名：${targetTableName}），数据校验${PASS_PREFIX}`,
      detail: checkItemDetail(freshResult.items),
      snapshotId,
      snapshotCode,
      targetTableName,
    }
  } catch (error) {
    if (rollbackPoint) {
      try {
        restoreCheckpoint(rollbackPoint)
      } catch {
        // 回滚也失败时至少保留内存回滚点，不留下半提交状态。
      }
    }    const reason = error instanceof Error ? error.message : '未知错误'
    return {
      ok: false,
      message: `启用事务失败，原始层状态与待创建快照已同时撤回：${reason}`,
    }
  } finally {
    releaseTargetLock(lock.handle)
  }
}

/**
 * 版本快照门禁：只能引用「启用同步」事务生成的、校验通过且引用表当前仍启用的目标表名。
 * 判定同时看原始表和待创建快照记录，两边缺一不可。
 */
export function inspectSnapshotReference(row: EntryRow): {
  ok: boolean
  message: string
  bronze: EntryRow | null
} {
  const targetTableName = normalizeText(row['目标表名'])
  if (!targetTableName) {
    return { ok: false, message: '快照的目标表名为空，无法关联校验通过的原始表', bronze: null }
  }
  const bronzeRows = latestRows('bronze')
  const normalized = normalizeTargetPath(targetTableName)
  const bronze = bronzeRows.find(
    (entry) =>
      normalizeTargetPath(entry['目标路径']) === normalized ||
      normalizeText(entry['表编号']).toLowerCase() === targetTableName.toLowerCase(),
  )
  if (!bronze) {
    return {
      ok: false,
      message: `目标表名「${targetTableName}」没有对应的原始表，快照只能引用已启用并校验通过的原始表`,
      bronze: null,
    }
  }
  if (normalizeText(bronze.status) !== BRONZE_ENABLED_STATUS) {
    return {
      ok: false,
      message: `目标表名「${targetTableName}」的原始表当前为「${normalizeText(bronze.status) || '未知'}」，只有已启用的原始表可以生成快照`,
      bronze,
    }
  }
  if (normalizeTargetPath(row['目标表名']) !== normalizeTargetPath(bronze['目标路径'])) {
    return {
      ok: false,
      message: `目标表名「${targetTableName}」与原始表登记的目标路径「${normalizeText(bronze['目标路径'])}」不一致`,
      bronze,
    }
  }
  const validation = normalizeText(bronze['数据校验'])
  if (!validation.startsWith(PASS_PREFIX)) {
    return {
      ok: false,
      message: `目标表名「${targetTableName}」没有通过启用资格校验，快照不能引用未校验通过的目标表`,
      bronze,
    }
  }
  const evidence = latestRows('snapshot').find(
    (entry) =>
      normalizeTargetPath(entry['目标表名']) === normalizeTargetPath(bronze['目标路径']) &&
      normalizeText(entry['来源表']) === normalizeText(bronze['表编号']) &&
      normalizeText(entry['校验令牌']).startsWith(`${normalizeText(bronze['表编号'])}@`) &&
      normalizeText(entry['数据校验']).startsWith(PASS_PREFIX),
  )
  if (!evidence) {
    return {
      ok: false,
      message: `目标表名「${targetTableName}」缺少启用同步事务生成的校验通过快照记录，不能直接生成后续快照`,
      bronze,
    }
  }
  return {
    ok: true,
    message: `目标表名「${targetTableName}」对应已启用且校验通过的原始表 ${normalizeText(bronze['表编号'])}（校验令牌 ${normalizeText(evidence['校验令牌'])}）`,
    bronze,
  }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = latestRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }

  if (key === 'bronze' && action === BRONZE_ENABLE_ACTION) {
    return enableBronzeTable(id)
  }

  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }

  if (key === 'snapshot' && (action === '提交创建' || action === '生效快照')) {
    const reference = inspectSnapshotReference(rows[index])
    if (!reference.ok) {
      return {
        ok: false,
        message: `快照门禁未通过：${reference.message}`,
        detail: [reference.message],
      }
    }
    updated[SNAPSHOT_VALIDATION_FIELD] = reference.message
    updated[SNAPSHOT_SOURCE_FIELD] =
      normalizeText(rows[index][SNAPSHOT_SOURCE_FIELD]) || normalizeText(reference.bronze?.['表编号'])
  }

  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
