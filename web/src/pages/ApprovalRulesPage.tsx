import { useEffect, useState } from 'react'
import { Card, Table, Button, Modal, Form, InputNumber, Select, Popconfirm, Space, message, Tag } from 'antd'
import { PlusOutlined, ExclamationCircleTwoTone } from '@ant-design/icons'
import { getApprovalRules, createApprovalRule, updateApprovalRule, deleteApprovalRule } from '../api/approval-rules'
import { getProductLines } from '../api/product-lines'
import { listIMTriggers } from '../api/imTriggers'
import { getEnvironments } from '../api/environments'
import DingTalkUserSelect from '../components/DingTalkUserSelect'
import type { ApprovalRule, ProductLine, Environment } from '../types'
import type { IMTrigger } from '../types/imTrigger'

export default function ApprovalRulesPage() {
  const [data, setData] = useState<ApprovalRule[]>([])
  const [loading, setLoading] = useState(false)
  const [productLines, setProductLines] = useState<ProductLine[]>([])
  const [productLineMap, setProductLineMap] = useState<Map<number, string>>(new Map())
  const [imTriggers, setImTriggers] = useState<IMTrigger[]>([])
  const [environments, setEnvironments] = useState<Environment[]>([])
  const [filterProductLineId, setFilterProductLineId] = useState<number | undefined>(undefined)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<ApprovalRule | null>(null)
  const [form] = Form.useForm()

  useEffect(() => {
    getProductLines().then(pls => {
      setProductLines(pls)
      setProductLineMap(new Map(pls.map(pl => [pl.id, pl.displayName])))
    })
    listIMTriggers().then(setImTriggers).catch(() => {})
    getEnvironments().then(setEnvironments)
  }, [])

  useEffect(() => { load() }, [filterProductLineId])

  async function load() {
    setLoading(true)
    try { setData(await getApprovalRules(filterProductLineId)) } finally { setLoading(false) }
  }

  function openCreate() {
    setEditing(null)
    form.resetFields()
    setModalOpen(true)
  }

  function openEdit(record: ApprovalRule) {
    setEditing(record)
    form.setFieldsValue(record)
    setModalOpen(true)
  }

  async function handleSubmit() {
    const values = await form.validateFields()
    if (editing) {
      await updateApprovalRule(editing.id, values)
      message.success('更新成功')
    } else {
      await createApprovalRule(values as Omit<ApprovalRule, 'id'>)
      message.success('创建成功')
    }
    setModalOpen(false)
    await load()
  }

  async function handleDelete(id: number) {
    await deleteApprovalRule(id)
    message.success('删除成功')
    await load()
  }

  // Build IM trigger options including stale-value compat
  function buildImTriggerOptions(currentValue: string | undefined) {
    const triggerKeys = new Set(imTriggers.map(t => t.key))
    const options = [
      { value: '*', label: <span><Tag color="purple">*</Tag> 任意触发器（通配）</span> },
      ...imTriggers.map(t => ({
        value: t.key,
        label: <span>{t.displayName} <span style={{ color: '#999', fontSize: 11 }}>({t.key})</span></span>,
      })),
    ]
    // Stale compat: 如当前值不在列表(且不是通配),展示一个标灰提示项保留原值
    if (currentValue && currentValue !== '*' && !triggerKeys.has(currentValue)) {
      options.push({
        value: currentValue,
        label: (
          <span>
            <ExclamationCircleTwoTone twoToneColor="#faad14" /> {currentValue}（不在列表中）
          </span>
        ),
      })
    }
    return options
  }

  function buildEnvOptions(currentValue: string | undefined) {
    const envNames = new Set(environments.map(e => e.name))
    const options = [
      { value: '*', label: <span><Tag color="purple">*</Tag> 任意环境（通配）</span> },
      ...environments.map(e => ({
        value: e.name,
        label: <span>{e.displayName} <span style={{ color: '#999', fontSize: 11 }}>({e.name})</span></span>,
      })),
    ]
    if (currentValue && currentValue !== '*' && !envNames.has(currentValue)) {
      options.push({
        value: currentValue,
        label: (
          <span>
            <ExclamationCircleTwoTone twoToneColor="#faad14" /> {currentValue}（不在列表中）
          </span>
        ),
      })
    }
    return options
  }

  const triggerNameMap = new Map(imTriggers.map(t => [t.key, t.displayName]))

  const columns = [
    { title: 'ID', dataIndex: 'id' },
    {
      title: '产线', dataIndex: 'productLineId',
      render: (v: number | null) => {
        if (v == null) return <Tag>全局</Tag>
        const name = productLineMap.get(v)
        return name ? <Tag color="blue">{name}</Tag> : <Tag>ID:{v}</Tag>
      },
    },
    {
      title: 'IM 触发器', dataIndex: 'imTriggerKey',
      render: (v: string) => {
        if (v === '*') return <Tag color="purple">*</Tag>
        const name = triggerNameMap.get(v)
        if (name) return <span>{name} <span style={{ color: '#999', fontSize: 11 }}>({v})</span></span>
        return <span><ExclamationCircleTwoTone twoToneColor="#faad14" /> {v}</span>
      },
    },
    { title: '环境', dataIndex: 'env' },
    {
      title: '主审批人', dataIndex: 'primaryApprovers',
      render: (ids: string[]) => (
        <Space size={4} wrap>
          {ids?.map(id => <Tag key={id}>{id}</Tag>)}
        </Space>
      ),
    },
    {
      title: '备选审批人', dataIndex: 'backupApprovers',
      render: (ids: string[]) => (
        <Space size={4} wrap>
          {ids?.map(id => <Tag key={id} color="default">{id}</Tag>)}
        </Space>
      ),
    },
    { title: '主超时(分钟)', dataIndex: 'primaryTimeoutMin' },
    { title: '总超时(分钟)', dataIndex: 'totalTimeoutMin' },
    {
      title: '操作',
      render: (_: unknown, record: ApprovalRule) => (
        <Space>
          <a onClick={() => openEdit(record)}>编辑</a>
          <Popconfirm title="确认删除？" onConfirm={() => handleDelete(record.id)}>
            <a style={{ color: 'red' }}>删除</a>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  const editingTriggerValue = editing?.imTriggerKey
  const editingEnvValue = editing?.env

  return (
    <Card
      title="审批规则"
      extra={
        <Space>
          <Select
            allowClear
            placeholder="按产线筛选"
            style={{ width: 180 }}
            value={filterProductLineId}
            onChange={v => setFilterProductLineId(v)}
            options={productLines.map(pl => ({ value: pl.id, label: pl.displayName }))}
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新增规则</Button>
        </Space>
      }
    >
      <Table rowKey="id" columns={columns} dataSource={data} loading={loading} pagination={false} scroll={{ x: 'max-content' }} />

      <Modal
        title={editing ? '编辑审批规则' : '新增审批规则'}
        open={modalOpen}
        onOk={handleSubmit}
        onCancel={() => setModalOpen(false)}
        destroyOnClose
        width={600}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="productLineId" label="产线" rules={[{ required: true, message: '请选择产线' }]}>
            <Select
              placeholder="请选择产线"
              options={productLines.map(pl => ({ value: pl.id, label: pl.displayName }))}
            />
          </Form.Item>
          <Form.Item name="imTriggerKey" label="IM 触发器" rules={[{ required: true, message: '请选择 IM 触发器' }]}>
            <Select
              showSearch
              placeholder="选择 IM 触发器"
              options={buildImTriggerOptions(editingTriggerValue)}
              filterOption={(input, opt) => {
                const v = String((opt as { value?: string } | undefined)?.value ?? '')
                return v.toLowerCase().includes(input.toLowerCase())
              }}
            />
          </Form.Item>
          <Form.Item name="env" label="环境" rules={[{ required: true, message: '请选择环境' }]}>
            <Select
              showSearch
              placeholder="选择环境"
              options={buildEnvOptions(editingEnvValue)}
              filterOption={(input, opt) => {
                const v = String((opt as { value?: string } | undefined)?.value ?? '')
                return v.toLowerCase().includes(input.toLowerCase())
              }}
            />
          </Form.Item>
          <Form.Item name="primaryApprovers" label="主审批人" initialValue={[]}>
            <DingTalkUserSelect mode="multiple" placeholder="搜索并添加主审批人" />
          </Form.Item>
          <Form.Item name="backupApprovers" label="备选审批人" initialValue={[]}>
            <DingTalkUserSelect mode="multiple" placeholder="搜索并添加备选审批人" />
          </Form.Item>
          <Form.Item name="primaryTimeoutMin" label="主超时(分钟)" initialValue={60}>
            <InputNumber min={1} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="totalTimeoutMin" label="总超时(分钟)" initialValue={120}>
            <InputNumber min={1} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}
