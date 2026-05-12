import { useMemo } from 'react'
import { Alert, Card, Collapse, List, Space, Tag, Typography } from 'antd'
import {
  CheckCircleTwoTone,
  CloseCircleTwoTone,
  WarningTwoTone,
  ToolOutlined,
} from '@ant-design/icons'
import type { V2StageResult } from '../api/requirements'

const { Text, Paragraph } = Typography

/**
 * QI E2E 进度展示组件
 *
 * 设计：docs/prds/prd-quick-impl-e2e-phase2.md - "总耗时透明度"
 *
 * 找到 stage_results 里所有 stageType='qi_e2e_runner' 的记录（每次重试一条），
 * 展示：
 *   - attempt 计数（Round N/3）
 *   - result（pass / fail / sandbox_failed）
 *   - scenariosRun / passed / failed / durationMs
 *   - failureReport: 失败 scenario 列表 + claudeTraceTail（Collapse 展开）
 *   - sandboxError（仅 sandbox_failed 时）
 *
 * 数据从 RequirementDetailDTO.stageResults 中筛 qi_e2e_runner 节点。
 * Phase 2 节点 result 字段 + failureReport 字段从 skillOutput 或顶层 output 取。
 */
export interface QiE2eRunnerOutput {
  result?: 'pass' | 'fail' | 'sandbox_failed' | 'skipped'
  attempt?: number
  scenariosRun?: number
  passed?: number
  failed?: number
  durationMs?: number
  skipped?: boolean
  skipReason?: string
  sandboxError?: string | null
  failureReport?: {
    total: number
    passed: number
    failed: number
    scenarios: Array<{
      id: string
      name: string
      result: 'fail' | 'error' | 'timeout' | 'no-manifest'
      failureReason: string
      failedAcceptances: Array<{
        kind: string
        index: number
        result: 'fail' | 'error'
        expected: unknown
        actual: unknown
        reason: string
      }>
      claudeTraceTail: string
      artifactsDir: string | null
    }>
  } | null
}

interface QiE2eProgressProps {
  stageResults: V2StageResult[] | null
}

interface E2eAttemptInfo {
  attemptIndex: number  // 在 stageResults 中第几次出现 qi_e2e_runner
  stageStatus: V2StageResult['status']
  startedAt?: string
  durationMs?: number
  output: QiE2eRunnerOutput
}

function extractQiE2eAttempts(stageResults: V2StageResult[] | null): E2eAttemptInfo[] {
  if (!stageResults) return []

  const attempts: E2eAttemptInfo[] = []
  let i = 0
  for (const sr of stageResults) {
    if (sr.type !== 'qi_e2e_runner') continue
    // skipE2E=true 时 e2e_skip_router 路由直接到 final_approval，qi_e2e_runner 节点 skipped。
    // 不展示「共 0 次执行」式的空 attempt。
    if (sr.status === 'skipped') continue
    // output 字段在 V2StageResult 里是 string；qi_e2e_runner 的实际 output 对象
    // 应该塞到 skillOutput 或一个新的扩展字段。这里 try parse output JSON 兜底
    let parsed: QiE2eRunnerOutput = {}
    if (sr.output) {
      try {
        parsed = JSON.parse(sr.output) as QiE2eRunnerOutput
      } catch {
        // output 不是 JSON 就忽略
      }
    }
    attempts.push({
      attemptIndex: ++i,
      stageStatus: sr.status,
      startedAt: sr.startedAt,
      durationMs: sr.durationMs,
      output: parsed,
    })
  }
  return attempts
}

function ResultTag({ result }: { result?: QiE2eRunnerOutput['result'] }) {
  if (result === 'pass') return <Tag color="green" icon={<CheckCircleTwoTone twoToneColor="#52c41a" />}>全部通过</Tag>
  if (result === 'skipped') return <Tag color="default">已跳过</Tag>
  if (result === 'fail') return <Tag color="red" icon={<CloseCircleTwoTone twoToneColor="#ff4d4f" />}>scenario 失败</Tag>
  if (result === 'sandbox_failed') return <Tag color="orange" icon={<WarningTwoTone twoToneColor="#faad14" />}>sandbox 启动失败</Tag>
  return <Tag>未知</Tag>
}

