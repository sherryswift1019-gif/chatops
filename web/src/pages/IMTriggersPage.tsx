import { useEffect, useState } from 'react'
import {
  Card, Table, Button, Modal, Form, Input, Select, Switch, Tag, Space, message,
  Popconfirm, Typography,
} from 'antd'
import { PlusOutlined, ExclamationCircleTwoTone } from '@ant-design/icons'
import {
  listIMTriggers, createIMTrigger, updateIMTrigger, deleteIMTrigger,
} from '../api/imTriggers'
import type { IMTrigger } from '../types/imTrigger'
import { getTestPipelines } from '../api/test-pipelines'
import type { TestPipeline } from '../types'

const { Text } = Typography

export default function IMTriggersPage() {
  const [data, setData] = useState<IMTrigger[]>([])
  const [pipelines, setPipelines] = useState<TestPipeline[]>([])
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<IMTrigger | null>(null)
  const [form] = Form.useForm()
  const [failureMessagesText, setFailureMessagesText] = useState<string>('{}')
  const [failureMessagesError, setFailureMessagesError] = useState<string>('')

  useEffect(() => {
    load()
    loadPipelines()
  }, [])

  async function load() {
    setLoading(true)
    try {
      setData(await listIMTriggers())
    } finally {
      setLoading(false)
    }
  }

  async function loadPipelines() {
    try {
      setPipelines(await getTestPipelines())
    } catch {
      /* ignore */
    }
  }

  function openCreate() {
    setEditing(null)
    form.resetFields()
    form.setFieldsValue({
      enabled: true,
      examples: [],
      pipelineId: null,
    })
    setFailureMessagesText('{}')
    setFailureMessagesError('')
    setModalOpen(true)
  }

  function openEdit(record: IMTrigger) {
    setEditing(record)
    form.setFieldsValue({
      key: record.key,
      displayName: record.displayName,
      description: record.description,
      pipelineId: record.pipelineId,
      intentHints: record.intentHints,
      examples: record.examples,
      enabled: record.enabled,
    })
    setFailureMessagesText(JSON.stringify(record.failureMessages ?? {}, null, 2))
    setFailureMessagesError('')
    setModalOpen(true)
  }

  async function handleSubmit() {
    const values = await form.validateFields()

    let failureMessages: Record<string, string> = {}
    const trimmed = (failureMessagesText ?? '').trim()
    if (trimmed) {
      try {
        const parsed = JSON.parse(trimmed)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          setFailureMessagesError('必须是 JSON 对象（key-value 字符串映射）')
          return
        }
        failureMessages = parsed as Record<string, string>
      } catch (e) {
        setFailureMessagesError(`JSON 解析失败: ${(e as Error).message}`)
        return
      }
    }
    setFailureMessagesError('')

    const payload: Partial<IMTrigger> = {
      ...values,
      failureMessages,
    }

    try {
      if (editing) {
        // key 不可改:剔除掉
        const { key: _key, ...patch } = payload
        void _key
        await updateIMTrigger(editing.id, patch)
        message.success('更新成功')
      } else {
        await createIMTrigger(payload)
        message.success('创建成功')
      }
      setModalOpen(false)
      await load()
    } catch (e) {
      const errMsg = (e as { response?: { data?: { error?: string } } }).response?.data?.error
      message.error(errMsg ? `操作失败: ${errMsg}` : '操作失败')
    }
  }

  async function handleDelete(record: IMTrigger) {
    try {
      await deleteIMTrigger(record.id)
      message.success('删除成功')
      await load()
    } catch (e) {
      const errMsg = (e as { response?: { data?: { error?: string } } }).response?.data?.error
      message.error(errMsg ? `删除失败: ${errMsg}` : '删除失败')
    }
  }

  const pipelineMap = new Map(pipelines.map(p => [p.id, p.name]))

  function renderPipeline(pid: number | null): React.ReactNode {
    if (pid == null) return <Tag color="default">未绑定</Tag>
    const name = pipelineMap.get(pid)
    if (name) return <Tag color="blue">{name}</Tag>
    return (
      <Tag>
        <ExclamationCircleTwoTone twoToneColor="#faad14" /> ID:{pid}（不在列表中）
      </Tag>
    )
  }

  const columns = [
    { title: 'ID', dataIndex: 'id', width: 60 },
    { title: '标识', dataIndex: 'key' },
    { title: '显示名', dataIndex: 'displayName' },
    { title: '描述', dataIndex: 'description', ellipsis: true },
    {
      title: '关联流水线', dataIndex: 'pipelineId',
      render: (v: number | null) => renderPipeline(v),
    },
    {
      title: '示例数', dataIndex: 'examples',
      render: (v: string[]) => <Text type="secondary">{(v ?? []).length}</Text>,
      width: 80,
    },
    {
      title: '类型', dataIndex: 'isSystem',
      render: (v: boolean) => <Tag color={v ? 'default' : 'blue'}>{v ? '系统' : '自定义'}</Tag>,
      width: 80,
    },
    {
      title: '启用', dataIndex: 'enabled',
      render: (v: boolean, record: IMTrigger) => (
        <Switch
          size="small"
          checked={v}
          onChange={async (next) => {
            try {
              await updateIMTrigger(record.id, { enabled: next })
              message.success(next ? '已启用' : '已停用')
              await load()
            } catch {
              message.error('操作失败')
            }
          }}
        />
      ),
      width: 80,
    },
    {
      title: '操作', key: 'action',
      render: (_: unknown, record: IMTrigger) => (
        <Space>
          <a onClick={() => openEdit(record)}>编辑</a>
          <Popconfirm
            title="确认删除该 IM 触发器？"
            description="删除后,该 key 下的产线级配置也会被级联清除。"
            onConfirm={() => handleDelete(record)}
            okText="删除"
            cancelText="取消"
          >
            <a style={{ color: 'red' }}>删除</a>
          </Popconfirm>
        </Space>
      ),
      width: 140,
    },
  ]

  return (
    <Card
      title="IM 触发器"
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          新增触发器
        </Button>
      }
    >
      <Table
        rowKey="id"
        columns={columns}
        dataSource={data}
        loading={loading}
        pagination={false}
      />

      <Modal
        title={editing ? '编辑 IM 触发器' : '新增 IM 触发器'}
        open={modalOpen}
        onOk={handleSubmit}
        onCancel={() => setModalOpen(false)}
        destroyOnClose
        width={720}
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="key"
            label="标识 (key)"
            rules={[{ required: true, message: '请输入标识' }]}
            extra="创建后不可修改;用作 product_line_im_triggers 与 approval_rules 的外键"
          >
            <Input placeholder="如: deploy_service" disabled={!!editing} />
          </Form.Item>
          <Form.Item
            name="displayName"
            label="显示名"
            rules={[{ required: true, message: '请输入显示名' }]}
          >
            <Input placeholder="如: 部署服务" />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={2} placeholder="描述该触发器的用途" />
          </Form.Item>
          <Form.Item
            name="pipelineId"
            label="关联流水线"
            extra="未绑定:IM 触发后只回复诊断信息;绑定:启动对应 pipeline,具备审批/容错/回滚能力"
          >
            <Select
              allowClear
              showSearch
              placeholder="未绑定 — 无法 IM 触发执行"
              options={pipelines.map(p => ({ value: p.id, label: `${p.name} (#${p.id})` }))}
              filterOption={(input, opt) => {
                const v = String(opt?.label ?? '')
                return v.toLowerCase().includes(input.toLowerCase())
              }}
            />
          </Form.Item>
          <Form.Item
            name="intentHints"
            label="意图识别提示词"
            extra="供 Agent 路由层判断该消息是否落在该触发器(自然语言)"
          >
            <Input.TextArea
              rows={3}
              placeholder="如: 用户要求部署、重启、回滚某个服务"
              style={{ fontFamily: 'monospace', fontSize: 12 }}
            />
          </Form.Item>
          <Form.Item
            name="examples"
            label="示例话术"
            extra="按回车添加;Agent greet 时会展示首条示例"
          >
            <Select
              mode="tags"
              placeholder='如: "部署 dev 环境的 user-service"'
              tokenSeparators={[',']}
              style={{ width: '100%' }}
            />
          </Form.Item>
          <Form.Item
            label="失败提示词 (JSON)"
            extra='形如 {"missing_pipeline": "该入口未绑定 pipeline"};留空则使用默认'
            validateStatus={failureMessagesError ? 'error' : undefined}
            help={failureMessagesError || undefined}
          >
            <Input.TextArea
              rows={5}
              value={failureMessagesText}
              onChange={(e) => {
                setFailureMessagesText(e.target.value)
                setFailureMessagesError('')
              }}
              style={{ fontFamily: 'monospace', fontSize: 12 }}
              placeholder="{}"
            />
          </Form.Item>
          <Form.Item name="enabled" label="启用" valuePropName="checked" initialValue={true}>
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}
