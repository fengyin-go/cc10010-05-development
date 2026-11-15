import type {
  CheckItem,
  EligibilityResult,
  EntryRow,
  ParsedPartition,
  PartitionGranularity,
} from './types'

/**
 * 原始表启用资格与分区兼容策略。
 *
 * 这里是纯函数：只做判定、不写任何数据。真正的状态流转和事务在
 * `src/api/local-service.ts` 里完成，页面不参与业务判断。
 */

export const PARTITION_GRANULARITIES: PartitionGranularity[] = ['hour', 'day', 'month', 'year']

/** 允许保留天数的闭区间，超出组合不得启用。 */
export const RETENTION_POLICY: Record<PartitionGranularity, { min: number; max: number }> = {
  // 小时分区至少保留 1 天，避免还没写完就被清理；上限按在线排障窗口收口。
  hour: { min: 1, max: 30 },
  day: { min: 1, max: 3650 },
  // 月/年分区至少要覆盖一个完整周期才谈得上稳定文件。
  month: { min: 28, max: 3650 },
  year: { min: 365, max: 36500 },
}

/** 分区值允许范围：小时 0-23、日 1-31、月 1-12、年 1970-2100。 */
export const PARTITION_VALUE_RANGE: Record<PartitionGranularity, { min: number; max: number }> = {
  hour: { min: 0, max: 23 },
  day: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  year: { min: 1970, max: 2100 },
}

/** 文件格式与压缩类型的可用组合，不在这张表里的组合不能启用同步。 */
export const FORMAT_COMPRESSION_MATRIX: Record<string, string[]> = {
  parquet: ['snappy', 'zstd', 'gzip', 'none'],
  orc: ['zlib', 'snappy', 'zstd', 'none'],
  avro: ['snappy', 'deflate', 'none'],
  json: ['gzip', 'zstd', 'none'],
  jsonl: ['gzip', 'zstd', 'none'],
  csv: ['gzip', 'zstd', 'none'],
  tsv: ['gzip', 'zstd', 'none'],
  text: ['gzip', 'zstd', 'none'],
}

const TIME_FIELD_ALIASES = new Set([
  'dt',
  'date',
  'event_date',
  'ingest_date',
  'log_date',
  'biz_date',
  'partition_date',
  'ts',
  'event_time',
])

const FIELD_GRANULARITY_LOCK: Record<string, PartitionGranularity> = {
  hour: 'hour',
  event_hour: 'hour',
  month: 'month',
  year: 'year',
}

export const PASS_PREFIX = '通过'
export const FAIL_PREFIX = '未通过'
export const SNAPSHOT_VALIDATION_FIELD = '数据校验'
export const SNAPSHOT_SOURCE_FIELD = '来源表'
export const SNAPSHOT_TOKEN_FIELD = '校验令牌'

export function normalizeText(value: unknown): string {
  return String(value ?? '').trim()
}

/** 目标路径归一化：忽略大小写、首尾空白和重复斜杠，避免同路径绕过冲突检查。 */
export function normalizeTargetPath(value: unknown): string {
  return normalizeText(value)
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()
}

export function normalizeFormat(value: unknown): string {
  return normalizeText(value).toLowerCase()
}

export function normalizeCompression(value: unknown): string {
  const raw = normalizeText(value).toLowerCase()
  const aliases: Record<string, string> = {
    '': 'none',
    none: 'none',
    '无': 'none',
    '不压缩': 'none',
    uncompressed: 'none',
    off: 'none',
    gz: 'gzip',
    gzip: 'gzip',
    snappy: 'snappy',
    zstd: 'zstd',
    zlib: 'zlib',
    lzo: 'lzo',
    deflate: 'deflate',
    bzip2: 'bzip2',
    bz2: 'bzip2',
  }
  return aliases[raw] ?? raw
}

function item(key: CheckItem['key'], label: string, ok: boolean, message: string): CheckItem {
  return { key, label, ok, message }
}

export function checkSourceChannel(row: EntryRow, ingestRows: EntryRow[]): CheckItem {
  const source = normalizeText(row['来源通道'])
  if (!source) {
    return item('sourceChannel', '来源通道有效', false, '来源通道为空，无法关联多源接入通道')
  }
  const matched = ingestRows.find(
    (channel) => normalizeText(channel['通道编号']).toLowerCase() === source.toLowerCase(),
  )
  if (!matched) {
    return item(
      'sourceChannel',
      '来源通道有效',
      false,
      `来源通道「${source}」未在多源接入中登记，需填写已登记的通道编号`,
    )
  }
  const status = normalizeText(matched.status)
  if (status !== '运行中') {
    return item(
      'sourceChannel',
      '来源通道有效',
      false,
      `来源通道「${source}」当前状态为「${status || '未知'}」，只有「运行中」的通道可以接入`,
    )
  }
  return item('sourceChannel', '来源通道有效', true, `来源通道「${source}」已登记且运行中`)
}

