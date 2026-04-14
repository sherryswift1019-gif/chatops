import { useEffect, useState, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Card, Tabs, Button, Table, Form, Input, Select, Modal, Space, Tag, Avatar,
  Popconfirm, message, Switch, Spin, Typography, Divider, Checkbox,
} from 'antd'
import { ArrowLeftOutlined, PlusOutlined, SaveOutlined, UserOutlined } from '@ant-design/icons'
import {
  getProductLines, updateProductLine,
  getMembers, addMember, updateMemberRole, removeMember,
  getProductLineEnvs, setProductLineEnvs,
} from '../api/product-lines'
import { getProjects, createProject, updateProject, deleteProject } from '../api/projects'
import { getEnvironments } from '../api/environments'
import { getApprovalRules, createApprovalRule, updateApprovalRule, deleteApprovalRule } from '../api/approval-rules'
import { getTestServers } from '../api/test-servers'
import { getDingTalkUsers } from '../api/dingtalk-users'
import { getCapabilities, getProductLineCapabilities, setProductLineCapabilities } from '../api/capabilities'
import type { Capability, ProductLineCapability } from '../api/capabilities'
import DingTalkUserSelect from '../components/DingTalkUserSelect'
import type { ProductLine, ProductLineMember, Project, Environment, ProductLineEnv, ApprovalRule, TestServer } from '../types'

const { Title } = Typography

// ─── Basic Info Tab ──────────────────────────────────────────────────────────

function BasicInfoTab({ productLine, onUpdated }: { productLine: ProductLine; onUpdated: (pl: ProductLine) => void }) {
  const [form] = Form.useForm()
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    form.setFieldsValue(productLine)
  }, [productLine, form])

  async function handleSave() {
    const values = await form.validateFields()
    setSaving(true)
    try {
      const updated = await updateProductLine(productLine.id, values)
      message.success('保存成功')
      onUpdated(updated)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ maxWidth: 600, paddingTop: 16 }}>
      <Form form={form} layout="vertical">
        <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入产线名称' }]}>
          <Input placeholder="如: pam" />
        </Form.Item>
        <Form.Item name="displayName" label="显示名" rules={[{ required: true, message: '请输入显示名' }]}>
          <Input placeholder="如: PAM 特权访问管理" />
        </Form.Item>
        <Form.Item name="description" label="描述">
          <Input.TextArea rows={4} />
        </Form.Item>
        <Form.Item>
          <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={handleSave}>
            保存
          </Button>
        </Form.Item>
      </Form>
    </div>
  )
}

// ─── Projects Tab ─────────────────────────────────────────────────────────────

