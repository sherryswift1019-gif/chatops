import { useEffect, useState } from 'react'
import { Button, Form, Input, Modal, Space, Switch, Table, Typography, message } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import axios from 'axios'
import { ParamSchemaForm } from './ParamSchemaForm.js'

interface Schedule {
  id: number; name: string; cronExpr: string; presetParams: Record<string, unknown>; enabled: boolean
}

interface Props {
  pipelineId: number
  paramSchema: Record<string, unknown> | null
}

export function SchedulesPanel({ pipelineId, paramSchema }: Props) {
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Schedule | null>(null)
  const [form] = Form.useForm()
  const [paramForm] = Form.useForm()

  const hasSchema = paramSchema && Object.keys((paramSchema.properties ?? {}) as object).length > 0

  async function load() {
    const res = await axios.get<Schedule[]>(`/admin/test-pipelines/${pipelineId}/schedules`)
    setSchedules(res.data)
  }

  useEffect(() => { void load() }, [pipelineId])

  function openAdd() {
    setEditing(null)
    form.resetFields()
    paramForm.resetFields()
    setModalOpen(true)
  }

  function openEdit(r: Schedule) {
    setEditing(r)
    form.setFieldsValue({ name: r.name, cronExpr: r.cronExpr })
    paramForm.setFieldsValue(r.presetParams)
    setModalOpen(true)
  }

  async function handleSave() {
    try {
      const base = await form.validateFields()
      const presetParams = hasSchema ? await paramForm.validateFields() : {}
      const data = { ...base, presetParams }
      if (editing) {
        await axios.put(`/admin/test-pipelines/${pipelineId}/schedules/${editing.id}`, data)
      } else {
        await axios.post(`/admin/test-pipelines/${pipelineId}/schedules`, data)
      }
      void message.success('已保存')
      setModalOpen(false)
      await load()
    } catch { /* validation error */ }
  }

  async function handleDelete(id: number) {
    await axios.delete(`/admin/test-pipelines/${pipelineId}/schedules/${id}`)
    await load()
  }

  async function handleToggle(id: number, enabled: boolean) {
    await axios.patch(`/admin/test-pipelines/${pipelineId}/schedules/${id}/toggle`, { enabled })
    await load()
  }

  const columns: ColumnsType<Schedule> = [
    { title: '名称', dataIndex: 'name' },
    { title: 'Cron', dataIndex: 'cronExpr' },
    { title: '启用', dataIndex: 'enabled', render: (v: boolean, r) => (
      <Switch checked={v} onChange={checked => void handleToggle(r.id, checked)} />
    )},
    { title: '操作', render: (_, r) => (
      <Space>
        <a onClick={() => openEdit(r)}>编辑</a>
        <a onClick={() => void handleDelete(r.id)} style={{ color: 'red' }}>删除</a>
      </Space>
    )},
  ]

  return (
    <>
      <Button type="primary" onClick={openAdd} style={{ marginBottom: 8 }}>新增规则</Button>
      <Table dataSource={schedules} rowKey="id" size="small" columns={columns} />
      <Modal
        title={editing ? '编辑规则' : '新增规则'}
        open={modalOpen}
        onOk={handleSave}
        onCancel={() => setModalOpen(false)}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="名称"><Input /></Form.Item>
          <Form.Item name="cronExpr" label="Cron 表达式" rules={[{ required: true, message: '请输入 Cron 表达式' }]}>
            <Input placeholder="0 9 * * *" />
          </Form.Item>
        </Form>
        {hasSchema && (
          <>
            <Typography.Text type="secondary">预设参数</Typography.Text>
            <Form form={paramForm} layout="vertical">
              <ParamSchemaForm schema={paramSchema as Record<string, unknown>} form={paramForm} />
            </Form>
          </>
        )}
      </Modal>
    </>
  )
}
