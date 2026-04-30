/**
 * StageLogView — pretty renderer for capability.log / script.log.
 *
 * Parses lines of the shape `[ISO] [type] payload` produced by
 * `formatMessage` in src/agent/repair/diagnose-repair-handler.ts:
 *   [ts] [assistant] <text>
 *   [ts] [tool_use] <toolName> input={JSON} [output=<escaped>]
 *   [ts] [result] <text>
 *   [ts] [error] <text> code=<code>
 *   [ts] [system] model=<model>
 *
 * Lines that don't match the prefix (e.g. script.log multi-line stdout/stderr
 * blocks) are preserved verbatim as `raw` entries.
 */

import { useEffect, useMemo, useState } from 'react'
import { getStageLog } from '../api/test-runs'

const HEADER_RE = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\] \[([^\]]+)\] ?(.*)$/

export type LogEntry =
  | { kind: 'assistant'; ts: string; text: string }
  | {
      kind: 'tool_use'
      ts: string
      toolName: string
      input: unknown
      inputRaw: string
      output?: string
    }
  | { kind: 'result'; ts: string; text: string }
  | { kind: 'error'; ts: string; text: string; code?: string }
  | { kind: 'system'; ts: string; model?: string }
  | { kind: 'unknown'; ts: string; type: string; payload: string }
  | { kind: 'raw'; text: string }

function unescapeNewlines(s: string): string {
  return s.replace(/\\n/g, '\n')
}

/**
 * Find the index *after* the matched closing `}` for an object starting at
 * `start` (which must point at the opening `{`). Honors string literals so
 * `{` / `}` inside JSON strings don't confuse the depth counter. Returns -1
 * if unbalanced (likely truncated by formatMessage's truncate(input, 1000)).
 */
function findJsonObjectEnd(s: string, start: number): number {
  let depth = 0
  let inStr = false
  let escape = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (escape) {
      escape = false
      continue
    }
    if (inStr) {
      if (c === '\\') {
        escape = true
        continue
      }
      if (c === '"') inStr = false
      continue
    }
    if (c === '"') {
      inStr = true
      continue
    }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return -1
}

function parseToolUsePayload(payload: string): {
  toolName: string
  input: unknown
  inputRaw: string
  output?: string
} {
  const m = payload.match(/^(\S+)\s+input=/)
  if (!m) return { toolName: '?', input: null, inputRaw: payload }
  const toolName = m[1]
  const afterEq = m[0].length
  const braceStart = payload.indexOf('{', afterEq)
  if (braceStart < 0) {
    return { toolName, input: null, inputRaw: payload.slice(afterEq) }
  }
  const end = findJsonObjectEnd(payload, braceStart)
  let input: unknown = null
  let inputRaw: string
  let rest = ''
  if (end > 0) {
    inputRaw = payload.slice(braceStart, end)
    try {
      input = JSON.parse(inputRaw)
    } catch {
      input = null
    }
    rest = payload.slice(end).trim()
  } else {
    inputRaw = payload.slice(braceStart)
    input = null
  }
  let output: string | undefined
  const outMatch = rest.match(/^output=([\s\S]*)$/)
  if (outMatch) output = unescapeNewlines(outMatch[1])
  return { toolName, input, inputRaw, output }
}

/**
 * Parse the raw log buffer into a sequence of structured entries.
 * Consecutive non-matching lines are coalesced into a single `raw` entry to
 * keep multi-line script.log blocks (`[stdout]\n...`) visually grouped.
 */
