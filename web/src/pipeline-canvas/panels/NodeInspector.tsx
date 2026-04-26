import { Drawer, Form, Input, InputNumber, Select, Switch, Alert, Tag, Tooltip, Modal, message } from 'antd'
import { ExclamationCircleTwoTone } from '@ant-design/icons'
import { useEffect, useState } from 'react'
import type { StageNode, StageFields, ImInputConfig } from '../types'
import type { CapabilityOption } from '../PipelineCanvasPage'
import { pruneStageFields, obsoleteFieldsOnSwitch } from './pruneStageFields'
import { CapabilityParamsForm } from './CapabilityParamsForm'
import { listPipelineNodeTypes } from '../../api/pipelineNodeTypes'
import type { PipelineNodeType } from '../../types/pipelineNodeType'

const CATEGORY_LABELS: Record<string, string> = {
  general: '通用',
  flow: '流程',
  llm: 'LLM',
  specialized: '业务',
}

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

function filterParamsBySchema(
  params: Record<string, unknown>,
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const props = (schema as { properties?: unknown }).properties
  if (typeof props !== 'object' || props === null) return {}
  const keys = new Set(Object.keys(props as Record<string, unknown>))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(params)) {
    if (keys.has(k)) out[k] = v
  }
  return out
}

export function NodeInspector({ node, onClose, onChange, availableRoles, dingtalkUsers, capabilities }: Props) {
  const [form] = Form.useForm()
  // paramSchema 作为 JSON 字符串在 Inspector 本地维护，避免 antd Form 在每次按键
  // 时重新受控导致编辑中断；onBlur 时解析并提交。
  const [paramSchemaText, setParamSchemaText] = useState('')
  const [paramSchemaErr, setParamSchemaErr] = useState<string | null>(null)
  const [nodeTypes, setNodeTypes] = useState<PipelineNodeType[]>([])

  useEffect(() => {
    listPipelineNodeTypes()
      .then(setNodeTypes)
      .catch((err) => {
        console.error(err)
        message.error('节点类型列表加载失败，请刷新页面')
      })
  }, [])

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
    // stageType 的变更由 handleStageTypeChange 独占处理（含 Modal.confirm + prune），
    // 这里跳过以避免双写与 Cancel 路径漏回滚。
    if (all.stageType !== undefined && all.stageType !== node!.data.stageType) {
      return
    }
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

  function handleStageTypeChange(newType: StageFields['stageType']) {
    if (!node) return
    const obsolete = obsoleteFieldsOnSwitch(node.data, newType)
    if (obsolete.length === 0) {
      const pruned = pruneStageFields(node.data, newType)
      form.setFieldsValue(pruned)
      onChange(node.id, pruned)
      return
    }
    Modal.confirm({
      title: '切换类型将清空字段',
      content: `将清空：${obsolete.join(', ')}。确认继续？`,
      okText: '确认切换',
      cancelText: '取消',
      onOk: () => {
        const pruned = pruneStageFields(node.data, newType)
        form.setFieldsValue(pruned)
        onChange(node.id, pruned)
      },
      onCancel: () => {
        form.setFieldsValue({ stageType: node.data.stageType })
      },
    })
  }

  return (
    <Drawer title={`节点: ${node.data.name || '未命名'}`} open onClose={onClose} width={420} mask={false}>
      <Form form={form} layout="vertical" onValuesChange={handleValuesChange}>
        <Form.Item name="name" label="名称" rules={[{ required: true }]}>
          <Input />
        </Form.Item>
        <Form.Item name="stageType" label="类型">
          <Select onChange={(newType) => handleStageTypeChange(newType)}>
            {Object.entries(
              nodeTypes.reduce<Record<string, PipelineNodeType[]>>((acc, t) => {
                ;(acc[t.category] ??= []).push(t)
                return acc
              }, {})
            ).map(([cat, items]) => (
              <Select.OptGroup key={cat} label={CATEGORY_LABELS[cat] ?? cat}>
                {items.map(t => (
                  <Select.Option key={t.key} value={t.key}>
                    {t.displayName}
                  </Select.Option>
                ))}
              </Select.OptGroup>
            ))}
            {node.data?.stageType
              && !nodeTypes.some(t => t.key === node.data.stageType)
              && nodeTypes.length > 0 && (
              <Select.Option value={node.data.stageType} key={`__stale_${node.data.stageType}`}>
                <ExclamationCircleTwoTone twoToneColor="#faad14" /> {node.data.stageType}（已禁用）
              </Select.Option>
            )}
          </Select>
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

        <Form.Item shouldUpdate={(p, c) => p.stageType !== c.stageType || p.capabilityKey !== c.capabilityKey} noStyle>
          {({ getFieldValue }) => {
            const t = getFieldValue('stageType')
            if (t === 'script') return (
              <>
                <Form.Item name="targetRoles" label="目标角色">
                  <Select mode="multiple" options={availableRoles.map(r => ({ value: r, label: r }))} />
                </Form.Item>
                <Form.Item name="script" label="脚本">
                  <Input.TextArea rows={8} style={{ fontFamily: 'monospace', fontSize: 12 }} />
                </Form.Item>
              </>
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
            if (t === 'capability') {
              const selectedKey = getFieldValue('capabilityKey') as string | undefined
              const selected = capabilities.find(c => c.key === selectedKey)
              return (
                <>
                  <Form.Item
                    name="capabilityKey"
                    label="Capability"
                    rules={[{ required: true, message: '请选择 Capability' }]}
                  >
                    <Select
                      showSearch
                      placeholder="选择一个 Agent Capability"
                      options={capabilityOptions(capabilities, selectedKey)}
                      filterOption={(input, opt) => {
                        const tx = (opt as { searchText?: string } | undefined)?.searchText ?? ''
                        return tx.toLowerCase().includes(input.toLowerCase())
                      }}
                      onChange={(newKey) => {
                        const newSchema = capabilities.find(c => c.key === newKey)?.paramSchema ?? {}
                        const currentParams = (getFieldValue('capabilityParams') as Record<string, unknown> | undefined) ?? {}
                        const filtered = filterParamsBySchema(currentParams, newSchema)
                        form.setFieldsValue({ capabilityParams: filtered })
                        onChange(node!.id, { capabilityKey: newKey, capabilityParams: filtered })
                      }}
                    />
                  </Form.Item>
                  {selected && (
                    <Form.Item shouldUpdate noStyle>
                      {() => (
                        <CapabilityParamsForm
                          paramSchema={selected.paramSchema}
                          value={form.getFieldValue('capabilityParams') as Record<string, unknown> | undefined}
                          onChange={(next) => {
                            form.setFieldsValue({ capabilityParams: next })
                            onChange(node!.id, { capabilityParams: next })
                          }}
                        />
                      )}
                    </Form.Item>
                  )}
                </>
              )
            }
            if (t === 'wait_webhook') return (
              <Form.Item name="webhookTag" label="Webhook Tag" rules={[{ required: true, message: 'Webhook Tag 必填' }]}>
                <Input placeholder="例如 mr-merge:PAM/java-code/pas-6.0:123，支持 {{vars.xxx}} 模板" />
              </Form.Item>
            )
            if (t === 'im_input') return (
              <>
                <Form.Item
                  name={['imInputConfig', 'prompt']}
                  label="引导语"
                  rules={[{ required: true, message: '引导语必填' }]}
                  extra="支持 {{vars.xxx}} / {{triggerParams.xxx}} 模板"
                >
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
