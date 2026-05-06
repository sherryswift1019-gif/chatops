// web/src/pages/E2eRunDetailPage.tsx
import { useState, useEffect, useCallback, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Card, Tag, Button, Space, Typography, Descriptions, Spin, message,
  Collapse, Drawer, List, Image, Divider, Badge, Popconfirm,
} from 'antd'
import {
  ArrowLeftOutlined, ReloadOutlined, StopOutlined,
  CheckCircleOutlined, CloseCircleOutlined, SyncOutlined,
  ClockCircleOutlined, MinusCircleOutlined,
} from '@ant-design/icons'
import {
  e2eRunsApi,
  type E2eRunDTO,
  type E2eSandboxDTO,
  type E2eScenarioRunDTO,
  type EvidenceManifest,
  type EvidenceArtifact,
  type PlaybookDraftSummary,
  type AwaitingReviewInfo,
} from '../api/e2e-runs'
import { useScenarioEvents } from '../hooks/useScenarioEvents'
import type { ScenarioEvent, ScenarioEventStatus } from '../hooks/useScenarioEvents'

const { Title, Text, Link, Paragraph } = Typography

const RUN_STATUS_CONFIG: Record<E2eRunDTO['status'], { color: string; label: string }> = {
  pending:                { color: 'default',    label: '等待中' },
  running:                { color: 'processing', label: '运行中' },
  awaiting_fix:           { color: 'warning',    label: '等待修复' },
  awaiting_human_review:  { color: 'warning',    label: '等待人审' },
  passed:                 { color: 'success',    label: '通过' },
  failed:                 { color: 'error',      label: '失败' },
  aborted:                { color: 'default',    label: '已中止' },
}

const SCENARIO_RESULT_CONFIG: Record<E2eScenarioRunDTO['result'], { icon: React.ReactNode; color: string; label: string }> = {
  pass:      { icon: <CheckCircleOutlined />, color: '#52c41a', label: '通过' },
  fail:      { icon: <CloseCircleOutlined />, color: '#ff4d4f', label: '失败' },
  error:     { icon: <CloseCircleOutlined />, color: '#ff4d4f', label: '错误' },
  timeout:   { icon: <ClockCircleOutlined />, color: '#faad14', label: '超时' },
  skipped:   { icon: <MinusCircleOutlined />, color: '#d9d9d9', label: '跳过' },
  unfixable: { icon: <CloseCircleOutlined />, color: '#722ed1', label: '无法修复' },
}

