/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type CheckItem = {
  /** 稳定标识，便于页面和测试定位是哪一条资格条件。 */
  key: 'sourceChannel' | 'formatCompression' | 'targetPath' | 'partitionRule'
  label: string
  ok: boolean
  message: string
}

export type EligibilityResult = {
  ok: boolean
  items: CheckItem[]
  targetTableName: string
  /** 四项全部通过时给出的数据校验结论，会写进原始表和待创建快照。 */
  validationText: string
  partition: ParsedPartition | null
}

export type PartitionGranularity = 'hour' | 'day' | 'month' | 'year'

export type ParsedPartition = {
  field: string
  granularity: PartitionGranularity
  format: string
  retentionDays: number
  /** 固定基准时间生成的分区文件路径，用来验证规则能稳定产出。 */
  samplePath: string
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
  /** 逐项校验明细：启用资格、快照门禁等动作会带上，页面直接展示。 */
  detail?: string[]
  /** 启用同步事务生成的待创建快照。 */
  snapshotId?: number
  snapshotCode?: string
  targetTableName?: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