export function checkFormatCompression(row: EntryRow): CheckItem {
  const format = normalizeFormat(row['文件格式'])
  const compression = normalizeCompression(row['压缩类型'])
  if (!format) {
    return item('formatCompression', '格式与压缩组合', false, '文件格式为空')
  }
  const allowed = FORMAT_COMPRESSION_MATRIX[format]
  if (!allowed) {
    return item(
      'formatCompression',
      '格式与压缩组合',
      false,
      `文件格式「${format}」不在可用清单（parquet/orc/avro/json/jsonl/csv/tsv/text）`,
    )
  }
  if (!allowed.includes(compression)) {
    return item(
      'formatCompression',
      '格式与压缩组合',
      false,
      `${format} 不支持 ${compression} 压缩，可用组合：${format} + ${allowed.join('/')}`,
    )
  }
  return item('formatCompression', '格式与压缩组合', true, `${format} + ${compression} 组合可用`)
}

export function checkTargetPath(row: EntryRow, bronzeRows: EntryRow[]): CheckItem {
  const raw = normalizeText(row['目标路径'])
  if (!raw) {
    return item('targetPath', '目标路径唯一', false, '目标路径为空')
  }
  const normalized = normalizeTargetPath(raw)
  if (!normalized) {
    return item('targetPath', '目标路径唯一', false, '目标路径归一化后为空')
  }
  if (normalized.startsWith('/') || /^[a-z]+:/.test(normalized)) {
    return item('targetPath', '目标路径唯一', false, '目标路径需为湖仓内部相对路径，不能是绝对路径或外部协议地址')
  }
  const conflicts = bronzeRows.filter((other) => {
    if (Number(other.id) === Number(row.id)) {
      return false
    }
    if (normalizeText(other.status) !== '已启用') {
      return false
    }
    return normalizeTargetPath(other['目标路径']) === normalized
  })
  if (conflicts.length > 0) {
    const codes = conflicts.map((conflict) => normalizeText(conflict['表编号']) || `#${conflict.id}`).join('、')
    return item(
      'targetPath',
      '目标路径唯一',
      false,
      `目标路径「${raw}」已被已启用表 ${codes} 占用，同一路径只能有一张已启用表`,
    )
  }
  return item('targetPath', '目标路径唯一', true, `目标路径「${raw}」未与其他已启用表冲突`)
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0')
}

function canonicalFormat(spec: string): string {
  return spec
    .replace(/YYYY/g, 'yyyy')
    .replace(/yyyy/gi, 'yyyy')
    .replace(/MM|mm/g, 'MM')
    .replace(/DD|dd/g, 'dd')
    .replace(/HH|hh/g, 'HH')
}

function formatValue(date: Date, format: string): string {
  const values: Record<string, string> = {
    yyyy: String(date.getUTCFullYear()),
    MM: pad(date.getUTCMonth() + 1),
    dd: pad(date.getUTCDate()),
    HH: pad(date.getUTCHours()),
  }
  return format.replace(/yyyy|MM|dd|HH/g, (token) => values[token] ?? token)
}

function detectGranularity(spec: string): { granularity: PartitionGranularity; format: string } | null {
  const normalized = canonicalFormat(spec.trim())
  const words: Record<string, PartitionGranularity> = {
    hour: 'hour',
    小时: 'hour',
    按小时: 'hour',
    hh: 'hour',
    day: 'day',
    天: 'day',
    日: 'day',
    按天: 'day',
    按日: 'day',
    daily: 'day',
    month: 'month',
    月: 'month',
    按月: 'month',
    monthly: 'month',
    year: 'year',
    年: 'year',
    按年: 'year',
    yearly: 'year',
  }
  const word = words[normalized.toLowerCase()]
  if (word) {
    const canonical: Record<PartitionGranularity, string> = {
      hour: 'yyyy-MM-dd-HH',
      day: 'yyyy-MM-dd',
      month: 'yyyy-MM',
      year: 'yyyy',
    }
    return { granularity: word, format: canonical[word] }
  }
  if (!/^(?:[^a-zA-Z]|yyyy|MM|dd|HH)*$/.test(normalized) || !/yyyy/i.test(normalized)) {
    return null
  }
  if (/HH/.test(normalized)) {
    return { granularity: 'hour', format: normalized }
  }
  if (/dd/.test(normalized)) {
    return { granularity: 'day', format: normalized }
  }
  if (/MM/.test(normalized)) {
    return { granularity: 'month', format: normalized }
  }
  if (/yyyy/.test(normalized)) {
    return { granularity: 'year', format: normalized }
  }
  return null
}

