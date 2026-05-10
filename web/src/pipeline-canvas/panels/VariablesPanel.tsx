import { useState } from 'react'
import { Collapse, Tag, Typography, Input, Button, Space, message as antMessage } from 'antd'
import { EditOutlined, SaveOutlined, CheckOutlined } from '@ant-design/icons'
import type { TestPipeline } from '../../types'
import { updateTestPipeline } from '../../api/test-pipelines'

interface Props {
  pipeline: TestPipeline | null
  variableCatalog: { key: string; description: string; category: string }[]
  onVariablesUpdated?: (variables: Record<string, string>) => void
}

export function VariablesPanel({ pipeline, variableCatalog, onVariablesUpdated }: Props) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  if (!pipeline) return null

  function copy(s: string) {
    navigator.clipboard.writeText(s).then(() => antMessage.success(`已复制 ${s}`))
  }

  function startEdit() {
    setDraft({ ...(pipeline!.variables ?? {}) })
    setEditing(true)
  }

  async function saveVariables() {
    if (!pipeline) return
    setSaving(true)
    try {
      await updateTestPipeline(pipeline.id, { variables: draft })
      onVariablesUpdated?.(draft)
      setEditing(false)
      antMessage.success('变量已保存')
    } catch (err: any) {
      antMessage.error(`保存失败：${err?.response?.data?.error ?? err.message}`)
    } finally {
      setSaving(false)
    }
  }

  const vars = pipeline.variables ?? {}

  const items = [
    {
      key: 'vars',
      label: '自定义变量',
      extra: !editing
        ? <EditOutlined onClick={e => { e.stopPropagation(); startEdit() }} style={{ color: '#1677ff' }} title="编辑变量值" />
        : null,
      children: editing ? (
        <div>
          {Object.keys(draft).length === 0 && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>暂无变量</Typography.Text>
          )}
          {Object.entries(draft).map(([k, v]) => (
            <div key={k} style={{ marginBottom: 8 }}>
              <Typography.Text code style={{ fontSize: 11 }}>{`{{vars.${k}}}`}</Typography.Text>
              <Input
                size="small"
                placeholder="填入变量值"
                value={v}
                onChange={e => setDraft(prev => ({ ...prev, [k]: e.target.value }))}
                style={{ marginTop: 4 }}
              />
            </div>
          ))}
          <Space style={{ marginTop: 8 }}>
            <Button size="small" type="primary" icon={<SaveOutlined />} loading={saving} onClick={saveVariables}>
              保存
            </Button>
            <Button size="small" onClick={() => setEditing(false)}>取消</Button>
          </Space>
        </div>
      ) : (
        <div>
          {Object.entries(vars).length === 0 && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>暂无变量，点击 ✏️ 编辑</Typography.Text>
          )}
          {Object.entries(vars).map(([k, v]) => (
            <div key={k} style={{ marginBottom: 4 }}>
              <Tag color="blue" style={{ cursor: 'pointer' }} onClick={() => copy(`{{vars.${k}}}`)}
                title={`点击复制，当前值：${v || '(未设置)'}`}>
                {`{{vars.${k}}}`}
              </Tag>
              {v ? (
                <Typography.Text style={{ fontSize: 11, color: '#52c41a' }}>
                  <CheckOutlined /> {v.length > 20 ? v.slice(0, 20) + '…' : v}
                </Typography.Text>
              ) : (
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>未设置</Typography.Text>
              )}
            </div>
          ))}
        </div>
      ),
    },
    {
      key: 'artifacts',
      label: '制品输入',
      children: (
        <div>
          {(pipeline.artifactInputs ?? []).map((a) => (
            <Tag key={a.outputVar} color="purple" style={{ cursor: 'pointer', marginBottom: 4 }}
              onClick={() => copy(`{{vars.${a.outputVar}}}`)}>
              {`{{vars.${a.outputVar}}}`}
            </Tag>
          ))}
        </div>
      ),
    },
    {
      key: 'serverRoles',
      label: '服务器角色',
      children: (
        <div>
          {Object.entries(pipeline.serverRoles ?? {}).map(([r, c]) => (
            <Tag key={r} color="green">{r} × {c.count}</Tag>
          ))}
        </div>
      ),
    },
    {
      key: 'builtin',
      label: '内置变量',
      children: (
        <div>
          {variableCatalog.map(v => (
            <Tag key={v.key} color="default" style={{ cursor: 'pointer', marginBottom: 4 }}
              onClick={() => copy(`{{${v.key}}}`)} title={v.description}>
              {`{{${v.key}}}`}
            </Tag>
          ))}
        </div>
      ),
    },
  ]

  return <Collapse items={items} defaultActiveKey={['vars', 'artifacts']} size="small" />
}
