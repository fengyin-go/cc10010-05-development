import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import {
  downloadEntries,
  inspectSnapshotReference,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { subscribeStorage } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('snapshot')
const columns = [
  "快照编号",
  "目标表名",
  "快照时间",
  "快照大小",
  "存储介质",
  "过期策略",
  "恢复校验",
  "依赖快照"
]
const extraColumns = ["来源表", "数据校验"]
const actions = [
  "提交创建",
  "生效快照",
  "标记过期"
]
const statuses = [
  "草稿",
  "待创建",
  "已生效",
  "已过期"
]
const stats = [
  {
    "label": "快照记录总数",
    "value": 0
  },
  {
    "label": "已生效快照",
    "value": 0
  },
  {
    "label": "待创建快照",
    "value": 0
  }
]

type Feedback = {
  ok: boolean
  message: string
  detail: string[]
}

export default function SnapshotView() {
  const [rows, setRows] = useState<EntryRow[]>([])
  const [allRows, setAllRows] = useState<EntryRow[]>([])
  const [total, setTotal] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [filters, setFilters] = useState<Record<string, string>>({})
  const filterFields = useMemo(() => columns.slice(0, 3), [])

  const reload = useCallback(() => {
    setErrorMessage('')
    try {
      const payload = listEntries(meta.key, filters)
      setRows(payload.items)
      setTotal(payload.total)
      setAllRows(listEntries(meta.key).items)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '版本快照列表读取失败')
    }
  }, [filters])

  useEffect(() => {
    reload()
  }, [reload])

  useEffect(() => subscribeStorage(reload), [reload])

  function runAction(action: string, row: EntryRow) {
    setErrorMessage('')
    setFeedback(null)
    const result = applyAction(meta.key, Number(row.id), action)
    setFeedback({ ok: result.ok, message: result.message, detail: result.detail ?? [] })
    if (!result.ok) {
      setErrorMessage(result.message)
    }
    reload()
  }

  const statValues = [
    allRows.length,
    allRows.filter((row) => String(row.status) === '已生效').length,
    allRows.filter((row) => String(row.status) === '待创建').length,
  ]
  const pendingFromBronze = allRows
    .filter((row) => String(row.status) === '待创建' && String(row['来源表'] ?? '').trim() !== '')
    .sort((left, right) => String(right['快照编号']).localeCompare(String(left['快照编号'])))

  return (
    <section className="page" data-module="snapshot">
      <header className="page-head">
        <div>
          <h2>版本快照管理</h2>
          <p className="page-desc">快照只能引用原始层「启用同步」事务生成、校验通过且当前仍启用的目标表名；不满足门禁的引用会被拒绝。</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setErrorMessage('快照记录登记入口尚未接入审批流')}>
            登记快照记录
          </button>
          <button className="btn" type="button" onClick={() => downloadEntries(meta.key)}>
            导出版本快照清单
          </button>
        </div>
      </header>

      <div className="stat-row">
        {stats.map((item, index) => (
          <article key={item.label} className="stat-card">
            <span className="stat-label">{item.label}</span>
            <strong className="stat-value">{statValues[index]}</strong>
          </article>
        ))}
      </div>

      <p className="status-legend">
        {statuses.map((status: string) => (
          <span key={status} className="legend-item">
            {status}：{allRows.filter((row) => String(row.status) === status).length}
          </span>
        ))}
      </p>

      {pendingFromBronze.length > 0 && (
        <div className="notice notice-ok" data-testid="snapshot-pending-notice">
          <strong>原始层启用同步本次更新（{pendingFromBronze.length} 条待创建快照）：</strong>
          <ul className="notice-list">
            {pendingFromBronze.map((row) => {
              const gate = inspectSnapshotReference(row)
              return (
                <li key={String(row.id)}>
                  {row['快照编号']}｜来源 {row['来源表']}｜目标表名 {row['目标表名']}｜
                  {gate.ok ? '门禁通过' : `门禁未通过：${gate.message}`}
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {feedback && (
        <div className={feedback.ok ? 'notice notice-ok' : 'notice notice-bad'} data-testid="snapshot-feedback">
          <strong>{feedback.message}</strong>
          {feedback.detail.length > 0 && (
            <ul className="notice-list">
              {feedback.detail.map((line) => <li key={line}>{line}</li>)}
            </ul>
          )}
        </div>
      )}

      <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); reload() }}>
        {filterFields.map((field) => (
          <label key={field} className="filter-item">
            <span>{field}</span>
            <input
              value={filters[field] ?? ''}
              placeholder={`按${field}检索`}
              onChange={(event) => setFilters((prev) => ({ ...prev, [field]: event.target.value }))}
            />
          </label>
        ))}
        <button className="btn" type="submit">查询</button>
        <button className="btn ghost" type="button" onClick={() => setFilters({})}>重置条件</button>
      </form>

      <table className="data-table">
        <thead>
          <tr>
            {[...columns, ...extraColumns].map((column) => <th key={column}>{column}</th>)}
            <th>当前状态</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={String(row.id)}>
              {[...columns, ...extraColumns].map((column) => <td key={column}>{row[column] ?? '—'}</td>)}
              <td>{row.status}</td>
              <td className="row-actions">
                {actions.map((action) => (
                  <button
                    key={action}
                    className="link"
                    type="button"
                    title={action === '生效快照' ? '需目标表名对应的原始表仍已启用且校验通过' : action}
                    onClick={() => runAction(action, row)}
                  >
                    {action}
                  </button>
                ))}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={columns.length + extraColumns.length + 2}>暂无版本快照数据，可先在原始层启用同步生成待创建快照</td>
            </tr>
          )}
        </tbody>
      </table>

      <footer className="page-foot">
        <span>共 {total} 条版本快照记录，原始层启用同步生成的待创建快照 {pendingFromBronze.length} 条</span>
        {errorMessage && <span className="error-text">{errorMessage}</span>}
      </footer>
    </section>
  )
}