export function parseLogContent(raw: string): LogEntry[] {
  if (!raw) return []
  // Don't strip trailing \n via split('\n') without care: appendFile streams
  // ending in \n produce a trailing empty string we want to drop.
  const lines = raw.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  const entries: LogEntry[] = []
  let rawBuf: string[] = []
  const flushRaw = () => {
    if (rawBuf.length > 0) {
      entries.push({ kind: 'raw', text: rawBuf.join('\n') })
      rawBuf = []
    }
  }

  for (const line of lines) {
    const h = line.match(HEADER_RE)
    if (!h) {
      rawBuf.push(line)
      continue
    }
    flushRaw()
    const ts = h[1]
    const type = h[2]
    const payload = h[3] ?? ''
    switch (type) {
      case 'assistant':
        entries.push({ kind: 'assistant', ts, text: unescapeNewlines(payload) })
        break
      case 'tool_use': {
        const { toolName, input, inputRaw, output } = parseToolUsePayload(payload)
        entries.push({ kind: 'tool_use', ts, toolName, input, inputRaw, output })
        break
      }
      case 'result':
        entries.push({ kind: 'result', ts, text: unescapeNewlines(payload) })
        break
      case 'error': {
        const codeMatch = payload.match(/^(.*) code=(\S+)$/)
        if (codeMatch) {
          entries.push({ kind: 'error', ts, text: unescapeNewlines(codeMatch[1]), code: codeMatch[2] })
        } else {
          entries.push({ kind: 'error', ts, text: unescapeNewlines(payload) })
        }
        break
      }
      case 'system': {
        const modelMatch = payload.match(/model=(\S+)/)
        entries.push({ kind: 'system', ts, model: modelMatch?.[1] })
        break
      }
      default:
        entries.push({ kind: 'unknown', ts, type, payload: unescapeNewlines(payload) })
    }
  }
  flushRaw()
  return entries
}

function shortTime(iso: string): string {
  // ISO 时间戳缩成 HH:mm:ss（运行进度看分秒就够了，UTC/本地差异不重要）
  const m = iso.match(/T(\d{2}):(\d{2}):(\d{2})/)
  return m ? `${m[1]}:${m[2]}:${m[3]}` : iso
}

const STR = {
  bg: '#0d1117',
  fg: '#c9d1d9',
  dim: '#7d8590',
  border: '#30363d',
  rowGap: 10,
  timeWidth: 64,
} as const

const CHIP_STYLES: Record<string, { bg: string; border: string; color: string }> = {
  assistant: { bg: '#1f6feb22', border: '#1f6feb', color: '#79c0ff' },
  tool_use: { bg: '#8957e522', border: '#8957e5', color: '#d2a8ff' },
  result: { bg: '#23863622', border: '#238636', color: '#56d364' },
  error: { bg: '#da363322', border: '#da3633', color: '#ff7b72' },
  system: { bg: '#7d859022', border: '#484f58', color: '#8b949e' },
  unknown: { bg: '#7d859022', border: '#484f58', color: '#8b949e' },
}

const CHIP_LABEL: Record<string, string> = {
  assistant: '💬 assistant',
  tool_use: '🔧 tool',
  result: '✅ result',
  error: '❗ error',
  system: '⚙ system',
}

function Chip({ kind, label }: { kind: string; label: string }) {
  const c = CHIP_STYLES[kind] ?? CHIP_STYLES.unknown
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '0 6px',
        background: c.bg,
        border: `1px solid ${c.border}`,
        color: c.color,
        borderRadius: 3,
        fontSize: 11,
        lineHeight: '16px',
        marginRight: 6,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  )
}

function Row({ ts, children }: { ts?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: STR.rowGap, alignItems: 'flex-start' }}>
      <span
        style={{
          color: STR.dim,
          flexShrink: 0,
          width: STR.timeWidth,
          fontVariantNumeric: 'tabular-nums',
          userSelect: 'none',
        }}
      >
        {ts ? shortTime(ts) : ''}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  )
}

