import { useState, useEffect, useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Card, Table, Tag, Button, Space, Drawer, Descriptions, Timeline,
  Modal, Form, Input, message, Select, Badge, Typography, Popconfirm, Collapse,
  Checkbox, Divider,
} from 'antd'
import {
  PlusOutlined, ReloadOutlined, CheckOutlined,
  EditOutlined, DeleteOutlined, PlayCircleOutlined, FileTextOutlined, StopOutlined,
} from '@ant-design/icons'
import MarkdownViewer from '../components/MarkdownViewer'
import type { ColumnsType } from 'antd/es/table'
import {
  requirementsApi,
  type RequirementDTO,
  type RequirementDetailDTO,
  type ApprovalWaiterDTO,
  type RequirementStatus,
  type ApprovalDecision,
  type V2StageResult,
} from '../api/requirements'
import { findStageForWaiter, shouldWarnPlanRework, KIND_LABEL, buildDecisionModalTitle } from './requirements-helpers'
import { QiE2eProgress } from './QiE2eProgress'
import { StageResultsTimeline } from '../components/StageResultsTimeline'

const { Text, Paragraph } = Typography
const { TextArea } = Input

const STATUS_CONFIG: Record<RequirementStatus, { color: string; label: string }> = {
  draft:       { color: 'default',    label: '草稿' },
  queued:      { color: 'processing', label: '排队中' },
  spec_review: { color: 'gold',       label: '需求审核' },
  planning:    { color: 'cyan',       label: '规划中' },
  developing:  { color: 'blue',       label: '开发中' },
  reviewing:   { color: 'purple',     label: '代码审核' },
  testing:     { color: 'geekblue',   label: '测试中' },
  mr_pending:  { color: 'lime',       label: 'MR 待审' },
  mr_open:     { color: 'success',    label: 'MR 已开' },
  merged:      { color: 'success',    label: '已合入' },
  aborting:    { color: 'warning',    label: '中止中' },
  aborted:     { color: 'default',    label: '已中止' },
  failed:      { color: 'error',      label: '失败' },
}

const DECISION_CONFIG: Record<ApprovalDecision, { color: string; label: string }> = {
  approved:       { color: 'success', label: '通过' },
  rejected:       { color: 'error',   label: '拒绝' },
  rejected_plan:  { color: 'error',   label: '拒绝 plan' },
  rejected_spec:  { color: 'error',   label: '拒绝 spec' },
  force_passed:   { color: 'warning', label: '强制通过' },
  budget_extended:{ color: 'blue',    label: '延期' },
  aborted:        { color: 'default', label: '中止' },
  fix:            { color: 'processing', label: '再修一轮' },
}

// KIND_LABEL & buildDecisionModalTitle 已搬到 ./requirements-helpers.ts

const ALL_STATUSES: RequirementStatus[] = [
  'draft', 'queued', 'spec_review', 'planning', 'developing',
  'reviewing', 'testing', 'mr_pending', 'mr_open', 'merged',
  'aborting', 'aborted', 'failed',
]

function StatusTag({ status }: { status: RequirementStatus }) {
  const cfg = STATUS_CONFIG[status] ?? { color: 'default', label: status }
  return <Tag color={cfg.color}>{cfg.label}</Tag>
}

// =============================================================================
// V2 结构化字段展示（Phase 4，详见 docs/prds/quick-impl-roles-v2/01-roles.md）
// helpers 在 ./requirements-helpers.ts；本组件是纯展示。
// =============================================================================

const RISK_COLOR: Record<'low' | 'medium' | 'high', string> = {
  low: 'green', medium: 'gold', high: 'red',
}

/**
 * 展示某 stage 的 v2 结构化输出。根据可用字段渲染不同区块。
 * - spec stage：AC 列表 / 澄清问题 / 风险 / openQuestions
 * - dev / reviewer stage：commits 列表 / specCoverage 矩阵 / scopeViolations / fileRisks
 */
