import { Form, Input, Button, message } from 'antd'
import { updateTestPipeline } from '../../api/test-pipelines'
import type { TestPipeline } from '../../types'

interface Props {
  pipeline: TestPipeline
  onSaved: (updated: TestPipeline) => void
}

export default function PipelineSettingsPanel({ pipeline, onSaved }: Props) {
  const [form] = Form.useForm<{ containerImage: string }>()

  const handleSave = async () => {
    const values = await form.validateFields()
    const image = values.containerImage?.trim() ?? ''
    try {
      const updated = await updateTestPipeline(pipeline.id, { containerImage: image || null })
      onSaved(updated)
      void message.success('已保存')
    } catch {
      void message.error('保存失败')
    }
  }

  return (
    <Form
      form={form}
      layout="vertical"
      initialValues={{ containerImage: pipeline.containerImage ?? '' }}
    >
      <Form.Item
        name="containerImage"
        label="默认容器镜像"
        extra="script 节点无 role 时使用此 image 在本机 Docker 容器内执行；留空则关闭 Docker 模式"
      >
        <Input placeholder="例如：node:18、harbor.internal/myapp:latest" allowClear />
      </Form.Item>
      <Form.Item>
        <Button type="primary" onClick={handleSave}>保存</Button>
      </Form.Item>
    </Form>
  )
}
