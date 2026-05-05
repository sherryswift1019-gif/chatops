// web/src/pages/E2eRunDetailPage.tsx
import { useState, useEffect, useCallback } from 'react'
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
} from '../api/e2e-runs'

const { Title, Text, Link, Paragraph } = Typography

const RUN_STATUS_CONFIG: Record<E2eRunDTO['status'], { color: string; label: string }> = {
  pending:       { color: 'default',    label: '等待中' },
  running:       { color: 'processing', label: '运行中' },
  awaiting_fix:  { color: 'warning',    label: '等待修复' },
  passed:        { color: 'success',    label: '通过' },
  failed:        { color: 'error',      label: '失败' },
  aborted:       { color: 'default',    label: '已中止' },
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

const ACTIVE_STATUSES = new Set<E2eRunDTO['status']>(['running', 'awaiting_fix', 'pending'])

function RunSummary({ run }: { run: E2eRunDTO }) {
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
    const lastCfg = last ? SCENARIO_RESULT_CONFIG[last.result] : null
    const scenarioName = last?.scenarioName ?? scenarioId
    const isRunning = !last?.finishedAt && attempts.length > 0

    const headerExtra = (
      <Space size={4}>
        {isRunning && <SyncOutlined spin style={{ color: '#4B8BFF' }} />}
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
                  <span style={{ color: cfg.color }}>{cfg.icon}</span>
                  <Text>第 {sr.attemptNumber} 次</Text>
                  <Tag
                    color={
                      sr.result === 'pass' ? 'success'
                      : sr.result === 'fail' || sr.result === 'error' ? 'error'
                      : 'default'
                    }
                  >
                    {cfg.label}
                  </Tag>
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
  const src = `/admin${evidenceDirUri}/artifacts/${artifact.path}`

  useEffect(() => {
    if (!artifact.mimeType.startsWith('text/') && artifact.mimeType !== 'application/json') return
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
  }, [src, artifact.mimeType])

  if (artifact.mimeType.startsWith('image/')) {
    return (
      <div style={{ marginBottom: 8 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>{artifact.description}</Text>
        <br />
        <Image src={src} style={{ maxWidth: '100%', maxHeight: 320 }} />
      </div>
    )
  }

  if (artifact.mimeType.startsWith('text/') || artifact.mimeType === 'application/json') {
    return (
      <div style={{ marginBottom: 8 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>{artifact.description}</Text>
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
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}
          >
            {textContent}
          </pre>
        )}
      </div>
    )
  }

  return (
    <div style={{ marginBottom: 8 }}>
      <Link href={src} target="_blank">{artifact.description || artifact.path}</Link>
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
          {manifest.artifacts.length > 0 && (
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>Artifacts（{manifest.artifacts.length} 个）</Text>
              <div style={{ marginTop: 8 }}>
                {manifest.artifacts.map((a, i) =>
                  evidenceDirUri ? (
                    <ArtifactViewer key={i} artifact={a} evidenceDirUri={evidenceDirUri} />
                  ) : (
                    <div key={i}>
                      <Text code>{a.path}</Text> — <Text type="secondary">{a.description}</Text>
                    </div>
                  )
                )}
              </div>
            </div>
          )}
          {manifest.aiDiagnosis && (
            <AiDiagnosisSection diagnosis={manifest.aiDiagnosis} />
          )}
        </Space>
      )}
    </Drawer>
  )
}

export default function E2eRunDetailPage() {
  const { runId } = useParams<{ runId: string }>()
  const navigate = useNavigate()
  const [run, setRun] = useState<E2eRunDTO | null>(null)
  const [sandbox, setSandbox] = useState<E2eSandboxDTO | null>(null)
  const [scenarioRuns, setScenarioRuns] = useState<E2eScenarioRunDTO[]>([])
  const [loading, setLoading] = useState(true)
  const [aborting, setAborting] = useState(false)
  const [evidenceSr, setEvidenceSr] = useState<E2eScenarioRunDTO | null>(null)

  const fetchDetail = useCallback(async () => {
    if (!runId) return
    try {
      const { run: r, sandbox: sb, scenarioRuns: srs } = await e2eRunsApi.get(runId)
      setRun(r)
      setSandbox(sb)
      setScenarioRuns(srs)
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
        <RunSummary run={run} />
      </div>
      {sandbox && <SandboxCard sandbox={sandbox} />}
      <ScenarioTimeline
        scenarioRuns={scenarioRuns}
        onViewEvidence={setEvidenceSr}
      />
      <EvidenceDrawer
        scenarioRun={evidenceSr}
        onClose={() => setEvidenceSr(null)}
      />
    </Card>
  )
}