function parseRetentionDays(raw: unknown): number | null {
  const match = normalizeText(raw).match(/(\d+)/)
  if (!match) {
    return null
  }
  const days = Number(match[1])
  return Number.isInteger(days) && days > 0 ? days : null
}

function splitRuleSegments(raw: string): string[] {
  return raw
    .split(/[,;；]/)
    .map((segment) => segment.trim())
    .filter(Boolean)
}

function parseSegment(segment: string): { field: string; spec: string } | null {
  const match = segment.match(/^([A-Za-z][A-Za-z0-9_]{0,31})\s*(?:=|:|\/|\s)\s*(.+)$/)
  if (!match) {
    return null
  }
  return { field: match[1].toLowerCase(), spec: match[2].trim() }
}

function addPeriod(date: Date, granularity: PartitionGranularity, periods = 1): Date {
  const next = new Date(date.getTime())
  if (granularity === 'hour') {
    next.setUTCHours(next.getUTCHours() + periods)
  } else if (granularity === 'day') {
    next.setUTCDate(next.getUTCDate() + periods)
  } else if (granularity === 'month') {
    next.setUTCMonth(next.getUTCMonth() + periods)
  } else {
    next.setUTCFullYear(next.getUTCFullYear() + periods)
  }
  return next
}

function extractRangeValue(value: string, granularity: PartitionGranularity): number | null {
  if (granularity === 'hour') {
    const match = value.match(/(\d{2})$/)
    return match ? Number(match[1]) : null
  }
  if (granularity === 'day') {
    const match = value.match(/(\d{2})(?!.*\d{2})/)
    return match ? Number(match[1]) : null
  }
  if (granularity === 'month') {
    const match = value.match(/(\d{2})(?!.*\d)/)
    return match ? Number(match[1]) : null
  }
  const match = value.match(/(\d{4})/)
  return match ? Number(match[1]) : null
}

export type PartitionCheckResult = {
  ok: boolean
  message: string
  partition: ParsedPartition | null
}