function CodeBlock({ children, label }: { children: string; label?: string }) {
  return (
    <div
      style={{
        marginTop: 4,
        background: '#161b22',
        border: `1px solid ${STR.border}`,
        borderRadius: 4,
        fontSize: 12,
      }}
    >
      {label && (
        <div
          style={{
            padding: '2px 8px',
            color: STR.dim,
            borderBottom: `1px solid ${STR.border}`,
            fontSize: 11,
          }}
        >
          {label}
        </div>
      )}
      <pre
        style={{
          margin: 0,
          padding: '6px 10px',
          color: '#e6edf3',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          fontFamily: 'inherit',
          fontSize: 'inherit',
        }}
      >
        {children}
      </pre>
    </div>
  )
}

function ToolUseRow({ entry }: { entry: Extract<LogEntry, { kind: 'tool_use' }> }) {
  // 把 mcp__chatops-tools__ 之类的前缀脱掉，让 toolName 更醒目
  const displayTool = entry.toolName.replace(/^mcp__[^_]+(?:-[^_]+)*__/, '')
  const obj = (entry.input ?? {}) as Record<string, unknown>
  const command = typeof obj.command === 'string' ? obj.command : null
  const host = typeof obj.host === 'string' ? obj.host : null
  // 除了 command/host 之外的 input 字段，单独显示便于排查
  const restEntries = Object.entries(obj).filter(([k]) => k !== 'command' && k !== 'host')

  return (
    <Row ts={entry.ts}>
      <div>
        <Chip kind="tool_use" label={CHIP_LABEL.tool_use} />
        <span style={{ color: '#d2a8ff', fontWeight: 500 }}>{displayTool}</span>
        {host && (
          <span style={{ color: STR.dim, marginLeft: 8 }}>
            host=<span style={{ color: '#a5d6ff' }}>{host}</span>
          </span>
        )}
      </div>
      {command !== null && <CodeBlock label="command">{command}</CodeBlock>}
      {restEntries.length > 0 && (
        <CodeBlock label={command !== null ? 'other input' : 'input'}>
          {JSON.stringify(Object.fromEntries(restEntries), null, 2)}
        </CodeBlock>
      )}
      {command === null && restEntries.length === 0 && entry.inputRaw && (
        <CodeBlock label="input (unparsed)">{entry.inputRaw}</CodeBlock>
      )}
      {entry.output && <CodeBlock label="output">{entry.output}</CodeBlock>}
    </Row>
  )
}

function AssistantRow({ entry }: { entry: Extract<LogEntry, { kind: 'assistant' }> }) {
  return (
    <Row ts={entry.ts}>
      <div>
        <Chip kind="assistant" label={CHIP_LABEL.assistant} />
      </div>
      <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginTop: 2, color: STR.fg }}>
        {entry.text}
      </div>
    </Row>
  )
}

function SimpleTextRow({
  entry,
  kind,
  extra,
}: {
  entry: Extract<LogEntry, { ts: string }>
  kind: 'result' | 'error' | 'system' | 'unknown'
  extra?: string
}) {
  const text = 'text' in entry ? entry.text : 'payload' in entry ? entry.payload : ''
  return (
    <Row ts={entry.ts}>
      <div>
        <Chip kind={kind} label={CHIP_LABEL[kind] ?? `· ${kind}`} />
        {extra && <span style={{ color: STR.dim, fontSize: 11 }}>{extra}</span>}
      </div>
      {text && (
        <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginTop: 2, color: STR.fg }}>
          {text}
        </div>
      )}
    </Row>
  )
}

function RawRow({ text }: { text: string }) {
  return (
    <Row>
      <pre
        style={{
          margin: 0,
          padding: '4px 0',
          color: STR.fg,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          fontFamily: 'inherit',
          fontSize: 'inherit',
        }}
      >
        {text}
      </pre>
    </Row>
  )
}

export interface StageLogViewProps {
  raw: string
  /** Container max-height (px). Defaults to 360. */
  maxHeight?: number
  scrollRef?: React.MutableRefObject<HTMLDivElement | null>
}