function ProjectsTab({ productLineId }: { productLineId: number }) {
  const [data, setData] = useState<Project[]>([])
  const [avatarMap, setAvatarMap] = useState<Map<string, string>>(new Map())
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Project | null>(null)
  const [form] = Form.useForm()
  const ownerRef = useRef<{ userId: string; userName: string } | null>(null)

  useEffect(() => { load() }, [productLineId])

  async function load() {
    setLoading(true)
    try {
      const [projects, dtUsers] = await Promise.all([getProjects(productLineId), getDingTalkUsers()])
      setData(projects)
      const map = new Map<string, string>()
      for (const u of dtUsers.users) { if (u.avatar) map.set(u.userId, u.avatar) }
      setAvatarMap(map)
    } finally { setLoading(false) }
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
      await createProject({ ...payload, productLineId })
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

  function handleOwnerChange(userId: string | string[]) {
    const uid = Array.isArray(userId) ? userId[0] : userId
    // ownerRef is updated via DingTalkUserSelect's onChange;
    // we also need to find the name from the component's internal options
    ownerRef.current = { userId: uid, userName: ownerRef.current?.userName ?? uid }
  }

  const columns = [
    { title: 'ID', dataIndex: 'id', width: 60 },
    { title: '名称', dataIndex: 'name' },
    { title: '显示名', dataIndex: 'displayName' },
    { title: 'GitLab 路径', dataIndex: 'gitlabPath', ellipsis: true },
    { title: 'Harbor 项目', dataIndex: 'harborProject', ellipsis: true },
    { title: '负责人', key: 'owner',
      render: (_: unknown, record: Project) => record.ownerId ? (
        <Space>
          <Avatar size="small" src={avatarMap.get(record.ownerId) || undefined} icon={!avatarMap.get(record.ownerId) ? <UserOutlined /> : undefined} />
          <span>{record.ownerName || record.ownerId}</span>
        </Space>
      ) : '-',
    },
    { title: 'Docker 容器名', dataIndex: 'dockerContainerName', ellipsis: true },
    { title: 'K8s 项目名', dataIndex: 'k8sProjectName', ellipsis: true },
    {
      title: '操作', width: 150,
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
    <>
      <div style={{ marginBottom: 16, textAlign: 'right' }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新增项目</Button>
      </div>
      <Table rowKey="id" columns={columns} dataSource={data} loading={loading} pagination={false} />
      <Modal
        title={editing ? '编辑项目' : '新增项目'}
        open={modalOpen}
        onOk={handleSubmit}
        onCancel={() => setModalOpen(false)}
        destroyOnClose
        width={600}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="项目名称" rules={[{ required: true, message: '请输入项目名称' }]}>
            <Input placeholder="如: pam-backend" />
          </Form.Item>
          <Form.Item name="displayName" label="显示名" rules={[{ required: true, message: '请输入显示名' }]}>
            <Input placeholder="如: PAM 后端服务" />
          </Form.Item>
          <Form.Item name="gitlabPath" label="GitLab 路径">
            <Input placeholder="如: group/pam-backend" />
          </Form.Item>
          <Form.Item name="harborProject" label="Harbor 项目">
            <Input placeholder="如: pam" />
          </Form.Item>
          <Form.Item name="ownerId" label="负责人">
            <DingTalkUserSelect
              placeholder="搜索负责人"
              initialUsers={editing?.ownerId ? [{ userId: editing.ownerId, name: editing.ownerName || editing.ownerId, avatar: avatarMap.get(editing.ownerId) }] : undefined}
              onChange={(val) => {
                const uid = Array.isArray(val) ? val[0] : val
                handleOwnerChange(uid)
              }}
              onUserSelect={(user) => {
                ownerRef.current = { userId: user.userId, userName: user.name }
              }}
            />
          </Form.Item>
          <Form.Item name="dockerContainerName" label="Docker 容器名">
            <Input placeholder="如: pam-backend-dev" />
          </Form.Item>
          <Form.Item name="k8sProjectName" label="K8s 项目名">
            <Input placeholder="如: pam-backend" />
          </Form.Item>
          <Form.Item name="composePath" label="Docker Compose 路径">
            <Input placeholder="如: /opt/pam/ssh-proxy" />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  )
}

// ─── Members Tab ──────────────────────────────────────────────────────────────

const ROLE_LABELS: Record<string, string> = {
  admin: '管理员',
  developer: '开发者',
  ops: '运维',
}

const ROLE_COLORS: Record<string, string> = {
  admin: 'red',
  developer: 'blue',
  ops: 'green',
}

function MembersTab({ productLineId }: { productLineId: number }) {
  const [data, setData] = useState<ProductLineMember[]>([])
  const [avatarMap, setAvatarMap] = useState<Map<string, string>>(new Map())
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editingMember, setEditingMember] = useState<ProductLineMember | null>(null)
  const [selectedUserId, setSelectedUserId] = useState<string | undefined>()
  const [form] = Form.useForm()

  useEffect(() => { load() }, [productLineId])

  async function load() {
    setLoading(true)
    try {
      const members = await getMembers(productLineId)
      setData(members)
      // Load avatars from dingtalk_users
      const res = await getDingTalkUsers()
      const map = new Map<string, string>()
      for (const u of res.users) {
        if (u.avatar) map.set(u.userId, u.avatar)
      }
      setAvatarMap(map)
    } finally { setLoading(false) }
  }

  function openAdd() {
    setEditingMember(null)
    setSelectedUserId(undefined)
    form.resetFields()
    setModalOpen(true)
  }

  function openEditRole(member: ProductLineMember) {
    setEditingMember(member)
    form.setFieldsValue({ role: member.role })
    setModalOpen(true)
  }

  const selectedUserRef = useRef<{ userId: string; name: string } | null>(null)

  async function handleSubmit() {
    const values = await form.validateFields()
    if (editingMember) {
      await updateMemberRole(productLineId, editingMember.id, values.role)
      message.success('角色更新成功')
    } else {
      if (!selectedUserId) { message.error('请选择用户'); return }
      const userName = selectedUserRef.current?.name || selectedUserId
      await addMember(productLineId, { userId: selectedUserId, userName, role: values.role })
      message.success('添加成员成功')
    }
    setModalOpen(false)
    await load()
  }

  async function handleRemove(memberId: number) {
    await removeMember(productLineId, memberId)
    message.success('移除成功')
    await load()
  }

  const columns = [
    { title: 'ID', dataIndex: 'id', width: 60 },
    { title: '成员', key: 'user',
      render: (_: unknown, record: ProductLineMember) => (
        <Space>
          <Avatar size="small" src={avatarMap.get(record.userId) || undefined} icon={!avatarMap.get(record.userId) ? <UserOutlined /> : undefined} />
          <span>{record.userName}</span>
          <span style={{ color: '#999', fontSize: 12 }}>{record.userId}</span>
        </Space>
      ),
    },
    {
      title: '角色', dataIndex: 'role',
      render: (role: string) => <Tag color={ROLE_COLORS[role] ?? 'default'}>{ROLE_LABELS[role] ?? role}</Tag>,
    },
    { title: '加入时间', dataIndex: 'createdAt', render: (v: string) => new Date(v).toLocaleString() },
    {
      title: '操作', width: 150,
      render: (_: unknown, record: ProductLineMember) => (
        <Space>
          <a onClick={() => openEditRole(record)}>修改角色</a>
          <Popconfirm title="确认移除该成员？" onConfirm={() => handleRemove(record.id)}>
            <a style={{ color: 'red' }}>移除</a>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <>
      <div style={{ marginBottom: 16, textAlign: 'right' }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={openAdd}>添加成员</Button>
      </div>
      <Table rowKey="id" columns={columns} dataSource={data} loading={loading} pagination={false} />
      <Modal
        title={editingMember ? '修改角色' : '添加成员'}
        open={modalOpen}
        onOk={handleSubmit}
        onCancel={() => setModalOpen(false)}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          {!editingMember && (
            <Form.Item label="选择用户" required>
              <DingTalkUserSelect
                value={selectedUserId}
                onChange={(v) => {
                  const userId = v as string
                  setSelectedUserId(userId)
                  form.setFieldValue('userId', userId)
                }}
                onUserSelect={(user) => {
                  selectedUserRef.current = { userId: user.userId, name: user.name }
                }}
                placeholder="搜索钉钉用户"
              />
            </Form.Item>
          )}
          {editingMember && (
            <Form.Item label="用户">
              <Input value={editingMember.userName} disabled />
            </Form.Item>
          )}
          <Form.Item name="role" label="角色" rules={[{ required: true, message: '请选择角色' }]}>
            <Select placeholder="请选择角色">
              <Select.Option value="admin">管理员</Select.Option>
              <Select.Option value="developer">开发者</Select.Option>
              <Select.Option value="ops">运维</Select.Option>
            </Select>
          </Form.Item>
        </Form>
      </Modal>
    </>
  )
}

// ─── Env Config Tab ───────────────────────────────────────────────────────────

interface EnvRow {
  envId: number
  envName: string
  envDisplayName: string
  enabled: boolean
  runtime: 'kubernetes' | 'docker'
  namespace: string
  connectionConfig: Record<string, unknown>
}

function EnvConfigTab({ productLineId }: { productLineId: number }) {
  const [rows, setRows] = useState<EnvRow[]>([])
  const [servers, setServers] = useState<TestServer[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => { load() }, [productLineId])

  async function load() {
    setLoading(true)
    try {
      const [allEnvs, plEnvs, plServers] = await Promise.all([
        getEnvironments(),
        getProductLineEnvs(productLineId),
        getTestServers(productLineId),
      ])
      setServers(plServers)
      const plEnvMap = new Map<number, ProductLineEnv>(plEnvs.map(e => [e.envId, e]))
      setRows(allEnvs.map(env => {
        const existing = plEnvMap.get(env.id)
        return {
          envId: env.id,
          envName: env.name,
          envDisplayName: env.displayName,
          enabled: existing?.enabled ?? false,
          runtime: (existing?.runtime as 'kubernetes' | 'docker') ?? 'docker',
          namespace: existing?.namespace ?? '',
          connectionConfig: existing?.connectionConfig ?? {},
        }
      }))
    } finally {
      setLoading(false)
    }
  }

  function updateRow(envId: number, patch: Partial<EnvRow>) {
    setRows(prev => prev.map(r => r.envId === envId ? { ...r, ...patch } : r))
  }

  async function handleSave() {
    setSaving(true)
    try {
      await setProductLineEnvs(productLineId, rows.map(r => ({
        envId: r.envId,
        runtime: r.runtime,
        namespace: r.namespace,
        enabled: r.enabled,
        connectionConfig: r.connectionConfig,
      })))
      message.success('环境配置保存成功')
    } finally {
      setSaving(false)
    }
  }

  const columns = [
    { title: '环境', dataIndex: 'envDisplayName', width: 120 },
    { title: '标识', dataIndex: 'envName', width: 100 },
    {
      title: '启用', dataIndex: 'enabled', width: 80,
      render: (v: boolean, record: EnvRow) => (
        <Switch checked={v} onChange={(checked) => updateRow(record.envId, { enabled: checked })} />
      ),
    },
    {
      title: '运行时', dataIndex: 'runtime', width: 140,
      render: (v: string, record: EnvRow) => (
        <Select
          value={v}
          style={{ width: '100%' }}
          onChange={(val) => updateRow(record.envId, { runtime: val as 'kubernetes' | 'docker' })}
          options={[
            { value: 'kubernetes', label: 'Kubernetes' },
            { value: 'docker', label: 'Docker' },
          ]}
        />
      ),
    },
    {
      title: '连接配置',
      key: 'connection',
      width: 360,
      render: (_: unknown, record: EnvRow) => {
        const cfg = record.connectionConfig as Record<string, string>
        if (record.runtime === 'kubernetes') {
          return (
            <Input
              value={record.namespace || (cfg.namespace as string) || ''}
              placeholder="K8s Namespace，如: pam-prod"
              onChange={(e) => updateRow(record.envId, {
                namespace: e.target.value,
                connectionConfig: { ...cfg, namespace: e.target.value },
              })}
            />
          )
        }
        // Docker: select servers from TestServer pool
        const serverIds = (cfg.serverIds as unknown as number[]) ?? []
        // Legacy format: show migration hint
        if (!cfg.serverIds && cfg.host) {
          return (
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              <Tag color="orange">旧配置: {cfg.host as string}@{cfg.username as string ?? ''}</Tag>
              <Select
                mode="multiple"
                value={[]}
                style={{ width: '100%' }}
                placeholder="请选择服务器以替换旧配置"
                onChange={(ids: number[]) => updateRow(record.envId, {
                  connectionConfig: { serverIds: ids },
                })}
                options={servers.map(s => ({
                  value: s.id,
                  label: `${s.name} (${s.host}) - ${s.role || '无角色'}`,
                }))}
              />
            </Space>
          )
        }
        return (
          <Select
            mode="multiple"
            value={serverIds}
            style={{ width: '100%' }}
            placeholder={servers.length > 0 ? '选择服务器' : '请先在测试服务器页面添加服务器'}
            onChange={(ids: number[]) => updateRow(record.envId, {
              connectionConfig: { serverIds: ids },
            })}
            options={servers.map(s => ({
              value: s.id,
              label: `${s.name} (${s.host}) - ${s.role || '无角色'}`,
            }))}
          />
        )
      },
    },
  ]

  return (
    <>
      <Spin spinning={loading}>
        <Table rowKey="envId" columns={columns} dataSource={rows} pagination={false} />
      </Spin>
      <div style={{ marginTop: 16, textAlign: 'right' }}>
        <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={handleSave} disabled={loading}>
          保存配置
        </Button>
      </div>
    </>
  )
}

// ─── Approval Rules Tab ───────────────────────────────────────────────────────

function ApprovalRulesTab({ productLineId }: { productLineId: number }) {
  const [data, setData] = useState<ApprovalRule[]>([])
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<ApprovalRule | null>(null)
  const [form] = Form.useForm()

  useEffect(() => { load() }, [productLineId])

  async function load() {
    setLoading(true)
    try { setData(await getApprovalRules(productLineId)) } finally { setLoading(false) }
  }

  function openCreate() { setEditing(null); form.resetFields(); setModalOpen(true) }
  function openEdit(record: ApprovalRule) {
    setEditing(record)
    form.setFieldsValue(record)
    setModalOpen(true)
  }

  async function handleSubmit() {
    const values = await form.validateFields()
    const body: Omit<ApprovalRule, 'id'> = {
      productLineId,
      action: values.action,
      env: values.env,
      primaryApprovers: values.primaryApprovers ?? [],
      backupApprovers: values.backupApprovers ?? [],
      primaryTimeoutMin: values.primaryTimeoutMin ?? 30,
      totalTimeoutMin: values.totalTimeoutMin ?? 60,
    }
    if (editing) {
      await updateApprovalRule(editing.id, body)
      message.success('更新成功')
    } else {
      await createApprovalRule(body)
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

  const renderApprovers = (approvers: string[]) => (
    <Space wrap>
      {approvers.map(a => <Tag key={a}>{a}</Tag>)}
    </Space>
  )

  const columns = [
    { title: 'ID', dataIndex: 'id', width: 60 },
    { title: '操作类型', dataIndex: 'action' },
    { title: '环境', dataIndex: 'env' },
    {
      title: '主审批人',
      dataIndex: 'primaryApprovers',
      render: renderApprovers,
    },
    {
      title: '备用审批人',
      dataIndex: 'backupApprovers',
      render: renderApprovers,
    },
    { title: '主超时(分钟)', dataIndex: 'primaryTimeoutMin', width: 120 },
    { title: '总超时(分钟)', dataIndex: 'totalTimeoutMin', width: 120 },
    {
      title: '操作', width: 150,
      render: (_: unknown, record: ApprovalRule) => (
        <Space>
          <a onClick={() => openEdit(record)}>编辑</a>
          <Popconfirm title="确认删除此审批规则？" onConfirm={() => handleDelete(record.id)}>
            <a style={{ color: 'red' }}>删除</a>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <>
      <div style={{ marginBottom: 16, textAlign: 'right' }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新增审批规则</Button>
      </div>
      <Table rowKey="id" columns={columns} dataSource={data} loading={loading} pagination={false} />
      <Modal
        title={editing ? '编辑审批规则' : '新增审批规则'}
        open={modalOpen}
        onOk={handleSubmit}
        onCancel={() => setModalOpen(false)}
        destroyOnClose
        width={640}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="action" label="操作类型" rules={[{ required: true, message: '请输入操作类型' }]}>
            <Input placeholder="如: deploy, rollback" />
          </Form.Item>
          <Form.Item name="env" label="环境" rules={[{ required: true, message: '请输入环境标识' }]}>
            <Input placeholder="如: prod, staging" />
          </Form.Item>
          <Form.Item name="primaryApprovers" label="主审批人（钉钉用户ID，多选）">
            <DingTalkUserSelect mode="multiple" placeholder="搜索并添加主审批人" />
          </Form.Item>
          <Form.Item name="backupApprovers" label="备用审批人（钉钉用户ID，多选）">
            <DingTalkUserSelect mode="multiple" placeholder="搜索并添加备用审批人" />
          </Form.Item>
          <Form.Item name="primaryTimeoutMin" label="主审批超时（分钟）" initialValue={30}>
            <Input type="number" min={1} />
          </Form.Item>
          <Form.Item name="totalTimeoutMin" label="总审批超时（分钟）" initialValue={60}>
            <Input type="number" min={1} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  )
}

// ─── Capabilities Tab ─────────────────────────────────────────────────────────

function CapabilitiesTab({ productLineId }: { productLineId: number }) {
  const [capabilities, setCapabilities] = useState<Capability[]>([])
  const [envs, setEnvs] = useState<Environment[]>([])
  const [plCaps, setPlCaps] = useState<ProductLineCapability[]>([])
  const [loading, setLoading] = useState(false)
  const [editingCap, setEditingCap] = useState<Capability | null>(null)
  const [editConfigs, setEditConfigs] = useState<Record<string, { enabled: boolean; allowedRoles: string[] }>>({})
  const [saving, setSaving] = useState(false)

  useEffect(() => { loadData() }, [productLineId])

  async function loadData() {
    setLoading(true)
    try {
      const [caps, environments, configs] = await Promise.all([
        getCapabilities(), getEnvironments(), getProductLineCapabilities(productLineId),
      ])
      setCapabilities(caps); setEnvs(environments); setPlCaps(configs)
    } finally { setLoading(false) }
  }

  function openEdit(cap: Capability) {
    setEditingCap(cap)
    const configs: Record<string, { enabled: boolean; allowedRoles: string[] }> = {}
    const capConfigs = plCaps.filter(c => c.capabilityKey === cap.key)
    for (const c of capConfigs) {
      configs[c.envName] = { enabled: c.enabled, allowedRoles: [...c.allowedRoles] }
    }
    setEditConfigs(configs)
  }

  function handleConfigChange(envName: string, field: 'enabled' | 'allowedRoles', value: unknown) {
    setEditConfigs(prev => ({
      ...prev,
      [envName]: {
        ...(prev[envName] ?? { enabled: true, allowedRoles: ['developer', 'tester', 'ops', 'admin'] }),
        [field]: value,
      },
    }))
  }

  async function handleSave() {
    if (!editingCap) return
    setSaving(true)
    try {
      // Keep other capabilities' configs
      const otherConfigs = plCaps
        .filter(c => c.capabilityKey !== editingCap.key)
        .map(c => ({ capabilityKey: c.capabilityKey, envName: c.envName, enabled: c.enabled, allowedRoles: c.allowedRoles }))

      const thisConfigs = Object.entries(editConfigs)
        .filter(([_, v]) => v.enabled || v.allowedRoles.length > 0)
        .map(([envName, v]) => ({ capabilityKey: editingCap.key, envName, enabled: v.enabled, allowedRoles: v.allowedRoles }))

      await setProductLineCapabilities(productLineId, [...otherConfigs, ...thisConfigs])
      message.success('能力配置已保存')
      setEditingCap(null)
      await loadData()
    } catch { message.error('保存失败') }
    finally { setSaving(false) }
  }

  const categoryColors: Record<string, string> = { query: 'blue', action: 'orange', admin: 'red' }
  const categoryLabels: Record<string, string> = { query: '查询', action: '操作', admin: '管理' }
  const roleOptions = [
    { label: '开发', value: 'developer' },
    { label: '测试', value: 'tester' },
    { label: '运维', value: 'ops' },
    { label: '管理员', value: 'admin' },
  ]

  function getConfigSummary(capKey: string): string {
    const configs = plCaps.filter(c => c.capabilityKey === capKey)
    if (configs.length === 0) return '未配置'
    const enabledCount = configs.filter(c => c.enabled).length
    return `已配置 ${configs.length} 条规则，${enabledCount} 条启用`
  }

  const columns = [
    { title: '能力名称', dataIndex: 'displayName', width: 140 },
    { title: '标识', dataIndex: 'key', width: 140 },
    { title: '描述', dataIndex: 'description', ellipsis: true },
    { title: '分类', dataIndex: 'category', width: 80,
      render: (v: string) => <Tag color={categoryColors[v]}>{categoryLabels[v] ?? v}</Tag> },
    { title: '需审批', dataIndex: 'needsApproval', width: 80,
      render: (v: boolean) => v ? <Tag color="red">是</Tag> : <Tag>否</Tag> },
    { title: '当前配置', key: 'config', width: 200,
      render: (_: unknown, record: Capability) => (
        <span style={{ color: '#999' }}>{getConfigSummary(record.key)}</span>
      ) },
    { title: '操作', key: 'action', width: 100,
      render: (_: unknown, record: Capability) => <a onClick={() => openEdit(record)}>编辑配置</a> },
  ]

  return (
    <>
      <Table rowKey="id" columns={columns} dataSource={capabilities} loading={loading} pagination={false} size="middle" />

      <Modal
        title={editingCap ? `配置能力：${editingCap.displayName}` : ''}
        open={!!editingCap}
        onOk={handleSave}
        onCancel={() => setEditingCap(null)}
        confirmLoading={saving}
        width={650}
        destroyOnClose
      >
        {editingCap && (
          <div>
            <p style={{ color: '#666', marginBottom: 16 }}>
              关联工具: {editingCap.toolNames.join(', ')}。为每个环境配置是否开放及允许角色。
            </p>

            <div style={{ marginBottom: 12, padding: '8px 12px', background: '#fafafa', borderRadius: 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
                <span style={{ fontWeight: 500, width: 120 }}>* 全局</span>
                <Switch
                  checked={editConfigs['*']?.enabled ?? false}
                  onChange={(v) => handleConfigChange('*', 'enabled', v)}
                  checkedChildren="开" unCheckedChildren="关"
                />
              </div>
              {editConfigs['*']?.enabled && (
                <Checkbox.Group
                  options={roleOptions}
                  value={editConfigs['*']?.allowedRoles ?? []}
                  onChange={(v) => handleConfigChange('*', 'allowedRoles', v)}
                />
              )}
            </div>

            {envs.map(env => (
              <div key={env.id} style={{ marginBottom: 12, padding: '8px 12px', background: '#fafafa', borderRadius: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
                  <span style={{ fontWeight: 500, width: 120 }}>{env.displayName}（{env.name}）</span>
                  <Switch
                    checked={editConfigs[env.name]?.enabled ?? false}
                    onChange={(v) => handleConfigChange(env.name, 'enabled', v)}
                    checkedChildren="开" unCheckedChildren="关"
                  />
                </div>
                {editConfigs[env.name]?.enabled && (
                  <Checkbox.Group
                    options={roleOptions}
                    value={editConfigs[env.name]?.allowedRoles ?? []}
                    onChange={(v) => handleConfigChange(env.name, 'allowedRoles', v)}
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </Modal>
    </>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function ProductLineDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const productLineId = Number(id)

  const [productLine, setProductLine] = useState<ProductLine | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!productLineId) return
    setLoading(true)
    getProductLines()
      .then(list => {
        const found = list.find(pl => pl.id === productLineId) ?? null
        setProductLine(found)
      })
      .finally(() => setLoading(false))
  }, [productLineId])

  if (loading) {
    return (
      <div style={{ padding: 40, textAlign: 'center' }}>
        <Spin size="large" />
      </div>
    )
  }

  if (!productLine) {
    return (
      <Card>
        <div style={{ padding: 24 }}>产线不存在或已删除</div>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/product-lines')}>返回列表</Button>
      </Card>
    )
  }

  const tabItems = [
    {
      key: 'basic',
      label: '基本信息',
      children: <BasicInfoTab productLine={productLine} onUpdated={setProductLine} />,
    },
    {
      key: 'projects',
      label: '项目列表',
      children: <ProjectsTab productLineId={productLineId} />,
    },
    {
      key: 'members',
      label: '成员管理',
      children: <MembersTab productLineId={productLineId} />,
    },
    {
      key: 'envs',
      label: '环境配置',
      children: <EnvConfigTab productLineId={productLineId} />,
    },
    {
      key: 'approval-rules',
      label: '审批规则',
      children: <ApprovalRulesTab productLineId={productLineId} />,
    },
    {
      key: 'capabilities',
      label: '能力配置',
      children: <CapabilitiesTab productLineId={productLineId} />,
    },
  ]

  return (
    <Card
      title={
        <Space>
          <Button
            type="text"
            icon={<ArrowLeftOutlined />}
            onClick={() => navigate('/product-lines')}
            style={{ padding: '0 4px' }}
          >
            返回列表
          </Button>
          <Divider type="vertical" />
          <Title level={5} style={{ margin: 0 }}>
            {productLine.displayName}
          </Title>
          <Tag color="blue">{productLine.name}</Tag>
        </Space>
      }
    >
      <Tabs items={tabItems} />
    </Card>
  )
}