export function checkPartitionRule(row: EntryRow): PartitionCheckResult {
  const rawRule = normalizeText(row['分区规则'])
  if (!rawRule) {
    return { ok: false, message: '分区规则为空，需写成「字段=粒度/格式」，例如 dt=yyyy-MM-dd', partition: null }
  }
  const segments = splitRuleSegments(rawRule)
  if (segments.length !== 1) {
    return {
      ok: false,
      message: `分区规则「${rawRule}」需且仅需一个时间分区字段，多字段组合无法判定稳定的分区文件`,
      partition: null,
    }
  }
  const parsedSegment = parseSegment(segments[0])
  if (!parsedSegment) {
    return {
      ok: false,
      message: `分区规则「${rawRule}」无法解析，需写成「字段=粒度/格式」，例如 dt=yyyy-MM-dd`,
      partition: null,
    }
  }
  const { field, spec } = parsedSegment
  if (!TIME_FIELD_ALIASES.has(field) && !(field in FIELD_GRANULARITY_LOCK)) {
    return {
      ok: false,
      message: `分区字段「${field}」不是允许的时间分区字段（${[...TIME_FIELD_ALIASES, ...Object.keys(FIELD_GRANULARITY_LOCK)].join('/')}）`,
      partition: null,
    }
  }
  const granularityInfo = detectGranularity(spec)
  if (!granularityInfo) {
    return {
      ok: false,
      message: `分区粒度「${spec}」无法识别，可用 hour/day/month/year 或对应的 yyyy/MM/dd/HH 日期格式`,
      partition: null,
    }
  }
  const { granularity, format } = granularityInfo
  const locked = FIELD_GRANULARITY_LOCK[field]
  if (locked && locked !== granularity) {
    return {
      ok: false,
      message: `分区字段「${field}」只能使用 ${locked} 粒度，当前为 ${granularity}`,
      partition: null,
    }
  }
  if (/[^A-Za-z0-9_./:=+-]/.test(format)) {
    return {
      ok: false,
      message: `分区格式「${format}」含非法路径字符，无法生成分区文件`,
      partition: null,
    }
  }
  if (!/yyyy/i.test(format)) {
    return {
      ok: false,
      message: `分区格式「${format}」缺少年份 yyyy，跨年时会生成相同的分区文件`,
      partition: null,
    }
  }

  const retentionDays = parseRetentionDays(row['保留策略'])
  if (retentionDays === null) {
    return {
      ok: false,
      message: `保留策略「${normalizeText(row['保留策略']) || '空'}」无法解析出保留天数，需给出正整数（如 30天）`,
      partition: null,
    }
  }
  const retentionLimit = RETENTION_POLICY[granularity]
  if (retentionDays < retentionLimit.min || retentionDays > retentionLimit.max) {
    return {
      ok: false,
      message: `${granularity} 粒度允许保留 ${retentionLimit.min}-${retentionLimit.max} 天，当前 ${retentionDays} 天超出组合范围`,
      partition: null,
    }
  }

  const reference = new Date(Date.UTC(2026, 10, 15, 5, 0, 0))
  const samplePath = `${field}=${formatValue(reference, format)}`
  // 连续 61 个周期的分区文件必须互不相同，否则粒度与格式不匹配会产生覆盖。
  const periodPaths = new Map<string, number>()
  for (let step = 0; step < 61; step += 1) {
    const path = `${field}=${formatValue(addPeriod(reference, granularity, step), format)}`
    const existing = periodPaths.get(path)
    if (existing !== undefined) {
      return {
        ok: false,
        message: `分区规则「${rawRule}」在第 ${existing} 与第 ${step} 个周期生成同一路径 ${path}，分区文件不稳定`,
        partition: null,
      }
    }
    periodPaths.set(path, step)
  }
  const nextPath = `${field}=${formatValue(addPeriod(reference, granularity, 1), format)}`
  if (nextPath === samplePath) {
    return {
      ok: false,
      message: `分区规则「${rawRule}」相邻 ${granularity} 周期生成同一路径 ${samplePath}，会产生文件覆盖`,
      partition: null,
    }
  }
  if (!/^[a-z][a-z0-9_]{0,31}=[A-Za-z0-9_.-]+$/.test(samplePath)) {
    return { ok: false, message: `分区规则「${rawRule}」生成的文件路径 ${samplePath} 含非法字符`, partition: null }
  }
  const rangeValue = extractRangeValue(formatValue(reference, format), granularity)
  const allowedRange = PARTITION_VALUE_RANGE[granularity]
  if (rangeValue === null || rangeValue < allowedRange.min || rangeValue > allowedRange.max) {
    return {
      ok: false,
      message: `${granularity} 粒度的分区值需在 ${allowedRange.min}-${allowedRange.max} 范围，当前生成 ${rangeValue ?? '未知'}`,
      partition: null,
    }
  }

  return {
    ok: true,
    message: `分区规则「${rawRule}」可稳定生成 ${samplePath}（${granularity} 粒度，保留 ${retentionDays} 天，允许 ${allowedRange.min}-${allowedRange.max}）`,
    partition: { field, granularity, format, retentionDays, samplePath },
  }
}

/** 生成某一时刻的分区文件路径；同一条规则对同一时刻必须得到相同结果。 */
export function buildPartitionPath(partition: ParsedPartition, at: Date = new Date()): string {
  return `${partition.field}=${formatValue(at, partition.format)}`
}

export function evaluateBronzeEligibility(
  row: EntryRow,
  bronzeRows: EntryRow[],
  ingestRows: EntryRow[],
): EligibilityResult {
  const items: CheckItem[] = [
    checkSourceChannel(row, ingestRows),
    checkFormatCompression(row),
    checkTargetPath(row, bronzeRows),
  ]
  const partitionCheck = checkPartitionRule(row)
  items.push(item('partitionRule', '分区规则稳定', partitionCheck.ok, partitionCheck.message))

  const ok = items.every((entry) => entry.ok)
  const targetTableName = normalizeText(row['目标路径'])
  let validationText = ''
  if (ok) {
    validationText = `${PASS_PREFIX}｜${items.map((entry) => entry.message).join('；')}`
  } else {
    validationText = `${FAIL_PREFIX}｜${items
      .filter((entry) => !entry.ok)
      .map((entry) => entry.message)
      .join('；')}`
  }
  return { ok, items, targetTableName, validationText, partition: partitionCheck.partition }
}