function V2StructuredView({ stage }: { stage: V2StageResult | undefined }) {
  if (!stage || !stage.skillOutput) return null
  const so = stage.skillOutput

  const items: Array<{ key: string; label: React.ReactNode; children: React.ReactNode }> = []

  // === acceptanceCriteria ===
  if (so.acceptanceCriteria && so.acceptanceCriteria.length > 0) {
    items.push({
      key: 'ac',
      label: <Space><CheckOutlined /><span>验收标准（{so.acceptanceCriteria.length} 条 Given-When-Then）</span></Space>,
      children: (
        <ul style={{ paddingLeft: 20, margin: 0 }}>
          {so.acceptanceCriteria.map(ac => (
            <li key={ac.id} style={{ marginBottom: 6 }}>
              <Tag color="cyan">{ac.id}</Tag>
              <Text>{ac.text}</Text>
            </li>
          ))}
        </ul>
      ),
    })
  }

  // === openQuestions（待澄清，C3 占位） ===
  if (so.openQuestions && so.openQuestions.length > 0) {
    items.push({
      key: 'oq',
      label: <Space><Tag color="orange">待澄清</Tag><span>{so.openQuestions.length} 条</span></Space>,
      children: (
        <div>
          <Text type="warning" style={{ fontSize: 12 }}>
            AI 标记的不确定点。当前版本仅展示，后续支持"补充信息"输入框（Phase 4+）。
          </Text>
          <ul style={{ paddingLeft: 20, marginTop: 8 }}>
            {so.openQuestions.map((q, i) => <li key={i}>{q}</li>)}
          </ul>
        </div>
      ),
    })
  }

  // === clarifications（澄清记录；v3 含 kind / userMayDisagreeIf） ===
  if (so.clarifications && so.clarifications.length > 0) {
    items.push({
      key: 'cl',
      label: <span>澄清记录（{so.clarifications.length} 条）</span>,
      children: (
        <ul style={{ paddingLeft: 20, margin: 0, fontSize: 13 }}>
          {so.clarifications.map((c, i) => (
            <li key={i} style={{ marginBottom: 6 }}>
              {c.kind && (
                <Tag color={c.kind === 'assumption' ? 'gold' : 'blue'} style={{ marginRight: 4 }}>
                  {c.kind === 'assumption' ? '🤔 假设' : '📋 事实'}
                </Tag>
              )}
              <Text strong>Q: </Text><Text>{c.q}</Text><br />
              <Text strong>A: </Text>
              <Text type={c.a === 'OPEN_QUESTION' ? 'warning' : 'secondary'}>{c.a}</Text>
              {c.userMayDisagreeIf && (
                <div style={{ fontSize: 12, marginTop: 2, color: '#fa8c16' }}>
                  ⚠ 反对条件：{c.userMayDisagreeIf}
                </div>
              )}
            </li>
          ))}
        </ul>
      ),
    })
  }

  // === risks ===
  if (so.risks && so.risks.length > 0) {
    items.push({
      key: 'risks',
      label: <span>风险与未知（{so.risks.length} 条）</span>,
      children: (
        <ul style={{ paddingLeft: 20, margin: 0 }}>
          {so.risks.map((r, i) => (
            <li key={i}>
              <Tag color={RISK_COLOR[r.severity]}>{r.severity}</Tag>
              <Text>{r.desc}</Text>
            </li>
          ))}
        </ul>
      ),
    })
  }

  // === reviewHints（v3：LLM 主动标记的"需要 review 的点"） ===
  if (so.reviewHints && so.reviewHints.length > 0) {
    const sorted = [...so.reviewHints].sort((a, b) => {
      const order: Record<string, number> = { high: 0, medium: 1, low: 2 }
      return (order[a.severity] ?? 9) - (order[b.severity] ?? 9)
    })
    items.push({
      key: 'reviewHints',
      label: (
        <Space>
          <Tag color="purple">⚠ LLM 提示</Tag>
          <span>需 review 的点（{so.reviewHints.length} 条）</span>
        </Space>
      ),
      children: (
        <ul style={{ paddingLeft: 20, margin: 0 }}>
          {sorted.map((h, i) => (
            <li key={i} style={{ marginBottom: 8 }}>
              <Tag color={RISK_COLOR[h.severity]}>{h.severity}</Tag>
              <Text strong>{h.point}</Text>
              <div style={{ fontSize: 12, marginTop: 2, color: '#888' }}>{h.reason}</div>
            </li>
          ))}
        </ul>
      ),
    })
  }

  // === noGos（v3：明确不实现的边界） ===
  if (so.noGos && so.noGos.length > 0) {
    items.push({
      key: 'noGos',
      label: <span><Tag color="red">禁区</Tag>明确不实现（{so.noGos.length} 条）</span>,
      children: (
        <ul style={{ paddingLeft: 20, margin: 0 }}>
          {so.noGos.map((n, i) => (
            <li key={i} style={{ marginBottom: 6 }}>
              <Text>{n.desc}</Text>
              {n.reason && (
                <Text type="secondary" style={{ fontSize: 12 }}> — {n.reason}</Text>
              )}
            </li>
          ))}
        </ul>
      ),
    })
  }

  // === acDiff（round 2+ 才有；展示 AC 增/删/改）===
  if (stage.acDiff && (
    (stage.acDiff.added?.length ?? 0) +
    (stage.acDiff.removed?.length ?? 0) +
    (stage.acDiff.changed?.length ?? 0) > 0
  )) {
    const { added = [], removed = [], changed = [] } = stage.acDiff
    items.push({
      key: 'acDiff',
      label: (
        <Space>
          <Tag color="blue">Round 变化</Tag>
          <span>+{added.length} -{removed.length} ~{changed.length}</span>
        </Space>
      ),
      children: (
        <div style={{ fontSize: 13 }}>
          {added.length > 0 && (
            <div style={{ marginBottom: 6 }}>
              <Text strong style={{ color: '#52c41a' }}>新增：</Text>
              <ul style={{ paddingLeft: 20, margin: 0 }}>
                {added.map((a) => (
                  <li key={a.id}><Tag color="green">+ {a.id}</Tag>{a.text}</li>
                ))}
              </ul>
            </div>
          )}
          {removed.length > 0 && (
            <div style={{ marginBottom: 6 }}>
              <Text strong style={{ color: '#f5222d' }}>删除：</Text>
              <ul style={{ paddingLeft: 20, margin: 0 }}>
                {removed.map((id) => (
                  <li key={id} style={{ textDecoration: 'line-through', color: '#999' }}>
                    <Tag color="red">- {id}</Tag>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {changed.length > 0 && (
            <div>
              <Text strong style={{ color: '#faad14' }}>修订：</Text>
              <ul style={{ paddingLeft: 20, margin: 0 }}>
                {changed.map((c) => (
                  <li key={c.id} style={{ marginBottom: 6 }}>
                    <Tag color="orange">~ {c.id}</Tag>
                    <div style={{ fontSize: 12, color: '#888', textDecoration: 'line-through' }}>
                      {c.oldText}
                    </div>
                    <div style={{ fontSize: 13 }}>{c.newText}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ),
    })
  }

  // === standardsConsulted（v3：兼容 string | {file, usedFor}） ===
  const stdConsulted = stage.evidence?.standardsConsulted
  if (stdConsulted && stdConsulted.length > 0) {
    items.push({
      key: 'stdConsulted',
      label: <span>引用规范（{stdConsulted.length} 项）</span>,
      children: (
        <ul style={{ paddingLeft: 20, margin: 0, fontSize: 12 }}>
          {stdConsulted.map((s, i) => (
            <li key={i}>
              {typeof s === 'string' ? (
                <Text code>{s}</Text>
              ) : (
                <>
                  <Text code>{s.file}</Text>
                  {' '}— <Text type="secondary">{s.usedFor}</Text>
                </>
              )}
            </li>
          ))}
        </ul>
      ),
    })
  }

  // === selfCheck（v3：兼容 union {item, passed, reason} | {item, answer}） ===
  const selfCheck = stage.evidence?.selfCheck
  if (selfCheck && selfCheck.length > 0) {
    items.push({
      key: 'selfCheck',
      label: <span>LLM 自检（{selfCheck.length} 条）</span>,
      children: (
        <ul style={{ paddingLeft: 20, margin: 0, fontSize: 13 }}>
          {selfCheck.map((sc, i) => {
            const isSubjective = 'answer' in sc
            return (
              <li key={i} style={{ marginBottom: 6 }}>
                {isSubjective ? (
                  <>
                    <Text strong>💡 {sc.item}</Text>
                    <div style={{ marginTop: 2 }}>
                      <Text type="secondary">{(sc as { answer: string }).answer}</Text>
                    </div>
                  </>
                ) : (
                  <>
                    <Tag color={(sc as { passed: boolean }).passed ? 'success' : 'error'}>
                      {(sc as { passed: boolean }).passed ? '✓' : '✗'}
                    </Tag>
                    <Text>{sc.item}</Text>
                    {(sc as { reason?: string }).reason && (
                      <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>
                        {(sc as { reason: string }).reason}
                      </div>
                    )}
                  </>
                )}
              </li>
            )
          })}
        </ul>
      ),
    })
  }

  // === specCoverage（reviewer 输出，AC 覆盖矩阵） ===
  if (so.specCoverage && so.specCoverage.length > 0) {
    const covered = so.specCoverage.filter(x => x.covered).length
    items.push({
      key: 'cov',
      label: (
        <Space>
          <Tag color={covered === so.specCoverage.length ? 'success' : 'warning'}>
            {covered}/{so.specCoverage.length} AC 已覆盖
          </Tag>
        </Space>
      ),
      children: (
        <ul style={{ paddingLeft: 20, margin: 0 }}>
          {so.specCoverage.map(c => (
            <li key={c.ac} style={{ marginBottom: 6 }}>
              <Tag color={c.covered ? 'success' : 'error'}>{c.ac}</Tag>
              {c.covered ? (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  ✓ 证据：{c.evidence.map(e => `${e.file}${e.line ? ':' + e.line : ''}`).join(' · ')}
                </Text>
              ) : (
                <Text type="warning" style={{ fontSize: 12 }}>✗ {c.missingReason}</Text>
              )}
            </li>
          ))}
        </ul>
      ),
    })
  }

  // === commits（dev-loop 输出） ===
  if (so.commits && so.commits.length > 0) {
    items.push({
      key: 'commits',
      label: <span>Commits（{so.commits.length} 个）</span>,
      children: (
        <ul style={{ paddingLeft: 20, margin: 0, fontSize: 12 }}>
          {so.commits.map((c, i) => (
            <li key={i}>
              <Tag color={c.tsc === 'pass' ? 'success' : 'error'}>{c.tsc}</Tag>
              {c.isFix && <Tag color="orange">fix r{c.round ?? 2}</Tag>}
              <Text code>{c.sha.slice(0, 7)}</Text>
              {' '}{c.message}
              {c.vitest && (
                <Text type="secondary"> · vitest {c.vitest.passed}p/{c.vitest.failed}f</Text>
              )}
            </li>
          ))}
        </ul>
      ),
    })
  }

  // === scopeViolations ===
  if (so.scopeViolations && so.scopeViolations.length > 0) {
    items.push({
      key: 'scope',
      label: <span><Tag color="red">越界改动</Tag>{so.scopeViolations.length} 个</span>,
      children: (
        <ul style={{ paddingLeft: 20, margin: 0 }}>
          {so.scopeViolations.map((v, i) => (
            <li key={i}><Text code>{v.file}</Text> — <Text type="warning">{v.reason}</Text></li>
          ))}
        </ul>
      ),
    })
  }

  // === fileRisks ===
  if (so.fileRisks && so.fileRisks.length > 0) {
    items.push({
      key: 'fr',
      label: <span>变更影响分析（{so.fileRisks.length} 个文件）</span>,
      children: (
        <div>
          {so.fileRisks.map((r, i) => (
            <div key={i} style={{ marginBottom: 8 }}>
              <Text code>{r.file}</Text> <Tag color={RISK_COLOR[r.risk]}>{r.risk}</Tag>
              <div style={{ fontSize: 12, marginTop: 4 }}>
                <div>职责：{r.role}</div>
                <div>影响：{r.impact}</div>
                <div><Text strong>重点 review：</Text>{r.focusOn}</div>
              </div>
            </div>
          ))}
        </div>
      ),
    })
  }

  if (items.length === 0) return null

  return (
    <Collapse size="small" style={{ marginBottom: 16 }} items={items} />
  )
}

function formatRelativeDuration(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(ms) || ms < 0) return '刚刚'
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec} 秒`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} 分钟`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时`
  const day = Math.floor(hr / 24)
  return `${day} 天`
}

function formatDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const CLAIMED_BY_LABEL: Record<NonNullable<ApprovalWaiterDTO['claimedBy']>, string> = {
  im: 'IM 群',
  web: '管理后台',
  retry: '重试',
  abort: '中止',
}

function WaiterTimeline({ waiters }: { waiters: ApprovalWaiterDTO[] }) {
  if (waiters.length === 0) return <Text type="secondary">暂无审批记录</Text>
  return (
    <Timeline
      items={waiters.map(w => {
        const isPending = !w.claimedBy
        const dec = w.decision ? DECISION_CONFIG[w.decision] : null
        return {
          color: isPending ? 'blue' : (dec?.color === 'success' ? 'green' : dec?.color === 'error' ? 'red' : 'gray'),
          children: (
            <div>
              <Space size={6} wrap>
                <Text strong>{KIND_LABEL[w.approvalKind] ?? w.approvalKind}</Text>
                <Text type="secondary">第 {w.round} 轮</Text>
                {isPending && <Badge status="processing" text="等待决策" />}
                {dec && <Tag color={dec.color}>{dec.label}</Tag>}
              </Space>

              {isPending && (
                <div style={{ marginTop: 4, fontSize: 12, color: '#8C8C8C' }}>
                  已等待 {formatRelativeDuration(w.createdAt)}
                  {w.imPlatform && w.imGroupId && <span> · 已推送至 {w.imPlatform} 群</span>}
                </div>
              )}

              {!isPending && (
                <div style={{ marginTop: 4, fontSize: 12, color: '#8C8C8C' }}>
                  {w.claimedAt && <span>{formatDateTime(w.claimedAt)}</span>}
                  {w.decidedBy && <span> · 由 {w.decidedBy} 决策</span>}
                  {w.claimedBy && <span>（{CLAIMED_BY_LABEL[w.claimedBy]}）</span>}
                </div>
              )}

              {w.budgetDelta != null && (
                <div style={{ marginTop: 4, fontSize: 12 }}>
                  <Tag color="blue">预算 +{w.budgetDelta}</Tag>
                </div>
              )}

              {w.rejectReason && (
                <div
                  style={{
                    marginTop: 6,
                    padding: '6px 10px',
                    background: '#FFF1F0',
                    borderLeft: '3px solid #FF4D4F',
                    borderRadius: 4,
                    fontSize: 12,
                    whiteSpace: 'pre-wrap',
                    color: '#434343',
                  }}
                >
                  <Text strong style={{ color: '#CF1322' }}>拒绝原因</Text>
                  <div style={{ marginTop: 2 }}>{w.rejectReason}</div>
                </div>
              )}
            </div>
          ),
        }
      })}
    />
  )
}

interface DecideModalState {
  open: boolean
  waiter: ApprovalWaiterDTO | null
  requirementId: number
}

export default function RequirementsPage() {
  const [items, setItems] = useState<RequirementDTO[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [filterStatus, setFilterStatus] = useState<string | undefined>(undefined)

  // Detail drawer
  const [detailOpen, setDetailOpen] = useState(false)
  const [detail, setDetail] = useState<RequirementDetailDTO | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  // Create modal
  const [createOpen, setCreateOpen] = useState(false)
  const [createForm] = Form.useForm()
  const [createLoading, setCreateLoading] = useState(false)

  // Edit modal
  const [editTarget, setEditTarget] = useState<RequirementDTO | null>(null)
  const [editForm] = Form.useForm()
  const [editLoading, setEditLoading] = useState(false)

  // Run loading per row
  const [runningIds, setRunningIds] = useState<Set<number>>(new Set())

  // Stop loading per row
  const [stoppingIds, setStoppingIds] = useState<Set<number>>(new Set())

  // Delete loading per row
  const [deletingIds, setDeletingIds] = useState<Set<number>>(new Set())

  // Decide modal
  const [decideState, setDecideState] = useState<DecideModalState>({ open: false, waiter: null, requirementId: 0 })
  const [decideForm] = Form.useForm()
  const [decideLoading, setDecideLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await requirementsApi.list({ status: filterStatus, page, size: 20 })
      setItems(res.items)
      setTotal(res.total)
    } catch {
      message.error('加载失败')
    } finally {
      setLoading(false)
    }
  }, [filterStatus, page])

  useEffect(() => { load() }, [load])

  const openDetail = async (id: number) => {
    setDetailOpen(true)
    setDetailLoading(true)
    try {
      const d = await requirementsApi.get(id)
      setDetail(d)
    } catch {
      message.error('加载详情失败')
    } finally {
      setDetailLoading(false)
    }
  }

  // ── 直达审批 Modal：?id=N&openWaiter=M ────────────────────────────────────
  // 来源：钉钉/飞书审批卡片的"📋 审批链接"+ qi-approval-manager URL openWaiter 参数
  const [searchParams, setSearchParams] = useSearchParams()
  // 第一步：URL ?id=N → 自动打开详情抽屉
  useEffect(() => {
    const idStr = searchParams.get('id')
    if (!idStr) return
    const id = Number(idStr)
    if (!Number.isFinite(id)) return
    void openDetail(id)
    // 仅 ?id 触发；?openWaiter 由下面 useEffect 处理（依赖 detail 加载完成）
  }, [searchParams])

  // 第二步：detail 加载完且 ?openWaiter=M 在未 claim 的 waiters 中 → 自动弹决策 Modal
  useEffect(() => {
    const waiterStr = searchParams.get('openWaiter')
    if (!waiterStr || !detail) return
    const wid = Number(waiterStr)
    if (!Number.isFinite(wid)) return
    const w = detail.waiters?.find(x => x.id === wid && !x.claimedBy)
    if (!w) return
    setDecideState({ open: true, waiter: w, requirementId: detail.id })
    // 清掉 openWaiter query 参数防止刷新重复弹（保留 ?id=N 让用户能停留在抽屉）
    const next = new URLSearchParams(searchParams)
    next.delete('openWaiter')
    setSearchParams(next, { replace: true })
  }, [detail, searchParams, setSearchParams])

  // ── Create ─────────────────────────────────────────────────────────────────
  const handleCreate = async (values: { title: string; rawInput: string; gitlabProject: string; baseBranch?: string; skipE2E?: boolean }) => {
    setCreateLoading(true)
    try {
      await requirementsApi.create(values)
      message.success('需求已保存为草稿，点击「运行」启动流水线')
      setCreateOpen(false)
      createForm.resetFields()
      load()
    } catch {
      message.error('创建失败')
    } finally {
      setCreateLoading(false)
    }
  }

  // ── Edit ───────────────────────────────────────────────────────────────────
  const openEdit = (row: RequirementDTO) => {
    setEditTarget(row)
    editForm.setFieldsValue({
      title: row.title,
      rawInput: row.rawInput,
      gitlabProject: row.gitlabProject,
      baseBranch: row.baseBranch,
      skipE2E: row.skipE2E,
    })
  }

  const handleEdit = async (values: { title: string; rawInput: string; gitlabProject: string; baseBranch?: string; skipE2E?: boolean }) => {
    if (!editTarget) return
    setEditLoading(true)
    try {
      await requirementsApi.update(editTarget.id, values)
      message.success('已更新')
      setEditTarget(null)
      editForm.resetFields()
      load()
      if (detail?.id === editTarget.id) openDetail(editTarget.id)
    } catch (e: any) {
      if (e?.response?.status === 409) {
        message.error('只有草稿状态的需求可以编辑')
      } else {
        message.error('更新失败')
      }
    } finally {
      setEditLoading(false)
    }
  }

  // ── Delete ────────────────────────────────────────────────────────────────
  const handleDelete = async (id: number) => {
    setDeletingIds(s => new Set(s).add(id))
    try {
      await requirementsApi.delete(id)
      message.success('已删除')
      load()
      if (detail?.id === id) setDetailOpen(false)
    } catch (e: any) {
      if (e?.response?.status === 409) {
        message.error('运行中的需求无法删除')
      } else {
        message.error('删除失败')
      }
    } finally {
      setDeletingIds(s => { const n = new Set(s); n.delete(id); return n })
    }
  }

  // ── Run ───────────────────────────────────────────────────────────────────
  const handleRun = async (id: number) => {
    setRunningIds(s => new Set(s).add(id))
    try {
      await requirementsApi.run(id)
      message.success('已加入队列，worker 将在 30 秒内启动流水线')
      load()
      if (detail?.id === id) openDetail(id)
    } catch (e: any) {
      const msg = e?.response?.data?.error ?? '启动失败'
      message.error(msg)
    } finally {
      setRunningIds(s => { const n = new Set(s); n.delete(id); return n })
    }
  }

  // ── Stop ──────────────────────────────────────────────────────────────────
  const STOPPABLE_STATUSES: RequirementStatus[] = [
    'queued', 'spec_review', 'planning', 'developing',
    'reviewing', 'testing', 'mr_pending', 'mr_open',
  ]

  const handleStop = async (id: number) => {
    setStoppingIds(s => new Set(s).add(id))
    try {
      await requirementsApi.abort(id)
      message.success('需求已停止')
      load()
      if (detail?.id === id) openDetail(id)
    } catch (e: any) {
      const msg = e?.response?.data?.error ?? '停止失败'
      message.error(msg)
    } finally {
      setStoppingIds(s => { const n = new Set(s); n.delete(id); return n })
    }
  }

  // ── Approve ───────────────────────────────────────────────────────────────
  const openDecide = (waiter: ApprovalWaiterDTO, requirementId: number) => {
    setDecideState({ open: true, waiter, requirementId })
    decideForm.resetFields()
  }

  const handleDecide = async (values: {
    decision: ApprovalDecision
    rejectReason?: string
    budgetDelta?: number
    decidedBy?: string
    targetTaskId?: string
    citedAiNotes?: string[]
  }) => {
    if (!decideState.waiter) return

    // v2 §3.1.7：spec round ≥ 2 改 AC 会触发 plan 节点重置 → 弹提示让用户确认
    if (shouldWarnPlanRework(decideState.waiter, values.decision)) {
      const confirmed = await new Promise<boolean>((resolve) => {
        Modal.confirm({
          title: '提醒：可能触发 plan 重做',
          content: (
            <div>
              <p>spec 已是第 <Text strong>{decideState.waiter!.round}</Text> 轮，再次拒绝可能让 AI 修改验收标准（AC）。</p>
              <p>如果新一轮 AC 与上一轮有差异（acDiff 非空），系统会<Text strong type="warning">自动重置 plan 节点</Text>让 plan-decomposer 重新拆任务。</p>
              <p>这会消耗额外 token，并可能让已 commit 的代码失效。确认继续吗？</p>
            </div>
          ),
          okText: '确认拒绝',
          cancelText: '取消',
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        })
      })
      if (!confirmed) return
    }

    setDecideLoading(true)
    try {
      const res = await requirementsApi.decide(decideState.requirementId, decideState.waiter.id, {
        decision: values.decision,
        rejectReason: values.rejectReason ?? null,
        budgetDelta: values.budgetDelta ?? null,
        decidedBy: values.decidedBy ?? null,
        // PRD §7 step 6：仅 plan_escalation rejected_plan 时填字段级反馈
        targetTaskId: values.targetTaskId === '__GLOBAL__' ? null : (values.targetTaskId ?? null),
        citedAiNotes: values.citedAiNotes ?? null,
      })
      if (res.ok) {
        message.success(res.resumed ? '已决策，流水线已恢复' : '已决策（流水线未恢复，可能已离线）')
        setDecideState(s => ({ ...s, open: false }))
        if (detail) openDetail(detail.id)
        load()
      }
    } catch (e: any) {
      const data = e?.response?.data
      if (data?.error === 'already claimed') {
        message.warning(`已被 ${data.claimedBy} 端率先决策`)
      } else {
        message.error('决策失败')
      }
    } finally {
      setDecideLoading(false)
    }
  }

  // PRD §7 step 6：从 contextSummary（plan_escalation 通知体）解析 task IDs 与 AI notes，
  // 给 rejected_plan 表单的 task select / cited notes 多选用。Regex 失败时降级（任务列表为空，
  // 用户只能选"全局问题"；AI notes 列表为空，用户跳过该字段）。
  const planEscalationOptions = useMemo(() => {
    const cs = decideState.waiter?.contextSummary ?? ''
    const taskIds = Array.from(cs.matchAll(/\|\s*(T\d+)\s*\|/g)).map(m => m[1])
    const uniqueTasks = Array.from(new Set(taskIds))

    // AI notes：找 "AI Reviewer 拒绝原因" 段后的 `数字. {内容}` 行
    const aiNotes: string[] = []
    const noteSection = cs.match(/AI Reviewer 拒绝原因[\s\S]*?(?=\n\n###|\n\n##|$)/)
    if (noteSection) {
      const noteLines = noteSection[0].matchAll(/^\d+\.\s+[🔴🟡⚪]\s+(.+?)(?:\s+·\s+`[^`]+`)?$/gm)
      for (const m of noteLines) aiNotes.push(m[1].trim())
    }

    return { taskIds: uniqueTasks, aiNotes }
  }, [decideState.waiter?.contextSummary])

  const activePendingWaiter = detail?.waiters.find(w => !w.claimedBy) ?? null
  const selectedDecision = Form.useWatch('decision', decideForm)

  const columns: ColumnsType<RequirementDTO> = [
    { title: 'ID', dataIndex: 'id', width: 64, render: v => <Text type="secondary">#{v}</Text> },
    {
      title: '需求标题',
      dataIndex: 'title',
      render: (title, row) => (
        <Button type="link" style={{ padding: 0, fontWeight: 500 }} onClick={() => openDetail(row.id)}>
          {title}
        </Button>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 110,
      render: s => <StatusTag status={s} />,
    },
    { title: '当前阶段', dataIndex: 'currentStage', width: 130, render: v => v ?? <Text type="secondary">—</Text> },
    { title: 'GitLab 项目', dataIndex: 'gitlabProject', width: 180 },
    {
      title: 'MR',
      dataIndex: 'mrUrl',
      width: 60,
      render: v => v ? <a href={v} target="_blank" rel="noreferrer">MR</a> : <Text type="secondary">—</Text>,
    },
    {
      title: '操作',
      key: 'action',
      width: 200,
      render: (_, row) => (
        <Space size={4}>
          {row.status === 'draft' && (
            <Button
              size="small"
              type="primary"
              icon={<PlayCircleOutlined />}
              loading={runningIds.has(row.id)}
              onClick={() => handleRun(row.id)}
            >
              运行
            </Button>
          )}
          {row.status === 'draft' && (
            <Button
              size="small"
              icon={<EditOutlined />}
              onClick={() => openEdit(row)}
            >
              编辑
            </Button>
          )}
          {STOPPABLE_STATUSES.includes(row.status) && (
            <Popconfirm
              title="确定要停止该需求吗？"
              description="停止后将标记为已中止，pipeline 将被终止。"
              onConfirm={() => handleStop(row.id)}
              okText="停止"
              okButtonProps={{ danger: true }}
              cancelText="取消"
            >
              <Button
                size="small"
                danger
                icon={<StopOutlined />}
                loading={stoppingIds.has(row.id)}
              >
                停止
              </Button>
            </Popconfirm>
          )}
          {(['draft', 'aborted'] as RequirementStatus[]).includes(row.status) && (
            <Popconfirm
              title="确认删除此需求？"
              onConfirm={() => handleDelete(row.id)}
              okText="删除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
            >
              <Button
                size="small"
                danger
                icon={<DeleteOutlined />}
                loading={deletingIds.has(row.id)}
              >
                删除
              </Button>
            </Popconfirm>
          )}
          <Button size="small" onClick={() => openDetail(row.id)}>详情</Button>
        </Space>
      ),
    },
  ]

  return (
    <>
      <Card
        title="需求管理（Quick-Impl）"
        extra={
          <Space>
            <Select
              allowClear
              placeholder="按状态筛选"
              style={{ width: 150 }}
              value={filterStatus}
              onChange={v => { setFilterStatus(v); setPage(1) }}
              options={ALL_STATUSES.map(s => ({ value: s, label: STATUS_CONFIG[s]?.label ?? s }))}
            />
            <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
              新建需求
            </Button>
          </Space>
        }
      >
        <Table
          rowKey="id"
          columns={columns}
          dataSource={items}
          loading={loading}
          pagination={{
            current: page,
            pageSize: 20,
            total,
            onChange: setPage,
            showTotal: t => `共 ${t} 条`,
          }}
        />
      </Card>

      {/* 详情抽屉 */}
      <Drawer
        title={detail ? `需求 #${detail.id} — ${detail.title}` : '需求详情'}
        width={640}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        loading={detailLoading}
        extra={
          <Space>
            {detail?.status === 'draft' && (
              <Button
                type="primary"
                icon={<PlayCircleOutlined />}
                loading={runningIds.has(detail.id)}
                onClick={() => handleRun(detail.id)}
              >
                运行
              </Button>
            )}
            {detail?.status === 'draft' && (
              <Button icon={<EditOutlined />} onClick={() => { openEdit(detail); setDetailOpen(false) }}>
                编辑
              </Button>
            )}
            {activePendingWaiter && (
              <Button
                type="primary"
                icon={<CheckOutlined />}
                onClick={() => openDecide(activePendingWaiter, detail!.id)}
              >
                审批决策
              </Button>
            )}
            {detail?.status === 'failed' && (
              <Popconfirm
                title="确定从失败节点重试？"
                description="将重置 run 状态并从 LangGraph checkpoint 继续执行。"
                onConfirm={async () => {
                  try {
                    await requirementsApi.retry(detail.id)
                    message.success('已触发重试')
                    await openDetail(detail.id)
                  } catch (err: any) {
                    message.error(`重试失败：${err?.response?.data?.error ?? err.message}`)
                  }
                }}
                okText="确定"
                cancelText="取消"
              >
                <Button icon={<ReloadOutlined />}>从失败节点重试</Button>
              </Popconfirm>
            )}
          </Space>
        }
      >
        {detail && (
          <Space direction="vertical" style={{ width: '100%' }} size={20}>
            <Descriptions bordered size="small" column={1}>
              <Descriptions.Item label="标题">{detail.title}</Descriptions.Item>
              <Descriptions.Item label="状态"><StatusTag status={detail.status} /></Descriptions.Item>
              <Descriptions.Item label="来源">{detail.source}</Descriptions.Item>
              <Descriptions.Item label="GitLab 项目">{detail.gitlabProject}</Descriptions.Item>
              <Descriptions.Item label="基础分支">{detail.baseBranch}</Descriptions.Item>
              {detail.skipE2E && (
                <Descriptions.Item label="E2E">
                  <Tag color="orange">已跳过</Tag>
                </Descriptions.Item>
              )}
              {detail.branch && <Descriptions.Item label="功能分支">{detail.branch}</Descriptions.Item>}
              {detail.pipelineRunId && (
                <Descriptions.Item label="流水线 Run">#{detail.pipelineRunId}</Descriptions.Item>
              )}
              {detail.mrUrl && (
                <Descriptions.Item label="MR">
                  <a href={detail.mrUrl} target="_blank" rel="noreferrer">{detail.mrUrl}</a>
                </Descriptions.Item>
              )}
              {detail.currentStage && <Descriptions.Item label="当前阶段">{detail.currentStage}</Descriptions.Item>}
              {detail.abortReason && (
                <Descriptions.Item label="中止原因">
                  <Text type="danger">{detail.abortReason}</Text>
                </Descriptions.Item>
              )}
              <Descriptions.Item label="创建时间">{new Date(detail.createdAt).toLocaleString('zh-CN')}</Descriptions.Item>
              <Descriptions.Item label="创建者">{detail.createdBy ?? '—'}</Descriptions.Item>
            </Descriptions>

            {detail.rawInput && (
              <div>
                <Text strong style={{ display: 'block', marginBottom: 8 }}>原始输入</Text>
                <Paragraph
                  style={{
                    background: '#F6F7FA', borderRadius: 6, padding: '8px 12px',
                    fontSize: 13, margin: 0, whiteSpace: 'pre-wrap',
                  }}
                >
                  {detail.rawInput}
                </Paragraph>
              </div>
            )}

            {detail.specContent && (
              <Collapse
                size="small"
                items={[{
                  key: 'spec',
                  label: <Space><FileTextOutlined /><span>需求规格（Spec）</span></Space>,
                  children: (
                    <div style={{ maxHeight: 520, overflowY: 'auto', fontSize: 13 }} className="spec-markdown">
                      <MarkdownViewer source={detail.specContent} />
                    </div>
                  ),
                }]}
              />
            )}

            <div>
              <Text strong style={{ display: 'block', marginBottom: 8 }}>审批记录</Text>
              <WaiterTimeline waiters={detail.waiters} />
            </div>

            <QiE2eProgress stageResults={detail.stageResults} />

            <div>
              <Divider orientation="left">节点执行记录</Divider>
              <StageResultsTimeline
                stageResults={detail.stageResults ?? []}
                pipelineNodes={undefined}
                onRetry={detail?.status === 'failed' ? async (nodeId) => {
                  try {
                    await requirementsApi.retryFromNode(detail.id, nodeId)
                    message.success(`已从节点「${nodeId}」重试`)
                    await openDetail(detail.id)
                  } catch (err: any) {
                    message.error(`重试失败：${err?.response?.data?.error ?? err.message}`)
                  }
                } : undefined}
              />
            </div>
          </Space>
        )}
      </Drawer>

      {/* 新建需求 Modal */}
      <Modal
        title="新建需求"
        open={createOpen}
        onCancel={() => { setCreateOpen(false); createForm.resetFields() }}
        onOk={() => createForm.submit()}
        confirmLoading={createLoading}
        okText="保存草稿"
        cancelText="取消"
      >
        <Form form={createForm} layout="vertical" onFinish={handleCreate}>
          <Form.Item name="title" label="需求标题" rules={[{ required: true, message: '请输入标题' }]}>
            <Input placeholder="一句话描述需求" />
          </Form.Item>
          <Form.Item name="rawInput" label="需求详情" rules={[{ required: true, message: '请输入详情' }]}>
            <TextArea rows={4} placeholder="详细描述需求内容、验收条件等" />
          </Form.Item>
          <Form.Item name="gitlabProject" label="GitLab 项目" rules={[{ required: true, message: '请输入项目路径' }]}>
            <Input placeholder="group/repo" />
          </Form.Item>
          <Form.Item name="baseBranch" label="基础分支">
            <Input placeholder="留空默认 main" />
          </Form.Item>
          <Form.Item name="skipE2E" valuePropName="checked" extra="勾选后 Dev 完成直接走到 Final Approval，整段 E2E 不跑。仅适合调试/小改/紧急合入。">
            <Checkbox>跳过 E2E 测试</Checkbox>
          </Form.Item>
        </Form>
      </Modal>

      {/* 编辑需求 Modal */}
      <Modal
        title={editTarget ? `编辑需求 #${editTarget.id}` : '编辑需求'}
        open={!!editTarget}
        onCancel={() => { setEditTarget(null); editForm.resetFields() }}
        onOk={() => editForm.submit()}
        confirmLoading={editLoading}
        okText="保存"
        cancelText="取消"
      >
        <Form form={editForm} layout="vertical" onFinish={handleEdit}>
          <Form.Item name="title" label="需求标题" rules={[{ required: true, message: '请输入标题' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="rawInput" label="需求详情" rules={[{ required: true, message: '请输入详情' }]}>
            <TextArea rows={4} />
          </Form.Item>
          <Form.Item name="gitlabProject" label="GitLab 项目" rules={[{ required: true, message: '请输入项目路径' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="baseBranch" label="基础分支">
            <Input />
          </Form.Item>
          <Form.Item name="skipE2E" valuePropName="checked" extra="勾选后 Dev 完成直接走到 Final Approval，整段 E2E 不跑。">
            <Checkbox>跳过 E2E 测试</Checkbox>
          </Form.Item>
        </Form>
      </Modal>

      {/* 审批决策 Modal */}
      <Modal
        title={buildDecisionModalTitle(decideState.waiter)}
        open={decideState.open}
        onCancel={() => setDecideState(s => ({ ...s, open: false }))}
        onOk={() => decideForm.submit()}
        confirmLoading={decideLoading}
        okText="提交决策"
        cancelText="取消"
        width={720}
      >
        {/* Spec content: from waiter contextSummary (新 run) 或 detail.specContent (已有 run) */}
        {(decideState.waiter?.contextSummary || detail?.specContent) && (
          <Collapse
            size="small"
            defaultActiveKey={['spec']}
            style={{ marginBottom: 16 }}
            items={[{
              key: 'spec',
              label: <Space><FileTextOutlined /><span>需求规格（Spec）— 请阅读后再决策</span></Space>,
              children: (
                <div style={{ maxHeight: 400, overflowY: 'auto', fontSize: 13 }} className="spec-markdown">
                  <MarkdownViewer source={decideState.waiter?.contextSummary ?? detail?.specContent ?? ''} />
                </div>
              ),
            }]}
          />
        )}
        {/* v2 结构化决策依据（acceptanceCriteria / specCoverage / commits 等） */}
        <V2StructuredView stage={findStageForWaiter(detail?.stageResults ?? null, decideState.waiter)} />
        <Form form={decideForm} layout="vertical" onFinish={handleDecide}>
          <Form.Item name="decision" label="决策" rules={[{ required: true, message: '请选择决策' }]}>
            <Select
              options={
                decideState.waiter?.decisionSet === 'plan_escalation'
                  ? [
                      { value: 'approved',       label: '✅ 通过（plan 可用，AI 抠的是 nitpick）' },
                      { value: 'rejected_plan',  label: '❌ 拒绝 plan（让 plan-decomposer 重拆）' },
                      { value: 'rejected_spec',  label: '⛔ 拒绝 spec（spec 本身有问题，需手工重新提交需求）' },
                      { value: 'aborted',        label: '🛑 终止（说不准 / 不该 AI 拆）' },
                    ]
                  : [
                      { value: 'approved',        label: '✅ 通过' },
                      { value: 'rejected',        label: '❌ 拒绝（要求修改）' },
                      { value: 'force_passed',    label: '⚡ 强制通过（跳过评审）' },
                      { value: 'budget_extended', label: '⏳ 延期（追加预算）' },
                      { value: 'aborted',         label: '🛑 中止需求' },
                    ]
              }
            />
          </Form.Item>
          {(selectedDecision === 'rejected' || selectedDecision === 'rejected_plan' || selectedDecision === 'rejected_spec') && (
            <Form.Item name="rejectReason" label="拒绝原因" rules={[{ required: true, message: '请说明拒绝原因' }]}>
              <TextArea rows={3} placeholder="请具体说明需要修改的内容..." />
            </Form.Item>
          )}
          {selectedDecision === 'rejected_plan' && decideState.waiter?.decisionSet === 'plan_escalation' && (
            <>
              <Form.Item
                name="targetTaskId"
                label="问题在哪个 task？"
                tooltip="选具体 task → plan-decomposer 下轮只修订该 task；选全局问题 → 整体重拆"
              >
                <Select
                  placeholder="选择 task 或全局问题"
                  options={[
                    { value: '__GLOBAL__', label: '🌐 全局问题（整体粒度 / 任务划分错）' },
                    ...planEscalationOptions.taskIds.map(id => ({ value: id, label: `📌 ${id}` })),
                  ]}
                  allowClear
                />
              </Form.Item>
              {planEscalationOptions.aiNotes.length > 0 && (
                <Form.Item
                  name="citedAiNotes"
                  label='勾选你认可的 AI 拒绝理由（人审"已确认是真问题"的子集）'
                  tooltip="未勾选的 AI notes 视为 nitpick，下轮可降级为 warn"
                >
                  <Checkbox.Group options={planEscalationOptions.aiNotes.map(n => ({ value: n, label: n }))} />
                </Form.Item>
              )}
            </>
          )}
          {selectedDecision === 'budget_extended' && (
            <Form.Item name="budgetDelta" label="追加预算（轮次）" rules={[{ required: true, message: '请输入追加轮次' }]}>
              <Input type="number" min={1} placeholder="例如 2" />
            </Form.Item>
          )}
          <Form.Item name="decidedBy" label="决策人">
            <Input placeholder="留空使用当前登录用户" />
          </Form.Item>
        </Form>
      </Modal>
    </>
  )
}
