// web/src/pages/E2eTargetsPage.tsx
import { useState, useEffect } from 'react'
import {
  Card, Descriptions, Tag, Spin, Typography, Button, Modal,
  Form, Input, Space, message,
} from 'antd'
import { EditOutlined } from '@ant-design/icons'
import { e2eApi, type E2eTargetProject } from '../api/e2e'

const { Title, Text, Link } = Typography

interface EditFormValues {
  displayName: string
  gitlabRepo: string
  defaultBranch: string
  workingDir: string
  scriptBuild: string
  scriptDeploy: string
  scriptTest: string
  scriptFix: string
  defaultSandboxKind: string
}

function EditModal({
  open,
  project,
  gitlabBaseUrl,
  onClose,
  onSaved,
}: {
  open: boolean
  project: E2eTargetProject
  gitlabBaseUrl: string | null
  onClose: () => void
  onSaved: (updated: E2eTargetProject) => void
}) {
  const [form] = Form.useForm<EditFormValues>()
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      form.setFieldsValue({
        displayName: project.displayName,
        gitlabRepo: project.gitlabRepo,
        defaultBranch: project.defaultBranch,
        workingDir: project.workingDir,
        scriptBuild: project.scripts.build,
        scriptDeploy: project.scripts.deploy,
        scriptTest: project.scripts.test,
        scriptFix: project.scripts.fix ?? '',
        defaultSandboxKind: project.defaultSandboxKind,
      })
    }
  }, [open, project, form])

  const handleOk = async () => {
    const values = await form.validateFields()
    setSaving(true)
    try {
      const scripts: E2eTargetProject['scripts'] = {
        build: values.scriptBuild,
        deploy: values.scriptDeploy,
        test: values.scriptTest,
        ...(values.scriptFix.trim() ? { fix: values.scriptFix.trim() } : {}),
      }
      const updated = await e2eApi.updateTarget(project.id, {
        displayName: values.displayName,
        gitlabRepo: values.gitlabRepo,
        defaultBranch: values.defaultBranch,
        workingDir: values.workingDir,
        scripts,
        defaultSandboxKind: values.defaultSandboxKind,
      })
      message.success('保存成功')
      onSaved(updated)
      onClose()
    } catch {
      message.error('保存失败')
    } finally {
      setSaving(false)
    }
  }

  const repoExtra = gitlabBaseUrl
    ? `系统 GitLab 基础地址：${gitlabBaseUrl}，凭证由系统配置提供，此处填写完整 git 地址`
    : '凭证由系统 GitLab 配置提供，此处填写完整 git 地址'

  return (
    <Modal
      title="编辑被测项目"
      open={open}
      onOk={handleOk}
      onCancel={onClose}
      confirmLoading={saving}
      width={560}
      destroyOnClose
    >
      <Form form={form} layout="vertical" style={{ marginTop: 8 }}>
        <Form.Item name="displayName" label="显示名称" rules={[{ required: true }]}>
          <Input />
        </Form.Item>
        <Form.Item
          name="gitlabRepo"
          label="GitLab 仓库地址"
          rules={[{ required: true, message: '请输入仓库地址' }]}
          extra={repoExtra}
        >
          <Input placeholder="https://gitlab.example.com/group/repo.git" />
        </Form.Item>
        <Form.Item name="defaultBranch" label="默认分支" rules={[{ required: true }]}>
          <Input placeholder="main" />
        </Form.Item>
        <Form.Item name="workingDir" label="工作目录" rules={[{ required: true }]}>
          <Input placeholder="." />
        </Form.Item>
        <Form.Item name="defaultSandboxKind" label="沙盒类型" rules={[{ required: true }]}>
          <Input placeholder="docker-compose-local" />
        </Form.Item>
        <Form.Item label="脚本路径">
          <Space direction="vertical" style={{ width: '100%' }}>
            <Form.Item name="scriptBuild" label="build.sh" style={{ marginBottom: 0 }} rules={[{ required: true }]}>
              <Input placeholder="build.sh" addonBefore="build" />
            </Form.Item>
            <Form.Item name="scriptDeploy" label="deploy.sh" style={{ marginBottom: 0 }} rules={[{ required: true }]}>
              <Input placeholder="deploy.sh" addonBefore="deploy" />
            </Form.Item>
            <Form.Item name="scriptTest" label="test.sh" style={{ marginBottom: 0 }} rules={[{ required: true }]}>
              <Input placeholder="test.sh" addonBefore="test" />
            </Form.Item>
            <Form.Item name="scriptFix" label="fix.sh（可选）" style={{ marginBottom: 0 }}>
              <Input placeholder="fix.sh（留空则不启用）" addonBefore="fix" />
            </Form.Item>
          </Space>
        </Form.Item>
      </Form>
    </Modal>
  )
}

