import { useEffect, useState } from 'react'
import {
  Table, Button, Switch, Modal, Form, Input, message, Space,
  Typography, Popconfirm, Tag,
} from 'antd'
import { PlusOutlined, ReloadOutlined, DeleteOutlined, CopyOutlined } from '@ant-design/icons'
import type { PipelineWebhook } from '../../types'
import {
  listPipelineWebhooks,
  createPipelineWebhook,
  rotatePipelineWebhook,
  updatePipelineWebhook,
  deletePipelineWebhook,
} from '../../api/pipeline-webhooks'

const { Text, Paragraph } = Typography

// Tag is imported for potential future use (stale value indicator)
void Tag

interface Props {
  pipelineId: number
}

export default function WebhooksPanel({ pipelineId }: Props) {
  const [webhooks, setWebhooks] = useState<PipelineWebhook[]>([])
  const [loading, setLoading] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [secretModal, setSecretModal] = useState<{ url: string; token: string } | null>(null)
  const [secretSaved, setSecretSaved] = useState(false)
  const [form] = Form.useForm()

  const baseUrl = window.location.origin

  async function load() {
    setLoading(true)
    try {
      setWebhooks(await listPipelineWebhooks(pipelineId))
    } catch {
      message.error('加载 webhook 列表失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [pipelineId])

  async function handleCreate(values: { name: string; defaultServers?: string }) {
    let defaultServers: Record<string, string[]> | undefined
    if (values.defaultServers?.trim()) {
      try {
        defaultServers = JSON.parse(values.defaultServers)
      } catch {
        message.error('defaultServers 格式错误，请输入合法 JSON')
        return
      }
    }
    try {
      const result = await createPipelineWebhook(pipelineId, { name: values.name, defaultServers })
      setCreateOpen(false)
      form.resetFields()
      setSecretSaved(false)
      setSecretModal({ url: `${baseUrl}${result.url}`, token: result.token })
      await load()
    } catch {
      message.error('创建失败')
    }
  }

  async function handleRotate(wh: PipelineWebhook) {
    try {
      const result = await rotatePipelineWebhook(pipelineId, wh.id)
      setSecretSaved(false)
      setSecretModal({ url: `${baseUrl}${result.url}`, token: result.token })
      await load()
    } catch {
      message.error('Rotate 失败')
    }
  }

  async function handleToggleEnabled(wh: PipelineWebhook, enabled: boolean) {
    try {
      await updatePipelineWebhook(pipelineId, wh.id, { enabled })
      await load()
    } catch {
      message.error('更新失败')
    }
  }

  async function handleDelete(wh: PipelineWebhook) {
    try {
      await deletePipelineWebhook(pipelineId, wh.id)
      message.success('已删除')
      await load()
    } catch {
      message.error('删除失败')
    }
  }

  const curlTemplate = (url: string) =>
    `curl -X POST ${url} \\\n  -H 'Content-Type: application/json' \\\n  -d '{"hello":"world"}'`

  const columns = [
    { title: '名称', dataIndex: 'name', key: 'name' },
    {
      title: 'Token',
      dataIndex: 'token',
      key: 'token',
      render: (t: string) => <Text code style={{ fontSize: 12 }}>{t}</Text>,
    },
    {
      title: '启用',
      dataIndex: 'enabled',
      key: 'enabled',
      render: (enabled: boolean, record: PipelineWebhook) => (
        <Switch
          checked={enabled}
          size="small"
          onChange={(val) => { void handleToggleEnabled(record, val) }}
        />
      ),
    },
    {
      title: '最近触发',
      dataIndex: 'lastUsedAt',
      key: 'lastUsedAt',
      render: (v: string | null) => v ? new Date(v).toLocaleString() : '—',
    },
    {
      title: '次数',
      dataIndex: 'triggerCount',
      key: 'triggerCount',
      width: 60,
    },
    {
      title: '操作',
      key: 'actions',
      render: (_: unknown, record: PipelineWebhook) => (
        <Space>
          <Popconfirm
            title="Rotate 后旧 Token 立即失效，确认？"
            onConfirm={() => { void handleRotate(record) }}
          >
            <Button icon={<ReloadOutlined />} size="small" title="Rotate Token" />
          </Popconfirm>
          <Popconfirm title="确认删除？" onConfirm={() => { void handleDelete(record) }}>
            <Button icon={<DeleteOutlined />} size="small" danger />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          新建 Webhook
        </Button>
      </div>

      <Table
        dataSource={webhooks}
        columns={columns}
        rowKey="id"
        loading={loading}
        size="small"
        pagination={false}
        expandable={{
          expandedRowRender: (record: PipelineWebhook) => {
            const maskedUrl = `${baseUrl}/webhook/pipeline/${record.token}`
            return (
              <div style={{ padding: '4px 16px', background: '#fafafa' }}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  Curl 模板（Token 已脱敏，替换为完整 Token 后使用）：
                </Text>
                <Paragraph
                  copyable={{ text: curlTemplate(maskedUrl) }}
                  code
                  style={{ fontSize: 11, marginTop: 4, marginBottom: 0 }}
                >
                  {curlTemplate(maskedUrl)}
                </Paragraph>
              </div>
            )
          },
        }}
      />

      {/* 新建 Modal */}
      <Modal
        title="新建 Webhook 触发器"
        open={createOpen}
        onOk={() => form.submit()}
        onCancel={() => { setCreateOpen(false); form.resetFields() }}
        okText="创建"
        cancelText="取消"
      >
        <Form form={form} layout="vertical" onFinish={handleCreate}>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="例：ci-trigger" />
          </Form.Item>
          <Form.Item
            name="defaultServers"
            label="默认 Server 分配（JSON，可选）"
            extra='格式：{"roleKey": ["server-id"]}，留空则使用 pipeline 默认'
          >
            <Input.TextArea rows={2} placeholder='{"deploy": ["server-prod-1"]}' />
          </Form.Item>
        </Form>
      </Modal>

      {/* Token 仅此一次展示 Modal */}
      <Modal
        title="请保存完整 Webhook URL"
        open={!!secretModal}
        footer={[
          <Button
            key="copy"
            icon={<CopyOutlined />}
            onClick={() => {
              if (secretModal?.url) {
                void navigator.clipboard.writeText(secretModal.url)
                setSecretSaved(true)
                message.success('已复制到剪贴板')
              }
            }}
          >
            复制 URL
          </Button>,
          <Button
            key="confirm"
            type="primary"
            disabled={!secretSaved}
            onClick={() => setSecretModal(null)}
          >
            我已保存
          </Button>,
        ]}
        closable={false}
        maskClosable={false}
      >
        <p style={{ color: '#ff4d4f', marginBottom: 8 }}>
          ⚠ Token 仅此一次显示，关闭后无法再查看。
        </p>
        <Paragraph copyable={{ text: secretModal?.url }} code style={{ wordBreak: 'break-all' }}>
          {secretModal?.url}
        </Paragraph>
        <Text type="secondary" style={{ fontSize: 12 }}>Curl 示例：</Text>
        <Paragraph code style={{ fontSize: 11, marginTop: 4 }}>
          {secretModal ? curlTemplate(secretModal.url) : ''}
        </Paragraph>
      </Modal>
    </div>
  )
}