export function StageLogView({ raw, maxHeight = 360, scrollRef }: StageLogViewProps) {
  const entries = useMemo(() => parseLogContent(raw), [raw])

  return (
    <div
      ref={(el) => {
        if (scrollRef) scrollRef.current = el
      }}
      style={{
        background: STR.bg,
        color: STR.fg,
        padding: '10px 12px',
        borderRadius: 4,
        fontSize: 12,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        lineHeight: 1.5,
        maxHeight,
        overflow: 'auto',
      }}
    >
      {entries.length === 0 ? (
        <span style={{ color: STR.dim }}>（暂无日志）</span>
      ) : (
        entries.map((e, i) => {
          switch (e.kind) {
            case 'assistant':
              return <AssistantRow key={i} entry={e} />
            case 'tool_use':
              return <ToolUseRow key={i} entry={e} />
            case 'result':
              return <SimpleTextRow key={i} entry={e} kind="result" />
            case 'error':
              return <SimpleTextRow key={i} entry={e} kind="error" extra={e.code ? `code=${e.code}` : undefined} />
            case 'system':
              return <SimpleTextRow key={i} entry={e} kind="system" extra={e.model ? `model=${e.model}` : undefined} />
            case 'unknown':
              return <SimpleTextRow key={i} entry={e} kind="unknown" extra={e.type} />
            case 'raw':
              return <RawRow key={i} text={e.text} />
          }
        })
      )}
    </div>
  )
}

export const STAGE_LOG_COLORS = STR

/**
 * 已完成 stage 的输出展示。优先一次性拉 capability.log / script.log（按 backend
 * `probeStageLog` 的优先级），用 StageLogView 渲染；endpoint 404（无 log 文件）
 * 时 fallback 到 stageResult.output 文本，仍走 StageLogView raw entry path 让
 * 视觉跟运行中的实时日志保持一致。
 *
 * 不订阅 SSE，仅一次性拉取——已完成 stage 的 log 不会再增长。
 */
export interface StageOutputViewProps {
  runId: number
  stageIndex: number
  fallback?: string
  maxHeight?: number
}

export function StageOutputView({ runId, stageIndex, fallback, maxHeight = 360 }: StageOutputViewProps) {
  const [content, setContent] = useState<string | null>(null)
  const [fileType, setFileType] = useState<'script' | 'capability' | null>(null)
  const [loadState, setLoadState] = useState<'loading' | 'loaded' | 'fallback' | 'empty'>('loading')

  useEffect(() => {
    const ctl = new AbortController()
    setLoadState('loading')
    setContent(null)
    setFileType(null)

    getStageLog(runId, stageIndex, ctl.signal)
      .then((r) => {
        if (ctl.signal.aborted) return
        setContent(r.content)
        setFileType(r.fileType)
        setLoadState('loaded')
      })
      .catch((err) => {
        if (ctl.signal.aborted) return
        // 404 / 网络异常 → 用 fallback；只在 fallback 也空时才显示「无输出」
        if (fallback && fallback.length > 0) {
          setContent(fallback)
          setLoadState('fallback')
        } else {
          setContent('')
          setLoadState('empty')
        }
        // 静默吞掉 404；其他网络错误打 console
        if (err && (err as { response?: { status?: number } }).response?.status !== 404) {
          console.warn('[StageOutputView] log fetch failed:', err)
        }
      })

    return () => ctl.abort()
  }, [runId, stageIndex, fallback])

  if (loadState === 'loading') {
    return (
      <div
        style={{
          marginTop: 6,
          padding: '10px 12px',
          background: STR.bg,
          color: STR.dim,
          borderRadius: 4,
          fontSize: 12,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        }}
      >
        加载日志…
      </div>
    )
  }

  return (
    <div style={{ marginTop: 6 }}>
      {fileType && (
        <div style={{ fontSize: 11, color: STR.dim, marginBottom: 4 }}>
          来源：<code>{fileType}.log</code>
        </div>
      )}
      <StageLogView raw={content ?? ''} maxHeight={maxHeight} />
    </div>
  )
}