const SANDBOX_STATUS_COLOR: Record<E2eSandboxDTO['status'], string> = {
  provisioning: 'processing',
  ready:        'success',
  redeploying:  'warning',
  torn_down:    'default',
  failed:       'error',
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

function formatElapsed(startMs: number): string {
  const elapsed = Date.now() - startMs
  const h = Math.floor(elapsed / 3_600_000)
  const m = Math.floor((elapsed % 3_600_000) / 60_000)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

const ACTIVE_STATUSES = new Set<E2eRunDTO['status']>(['running', 'awaiting_fix', 'awaiting_human_review', 'pending'])

function RunSummary({ run, playbookDraft }: { run: E2eRunDTO; playbookDraft: PlaybookDraftSummary | null }) {
  const gs = run.governorState
  const limits = gs?.limits
  const totalAttempts = gs?.totalAttempts ?? 0
  const elapsed = gs?.runStartedAt ? formatElapsed(gs.runStartedAt) : '—'

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={8}>
      <Space wrap>
        <Text type="secondary">
          尝试 {totalAttempts}/{limits?.maxTotalAttempts ?? '—'} ·
          用时 {elapsed} / {limits?.maxRunHours ?? '—'}h ·
          单场景重试 ≤ {limits?.maxPerScenarioAttempts ?? '—'}
        </Text>
      </Space>
      <Space wrap>
        <Text type="secondary">源分支：</Text>
        <Text code>{run.sourceBranch}</Text>
        <Text type="secondary">迭代分支：</Text>
        {run.iterationBranch ? (
          <Link
            href={`https://gitlab.example.com/-/tree/${run.iterationBranch}`}
            target="_blank"
          >
            <Text code>{run.iterationBranch}</Text>
          </Link>
        ) : <Text type="secondary">—</Text>}
      </Space>
      {run.summaryMrUrl && (
        <Space>
          <Text type="secondary">汇总 MR：</Text>
          <Link href={run.summaryMrUrl} target="_blank">查看 MR</Link>
        </Space>
      )}
      {playbookDraft?.mrUrl && (
        <Space wrap>
          <Text type="secondary">Playbook MR：</Text>
          <Link href={playbookDraft.mrUrl} target="_blank">查看 MR</Link>
          {playbookDraft.committedPath && (
            <Text type="secondary" code style={{ fontSize: 12 }}>
              {playbookDraft.committedPath}
            </Text>
          )}
        </Space>
      )}
      {run.abortReason && (
        <Text type="danger">中止原因：{run.abortReason}</Text>
      )}
    </Space>
  )
}

function SandboxCard({ sandbox }: { sandbox: E2eSandboxDTO }) {
  const statusColor = SANDBOX_STATUS_COLOR[sandbox.status] ?? 'default'
  const { handle } = sandbox

  return (
    <Card type="inner" title="沙盒" size="small" style={{ marginBottom: 16 }}>
      <Descriptions column={2} size="small">
        <Descriptions.Item label="类型">{sandbox.kind}</Descriptions.Item>
        <Descriptions.Item label="状态">
          <Tag color={statusColor}>{sandbox.status}</Tag>
        </Descriptions.Item>
        <Descriptions.Item label="环境 ID">{handle.envId}</Descriptions.Item>
      </Descriptions>
      {Object.keys(handle.endpoints).length > 0 && (
        <>
          <Divider style={{ margin: '8px 0' }} />
          <Text type="secondary" style={{ fontSize: 12 }}>Endpoints</Text>
          <div style={{ marginTop: 4 }}>
            {Object.entries(handle.endpoints).map(([k, v]) => (
              <div key={k} style={{ display: 'flex', gap: 8, marginBottom: 2 }}>
                <Text code style={{ minWidth: 80 }}>{k}</Text>
                <Link href={v} target="_blank">{v}</Link>
              </div>
            ))}
          </div>
        </>
      )}
      {handle.modules && handle.modules.length > 0 && (
        <>
          <Divider style={{ margin: '8px 0' }} />
          <Text type="secondary" style={{ fontSize: 12 }}>Modules</Text>
          <div style={{ marginTop: 4 }}>
            {handle.modules.map(m => (
              <div key={m.name} style={{ display: 'flex', gap: 8, marginBottom: 2 }}>
                <Text code style={{ minWidth: 120 }}>{m.name}</Text>
                <Text>{m.host}:{m.port}</Text>
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  )
}

function groupByScenario(
  scenarioRuns: E2eScenarioRunDTO[],
): Map<string, E2eScenarioRunDTO[]> {
  const map = new Map<string, E2eScenarioRunDTO[]>()
  for (const sr of scenarioRuns) {
    const list = map.get(sr.scenarioId) ?? []
    list.push(sr)
    map.set(sr.scenarioId, list)
  }
  return map
}

function getScenarioIcon(attempts: E2eScenarioRunDTO[]): React.ReactNode {
  const last = attempts[attempts.length - 1]
  if (!last) return <ClockCircleOutlined style={{ color: '#d9d9d9' }} />
  // result 字段 NOT NULL，createScenarioRun 时占位为 'error'，要等 finishScenarioRun 才写真实结果。
  // 所以 finishedAt === null 即"还在跑"，不要用占位 result 渲染成红色。
  if (!last.finishedAt) return <SyncOutlined spin style={{ color: '#1677ff' }} />
  const cfg = SCENARIO_RESULT_CONFIG[last.result]
  if (last.result === 'pass') return <CheckCircleOutlined style={{ color: cfg.color }} />
  if (last.result === 'fail' || last.result === 'error' || last.result === 'unfixable') {
    return <CloseCircleOutlined style={{ color: cfg.color }} />
  }
  if (last.result === 'timeout') return <ClockCircleOutlined style={{ color: cfg.color }} />
  return <MinusCircleOutlined style={{ color: cfg.color }} />
}

function ScenarioTimeline({
  scenarioRuns,
  onViewEvidence,
}: {
  scenarioRuns: E2eScenarioRunDTO[]
  onViewEvidence: (sr: E2eScenarioRunDTO) => void
}) {
  const groups = groupByScenario(scenarioRuns)

  if (groups.size === 0) {
    return (
      <Card type="inner" title="场景时间线" size="small">
        <Text type="secondary">暂无场景执行记录</Text>
      </Card>
    )
  }

  const collapseItems = Array.from(groups.entries()).map(([scenarioId, attempts]) => {
    const last = attempts[attempts.length - 1]
    const scenarioName = last?.scenarioName ?? scenarioId
    const isRunning = !last?.finishedAt && attempts.length > 0
    // 运行中时不展示占位 result Tag（'error' 是 createScenarioRun 的占位值）
    const lastCfg = !isRunning && last ? SCENARIO_RESULT_CONFIG[last.result] : null

    const headerExtra = (
      <Space size={4}>
        {isRunning && <Tag color="processing"><SyncOutlined spin /> 运行中</Tag>}
        {lastCfg && <Tag color={lastCfg.color === '#52c41a' ? 'success' : lastCfg.color === '#ff4d4f' ? 'error' : 'default'}>{lastCfg.label}</Tag>}
        <Text type="secondary" style={{ fontSize: 12 }}>{attempts.length} 次尝试</Text>
      </Space>
    )

    return {
      key: scenarioId,
      label: (
        <Space>
          {getScenarioIcon(attempts)}
          <Text strong>{scenarioName}</Text>
          {headerExtra}
        </Space>
      ),
      children: (
        <List
          size="small"
          dataSource={attempts}
          renderItem={(sr) => {
            const attemptRunning = !sr.finishedAt
            const cfg = SCENARIO_RESULT_CONFIG[sr.result]
            return (
              <List.Item
                key={sr.id}
                actions={[
                  sr.evidenceManifest ? (
                    <Button
                      size="small"
                      type="link"
                      onClick={() => onViewEvidence(sr)}
                    >
                      查看证据
                    </Button>
                  ) : null,
                ].filter((x): x is React.ReactElement => x != null)}
              >
                <Space>
                  {attemptRunning ? (
                    <SyncOutlined spin style={{ color: '#1677ff' }} />
                  ) : (
                    <span style={{ color: cfg.color }}>{cfg.icon}</span>
                  )}
                  <Text>第 {sr.attemptNumber} 次</Text>
                  {attemptRunning ? (
                    <Tag color="processing">运行中</Tag>
                  ) : (
                    <Tag
                      color={
                        sr.result === 'pass' ? 'success'
                        : sr.result === 'fail' || sr.result === 'error' ? 'error'
                        : 'default'
                      }
                    >
                      {cfg.label}
                    </Tag>
                  )}
                  <Text type="secondary">{formatDuration(sr.durationMs)}</Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {new Date(sr.startedAt).toLocaleTimeString()}
                  </Text>
                </Space>
              </List.Item>
            )
          }}
        />
      ),
    }
  })

  return (
    <Card type="inner" title="场景时间线" size="small">
      <Collapse items={collapseItems} defaultActiveKey={Array.from(groups.keys())} />
    </Card>
  )
}

function isImageArtifact(a: EvidenceArtifact): boolean {
  if (a.kind === 'screenshot') return true
  if (a.mimeType?.startsWith('image/')) return true
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(a.path)
}

function isTextArtifact(a: EvidenceArtifact): boolean {
  if (a.kind === 'log' || a.kind === 'sql_result' || a.kind === 'dom_snapshot' || a.kind === 'har') return true
  if (a.mimeType?.startsWith('text/') || a.mimeType === 'application/json') return true
  return /\.(txt|log|json|xml|ya?ml|md|html?|css|js|ts|sh|csv|tsv)$/i.test(a.path)
}

function ArtifactViewer({
  artifact,
  evidenceDirUri,
}: {
  artifact: EvidenceArtifact
  evidenceDirUri: string
}) {
  const [textContent, setTextContent] = useState<string | null>(null)
  const [textLoading, setTextLoading] = useState(false)
  const [tooLarge, setTooLarge] = useState(false)
  const src = `${evidenceDirUri}/${artifact.path}`
  const isImage = isImageArtifact(artifact)
  const isText = isTextArtifact(artifact)

  useEffect(() => {
    if (!isText) return
    setTextLoading(true)
    fetch(src)
      .then(async r => {
        const ct = r.headers.get('content-length')
        if (ct && parseInt(ct, 10) > 100_000) {
          setTooLarge(true)
          return null
        }
        const text = await r.text()
        if (text.length > 100_000) { setTooLarge(true); return null }
        return text
      })
      .then(t => { if (t != null) setTextContent(t) })
      .catch(() => {})
      .finally(() => setTextLoading(false))
  }, [src, isText])

  const header = (
    <Space size={4} style={{ width: '100%' }} wrap>
      <Text code style={{ fontSize: 11 }}>{artifact.path}</Text>
      {artifact.kind && <Tag>{artifact.kind}</Tag>}
      {artifact.size_bytes != null && (
        <Text type="secondary" style={{ fontSize: 11 }}>
          {artifact.size_bytes < 1024 ? `${artifact.size_bytes}B`
            : artifact.size_bytes < 1024 * 1024 ? `${(artifact.size_bytes / 1024).toFixed(1)}KB`
            : `${(artifact.size_bytes / 1024 / 1024).toFixed(2)}MB`}
        </Text>
      )}
    </Space>
  )

  if (isImage) {
    return (
      <div style={{ marginBottom: 8 }}>
        {header}
        {artifact.description && (
          <div><Text type="secondary" style={{ fontSize: 12 }}>{artifact.description}</Text></div>
        )}
        <Image src={src} style={{ maxWidth: '100%', maxHeight: 320, marginTop: 4 }} />
      </div>
    )
  }

  if (isText) {
    return (
      <div style={{ marginBottom: 8 }}>
        {header}
        {artifact.description && (
          <div><Text type="secondary" style={{ fontSize: 12 }}>{artifact.description}</Text></div>
        )}
        {textLoading && <Spin size="small" />}
        {tooLarge && (
          <div>
            <Text type="secondary">文件过大（&gt;100KB），</Text>
            <Link href={src} target="_blank">点此下载</Link>
          </div>
        )}
        {textContent != null && (
          <pre
            style={{
              background: '#F6F7FA',
              padding: 8,
              borderRadius: 4,
              fontSize: 11,
              maxHeight: 240,
              overflow: 'auto',
              marginTop: 4,
            }}
          >{textContent}</pre>
        )}
      </div>
    )
  }

  // 未知 kind / 二进制：仅给下载链接
  return (
    <div style={{ marginBottom: 8 }}>
      {header}
      {artifact.description && (
        <div><Text type="secondary" style={{ fontSize: 12 }}>{artifact.description}</Text></div>
      )}
      <Link href={src} target="_blank">点此下载</Link>
    </div>
  )
}

function AiDiagnosisSection({ diagnosis }: { diagnosis: NonNullable<EvidenceManifest['aiDiagnosis']> }) {
  return (
    <div style={{ marginTop: 12 }}>
      <Divider style={{ margin: '8px 0' }}>AI 诊断</Divider>
      <Descriptions column={1} size="small">
        <Descriptions.Item label="判定">
          <Badge
            status={diagnosis.success ? 'success' : 'error'}
            text={diagnosis.verdict}
          />
        </Descriptions.Item>
        <Descriptions.Item label="根因摘要">
          <Paragraph style={{ margin: 0 }}>{diagnosis.rootCauseSummary}</Paragraph>
        </Descriptions.Item>
        {diagnosis.fixCommitSha && (
          <Descriptions.Item label="修复 Commit">
            <Text code>{diagnosis.fixCommitSha.slice(0, 8)}</Text>
          </Descriptions.Item>
        )}
        {diagnosis.fixedFiles.length > 0 && (
          <Descriptions.Item label="修改文件">
            <Space wrap>
              {diagnosis.fixedFiles.map(f => <Text key={f} code style={{ fontSize: 11 }}>{f}</Text>)}
            </Space>
          </Descriptions.Item>
        )}
        {!diagnosis.success && diagnosis.failureReason && (
          <Descriptions.Item label="失败原因">
            <Text type="danger">{diagnosis.failureReason}</Text>
          </Descriptions.Item>
        )}
      </Descriptions>
    </div>
  )
}

function EvidenceDrawer({
  scenarioRun,
  onClose,
}: {
  scenarioRun: E2eScenarioRunDTO | null
  onClose: () => void
}) {
  const manifest = scenarioRun?.evidenceManifest
  const evidenceDirUri = scenarioRun?.evidenceDirUri

  return (
    <Drawer
      title={
        scenarioRun
          ? `证据 — ${scenarioRun.scenarioName ?? scenarioRun.scenarioId} · 第 ${scenarioRun.attemptNumber} 次`
          : '证据'
      }
      open={!!scenarioRun}
      onClose={onClose}
      width={560}
      destroyOnClose
    >
      {manifest && (
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          {manifest.result && (
            <Space>
              <Text type="secondary" style={{ fontSize: 12 }}>Result</Text>
              <Tag color={
                manifest.result === 'pass' ? 'success'
                : manifest.result === 'fail' || manifest.result === 'error' ? 'error'
                : manifest.result === 'timeout' ? 'warning' : 'default'
              }>{manifest.result}</Tag>
              {manifest.durationMs != null && (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  · {(manifest.durationMs / 1000).toFixed(1)}s
                </Text>
              )}
            </Space>
          )}
          {manifest.errorMessage && (
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>Error</Text>
              <Paragraph style={{ marginTop: 4, color: '#cf1322', whiteSpace: 'pre-wrap' }}>
                {manifest.errorMessage}
              </Paragraph>
            </div>
          )}
          {manifest.summary && (
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>Summary</Text>
              <Paragraph style={{ marginTop: 4 }}>{manifest.summary}</Paragraph>
            </div>
          )}
          {manifest.contextHint && (
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>Context Hint</Text>
              <Paragraph style={{ marginTop: 4 }}>{manifest.contextHint}</Paragraph>
            </div>
          )}
          {manifest.acceptanceResults && manifest.acceptanceResults.length > 0 && (
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>
                Acceptance Results（{manifest.acceptanceResults.length} 项）
              </Text>
              <div style={{ marginTop: 4 }}>
                {manifest.acceptanceResults.map((ar, i) => (
                  <div key={i} style={{ marginBottom: 6 }}>
                    <Space size={4}>
                      <Tag color={
                        ar.result === 'pass' ? 'success'
                        : ar.result === 'fail' || ar.result === 'error' ? 'error'
                        : 'default'
                      }>{ar.result}</Tag>
                      <Text code style={{ fontSize: 11 }}>{ar.kind}#{ar.index}</Text>
                    </Space>
                    {ar.reason && (
                      <div><Text type="secondary" style={{ fontSize: 11 }}>{ar.reason}</Text></div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          {manifest.artifacts && manifest.artifacts.length > 0 && (
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>Artifacts（{manifest.artifacts.length} 个）</Text>
              <div style={{ marginTop: 8 }}>
                {manifest.artifacts.map((a, i) =>
                  evidenceDirUri ? (
                    <ArtifactViewer key={i} artifact={a} evidenceDirUri={evidenceDirUri} />
                  ) : (
                    <div key={i}>
                      <Text code>{a.path}</Text>
                      {a.description && <> — <Text type="secondary">{a.description}</Text></>}
                    </div>
                  )
                )}
              </div>
            </div>
          )}
          {manifest.claudeTrace && manifest.claudeTrace.length > 0 && (
            <Collapse
              size="small"
              ghost
              items={[{
                key: 'trace',
                label: <Text type="secondary" style={{ fontSize: 12 }}>Claude Trace（{manifest.claudeTrace.length} 步）</Text>,
                children: (
                  <div>
                    {manifest.claudeTrace.map((t, i) => (
                      <div key={i} style={{ marginBottom: 6, paddingBottom: 6, borderBottom: '1px solid #f0f0f0' }}>
                        <Space size={4} wrap>
                          <Tag color={
                            t.verdict === 'ok' ? 'success'
                            : t.verdict === 'warn' ? 'warning' : 'error'
                          }>{t.verdict}</Tag>
                          <Text style={{ fontSize: 11 }}>#{t.step}</Text>
                          {t.tool && <Text code style={{ fontSize: 11 }}>{t.tool}</Text>}
                        </Space>
                        <div style={{ fontSize: 12, marginTop: 2 }}>{t.intent}</div>
                        {t.args_summary && (
                          <div><Text type="secondary" style={{ fontSize: 11 }}>{t.args_summary}</Text></div>
                        )}
                        {t.note && (
                          <div><Text type="secondary" style={{ fontSize: 11, fontStyle: 'italic' }}>{t.note}</Text></div>
                        )}
                      </div>
                    ))}
                  </div>
                ),
              }]}
            />
          )}
          {manifest.aiDiagnosis && (
            <AiDiagnosisSection diagnosis={manifest.aiDiagnosis} />
          )}
        </Space>
      )}
    </Drawer>
  )
}

function ReviewDecisionPanel({
  runId,
  awaitingReview,
  scenarioRuns,
  onSubmitted,
}: {
  runId: string
  awaitingReview: AwaitingReviewInfo
  scenarioRuns: E2eScenarioRunDTO[]
  onSubmitted: () => void
}) {
  const [submitting, setSubmitting] = useState<'approve' | 'retry' | 'reject' | null>(null)
  // 找到正在等审的 scenarioRun，把失败原因摘要显示给人，让审核者有依据再点按钮
  const sr = scenarioRuns.find((s) => s.id === awaitingReview.scenarioRunId)
  const manifest = sr?.evidenceManifest
  const failedAcceptances = (manifest?.acceptanceResults ?? []).filter(
    (a) => a.result === 'fail' || a.result === 'error',
  )
  // host Claude 没写出 manifest.json 时（如超时 / 推理结束漏写）由 run-scenario.ts
  // 兜底写入此字段；此时 acceptanceResults 是空，需要单独提示让用户决策
  const runnerError = manifest?.scenarioRunnerError

  const submit = async (decision: 'approve' | 'retry' | 'reject') => {
    setSubmitting(decision)
    try {
      await e2eRunsApi.submitReviewDecision(runId, decision)
      message.success(`已提交决策：${decision}`)
      onSubmitted()
    } catch (err) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message
      message.error(`提交失败${msg ? `：${msg}` : ''}`)
    } finally {
      setSubmitting(null)
    }
  }

  return (
    <Card
      type="inner"
      size="small"
      title={
        <Space>
          <Badge status="warning" />
          <Text strong>等待人审决策</Text>
          {awaitingReview.scenarioId && <Text code style={{ fontSize: 12 }}>{awaitingReview.scenarioId}</Text>}
        </Space>
      }
      style={{ marginBottom: 16, borderColor: '#faad14' }}
    >
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          场景失败，e2e-fix agent 是否应当介入修复？
        </Text>
        {runnerError && (
          <div>
            <Tag color="error">runner 异常</Tag>
            <Text type="danger" style={{ fontSize: 12 }}>{runnerError}</Text>
            <div>
              <Text type="secondary" style={{ fontSize: 11 }}>
                Claude 没写出 manifest.json，无验收结果可参考；可以选「重跑场景」再试一次。
              </Text>
            </div>
          </div>
        )}
        {failedAcceptances.length > 0 && (
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>失败的验收：</Text>
            <div style={{ marginTop: 4 }}>
              {failedAcceptances.map((ar, i) => (
                <div key={i} style={{ marginBottom: 4 }}>
                  <Tag color="error">{ar.kind}#{ar.index}</Tag>
                  {ar.reason && (
                    <Text type="secondary" style={{ fontSize: 11 }}>{ar.reason}</Text>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
        <Space>
          <Button
            type="primary"
            loading={submitting === 'approve'}
            disabled={submitting !== null}
            onClick={() => submit('approve')}
          >
            批准修复
          </Button>
          <Button
            loading={submitting === 'retry'}
            disabled={submitting !== null}
            onClick={() => submit('retry')}
          >
            重跑场景
          </Button>
          <Popconfirm
            title="拒绝后此场景将被标记为不可修复，整个 Run 终止"
            onConfirm={() => submit('reject')}
            okText="确认拒绝"
            cancelText="取消"
            okButtonProps={{ danger: true }}
          >
            <Button danger loading={submitting === 'reject'} disabled={submitting !== null}>
              拒绝
            </Button>
          </Popconfirm>
        </Space>
      </Space>
    </Card>
  )
}

interface LiveTracePanelProps {
  runId: string
  active: boolean
}

const STATUS_TAG_CONFIG: Record<ScenarioEventStatus, { color: string; label: string }> = {
  connecting: { color: 'default',    label: '连接中…' },
  live:       { color: 'processing', label: '直播中' },
  closed:     { color: 'default',    label: '已结束' },
  error:      { color: 'error',      label: '连接错误' },
}

function truncateText(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + '…'
}

interface ScenarioGroup {
  key: string                       // scenarioRunId（孤儿事件用 '__orphan__'）
  scenarioId: string
  attemptNumber: number
  events: ScenarioEvent[]
  status: 'running' | 'pass' | 'fail' | 'error'
  startedAt: number
  finishedAt: number | null
}

function groupEventsByScenario(events: ScenarioEvent[]): ScenarioGroup[] {
  const groups: ScenarioGroup[] = []
  let current: ScenarioGroup | null = null

  for (const ev of events) {
    if (ev.type === 'scenario_start') {
      current = {
        key: String(ev.scenarioRunId ?? `start-${ev.ts}`),
        scenarioId: String(ev.scenarioId ?? ''),
        attemptNumber: Number(ev.attemptNumber ?? 0),
        events: [ev],
        status: 'running',
        startedAt: Number(ev.ts ?? 0),
        finishedAt: null,
      }
      groups.push(current)
    } else if (ev.type === 'scenario_end' && current) {
      current.events.push(ev)
      const r = String(ev.result ?? '')
      current.status = r === 'pass' ? 'pass' : r === 'fail' ? 'fail' : 'error'
      current.finishedAt = Number(ev.ts ?? 0)
      current = null
    } else if (ev.type === 'closed') {
      // run 级别，不进 group
    } else if (current) {
      current.events.push(ev)
    } else {
      // 孤儿事件（reconnect 时 scenario_start 已被 ring buffer 截断）
      let orphan = groups.find(g => g.key === '__orphan__')
      if (!orphan) {
        orphan = {
          key: '__orphan__',
          scenarioId: '（场景上下文未知）',
          attemptNumber: 0,
          events: [],
          status: 'running',
          startedAt: Number(ev.ts ?? 0),
          finishedAt: null,
        }
        groups.unshift(orphan)
      }
      orphan.events.push(ev)
      current = orphan
    }
  }

  return groups
}

const SCENARIO_GROUP_STATUS_CFG: Record<ScenarioGroup['status'], { icon: React.ReactNode; tagColor: string; label: string }> = {
  running: { icon: <SyncOutlined spin style={{ color: '#1677ff' }} />,        tagColor: 'processing', label: '进行中' },
  pass:    { icon: <CheckCircleOutlined style={{ color: '#52c41a' }} />,      tagColor: 'success',    label: '通过' },
  fail:    { icon: <CloseCircleOutlined style={{ color: '#ff4d4f' }} />,      tagColor: 'error',      label: '失败' },
  error:   { icon: <CloseCircleOutlined style={{ color: '#ff4d4f' }} />,      tagColor: 'error',      label: '错误' },
}

function formatDurationMs(ms: number): string {
  if (ms < 0) return '—'
  if (ms < 1000) return `${ms}ms`
  const sec = ms / 1000
  if (sec < 60) return `${sec.toFixed(1)}s`
  const min = Math.floor(sec / 60)
  const remainSec = Math.round(sec - min * 60)
  return `${min}m${remainSec}s`
}

function ScenarioGroupHeader({ group }: { group: ScenarioGroup }) {
  const cfg = SCENARIO_GROUP_STATUS_CFG[group.status]
  const elapsed = group.finishedAt != null
    ? group.finishedAt - group.startedAt
    : Date.now() - group.startedAt
  const durationLabel = group.finishedAt != null
    ? formatDurationMs(elapsed)
    : `已 ${formatDurationMs(elapsed)}`
  // 事件计数：排除 scenario_start / scenario_end 这两个边界事件本身
  const meaningfulCount = group.events.filter(e =>
    e.type !== 'scenario_start' && e.type !== 'scenario_end',
  ).length
  return (
    <Space size={6} wrap>
      {cfg.icon}
      <Text code style={{ fontSize: 12 }}>{group.scenarioId || '(unknown)'}</Text>
      {group.attemptNumber > 0 && (
        <Text type="secondary" style={{ fontSize: 12 }}>#{group.attemptNumber}</Text>
      )}
      <Tag color={cfg.tagColor}>{cfg.label}</Tag>
      <Text type="secondary" style={{ fontSize: 12 }}>{meaningfulCount} 事件</Text>
      <Text type="secondary" style={{ fontSize: 12 }}>· {durationLabel}</Text>
    </Space>
  )
}

function ScenarioGroupBody({ events }: { events: ScenarioEvent[] }) {
  if (events.length === 0) {
    return <Text type="secondary" style={{ fontSize: 12 }}>暂无事件</Text>
  }
  return (
    <div style={{ maxHeight: 320, overflowY: 'auto' }}>
      <List
        size="small"
        dataSource={events}
        renderItem={(ev, idx) => {
          const key = `${ev.ts ?? idx}-${idx}`
          if (ev.type === 'scenario_start') {
            return (
              <List.Item key={key} style={{ padding: '4px 0' }}>
                <Text type="secondary" style={{ fontSize: 12 }}>── 场景开始 ──</Text>
              </List.Item>
            )
          }
          if (ev.type === 'scenario_end') {
            return (
              <List.Item key={key} style={{ padding: '4px 0' }}>
                <Divider style={{ margin: 0 }} orientation="left" plain>
                  <Text style={{ fontSize: 12 }}>
                    场景结束 (result={String(ev.result ?? '')})
                  </Text>
                </Divider>
              </List.Item>
            )
          }
          if (ev.type === 'fix_start') {
            return (
              <List.Item key={key} style={{ padding: '4px 0' }}>
                <Divider style={{ margin: 0, borderColor: '#fa8c16' }} orientation="left" plain>
                  <Text strong style={{ color: '#fa8c16', fontSize: 12 }}>修复阶段开始</Text>
                </Divider>
              </List.Item>
            )
          }
          if (ev.type === 'fix_end') {
            const success = Boolean(ev.success)
            return (
              <List.Item key={key} style={{ padding: '4px 0' }}>
                <Divider style={{ margin: 0, borderColor: '#fa8c16' }} orientation="left" plain>
                  <Text style={{ color: '#fa8c16', fontSize: 12 }}>
                    修复阶段结束 (success={String(success)}, verdict={String(ev.verdict ?? '')})
                  </Text>
                </Divider>
              </List.Item>
            )
          }
          if (ev.type === 'tool_use') {
            const phase = ev.phase === 'fix' ? 'fix' : 'scenario'
            return (
              <List.Item key={key} style={{ padding: '4px 0' }}>
                <Space size={4} wrap>
                  <Tag color={phase === 'fix' ? 'orange' : 'blue'}>
                    step #{Number(ev.step ?? 0)}
                  </Tag>
                  <Text code style={{ fontSize: 12 }}>{String(ev.toolName ?? '')}</Text>
                  {ev.argsSummary != null && (
                    <>
                      <Text type="secondary" style={{ fontSize: 12 }}>·</Text>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {String(ev.argsSummary)}
                      </Text>
                    </>
                  )}
                </Space>
              </List.Item>
            )
          }
          if (ev.type === 'assistant_text') {
            const text = truncateText(String(ev.text ?? ''), 200)
            return (
              <List.Item key={key} style={{ padding: '4px 0' }}>
                <Text type="secondary" italic style={{ fontSize: 12 }}>
                  "{text}"
                </Text>
              </List.Item>
            )
          }
          if (ev.type === 'agent_error') {
            return (
              <List.Item key={key} style={{ padding: '4px 0' }}>
                <Space size={4} wrap>
                  <Tag color="red">agent error</Tag>
                  <Text type="danger" style={{ fontSize: 12 }}>
                    {String(ev.message ?? '')}
                  </Text>
                </Space>
              </List.Item>
            )
          }
          return null
        }}
      />
    </div>
  )
}

function LiveTracePanel({ runId, active }: LiveTracePanelProps) {
  const { events, status } = useScenarioEvents(runId, active)
  const summary = useMemo(() => summarizeEvents(events), [events])
  const groups = useMemo(() => groupEventsByScenario(events), [events])

  // 内层 Collapse 默认展开：最后一个仍 running（无 finishedAt）的 scenario
  const defaultInnerActiveKey = useMemo(() => {
    const running = [...groups].reverse().find(g => g.finishedAt === null)
    return running ? [running.key] : []
  }, [groups])

  const statusCfg = STATUS_TAG_CONFIG[status]
  const phaseLabel =
    summary.phase === 'scenario' ? '场景执行'
    : summary.phase === 'fix' ? '修复阶段'
    : '空闲'

  // 外层 Collapse 默认折叠（不传 defaultActiveKey）
  return (
    <Collapse
      size="small"
      style={{ marginBottom: 16 }}
      items={[{
        key: 'live-trace',
        label: <Text strong>实时进度</Text>,
        extra: <Tag color={statusCfg.color}>{statusCfg.label}</Tag>,
        children: (
          <>
            <Space wrap size={12} style={{ marginBottom: 12 }}>
              <Space size={4}>
                <Text type="secondary" style={{ fontSize: 12 }}>当前阶段</Text>
                <Tag color={summary.phase === 'fix' ? 'orange' : summary.phase === 'scenario' ? 'blue' : 'default'}>
                  {phaseLabel}
                </Tag>
              </Space>
              {summary.scenarioId && (
                <Space size={4}>
                  <Text type="secondary" style={{ fontSize: 12 }}>场景</Text>
                  <Text code style={{ fontSize: 12 }}>{summary.scenarioId}</Text>
                  {summary.attempt > 0 && (
                    <Text type="secondary" style={{ fontSize: 12 }}>#{summary.attempt}</Text>
                  )}
                </Space>
              )}
              {summary.step > 0 && (
                <Space size={4}>
                  <Text type="secondary" style={{ fontSize: 12 }}>当前步数</Text>
                  <Text strong>{summary.step}</Text>
                </Space>
              )}
            </Space>
            {groups.length === 0 ? (
              <Text type="secondary" style={{ fontSize: 12 }}>
                {status === 'connecting' ? '等待事件…' : '暂无事件'}
              </Text>
            ) : (
              <Collapse
                size="small"
                ghost
                defaultActiveKey={defaultInnerActiveKey}
                items={groups.map(g => ({
                  key: g.key,
                  label: <ScenarioGroupHeader group={g} />,
                  children: <ScenarioGroupBody events={g.events} />,
                }))}
              />
            )}
          </>
        ),
      }]}
    />
  )
}

function summarizeEvents(events: ScenarioEvent[]): {
  phase: 'scenario' | 'fix' | 'idle'
  scenarioId: string
  attempt: number
  step: number
} {
  let phase: 'scenario' | 'fix' | 'idle' = 'idle'
  let scenarioId = ''
  let attempt = 0
  let step = 0

  // 反向扫描决定当前 phase：最近的 fix_start / fix_end / scenario_start / scenario_end
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev.type === 'fix_end') { phase = 'scenario'; break }
    if (ev.type === 'fix_start') { phase = 'fix'; break }
    if (ev.type === 'scenario_end') { phase = 'idle'; break }
    if (ev.type === 'scenario_start') { phase = 'scenario'; break }
  }

  // 找最近的 scenario_start 决定 scenarioId / attempt
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev.type === 'scenario_start') {
      scenarioId = String(ev.scenarioId ?? '')
      attempt = Number(ev.attemptNumber ?? 0)
      break
    }
  }

  // 找最近的 tool_use（同 phase）决定 step
  if (phase === 'scenario' || phase === 'fix') {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]
      if (ev.type === 'tool_use' && ev.phase === phase) {
        step = Number(ev.step ?? 0)
        break
      }
    }
  }

  return { phase, scenarioId, attempt, step }
}

export default function E2eRunDetailPage() {
  const { runId } = useParams<{ runId: string }>()
  const navigate = useNavigate()
  const [run, setRun] = useState<E2eRunDTO | null>(null)
  const [sandbox, setSandbox] = useState<E2eSandboxDTO | null>(null)
  const [scenarioRuns, setScenarioRuns] = useState<E2eScenarioRunDTO[]>([])
  const [playbookDraft, setPlaybookDraft] = useState<PlaybookDraftSummary | null>(null)
  const [awaitingReview, setAwaitingReview] = useState<AwaitingReviewInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [aborting, setAborting] = useState(false)
  const [evidenceSr, setEvidenceSr] = useState<E2eScenarioRunDTO | null>(null)

  const fetchDetail = useCallback(async () => {
    if (!runId) return
    try {
      const { run: r, sandbox: sb, scenarioRuns: srs, playbookDraft: pd, awaitingReview: ar } = await e2eRunsApi.get(runId)
      setRun(r)
      setSandbox(sb)
      setScenarioRuns(srs)
      setPlaybookDraft(pd)
      setAwaitingReview(ar)
    } catch {
      message.error('加载失败')
    } finally {
      setLoading(false)
    }
  }, [runId])

  useEffect(() => { fetchDetail() }, [fetchDetail])

  useEffect(() => {
    if (!run || !ACTIVE_STATUSES.has(run.status)) return
    const timer = setInterval(fetchDetail, 5000)
    return () => clearInterval(timer)
  }, [run?.status, fetchDetail])

  const handleAbort = async () => {
    if (!runId) return
    setAborting(true)
    try {
      await e2eRunsApi.abort(runId)
      message.success('已发送中止指令')
      await fetchDetail()
    } catch {
      message.error('中止失败')
    } finally {
      setAborting(false)
    }
  }

  if (loading) return <Spin style={{ display: 'block', margin: '64px auto' }} />
  if (!run) return <Text type="danger" style={{ padding: 24, display: 'block' }}>Run 不存在</Text>

  const statusCfg = RUN_STATUS_CONFIG[run.status] ?? { color: 'default', label: run.status }

  return (
    <Card
      title={
        <Space>
          <Button
            type="text"
            icon={<ArrowLeftOutlined />}
            onClick={() => navigate('/e2e-runs')}
            style={{ padding: '0 4px' }}
          >
            返回列表
          </Button>
          <Divider type="vertical" />
          <Title level={5} style={{ margin: 0 }}>
            Run #{run.id} · {run.targetProjectId}
          </Title>
          <Tag color={statusCfg.color}>{statusCfg.label}</Tag>
        </Space>
      }
      extra={
        <Space>
          <Button icon={<ReloadOutlined />} size="small" onClick={fetchDetail}>刷新</Button>
          {ACTIVE_STATUSES.has(run.status) && (
            <Popconfirm
              title="确认中止此 Run？"
              onConfirm={handleAbort}
              okText="中止"
              cancelText="取消"
              okButtonProps={{ danger: true }}
            >
              <Button size="small" danger icon={<StopOutlined />} loading={aborting}>
                中止
              </Button>
            </Popconfirm>
          )}
        </Space>
      }
    >
      <div style={{ marginBottom: 16 }}>
        <RunSummary run={run} playbookDraft={playbookDraft} />
      </div>
      {awaitingReview && runId && (
        <ReviewDecisionPanel
          runId={runId}
          awaitingReview={awaitingReview}
          scenarioRuns={scenarioRuns}
          onSubmitted={fetchDetail}
        />
      )}
      {sandbox && <SandboxCard sandbox={sandbox} />}
      <ScenarioTimeline
        scenarioRuns={scenarioRuns}
        onViewEvidence={setEvidenceSr}
      />
      {runId && <LiveTracePanel runId={runId} active={ACTIVE_STATUSES.has(run?.status ?? 'pending')} />}
      <EvidenceDrawer
        scenarioRun={evidenceSr}
        onClose={() => setEvidenceSr(null)}
      />
    </Card>
  )
}
