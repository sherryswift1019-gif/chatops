import { useEffect, useMemo, useState } from 'react'
import {
  Drawer,
  Descriptions,
  Tag,
  Typography,
  Card,
  Collapse,
  Timeline,
  Spin,
  Empty,
  Space,
  Divider,
  Alert,
} from 'antd'
import {
  CheckCircleTwoTone,
  CloseCircleTwoTone,
  LinkOutlined,
} from '@ant-design/icons'
import type { BugAnalysisReport, Solution } from '../types'
import {
  fetchBugEvents,
  listBugReports,
  getBugAnalysisReport,
  type BugFixEvent,
} from '../api/bug-analysis-reports'

const { Paragraph, Text, Title } = Typography

interface Props {
  open: boolean
  report: BugAnalysisReport | null
  onClose: () => void
  /** 钉钉 userId → name 映射，用于 triggered_by / notify userId 等字段显示姓名 */
  userNameMap?: Record<string, string>
}

// ─── 状态 / 等级 / 分类 徽标 ────────────────────────────────────────

const LEVEL_COLOR: Record<string, string> = {
  l1: 'blue',
  l2: 'cyan',
  l3: 'orange',
  l4: 'purple',
}

function LevelTag({ level }: { level: string | null | undefined }) {
  if (!level) return <Tag color="default">—</Tag>
  const key = String(level).toLowerCase()
  const color = LEVEL_COLOR[key] ?? 'default'
  return <Tag color={color}>{key.toUpperCase()}</Tag>
}

const CLASSIFICATION_META: Record<string, { color: string; label: string }> = {
  bug: { color: 'red', label: 'Bug' },
  config_issue: { color: 'blue', label: '配置问题' },
  usage_issue: { color: 'green', label: '使用问题' },
}

function ClassificationTag({ classification }: { classification: string | null | undefined }) {
  if (!classification) return <Tag color="default">—</Tag>
  const meta = CLASSIFICATION_META[classification]
  if (!meta) return <Tag>{classification}</Tag>
  return <Tag color={meta.color}>{meta.label}</Tag>
}

const STATUS_META: Record<string, { color: string; label: string }> = {
  draft: { color: 'default', label: '草稿' },
  published: { color: 'processing', label: '已发布' },
  pipeline_success: { color: 'cyan', label: 'Pipeline 成功' },
  pending_manual: { color: 'orange', label: '待人工接手' },
  completed: { color: 'success', label: '已完成' },
  aborted: { color: 'error', label: '已终止' },
}

function StatusTag({ status }: { status: string | null | undefined }) {
  if (!status) return <Tag>—</Tag>
  const meta = STATUS_META[status]
  if (!meta) return <Tag>{status}</Tag>
  return <Tag color={meta.color}>{meta.label}</Tag>
}

// ─── 工具函数 ─────────────────────────────────────────────────────