export default function E2eTargetsPage() {
  const [project, setProject] = useState<E2eTargetProject | null>(null)
  const [loading, setLoading] = useState(true)
  const [editOpen, setEditOpen] = useState(false)
  const [gitlabBaseUrl, setGitlabBaseUrl] = useState<string | null>(null)

  useEffect(() => {
    e2eApi.getTarget('chatops')
      .then(setProject)
      .catch(() => {})
      .finally(() => setLoading(false))
    e2eApi.getGitlabBaseUrl()
      .then(r => setGitlabBaseUrl(r.url))
      .catch(() => {})
  }, [])

  if (loading) return <Spin style={{ display: 'block', margin: '48px auto' }} />
  if (!project) return <Text type="danger">未找到 chatops 项目配置</Text>

  const repoUrl = gitlabBaseUrl && !project.gitlabRepo.startsWith('http')
    ? `${gitlabBaseUrl.replace(/\/$/, '')}/${project.gitlabRepo}`
    : project.gitlabRepo

  return (
    <div style={{ padding: 24, maxWidth: 800 }}>
      <Space style={{ marginBottom: 16, width: '100%', justifyContent: 'space-between' }}>
        <Title level={4} style={{ margin: 0 }}>被测项目详情</Title>
        <Button icon={<EditOutlined />} onClick={() => setEditOpen(true)}>编辑</Button>
      </Space>
      <Card>
        <Descriptions column={1} bordered size="small">
          <Descriptions.Item label="项目 ID"><Text code>{project.id}</Text></Descriptions.Item>
          <Descriptions.Item label="显示名称">{project.displayName}</Descriptions.Item>
          <Descriptions.Item label="GitLab 仓库">
            <Link href={repoUrl} target="_blank">{project.gitlabRepo}</Link>
          </Descriptions.Item>
          <Descriptions.Item label="默认分支"><Tag>{project.defaultBranch}</Tag></Descriptions.Item>
          <Descriptions.Item label="工作目录"><Text code>{project.workingDir}</Text></Descriptions.Item>
          <Descriptions.Item label="沙盒类型"><Tag color="blue">{project.defaultSandboxKind}</Tag></Descriptions.Item>
          <Descriptions.Item label="build"><Text code>{project.scripts.build}</Text></Descriptions.Item>
          <Descriptions.Item label="deploy"><Text code>{project.scripts.deploy}</Text></Descriptions.Item>
          <Descriptions.Item label="test"><Text code>{project.scripts.test}</Text></Descriptions.Item>
          {project.scripts.fix && (
            <Descriptions.Item label="fix"><Text code>{project.scripts.fix}</Text></Descriptions.Item>
          )}
          {Object.keys(project.capabilities).length > 0 && (
            <Descriptions.Item label="能力">
              {Object.entries(project.capabilities).map(([k, v]) => (
                <Tag key={k} color={v ? 'green' : 'default'}>{k}</Tag>
              ))}
            </Descriptions.Item>
          )}
        </Descriptions>
      </Card>
      <EditModal
        open={editOpen}
        project={project}
        gitlabBaseUrl={gitlabBaseUrl}
        onClose={() => setEditOpen(false)}
        onSaved={setProject}
      />
    </div>
  )
}
