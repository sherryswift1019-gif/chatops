import { Drawer, Form, Input, InputNumber, Select, Switch, Alert, Tooltip, Modal, Collapse, Typography, message, Radio, Tabs, Button, Popconfirm } from 'antd'
import { ExclamationCircleTwoTone, DeleteOutlined } from '@ant-design/icons'
import { useEffect, useMemo, useState } from 'react'
import type { StageNode, StageFields, StageType } from '../types'
import { BESPOKE_STAGE_TYPES } from '../types'
import type { CapabilityOption } from '../PipelineCanvasPage'
import { pruneStageFields, obsoleteFieldsOnSwitch } from './pruneStageFields'
import { CapabilityParamsForm } from './CapabilityParamsForm'
import { listPipelineNodeTypes } from '../../api/pipelineNodeTypes'
import type { PipelineNodeType } from '../../types/pipelineNodeType'
import { UpstreamFieldsTab } from './UpstreamFieldsTab'

const CATEGORY_LABELS: Record<string, string> = {  general: '通用',
  flow: '流程',
  llm: 'LLM',
  specialized: '业务',
}

interface Props {
  node: StageNode | null
  onClose: () => void
  onChange: (id: string, data: Partial<StageFields>) => void
  onDelete?: (id: string) => void
  availableRoles: string[]
  dingtalkUsers: { userId: string; name: string }[]
  capabilities: CapabilityOption[]
  pipelineId?: number
  ancestors?: Set<string>
  onRunUpstream?: (nodeId: string) => void
  pipelineContainerImage?: string | null
}

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

// ---------------------------------------------------------------------------
// JSON Schema 驱动的动态参数表单（phase 3 新增 7 节点：http / dm / db_update /
// sql_query / file_read / template_render / fan_out 共用）
// ---------------------------------------------------------------------------

interface JsonSchemaField {
  type?: string
  title?: string
  description?: string
  enum?: string[]
  format?: string
  default?: unknown
  items?: JsonSchemaField
  properties?: Record<string, JsonSchemaField>
  required?: string[]
}

function renderField(
  fieldSchema: JsonSchemaField,
  value: unknown,
  onChange: (v: unknown) => void,
): JSX.Element {
  if (Array.isArray(fieldSchema.enum) && fieldSchema.enum.length > 0) {
    return (
      <Select
        value={value as string | undefined}
        onChange={onChange}
        options={fieldSchema.enum.map((e) => ({ label: e, value: e }))}
        style={{ width: '100%' }}
        allowClear
      />
    )
  }
  if (fieldSchema.type === 'string' && fieldSchema.format === 'textarea') {
    return (
      <Input.TextArea
        value={(value as string | undefined) ?? ''}
        onChange={(e) => onChange(e.target.value)}
        rows={4}
        style={{ fontFamily: 'monospace', fontSize: 12 }}
      />
    )
  }
  if (fieldSchema.type === 'string') {
    return (
      <Input
        value={(value as string | undefined) ?? ''}
        onChange={(e) => onChange(e.target.value)}
      />
    )
  }
  if (fieldSchema.type === 'number' || fieldSchema.type === 'integer') {
    return (
      <InputNumber
        value={value as number | undefined}
        onChange={(v) => onChange(v)}
        style={{ width: '100%' }}
      />
    )
  }
  if (fieldSchema.type === 'boolean') {
    return <Switch checked={!!value} onChange={onChange} />
  }
  if (fieldSchema.type === 'array' && fieldSchema.items?.type === 'string') {
    return (
      <Select
        mode="tags"
        value={(value as string[] | undefined) ?? []}
        onChange={onChange}
        style={{ width: '100%' }}
        tokenSeparators={[',']}
      />
    )
  }
  // 兜底：array(非 string items) / object / 未知类型 → JSON 文本框
  return <ObjectJsonField value={value} onChange={onChange} />
}

function ObjectJsonField({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const [text, setText] = useState(() => JSON.stringify(value ?? null, null, 2))
  const [err, setErr] = useState<string | null>(null)
  // 当外部 value 变化（如切换节点）时重置文本
  useEffect(() => {
    setText(JSON.stringify(value ?? null, null, 2))
    setErr(null)
  }, [value])
  return (
    <>
      <Input.TextArea
        value={text}
        rows={6}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          try {
            const parsed = JSON.parse(text)
            setErr(null)
            onChange(parsed)
          } catch (e) {
            setErr((e as Error).message)
          }
        }}
        style={{ fontFamily: 'monospace', fontSize: 12 }}
      />
      {err && <Alert type="error" showIcon style={{ marginTop: 4 }} message={`JSON 解析失败：${err}`} />}
    </>
  )
}

