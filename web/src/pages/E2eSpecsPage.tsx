// web/src/pages/E2eSpecsPage.tsx
import { useState, useEffect, useCallback } from 'react'
import { Table, Tag, Button, Space, message, Typography, Tooltip, Badge } from 'antd'
import { ReloadOutlined, ThunderboltOutlined, StopOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import { e2eApi, type E2eSpec, type GenerationStatus } from '../api/e2e'

const { Text, Link } = Typography

const STATUS_CONFIG: Record<GenerationStatus, { color: string; label: string }> = {
  pending:                 { color: 'default',    label: '待生成' },
  generating:              { color: 'processing', label: '生成中' },
  pr_open:                 { color: 'blue',       label: 'PR 已创建' },
  committed:               { color: 'success',    label: '已合入' },
  baseline_failed:         { color: 'error',      label: 'Baseline 失败' },
  blocked_on_baseline_bug: { color: 'warning',    label: '产品 Bug 阻塞' },
  skipped:                 { color: 'default',    label: '已跳过' },
}

export default function E2eSpecsPage() {
  const [specs, setSpecs] = useState<E2eSpec[]>([])
  const [loading, setLoading] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [generating, setGenerating] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await e2eApi.listSpecs('chatops')
      setSpecs(data)
    } catch {
      message.error('加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const syncAndLoad = async () => {
    setSyncing(true)
    try {
      const { synced, specs: updated } = await e2eApi.syncSpecs('chatops')
      setSpecs(updated)
      if (synced > 0) {
        message.success(`已同步 ${synced} 条新规约`)
      } else {
        message.info('规约已是最新，无新增文件')
      }
    } catch {
      message.error('同步失败，请检查 GitLab 配置')
    } finally {
      setSyncing(false)
    }
  }

  useEffect(() => {
    const hasGenerating = specs.some(s => s.generationStatus === 'generating')
    if (!hasGenerating) return
    const timer = setInterval(load, 5000)
    return () => clearInterval(timer)
  }, [specs, load])

  const handleGenerate = async (spec: E2eSpec) => {
    setGenerating(prev => new Set(prev).add(spec.id))
    try {
      await e2eApi.generateSpec(spec.id)
      message.success(`已触发生成：${spec.title}`)
      await load()
    } catch {
      message.error('触发失败')
    } finally {
      setGenerating(prev => { const s = new Set(prev); s.delete(spec.id); return s })
    }
  }

  const handleSkip = async (spec: E2eSpec) => {
    try {
      await e2eApi.skipSpec(spec.id)
      await load()
    } catch {
      message.error('操作失败')
    }
  }

  const columns: ColumnsType<E2eSpec> = [
    {
      title: '规约路径',
      dataIndex: 'specPath',
      render: (path: string) => <Text code>{path}</Text>,
    },
    { title: '标题', dataIndex: 'title' },
    {
      title: '状态',
      dataIndex: 'generationStatus',
      render: (status: GenerationStatus) => {
        const cfg = STATUS_CONFIG[status]
        return (
          <Badge
            status={status === 'generating' ? 'processing' : undefined}
            text={<Tag color={cfg.color}>{cfg.label}</Tag>}
          />
        )
      },
    },
    {
      title: '生成的脚本',
      dataIndex: 'generatedArtifactPath',
      render: (path: string | null) => path ? <Text code>{path}</Text> : <Text type="secondary">—</Text>,
    },
    {
      title: 'PR',
      dataIndex: 'generatedPrUrl',
      render: (url: string | null) => url ? <Link href={url} target="_blank">查看 PR</Link> : <Text type="secondary">—</Text>,
    },
    {
      title: '上次生成',
      dataIndex: 'lastGeneratedAt',
      render: (d: string | null) => d ? new Date(d).toLocaleString() : '—',
    },
    {
      title: '操作',
      render: (_: unknown, spec: E2eSpec) => {
        const isGenerating = spec.generationStatus === 'generating' || generating.has(spec.id)
        const canGenerate = ['pending', 'baseline_failed', 'blocked_on_baseline_bug', 'committed'].includes(spec.generationStatus)
        return (
          <Space>
            {canGenerate && (
              <Button
                size="small"
                type="primary"
                icon={<ThunderboltOutlined />}
                loading={isGenerating}
                onClick={() => handleGenerate(spec)}
              >
                {spec.generationStatus === 'pending' ? '生成' : '重生成'}
              </Button>
            )}
            {spec.generationStatus !== 'skipped' && (
              <Tooltip title="跳过 Stage 1（项目已有脚本）">
                <Button size="small" icon={<StopOutlined />} onClick={() => handleSkip(spec)}>
                  跳过
                </Button>
              </Tooltip>
            )}
          </Space>
        )
      },
    },
  ]

  return (
    <div style={{ padding: 24 }}>
      <Space style={{ marginBottom: 16, width: '100%', justifyContent: 'space-between' }}>
        <Typography.Title level={4} style={{ margin: 0 }}>测试规约管理</Typography.Title>
        <Button icon={<ReloadOutlined />} onClick={syncAndLoad} loading={syncing || loading}>同步规约</Button>
      </Space>
      <Table
        rowKey="id"
        columns={columns}
        dataSource={specs}
        loading={loading}
        pagination={{ pageSize: 20 }}
        locale={{ emptyText: '暂无测试规约。在仓库 docs/test-specs/ 目录下创建 markdown spec 文件后，通过 API 或 IM 触发注册。' }}
      />
    </div>
  )
}
