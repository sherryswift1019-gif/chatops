// web/src/pages/E2eTargetsPage.tsx
import { useState, useEffect } from 'react'
import { Card, Descriptions, Tag, Spin, Typography } from 'antd'
import { e2eApi, type E2eTargetProject } from '../api/e2e'

const { Title, Text, Link } = Typography

function ScriptTag({ path }: { path: string }) {
  return <Text code>{path}</Text>
}

export default function E2eTargetsPage() {
  const [project, setProject] = useState<E2eTargetProject | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    e2eApi.getTarget('chatops')
      .then(setProject)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <Spin style={{ display: 'block', margin: '48px auto' }} />
  if (!project) return <Text type="danger">未找到 chatops 项目配置</Text>

  return (
    <div style={{ padding: 24, maxWidth: 800 }}>
      <Title level={4}>被测项目详情</Title>
      <Card>
        <Descriptions column={1} bordered size="small">
          <Descriptions.Item label="项目 ID"><Text code>{project.id}</Text></Descriptions.Item>
          <Descriptions.Item label="显示名称">{project.displayName}</Descriptions.Item>
          <Descriptions.Item label="GitLab 仓库">
            <Link href={`https://gitlab.example.com/${project.gitlabRepo}`} target="_blank">{project.gitlabRepo}</Link>
          </Descriptions.Item>
          <Descriptions.Item label="默认分支"><Tag>{project.defaultBranch}</Tag></Descriptions.Item>
          <Descriptions.Item label="沙盒类型"><Tag color="blue">{project.defaultSandboxKind}</Tag></Descriptions.Item>
          <Descriptions.Item label="build.sh"><ScriptTag path={project.scripts.build} /></Descriptions.Item>
          <Descriptions.Item label="deploy.sh"><ScriptTag path={project.scripts.deploy} /></Descriptions.Item>
          <Descriptions.Item label="test.sh"><ScriptTag path={project.scripts.test} /></Descriptions.Item>
          {project.scripts.fix && (
            <Descriptions.Item label="fix.sh (可选)"><ScriptTag path={project.scripts.fix} /></Descriptions.Item>
          )}
          <Descriptions.Item label="能力">
            {Object.entries(project.capabilities).map(([k, v]) => (
              <Tag key={k} color={v ? 'green' : 'default'}>{k}</Tag>
            ))}
          </Descriptions.Item>
        </Descriptions>
      </Card>
    </div>
  )
}