function DynamicParamsForm({
  schema,
  value,
  onChange,
}: {
  schema: Record<string, unknown> | undefined
  value: Record<string, unknown> | undefined
  onChange: (v: Record<string, unknown>) => void
}) {
  if (!schema || (schema as JsonSchemaField).type !== 'object') {
    return (
      <Alert
        type="info"
        showIcon
        message="该节点类型未提供 paramSchema，参数请直接以 JSON 形式编辑"
      />
    )
  }
  const s = schema as JsonSchemaField
  const props = s.properties ?? {}
  const required = new Set(s.required ?? [])
  const v = value ?? {}
  return (
    <>
      {Object.entries(props).map(([key, fieldSchema]) => (
        <Form.Item
          key={key}
          label={
            <span>
              {fieldSchema.title ?? key}
              <Typography.Text type="secondary" style={{ marginLeft: 4, fontSize: 11 }}>
                ({key})
              </Typography.Text>
            </span>
          }
          required={required.has(key)}
          extra={fieldSchema.description}
        >
          {renderField(fieldSchema, v[key], (next) => onChange({ ...v, [key]: next }))}
        </Form.Item>
      ))}
      {Object.keys(props).length === 0 && (
        <Alert type="info" showIcon message="paramSchema.properties 为空" />
      )}
    </>
  )
}export function NodeInspector({ node, onClose, onChange, onDelete, availableRoles, dingtalkUsers, capabilities, pipelineId, ancestors, onRunUpstream, pipelineContainerImage }: Props) {
  const [form] = Form.useForm()
  const [nodeTypes, setNodeTypes] = useState<PipelineNodeType[]>([])

  const nodeTypeByKey = useMemo(() => {
    const m: Record<string, PipelineNodeType> = {}
    for (const t of nodeTypes) m[t.key] = t
    return m
  }, [nodeTypes])

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
      form.setFieldsValue({
        agentMode: node.data.agentMode ?? 'capability',
        ...node.data,
      })
    }
  }, [node, form])

  if (!node) return null

  function handleValuesChange(_: unknown, all: Partial<StageFields>) {
    // stageType 的变更由 handleStageTypeChange 独占处理（含 Modal.confirm + prune），
    // 这里跳过以避免双写与 Cancel 路径漏回滚。
    if (all.stageType !== undefined && all.stageType !== node!.data.stageType) {
      return
    }
    // agentMode 切换时清理对侧字段，避免残留值被后端读取
    if ('agentMode' in all) {
      const newMode = all.agentMode as string
      if (newMode === 'custom') {
        form.setFieldsValue({ capabilityKey: undefined, capabilityParams: undefined })
        all = { ...all, capabilityKey: undefined, capabilityParams: undefined }
      } else {
        form.setFieldsValue({ customPrompt: undefined, allowedTools: undefined })
        all = { ...all, customPrompt: undefined, allowedTools: undefined }
      }
    }
    onChange(node!.id, all)
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
    <Drawer
      title={`节点: ${node.data.name || '未命名'}`}
      open
      onClose={onClose}
      width={420}
      mask={false}
      extra={onDelete ? (
        <Popconfirm
          title="确认删除该节点？"
          description="删除节点将同时移除所有连接到该节点的连线，可通过撤销恢复。"
          onConfirm={() => { onDelete(node.id); onClose() }}
          okText="删除"
          cancelText="取消"
          okButtonProps={{ danger: true }}
        >
          <Button danger icon={<DeleteOutlined />}>删除节点</Button>
        </Popconfirm>
      ) : null}
    >
      <Tabs
        items={[
          {
            key: 'params',
            label: '参数',
            children: (
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

                <Form.Item shouldUpdate={(p, c) => p.stageType !== c.stageType || p.capabilityKey !== c.capabilityKey || p.agentMode !== c.agentMode} noStyle>
                  {({ getFieldValue }) => {
                    const t = getFieldValue('stageType')
                    if (t === 'script') {
                      const roles: string[] = getFieldValue('targetRoles') ?? []
                      const hasRoles = roles.length > 0
                      return (
                        <>
                          <Form.Item name="targetRoles" label="目标角色">
                            <Select mode="multiple" options={availableRoles.map(r => ({ value: r, label: r }))} />
                          </Form.Item>
                          <Form.Item
                            name="containerImage"
                            label="容器镜像（覆盖 pipeline 默认）"
                            extra={
                              hasRoles
                                ? '已配置 role，此节点走 SSH 执行，镜像设置无效'
                                : pipelineContainerImage
                                  ? `继承自 pipeline：${pipelineContainerImage}`
                                  : '无 pipeline 默认镜像，需填写或配置 role'
                            }
                          >
                            <Input
                              placeholder="留空则继承 pipeline 默认"
                              disabled={hasRoles}
                              allowClear
                            />
                          </Form.Item>
                          <Form.Item name="script" label="脚本">
                            <Input.TextArea rows={8} style={{ fontFamily: 'monospace', fontSize: 12 }} />
                          </Form.Item>
                        </>
                      )
                    }
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
                    if (t === 'llm_agent') {
                      const agentMode = (getFieldValue('agentMode') as string | undefined) ?? 'capability'
                      const selectedKey = getFieldValue('capabilityKey') as string | undefined
                      const selected = capabilities.find(c => c.key === selectedKey)
                      return (
                        <>
                          <Form.Item label="模式" name="agentMode" initialValue="capability">
                            <Radio.Group>
                              <Radio.Button value="capability">已有能力</Radio.Button>
                              <Radio.Button value="custom">自定义</Radio.Button>
                            </Radio.Group>
                          </Form.Item>

                          {agentMode === 'custom' ? (
                            <>
                              <Form.Item
                                label="系统提示词"
                                name="customPrompt"
                                rules={[{ required: true, message: '自定义模式必须填写提示词' }]}
                              >
                                <Input.TextArea
                                  rows={6}
                                  style={{ fontFamily: 'monospace', fontSize: 12 }}
                                  placeholder="告诉 Claude 要做什么。支持 {{triggerParams.xxx}} 模板变量。"
                                />
                              </Form.Item>
                              <Form.Item label="可用工具" name="allowedTools">
                                <Select
                                  mode="multiple"
                                  placeholder="不选则禁用文件读写工具"
                                  options={[
                                    { value: 'WebFetch', label: 'WebFetch（HTTP 抓取）' },
                                    { value: 'WebSearch', label: 'WebSearch（搜索）' },
                                  ]}
                                />
                              </Form.Item>
                              <Form.Item name="outputFormat" label="输出格式" initialValue="string"
                                extra="JSON 模式下输出必须是 JSON 对象，否则该节点失败">
                                <Radio.Group>
                                  <Radio value="json">JSON</Radio>
                                  <Radio value="string">字符串</Radio>
                                </Radio.Group>
                              </Form.Item>
                            </>
                          ) : (
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
                                    // phase 2 cleanup: capability.paramSchema 已删，新选 capability 时不再按 schema 过滤参数。
                                    // 已填写的 capabilityParams 直接保留（JSON fallback 形式由用户自行编辑）。
                                    const currentParams = (getFieldValue('capabilityParams') as Record<string, unknown> | undefined) ?? {}
                                    onChange(node!.id, { capabilityKey: newKey, capabilityParams: currentParams })
                                  }}
                                />
                              </Form.Item>
                              {selected && (
                                <Form.Item shouldUpdate noStyle>
                                  {() => (
                                    <CapabilityParamsForm
                                      paramSchema={undefined}
                                      value={form.getFieldValue('capabilityParams') as Record<string, unknown> | undefined}
                                      onChange={(next) => {
                                        form.setFieldsValue({ capabilityParams: next })
                                        onChange(node!.id, { capabilityParams: next })
                                      }}
                                    />
                                  )}
                                </Form.Item>
                              )}
                              <Form.Item name="outputFormat" label="输出格式" initialValue="json"
                                extra="JSON 模式下 capability 输出必须是 JSON 对象，否则该节点失败">
                                <Radio.Group>
                                  <Radio value="json">JSON</Radio>
                                  <Radio value="string">字符串</Radio>
                                </Radio.Group>
                              </Form.Item>
                            </>
                          )}
                        </>
                      )
                    }
                    if (t === 'switch') {
                      return (
                        <Alert
                          type="info"
                          message="Switch 节点配置说明"
                          description={
                            <div>
                              <p><strong>添加 case：</strong>从节点底部居中的 source handle 拖一条线到目标节点。</p>
                              <p><strong>设置 default：</strong>从节点底部右侧的紫色 handle 拖一条线到目标节点。</p>
                              <p><strong>编辑表达式：</strong>右键边线 → 编辑 when。</p>
                              <p><strong>调整顺序：</strong>右键边线 → 上移 / 下移。</p>
                            </div>
                          }
                        />
                      )
                    }
                    if (t === 'wait_webhook') return (
                      <Form.Item name="webhookTag" label="Webhook Tag" rules={[{ required: true, message: 'Webhook Tag 必填' }]}>
                        <Input placeholder="例如 mr-merge:PAM/java-code/pas-6.0:123，支持 {{vars.xxx}} 模板" />
                      </Form.Item>
                    )
                    // phase 3 7 新节点（http / dm / db_update / sql_query / file_read /
                    // template_render / fan_out）走 paramSchema 驱动的动态表单。读取
                    // node.data.params 而非 form value（params 不在 antd Form 控制范围内）。
                    if (typeof t === 'string' && !BESPOKE_STAGE_TYPES.has(t as StageType)) {
                      const nodeType = nodeTypeByKey[t]
                      if (!nodeType) {
                        return (
                          <Alert
                            type="warning"
                            showIcon
                            message={`未知节点类型 "${t}"：paramSchema 不可用，参数无法编辑。`}
                          />
                        )
                      }
                      return (
                        <DynamicParamsForm
                          schema={nodeType.paramSchema}
                          value={node!.data.params}
                          onChange={(next) => onChange(node!.id, { params: next })}
                        />
                      )
                    }
                    return null
                  }}
                </Form.Item>

                {/* phase 3 高级配置：retry_when 表达式 / 重试间隔 + fan_out 子运行参数 */}
                <Form.Item shouldUpdate={(p, c) => p.stageType !== c.stageType} noStyle>
                  {({ getFieldValue }) => {
                    const t = getFieldValue('stageType') as StageType | undefined
                    return (
                      <Collapse style={{ marginTop: 8 }} ghost>
                        <Collapse.Panel header="高级：重试策略" key="retry">
                          <Form.Item
                            name="retryWhen"
                            label={
                              <Tooltip title="布尔表达式，命中时重试。例：output.statusCode >= 500，或 error contains 'timeout'">
                                <span>retry_when 表达式</span>
                              </Tooltip>
                            }
                            extra="留空表示按 retryCount 无条件重试；填写后只有命中表达式才重试"
                          >
                            <Input placeholder="output.statusCode >= 500" />
                          </Form.Item>
                          <Form.Item name="retryDelayMs" label="重试间隔 (ms)">
                            <InputNumber min={0} step={500} style={{ width: '100%' }} placeholder="默认 1000" />
                          </Form.Item>
                        </Collapse.Panel>
                        {t === 'fan_out' && (
                          <Collapse.Panel header="高级：fan_out 子运行" key="fanOut" forceRender>
                            <Alert
                              type="info"
                              showIcon
                              style={{ marginBottom: 8 }}
                              message="fan_out 主参数（source / as / parallel / onItemFailure / body）请在上方动态参数表单中填写。此处仅供回顾；body 数组建议用 JSON 编辑。"
                            />
                          </Collapse.Panel>
                        )}
                      </Collapse>
                    )
                  }}
                </Form.Item>
              </Form>
            ),
          },
          {
            key: 'upstream',
            label: '上游字段',
            children: pipelineId != null ? (
              <UpstreamFieldsTab
                pipelineId={pipelineId}
                currentNodeId={node.id}
                ancestors={ancestors ?? new Set()}
                onRunUpstream={onRunUpstream ?? (() => {})}
              />
            ) : (
              <span style={{ color: '#999', fontSize: 12 }}>需传入 pipelineId</span>
            ),
          },
        ]}
      />
    </Drawer>
  )
}