function formatDuration(ms?: number): string {
  if (!ms) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}min ${Math.floor((ms % 60_000) / 1000)}s`
}

export function QiE2eProgress({ stageResults }: QiE2eProgressProps) {
  const attempts = useMemo(() => extractQiE2eAttempts(stageResults), [stageResults])

  if (attempts.length === 0) {
    return null
  }

  return (
    <div>
      <Text strong style={{ display: 'block', marginBottom: 8 }}>
        <ToolOutlined /> E2E 测试进度（共 {attempts.length} 次执行）
      </Text>
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        {attempts.map((a) => (
          <AttemptCard key={a.attemptIndex} attempt={a} />
        ))}
      </Space>
    </div>
  )
}

function AttemptCard({ attempt }: { attempt: E2eAttemptInfo }) {
  const o = attempt.output
  const isFinal = attempt.stageStatus === 'success' || attempt.stageStatus === 'failed'
  const isSandboxFailed = o.result === 'sandbox_failed'

  return (
    <Card
      size="small"
      title={
        <Space>
          <Text strong>Round {o.attempt ?? attempt.attemptIndex}</Text>
          <ResultTag result={o.result} />
          {!isFinal && <Tag color="processing">进行中</Tag>}
        </Space>
      }
      extra={
        <Space size={12}>
          {o.scenariosRun !== undefined && (
            <Text type="secondary">
              {o.passed}/{o.scenariosRun} 通过
            </Text>
          )}
          <Text type="secondary">{formatDuration(o.durationMs ?? attempt.durationMs)}</Text>
        </Space>
      }
    >
      {isSandboxFailed && o.sandboxError && (
        <Alert
          type="warning"
          message="Sandbox 启动失败"
          description={o.sandboxError}
          showIcon
          style={{ marginBottom: 12 }}
        />
      )}

      {o.failureReport && o.failureReport.scenarios.length > 0 && (
        <Collapse
          size="small"
          items={[{
            key: 'fail-detail',
            label: <Text type="danger">{o.failureReport.failed} 个 scenario 失败 — 点击展开诊断</Text>,
            children: <FailureScenarioList scenarios={o.failureReport.scenarios} />,
          }]}
        />
      )}

      {o.result === 'pass' && (
        <Text type="success">
          <CheckCircleTwoTone twoToneColor="#52c41a" /> 全部 {o.scenariosRun} 个 scenario 通过
        </Text>
      )}

      {o.result === 'skipped' && (
        <Text type="secondary">
          ⚪ 跳过 E2E{o.skipReason ? `：${o.skipReason}` : ''}（需人工验证功能正确性）
        </Text>
      )}
    </Card>
  )
}

function FailureScenarioList({
  scenarios,
}: {
  scenarios: NonNullable<QiE2eRunnerOutput['failureReport']>['scenarios']
}) {
  return (
    <List
      size="small"
      dataSource={scenarios}
      renderItem={(s) => (
        <List.Item key={s.id}>
          <Space direction="vertical" style={{ width: '100%' }} size={4}>
            <Space>
              <Text strong>{s.name}</Text>
              <Text type="secondary" style={{ fontSize: 12 }}>({s.id})</Text>
              <Tag color={s.result === 'timeout' ? 'orange' : 'red'}>{s.result}</Tag>
            </Space>
            <Paragraph type="danger" style={{ margin: 0, fontSize: 12 }}>
              {s.failureReason}
            </Paragraph>
            {s.failedAcceptances.length > 0 && (
              <div style={{ fontSize: 12 }}>
                <Text type="secondary">失败断言：</Text>
                <ul style={{ margin: '4px 0', paddingLeft: 18 }}>
                  {s.failedAcceptances.map((a, i) => (
                    <li key={i}>
                      <Text code>{a.kind}#{a.index}</Text> — {a.reason || `expected=${JSON.stringify(a.expected)} actual=${JSON.stringify(a.actual)}`}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {s.claudeTraceTail && (
              <Collapse
                size="small"
                ghost
                items={[{
                  key: 'trace',
                  label: <Text type="secondary" style={{ fontSize: 12 }}>Claude trace 末尾（点击展开）</Text>,
                  children: (
                    <pre
                      style={{
                        background: '#F6F7FA',
                        padding: '8px 12px',
                        borderRadius: 4,
                        fontSize: 11,
                        maxHeight: 240,
                        overflow: 'auto',
                        margin: 0,
                      }}
                    >
                      {s.claudeTraceTail}
                    </pre>
                  ),
                }]}
              />
            )}
            {s.artifactsDir && (
              <Text type="secondary" style={{ fontSize: 11 }}>
                Artifacts: <Text code copyable>{s.artifactsDir}</Text>
              </Text>
            )}
          </Space>
        </List.Item>
      )}
    />
  )
}
