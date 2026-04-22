import { Drawer, Form, Input, InputNumber, Select, Switch, Alert, Tag, Tooltip } from 'antd'
import { ExclamationCircleTwoTone } from '@ant-design/icons'
import { useEffect, useState } from 'react'
import type { StageNode, StageFields, ImInputConfig } from '../types'
import type { CapabilityOption } from '../PipelineCanvasPage'

interface Props {
  node: StageNode | null
  onClose: () => void
  onChange: (id: string, data: Partial<StageFields>) => void
  availableRoles: string[]
  dingtalkUsers: { userId: string; name: string }[]
  capabilities: CapabilityOption[]
}

const DEFAULT_SCHEMA: Record<string, unknown> = { type: 'object', properties: {}, required: [] }

function capabilityOptions(list: CapabilityOption[], currentKey?: string) {
  const known = new Set(list.map(c => c.key))
  const opts = list.map(c => ({
    value: c.key,
    label: (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div>{c.displayName}</div>
          <div style={{ fontSize: 11, color: '#999' }}>{c.key}</div>
        </div>
        <Tag>{c.category}</Tag>
      </div>
    ),
    key: c.key,
    searchText: `${c.displayName} ${c.key}`,
  }))
  if (currentKey && !known.has(currentKey)) {
    opts.unshift({
      value: currentKey,
      label: (
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <ExclamationCircleTwoTone twoToneColor="#faad14" style={{ marginRight: 6 }} />
          <span>{currentKey}（不在能力列表中）</span>
        </div>
      ),
      key: currentKey,
      searchText: currentKey,
    })
  }
  return opts
}

export function NodeInspector({ node, onClose, onChange, availableRoles, dingtalkUsers, capabilities }: Props) {
  const [form] = Form.useForm()
  // paramSchema 作为 JSON 字符串在 Inspector 本地维护，避免 antd Form 在每次按键
  // 时重新受控导致编辑中断；onBlur 时解析并提交。
  const [paramSchemaText, setParamSchemaText] = useState('')
  const [paramSchemaErr, setParamSchemaErr] = useState<string | null>(null)

  useEffect(() => {
    if (node) {
      form.setFieldsValue(node.data)
      if (node.data.stageType === 'im_input') {
        const s = node.data.imInputConfig?.paramSchema ?? DEFAULT_SCHEMA
        setParamSchemaText(JSON.stringify(s, null, 2))
        setParamSchemaErr(null)
      }
    }
  }, [node, form])

  if (!node) return null

  function handleValuesChange(_: unknown, all: Partial<StageFields>) {
    // im_input 的 paramSchema 不在 Form 里，Form 触发变化时需要把本地 paramSchema
    // 合并回 imInputConfig，否则 updateNodeData 浅合并会丢掉 paramSchema。
    if (node!.data.stageType === 'im_input' && all.imInputConfig) {
      let schema = node!.data.imInputConfig?.paramSchema ?? DEFAULT_SCHEMA
      try {
        schema = JSON.parse(paramSchemaText)
      } catch {
        // 保留上一次已知良好的 schema
      }
      all = {
        ...all,
        imInputConfig: {
          ...(all.imInputConfig as Partial<ImInputConfig>),
          paramSchema: schema,
        } as ImInputConfig,
      }
    }
    onChange(node!.id, all)
  }

  function handleParamSchemaBlur() {
    try {
      const parsed = JSON.parse(paramSchemaText)
      setParamSchemaErr(null)
      const current = form.getFieldValue('imInputConfig') as Partial<ImInputConfig> | undefined
      onChange(node!.id, {
        imInputConfig: {
          ...(current ?? node!.data.imInputConfig ?? {}),
          paramSchema: parsed,
        } as ImInputConfig,
      })
    } catch (e) {
      setParamSchemaErr((e as Error).message)
    }
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
            { value: 'im_input', label: 'IM 参数采集' },
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
              <Form.Item
                name="capabilityKey"
                label="Capability"
                rules={[{ required: true, message: '请选择 Capability' }]}
              >
                <Select
                  showSearch
                  placeholder="选择一个 Agent Capability"
                  options={capabilityOptions(capabilities, node!.data.capabilityKey)}
                  filterOption={(input, opt) => {
                    const t = (opt as { searchText?: string } | undefined)?.searchText ?? ''
                    return t.toLowerCase().includes(input.toLowerCase())
                  }}
                />
              </Form.Item>
            )
            if (t === 'wait_webhook') return (
              <Form.Item name="webhookTag" label="Webhook Tag">
                <Input />
              </Form.Item>
            )
            if (t === 'im_input') return (
              <>
                <Form.Item name={['imInputConfig', 'prompt']} label="引导语" rules={[{ required: true }]}>
                  <Input.TextArea rows={3} placeholder="请提供以下参数：..." />
                </Form.Item>
                <Form.Item label="参数 Schema (JSON Schema)" required>
                  <Input.TextArea
                    rows={10}
                    value={paramSchemaText}
                    onChange={(e) => setParamSchemaText(e.target.value)}
                    onBlur={handleParamSchemaBlur}
                    style={{ fontFamily: 'monospace', fontSize: 12 }}
                  />
                  {paramSchemaErr && (
                    <Alert type="error" showIcon style={{ marginTop: 8 }} message={`JSON 解析失败：${paramSchemaErr}`} />
                  )}
                </Form.Item>
                <Form.Item name={['imInputConfig', 'capabilityKey']} label="关联 Capability（可选）">
                  <Select
                    allowClear
                    showSearch
                    placeholder="留空即可；用于增强 IM 参数判定的上下文"
                    options={capabilityOptions(capabilities, node!.data.imInputConfig?.capabilityKey)}
                    filterOption={(input, opt) => {
                      const t = (opt as { searchText?: string } | undefined)?.searchText ?? ''
                      return t.toLowerCase().includes(input.toLowerCase())
                    }}
                  />
                </Form.Item>
                <Form.Item name={['imInputConfig', 'timeoutSeconds']} label="采集超时 (秒)">
                  <InputNumber min={30} />
                </Form.Item>
              </>
            )
            return null
          }}
        </Form.Item>
      </Form>
    </Drawer>
  )
}