function formatDateTime(s: string | null | undefined): string {
  if (!s) return '—'
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return String(s)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return ''
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

const CODE_LABELS: Record<string, string> = {
  analysis: '分析',
  scope_identified: '识别 scope',
  create_issue: '创建 Issue',
  fix_attempt: '修复尝试',
  create_mr: '创建 MR',
  ai_review: 'AI Review',
  approval: '审批',
  notify: '通知',
  handover: '转人工',
  lifecycle_sync: '生命周期同步',
}

function codeLabel(code: string): string {
  return CODE_LABELS[code] ?? code
}

function lifecycleSyncTag(e: BugFixEvent): { text: string; color?: string } {
  const action = e.data['mrAction'] as string | undefined
  if (action === 'merge') return { text: 'MR 已合并', color: 'green' }
  if (action === 'close') return { text: 'MR 已关闭', color: 'red' }
  return { text: 'MR 状态同步' }
}

function get<T = unknown>(data: Record<string, unknown>, key: string): T | undefined {
  return data[key] as T | undefined
}

// 事件分组：按 code 聚合
function groupEventsByCode(events: BugFixEvent[]): Record<string, BugFixEvent[]> {
  const out: Record<string, BugFixEvent[]> = {}
  for (const e of events) {
    if (!out[e.code]) out[e.code] = []
    out[e.code].push(e)
  }
  return out
}

// ─── Section 2：推荐方案 / 备选方案 ──────────────────────────────

function SolutionCard({ solution, highlight }: { solution: Solution; highlight?: boolean }) {
  return (
    <Card
      size="small"
      title={
        <Space>
          {highlight && <Tag color="green">推荐</Tag>}
          <Text strong>{solution.summary || solution.id}</Text>
        </Space>
      }
      style={highlight ? { borderColor: '#52c41a' } : undefined}
    >
      <Descriptions column={2} size="small">
        <Descriptions.Item label="风险">{solution.risk ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="工作量">{solution.effort ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="ID" span={2}>
          <Text code>{solution.id}</Text>
        </Descriptions.Item>
      </Descriptions>
    </Card>
  )
}

// ─── Section 3：事件分组渲染 ─────────────────────────────────────

function IssueEventBlock({ events }: { events: BugFixEvent[] }) {
  if (events.length === 0) return null
  return (
    <Space direction="vertical" size="small" style={{ width: '100%' }}>
      {events.map((e) => {
        // 后端写的是 issueIid / issueUrl；旧事件兼容 iid / url
        const iid = get<number | string>(e.data, 'issueIid') ?? get<number | string>(e.data, 'iid')
        const url = get<string>(e.data, 'issueUrl') ?? get<string>(e.data, 'url')
        const isReused = get<boolean>(e.data, 'isReused')
        return (
          <Descriptions key={e.id} size="small" column={2} bordered>
            <Descriptions.Item label="Issue IID">{iid ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="复用已有">{isReused ? '是' : '否'}</Descriptions.Item>
            <Descriptions.Item label="URL" span={2}>
              {url ? (
                <a href={url} target="_blank" rel="noreferrer">
                  <LinkOutlined /> {url}
                </a>
              ) : (
                '—'
              )}
            </Descriptions.Item>
          </Descriptions>
        )
      })}
    </Space>
  )
}

function FixAttemptBlock({ events }: { events: BugFixEvent[] }) {
  if (events.length === 0) return null
  // 按 projectPath 分组，然后在每个 project 下按时间递增编号
  const byProject: Record<string, BugFixEvent[]> = {}
  for (const e of events) {
    const key = e.projectPath ?? '(unknown)'
    if (!byProject[key]) byProject[key] = []
    byProject[key].push(e)
  }
  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {Object.entries(byProject).map(([project, list]) => (
        <div key={project}>
          <Text strong>{project}</Text>
          <Space direction="vertical" size="small" style={{ width: '100%', marginTop: 8 }}>
            {list.map((e, idx) => {
              const branch = get<string>(e.data, 'branch')
              // 后端 fix-runner 写的是 testResult；保留 testPassed 兼容
              const testPassed = get<boolean>(e.data, 'testPassed') ?? get<boolean>(e.data, 'testResult')
              const error = get<string>(e.data, 'error')
              const output = get<string>(e.data, 'output')
              return (
                <Card key={e.id} size="small" title={`Attempt #${idx + 1}`}>
                  <Descriptions column={2} size="small">
                    <Descriptions.Item label="分支">
                      {branch ? <Text code>{branch}</Text> : '—'}
                    </Descriptions.Item>
                    <Descriptions.Item label="测试">
                      {testPassed === true ? (
                        <CheckCircleTwoTone twoToneColor="#52c41a" />
                      ) : testPassed === false ? (
                        <CloseCircleTwoTone twoToneColor="#ff4d4f" />
                      ) : (
                        '—'
                      )}
                    </Descriptions.Item>
                    <Descriptions.Item label="状态">
                      {e.status === 'success' ? (
                        <Tag color="success">success</Tag>
                      ) : (
                        <Tag color="error">failed</Tag>
                      )}
                    </Descriptions.Item>
                    <Descriptions.Item label="耗时">
                      {formatDuration(e.durationMs) || '—'}
                    </Descriptions.Item>
                  </Descriptions>
                  {error && (
                    <Collapse size="small" style={{ marginTop: 8 }}>
                      <Collapse.Panel header="错误详情" key="err">
                        <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{error}</pre>
                      </Collapse.Panel>
                    </Collapse>
                  )}
                  {output && (
                    <Collapse size="small" style={{ marginTop: 8 }}>
                      <Collapse.Panel header="输出摘要" key="out">
                        <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{output}</pre>
                      </Collapse.Panel>
                    </Collapse>
                  )}
                </Card>
              )
            })}
          </Space>
        </div>
      ))}
    </Space>
  )
}

function MRBlock({ events }: { events: BugFixEvent[] }) {
  if (events.length === 0) return null
  return (
    <Space direction="vertical" size="small" style={{ width: '100%' }}>
      {events.map((e) => {
        // 后端 create-mr-handler 写的是 mrIid / mrUrl；旧事件兼容 iid / url
        const iid = get<number | string>(e.data, 'mrIid') ?? get<number | string>(e.data, 'iid')
        const url = get<string>(e.data, 'mrUrl') ?? get<string>(e.data, 'url')
        return (
          <Descriptions key={e.id} size="small" column={2} bordered>
            <Descriptions.Item label="项目">{e.projectPath ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="MR IID">{iid ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="URL" span={2}>
              {url ? (
                <a href={url} target="_blank" rel="noreferrer">
                  <LinkOutlined /> {url}
                </a>
              ) : (
                '—'
              )}
            </Descriptions.Item>
          </Descriptions>
        )
      })}
    </Space>
  )
}

function AIReviewBlock({ events }: { events: BugFixEvent[] }) {
  if (events.length === 0) return null
  return (
    <Space direction="vertical" size="small" style={{ width: '100%' }}>
      {events.map((e) => {
        const label = get<string>(e.data, 'label')
        const summary = get<string>(e.data, 'summary')
        const color = label === 'ai-approved' ? 'green' : label === 'ai-needs-attention' ? 'orange' : 'default'
        return (
          <Card key={e.id} size="small" title={e.projectPath ?? 'AI Review'}>
            <Space direction="vertical" size="small" style={{ width: '100%' }}>
              {label && <Tag color={color}>{label}</Tag>}
              {summary ? (
                <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{summary}</pre>
              ) : (
                <Text type="secondary">（无摘要）</Text>
              )}
            </Space>
          </Card>
        )
      })}
    </Space>
  )
}

function NotifyBlock({ events }: { events: BugFixEvent[] }) {
  if (events.length === 0) return null
  return (
    <Space direction="vertical" size="small" style={{ width: '100%' }}>
      {events.map((e) => {
        // 后端 notify-handler 每条事件针对 1 个 userId + 可选 mrIids 数组；旧事件兼容 kind/targets/recipients
        const kind =
          get<string>(e.data, 'messageKind') ??
          get<string>(e.data, 'kind') ??
          ''
        const userId = get<string>(e.data, 'userId')
        const role = get<string>(e.data, 'role')
        const mrIids = (get<unknown[]>(e.data, 'mrIids') ?? []) as Array<number | string>
        const legacyTargets =
          (get<unknown[]>(e.data, 'targets') ?? get<unknown[]>(e.data, 'recipients') ?? []) as unknown[]
        return (
          <Descriptions key={e.id} size="small" column={1} bordered>
            <Descriptions.Item label="种类">{kind || '—'}</Descriptions.Item>
            <Descriptions.Item label="对象">
              {userId ? (
                <Space wrap>
                  <Tag>{role ? `${role}: ${userId}` : userId}</Tag>
                  {mrIids.map((m, i) => (
                    <Tag key={`mr-${i}`} color="blue">MR !{String(m)}</Tag>
                  ))}
                </Space>
              ) : legacyTargets.length > 0 ? (
                <Space wrap>
                  {legacyTargets.map((t, i) => (
                    <Tag key={i}>{typeof t === 'string' ? t : JSON.stringify(t)}</Tag>
                  ))}
                </Space>
              ) : (
                '—'
              )}
            </Descriptions.Item>
          </Descriptions>
        )
      })}
    </Space>
  )
}

function HandoverBlock({ events }: { events: BugFixEvent[] }) {
  if (events.length === 0) return null
  return (
    <Space direction="vertical" size="small" style={{ width: '100%' }}>
      {events.map((e) => {
        const reason = get<string>(e.data, 'reason')
        const owner = get<string>(e.data, 'owner')
        const branchUrl = get<string>(e.data, 'fixBranchUrl') ?? get<string>(e.data, 'branchUrl')
        const failureSummary = get<string>(e.data, 'failureSummary')
        const attemptCount = get<number>(e.data, 'attemptCount')
        return (
          <Descriptions key={e.id} size="small" column={2} bordered>
            <Descriptions.Item label="原因">{reason ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="接手人">{owner ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="尝试次数">{attemptCount ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="修复分支">
              {branchUrl ? (
                <a href={branchUrl} target="_blank" rel="noreferrer">
                  <LinkOutlined /> 查看
                </a>
              ) : (
                '—'
              )}
            </Descriptions.Item>
            <Descriptions.Item label="失败摘要" span={2}>
              {failureSummary ? (
                <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{failureSummary}</pre>
              ) : (
                '—'
              )}
            </Descriptions.Item>
          </Descriptions>
        )
      })}
    </Space>
  )
}

function ApprovalBlock({ events }: { events: BugFixEvent[] }) {
  if (events.length === 0) return null
  return (
    <Space direction="vertical" size="small" style={{ width: '100%' }}>
      {events.map((e) => {
        const decision = get<string>(e.data, 'decision')
        const approver = get<string>(e.data, 'approver') ?? get<string>(e.data, 'approverId')
        const comment = get<string>(e.data, 'comment') ?? get<string>(e.data, 'note')
        const color = decision === 'approved' ? 'green' : decision === 'rejected' ? 'red' : 'default'
        return (
          <Descriptions key={e.id} size="small" column={2} bordered>
            <Descriptions.Item label="决策">
              {decision ? <Tag color={color}>{decision}</Tag> : '—'}
            </Descriptions.Item>
            <Descriptions.Item label="审批人">{approver ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="备注" span={2}>
              {comment ?? '—'}
            </Descriptions.Item>
          </Descriptions>
        )
      })}
    </Space>
  )
}

// ─── Section 1：基础元数据 ───────────────────────────────────────

function BasicMetaSection({
  report,
  userNameMap,
}: {
  report: BugAnalysisReport
  userNameMap?: Record<string, string>
}) {
  const triggeredByLabel = report.triggeredBy
    ? userNameMap?.[report.triggeredBy] ?? report.triggeredBy
    : null
  return (
    <Descriptions column={2} bordered size="small">
      <Descriptions.Item label="Report ID">{report.id}</Descriptions.Item>
      <Descriptions.Item label="Issue">
        <a href={report.issueUrl} target="_blank" rel="noreferrer">
          #{report.issueId}
        </a>
      </Descriptions.Item>
      <Descriptions.Item label="产品线">
        <Tag>{report.productLineName || '—'}</Tag>
      </Descriptions.Item>
      <Descriptions.Item label="等级">
        <LevelTag level={report.level} />
      </Descriptions.Item>
      <Descriptions.Item label="分类">
        <ClassificationTag classification={report.classification} />
      </Descriptions.Item>
      <Descriptions.Item label="状态">
        <StatusTag status={report.status} />
      </Descriptions.Item>
      <Descriptions.Item label="触发人">{triggeredByLabel ?? '—'}</Descriptions.Item>
      <Descriptions.Item label="置信度">
        {report.confidence}
        {report.confidenceScore != null ? ` (${report.confidenceScore})` : ''}
      </Descriptions.Item>
      <Descriptions.Item label="主仓库">{report.primaryProjectPath ?? '—'}</Descriptions.Item>
      <Descriptions.Item label="Pipeline Run">
        {report.pipelineRunId ? (
          <a href="/test-runs" target="_blank" rel="noreferrer">
            #{report.pipelineRunId}
          </a>
        ) : (
          '—'
        )}
      </Descriptions.Item>
      <Descriptions.Item label="Agent Session" span={2}>
        {report.agentSessionId ? (
          <Paragraph copyable style={{ margin: 0 }}>
            <Text code>{report.agentSessionId}</Text>
          </Paragraph>
        ) : (
          '—'
        )}
      </Descriptions.Item>
      <Descriptions.Item label="创建时间">{formatDateTime(report.createdAt)}</Descriptions.Item>
      <Descriptions.Item label="更新时间">{formatDateTime(report.updatedAt)}</Descriptions.Item>
      <Descriptions.Item label="完成时间" span={2}>
        {formatDateTime(report.completedAt)}
      </Descriptions.Item>
    </Descriptions>
  )
}

// ─── Section 2：分析内容 ─────────────────────────────────────────

function AnalysisSection({
  report,
  markdown,
  markdownLoading,
}: {
  report: BugAnalysisReport
  markdown: string | null
  markdownLoading: boolean
}) {
  const solutions = Array.isArray(report.solutionsJson) ? report.solutionsJson : []
  const recommended = solutions.find((s) => s.recommended) ?? solutions[0]
  const others = solutions.filter((s) => s !== recommended)

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <div>
        <Title level={5} style={{ marginTop: 0 }}>根因摘要</Title>
        {report.rootCauseSummary ? (
          <Paragraph>{report.rootCauseSummary}</Paragraph>
        ) : (
          <Text type="secondary">（未提供）</Text>
        )}
      </div>

      <div>
        <Title level={5} style={{ marginTop: 0 }}>推荐方案</Title>
        {recommended ? (
          <SolutionCard solution={recommended} highlight />
        ) : (
          <Text type="secondary">（无）</Text>
        )}
      </div>

      {others.length > 0 && (
        <div>
          <Title level={5} style={{ marginTop: 0 }}>备选方案（{others.length}）</Title>
          <Collapse size="small">
            {others.map((s) => (
              <Collapse.Panel header={s.summary || s.id} key={s.id}>
                <SolutionCard solution={s} />
              </Collapse.Panel>
            ))}
          </Collapse>
        </div>
      )}

      <div>
        <Title level={5} style={{ marginTop: 0 }}>受影响模块</Title>
        {report.affectedModules && report.affectedModules.length > 0 ? (
          <Space wrap>
            {report.affectedModules.map((m, i) => (
              <Tag key={i}>{m}</Tag>
            ))}
          </Space>
        ) : (
          <Text type="secondary">（无）</Text>
        )}
      </div>

      <div>
        <Title level={5} style={{ marginTop: 0 }}>分析步骤</Title>
        {report.analysisSteps && report.analysisSteps.length > 0 ? (
          <ol style={{ paddingLeft: 20, margin: 0 }}>
            {report.analysisSteps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
        ) : (
          <Text type="secondary">（无）</Text>
        )}
      </div>

      <div>
        <Title level={5} style={{ marginTop: 0 }}>完整报告 Markdown</Title>
        <Collapse size="small">
          <Collapse.Panel header="展开查看" key="md">
            {markdownLoading ? (
              <Spin />
            ) : markdown ? (
              <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{markdown}</pre>
            ) : (
              <Text type="secondary">（当前报告未提供 Markdown 原文）</Text>
            )}
          </Collapse.Panel>
        </Collapse>
      </div>

      <div>
        <Title level={5} style={{ marginTop: 0 }}>原始 metadata</Title>
        <Collapse size="small">
          <Collapse.Panel header="展开查看" key="meta">
            <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
              {JSON.stringify(report.metadata ?? {}, null, 2)}
            </pre>
          </Collapse.Panel>
        </Collapse>
      </div>
    </Space>
  )
}

// ─── Section 3：执行结果 ─────────────────────────────────────────

function ExecutionSection({ events }: { events: BugFixEvent[] }) {
  const grouped = useMemo(() => groupEventsByCode(events), [events])
  const order: Array<[string, string]> = [
    ['create_issue', 'Issue 信息'],
    ['fix_attempt', '修复尝试'],
    ['create_mr', 'Merge Request'],
    ['ai_review', 'AI Review'],
    ['approval', '审批记录'],
    ['notify', '通知记录'],
    ['handover', 'Handover'],
  ]
  const hasAny = order.some(([code]) => (grouped[code]?.length ?? 0) > 0)
  if (!hasAny) {
    return <Empty description="本轮暂无执行事件" />
  }
  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {order.map(([code, title]) => {
        const list = grouped[code] ?? []
        if (list.length === 0) return null
        return (
          <div key={code}>
            <Title level={5} style={{ marginTop: 0 }}>{title}</Title>
            {code === 'create_issue' && <IssueEventBlock events={list} />}
            {code === 'fix_attempt' && <FixAttemptBlock events={list} />}
            {code === 'create_mr' && <MRBlock events={list} />}
            {code === 'ai_review' && <AIReviewBlock events={list} />}
            {code === 'approval' && <ApprovalBlock events={list} />}
            {code === 'notify' && <NotifyBlock events={list} />}
            {code === 'handover' && <HandoverBlock events={list} />}
          </div>
        )
      })}
    </Space>
  )
}

// ─── Section 4：多轮历史 ─────────────────────────────────────────

function RoundCompactBody({
  report,
  events,
}: {
  report: BugAnalysisReport
  events: BugFixEvent[]
}) {
  return (
    <Space direction="vertical" size="small" style={{ width: '100%' }}>
      <Descriptions column={2} size="small" bordered>
        <Descriptions.Item label="Report ID">{report.id}</Descriptions.Item>
        <Descriptions.Item label="状态">
          <StatusTag status={report.status} />
        </Descriptions.Item>
        <Descriptions.Item label="等级">
          <LevelTag level={report.level} />
        </Descriptions.Item>
        <Descriptions.Item label="分类">
          <ClassificationTag classification={report.classification} />
        </Descriptions.Item>
        <Descriptions.Item label="创建时间">{formatDateTime(report.createdAt)}</Descriptions.Item>
        <Descriptions.Item label="完成时间">{formatDateTime(report.completedAt)}</Descriptions.Item>
      </Descriptions>
      {events.length > 0 ? (
        <Timeline
          items={events.map((e) => ({
            color: e.status === 'success' ? 'green' : e.status === 'failed' ? 'red' : 'gray',
            children: (
              <Space size="small" wrap>
                <Text type="secondary">{formatDateTime(e.createdAt)}</Text>
                <Tag>{codeLabel(e.code)}</Tag>
                {e.projectPath && <Text code>{e.projectPath}</Text>}
              </Space>
            ),
          }))}
        />
      ) : (
        <Text type="secondary">（本轮无事件）</Text>
      )}
    </Space>
  )
}

function RoundsHistorySection({
  rounds,
  currentReportId,
  currentEvents,
}: {
  rounds: BugAnalysisReport[]
  currentReportId: number
  currentEvents: BugFixEvent[]
}) {
  if (rounds.length < 2) return null
  const sorted = [...rounds].sort((a, b) => a.id - b.id)
  return (
    <Collapse defaultActiveKey={[String(currentReportId)]} size="small">
      {sorted.map((r, idx) => (
        <Collapse.Panel
          key={String(r.id)}
          header={
            <Space size="small">
              <Text strong>第 {idx + 1} 轮</Text>
              <StatusTag status={r.status} />
              <Text type="secondary">创建 {formatDateTime(r.createdAt)}</Text>
              <Text type="secondary">完成 {formatDateTime(r.completedAt)}</Text>
              {r.id === currentReportId && <Tag color="blue">当前</Tag>}
            </Space>
          }
        >
          <RoundCompactBody
            report={r}
            events={r.id === currentReportId ? currentEvents : []}
          />
          {r.id !== currentReportId && (
            <Alert
              type="info"
              showIcon
              message="仅当前轮展示完整事件时间线；如需查看此轮事件，请切换查看该报告。"
              style={{ marginTop: 8 }}
            />
          )}
        </Collapse.Panel>
      ))}
    </Collapse>
  )
}

// ─── Section 5：本轮完整事件时间线 ────────────────────────────────

function eventDataSummary(e: BugFixEvent): string {
  const parts: string[] = []
  const keys = ['branch', 'iid', 'mrIid', 'mergedBy', 'closedBy', 'decision', 'label', 'kind', 'reason', 'owner']
  for (const k of keys) {
    const v = e.data[k]
    if (v != null && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) {
      parts.push(`${k}=${v}`)
    }
  }
  return parts.join(' · ')
}

function FullTimelineSection({ events }: { events: BugFixEvent[] }) {
  if (events.length === 0) return <Empty description="本轮无事件" />
  const sorted = [...events].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  )
  return (
    <Timeline
      items={sorted.map((e) => {
        const lifecycleTag = e.code === 'lifecycle_sync' ? lifecycleSyncTag(e) : null
        return {
          color: e.status === 'success' ? 'green' : e.status === 'failed' ? 'red' : 'gray',
          children: (
            <Space direction="vertical" size={2} style={{ width: '100%' }}>
              <Space size="small" wrap>
                <Text type="secondary">{formatDateTime(e.createdAt)}</Text>
                {lifecycleTag
                  ? <Tag color={lifecycleTag.color}>{lifecycleTag.text}</Tag>
                  : <Tag>{codeLabel(e.code)}</Tag>}
                {e.projectPath && <Text code>{e.projectPath}</Text>}
                {e.status === 'success' ? (
                  <CheckCircleTwoTone twoToneColor="#52c41a" />
                ) : (
                  <CloseCircleTwoTone twoToneColor="#ff4d4f" />
                )}
                {e.durationMs != null && <Text type="secondary">{formatDuration(e.durationMs)}</Text>}
              </Space>
              {eventDataSummary(e) && <Text type="secondary">{eventDataSummary(e)}</Text>}
            </Space>
          ),
        }
      })}
    />
  )
}

// ─── 主组件 ───────────────────────────────────────────────────────

export default function BugRunDetailDrawer({ open, report, onClose, userNameMap }: Props) {
  const [events, setEvents] = useState<BugFixEvent[]>([])
  const [rounds, setRounds] = useState<BugAnalysisReport[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [markdown, setMarkdown] = useState<string | null>(null)
  const [markdownLoading, setMarkdownLoading] = useState(false)

  useEffect(() => {
    if (!open || !report) {
      setEvents([])
      setRounds([])
      setError(null)
      setMarkdown(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    Promise.all([
      fetchBugEvents(report.id),
      listBugReports({
        issueId: report.issueId,
        productLineId: report.productLineId,
        pageSize: 100,
      }),
    ])
      .then(([evts, roundsResp]) => {
        if (cancelled) return
        setEvents(evts)
        setRounds(roundsResp.data)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    // markdown 按需拉（后端当前不返回 markdown 字段，兜底处理）
    setMarkdownLoading(true)
    setMarkdown(null)
    getBugAnalysisReport(report.id)
      .then((full) => {
        if (cancelled) return
        const md = (full as unknown as { markdown?: string }).markdown
        setMarkdown(typeof md === 'string' ? md : null)
      })
      .catch(() => {
        if (cancelled) return
        setMarkdown(null)
      })
      .finally(() => {
        if (!cancelled) setMarkdownLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [open, report])

  return (
    <Drawer
      title={report ? `Bug 报告 #${report.id}` : 'Bug 报告'}
      width={960}
      open={open}
      onClose={onClose}
      destroyOnClose
    >
      {!report ? (
        <Empty description="未选择报告" />
      ) : loading ? (
        <Spin tip="加载中..." />
      ) : error ? (
        <Alert type="error" message="加载失败" description={error} showIcon />
      ) : (
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          <div>
            <Title level={4} style={{ marginTop: 0 }}>基础元数据</Title>
            <BasicMetaSection report={report} userNameMap={userNameMap} />
          </div>

          <Divider style={{ margin: 0 }} />

          <div>
            <Title level={4} style={{ marginTop: 0 }}>分析内容</Title>
            <AnalysisSection
              report={report}
              markdown={markdown}
              markdownLoading={markdownLoading}
            />
          </div>

          <Divider style={{ margin: 0 }} />

          <div>
            <Title level={4} style={{ marginTop: 0 }}>执行结果</Title>
            <ExecutionSection events={events} />
          </div>

          {rounds.length >= 2 && (
            <>
              <Divider style={{ margin: 0 }} />
              <div>
                <Title level={4} style={{ marginTop: 0 }}>多轮历史（{rounds.length} 轮）</Title>
                <RoundsHistorySection
                  rounds={rounds}
                  currentReportId={report.id}
                  currentEvents={events}
                />
              </div>
            </>
          )}

          <Divider style={{ margin: 0 }} />

          <div>
            <Title level={4} style={{ marginTop: 0 }}>本轮完整事件时间线</Title>
            <FullTimelineSection events={events} />
          </div>
        </Space>
      )}
    </Drawer>
  )
}
