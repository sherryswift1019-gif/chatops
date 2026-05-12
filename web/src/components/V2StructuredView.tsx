import React from 'react'
import { Collapse, Tag, Space, Typography } from 'antd'
import { CheckOutlined } from '@ant-design/icons'
import type { V2StageResult } from '../api/requirements'

const { Text } = Typography

const RISK_COLOR: Record<'low' | 'medium' | 'high', string> = {
  low: 'green', medium: 'gold', high: 'red',
}

/**
 * 展示某 stage 的 v2 结构化输出。根据可用字段渲染不同区块。
 * - spec stage：AC 列表 / 澄清问题 / 风险 / openQuestions / reviewHints / noGos / acDiff
 * - dev / reviewer stage：commits 列表 / specCoverage 矩阵 / scopeViolations / fileRisks
 * - 共用：standardsConsulted / selfCheck
 */
export function V2StructuredView({ stage }: { stage: V2StageResult | undefined }) {
  if (!stage || !stage.skillOutput) return null
  const so = stage.skillOutput

  const items: Array<{ key: string; label: React.ReactNode; children: React.ReactNode }> = []

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

  return <Collapse size="small" style={{ marginBottom: 16 }} items={items} />
}
