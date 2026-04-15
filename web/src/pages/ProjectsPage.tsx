import { useEffect, useState, useRef } from 'react'
import { Card, Table, Button, Modal, Form, Input, Select, Popconfirm, Space, message, Tag, Avatar } from 'antd'
import { PlusOutlined, UserOutlined } from '@ant-design/icons'
import { getProjects, createProject, updateProject, deleteProject } from '../api/projects'
import { getProductLines } from '../api/product-lines'
import { getDingTalkUsers } from '../api/dingtalk-users'
import type { Project, ProductLine, DingTalkUser } from '../types'

// Inline owner search select that tracks both userId and userName
interface OwnerSelectProps {
  value?: string
  onChange?: (userId: string) => void
  onUserChange?: (user: DingTalkUser | null) => void
}

function OwnerSelect({ value, onChange, onUserChange }: OwnerSelectProps) {
  const [options, setOptions] = useState<DingTalkUser[]>([])
  const [fetching, setFetching] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout>>()

  const handleSearch = (keyword: string) => {
    clearTimeout(timerRef.current)
    if (!keyword) { setOptions([]); return }
    timerRef.current = setTimeout(async () => {
      setFetching(true)
      try {
        const res = await getDingTalkUsers(keyword)
        setOptions(res.users)
      } finally { setFetching(false) }
    }, 300)
  }

  const handleChange = (userId: string) => {
    const user = options.find(u => u.userId === userId) ?? null
    onChange?.(userId)
    onUserChange?.(user)
  }

  return (
    <Select
      showSearch
      value={value}
      placeholder="搜索并选择负责人"
      style={{ width: '100%' }}
      filterOption={false}
      onSearch={handleSearch}
      onChange={handleChange}
      loading={fetching}
      notFoundContent={fetching ? '搜索中...' : '无结果'}
      options={options.map(u => ({
        value: u.userId,
        label: (
          <Space>
            <Avatar size="small" src={u.avatar || undefined} icon={!u.avatar ? <UserOutlined /> : undefined} />
            <span>{u.name}</span>
            <span style={{ color: '#999', fontSize: 12 }}>{u.department}</span>
          </Space>
        ),
      }))}
    />
  )
}

export default function ProjectsPage() {
  const [data, setData] = useState<Project[]>([])
  const [loading, setLoading] = useState(false)
  const [productLines, setProductLines] = useState<ProductLine[]>([])
  const [productLineMap, setProductLineMap] = useState<Map<number, string>>(new Map())
  const [filterProductLineId, setFilterProductLineId] = useState<number | undefined>(undefined)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Project | null>(null)
  const [form] = Form.useForm()
  // Track the full owner object while modal is open
  const ownerRef = useRef<{ userId: string; userName: string } | null>(null)

  useEffect(() => {
    getProductLines().then(pls => {
      setProductLines(pls)
      setProductLineMap(new Map(pls.map(pl => [pl.id, pl.displayName])))
    })
  }, [])

  useEffect(() => { load() }, [filterProductLineId])

  async function load() {
    setLoading(true)
    try { setData(await getProjects(filterProductLineId)) } finally { setLoading(false) }
  }

  function openCreate() {
    setEditing(null)
    ownerRef.current = null
    form.resetFields()
    setModalOpen(true)
  }

  function openEdit(record: Project) {
    setEditing(record)
    ownerRef.current = { userId: record.ownerId, userName: record.ownerName }
    form.setFieldsValue(record)
    setModalOpen(true)
  }

  async function handleSubmit() {
    const values = await form.validateFields()
    const ownerName = ownerRef.current?.userName ?? ''
    const payload = { ...values, ownerName }
    if (editing) {
      await updateProject(editing.id, payload)
      message.success('更新成功')
    } else {
      await createProject(payload)
      message.success('创建成功')
    }
    setModalOpen(false)
    await load()
  }

  async function handleDelete(id: number) {
    await deleteProject(id)
    message.success('删除成功')
    await load()
  }

  const columns = [
    { title: 'ID', dataIndex: 'id' },
    {
      title: '产线', dataIndex: 'productLineId',
      render: (v: number) => {
        const name = productLineMap.get(v)
        return name ? <Tag color="blue">{name}</Tag> : <Tag>ID:{v}</Tag>
      },
    },
    { title: '项目名', dataIndex: 'name' },
    { title: '显示名', dataIndex: 'displayName' },
    { title: 'GitLab路径', dataIndex: 'gitlabPath', ellipsis: true },
    { title: 'Harbor项目', dataIndex: 'harborProject', ellipsis: true },
    {
      title: '负责人', dataIndex: 'ownerName',
      render: (v: string, r: Project) => v || r.ownerId,
    },
    {
      title: '操作',
      render: (_: unknown, record: Project) => (
        <Space>
          <a onClick={() => openEdit(record)}>编辑</a>
          <Popconfirm title="确认删除？" onConfirm={() => handleDelete(record.id)}>
            <a style={{ color: 'red' }}>删除</a>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <Card
      title="项目管理"
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
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新增项目</Button>
        </Space>
      }
    >
      <Table rowKey="id" columns={columns} dataSource={data} loading={loading} pagination={false} />

      <Modal
        title={editing ? '编辑项目' : '新增项目'}
        open={modalOpen}
        onOk={handleSubmit}
        onCancel={() => setModalOpen(false)}
        destroyOnClose
        width={560}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="productLineId" label="产线" rules={[{ required: true, message: '请选择产线' }]}>
            <Select
              placeholder="请选择产线"
              options={productLines.map(pl => ({ value: pl.id, label: pl.displayName }))}
            />
          </Form.Item>
          <Form.Item name="name" label="项目名" rules={[{ required: true, message: '请输入项目名' }]}>
            <Input placeholder="如: my-service" />
          </Form.Item>
          <Form.Item name="displayName" label="显示名" rules={[{ required: true, message: '请输入显示名' }]}>
            <Input placeholder="如: 我的服务" />
          </Form.Item>
          <Form.Item name="gitlabPath" label="GitLab路径">
            <Input placeholder="如: group/my-service" />
          </Form.Item>
          <Form.Item name="harborProject" label="Harbor项目">
            <Input placeholder="如: library" />
          </Form.Item>
          <Form.Item name="ownerId" label="负责人">
            <OwnerSelect
              onUserChange={user => {
                ownerRef.current = user ? { userId: user.userId, userName: user.name } : null
              }}
            />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}
