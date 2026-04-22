import { Drawer, Form, Input, InputNumber, Select, Switch } from 'antd'
import { useEffect } from 'react'
import type { StageNode, StageFields } from '../types'

interface Props {
  node: StageNode | null
  onClose: () => void
  onChange: (id: string, data: Partial<StageFields>) => void
  availableRoles: string[]
  dingtalkUsers: { userId: string; name: string }[]
}

export function NodeInspector({ node, onClose, onChange, availableRoles, dingtalkUsers }: Props) {
  const [form] = Form.useForm()
  useEffect(() => {
    if (node) form.setFieldsValue(node.data)
  }, [node, form])

  if (!node) return null

  function handleValuesChange(_: unknown, all: Partial<StageFields>) {
    onChange(node!.id, all)
  }

  return (
    <Drawer title={`节点: ${node.data.name || '未命名'}`} open onClose={onClose} width={420} mask={false}>
      <Form form={form} layout="vertical" onValuesChange={handleValuesChange}>
        <Form.Item name="name" label="名称" rules={[{ required: true }]}>
          <Input />
        </Form.Item>
        <Form.Item name="stageType" label="类型">
          <Select options={[
            { value: 'script', label: '运行脚本' },
            { value: 'approval', label: '人员审批' },
            { value: 'capability', label: 'Agent Capability' },
            { value: 'wait_webhook', label: '等待 Webhook' },
          ]} />
        </Form.Item>
        <Form.Item name="targetRoles" label="目标角色">
          <Select mode="multiple" options={availableRoles.map(r => ({ value: r, label: r }))} />
        </Form.Item>
        <Form.Item name="timeoutSeconds" label="超时(秒)">
          <InputNumber min={10} />
        </Form.Item>
        <Form.Item name="retryCount" label="重试次数">
          <InputNumber min={0} max={5} />
        </Form.Item>
        <Form.Item name="onFailure" label="失败策略">
          <Select options={[{ value: 'stop', label: '停止' }, { value: 'continue', label: '继续' }]} />
        </Form.Item>
        <Form.Item name="parallel" label="并行" valuePropName="checked">
          <Switch />
        </Form.Item>

        <Form.Item shouldUpdate={(p, c) => p.stageType !== c.stageType} noStyle>
          {({ getFieldValue }) => {
            const t = getFieldValue('stageType')
            if (t === 'script') return (
              <Form.Item name="script" label="脚本">
                <Input.TextArea rows={8} style={{ fontFamily: 'monospace', fontSize: 12 }} />
              </Form.Item>
            )
            if (t === 'approval') return (
              <>
                <Form.Item name="approverIds" label="审批人">
                  <Select mode="multiple" options={dingtalkUsers.map(u => ({ value: u.userId, label: u.name }))} />
                </Form.Item>
                <Form.Item name="approvalDescription" label="审批描述">
                  <Input />
                </Form.Item>
              </>
            )
            if (t === 'capability') return (
              <Form.Item name="capabilityKey" label="Capability Key">
                <Input placeholder="pipeline_xxx / deploy / ..." />
              </Form.Item>
            )
            if (t === 'wait_webhook') return (
              <Form.Item name="webhookTag" label="Webhook Tag">
                <Input />
              </Form.Item>
            )
            return null
          }}
        </Form.Item>
      </Form>
    </Drawer>
  )
}
