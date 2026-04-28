import React, { useEffect, useState } from 'react'
import { Form, Input, Select, Button, Modal, message, Space, Tag, AutoComplete } from 'antd'
import { getTestPipelines } from '../api/test-pipelines'
import { getTestServers } from '../api/test-servers'
import { upsertPipelineBinding, type PipelineBinding } from '../api/pipeline-bindings'
import { getPipelineGraph } from '../pipeline-canvas/api'
import type { TestPipeline, TestServer } from '../types'

interface Props {
  productLineId: number
  initialValue?: PipelineBinding
  onSuccess: () => void
  onCancel: () => void
  open: boolean
}

const RESERVED_REF_KEYS = ['fix_bug_l1', 'fix_bug_l2', 'fix_bug_l3', 'fix_bug_l4']

export const PipelineBindingForm: React.FC<Props> = ({ productLineId, initialValue, onSuccess, onCancel, open }) => {
  const [form] = Form.useForm()
  const [pipelines, setPipelines] = useState<TestPipeline[]>([])
  const [servers, setServers] = useState<TestServer[]>([])
  const [scriptRoles, setScriptRoles] = useState<string[]>([])

  useEffect(() => {
    Promise.all([getTestPipelines(), getTestServers(productLineId)])
      .then(([ps, ss]) => { setPipelines(ps); setServers(ss) })
  }, [productLineId])

  useEffect(() => {
    if (initialValue) {
      form.setFieldsValue(initialValue)
      loadScriptRoles(initialValue.pipelineId)
    } else {
      form.resetFields()
      setScriptRoles([])
    }
  }, [initialValue, open])

  async function loadScriptRoles(pipelineId: number) {
    try {
      const graph = await getPipelineGraph(pipelineId)
      const roles = new Set<string>()
      for (const node of graph.nodes ?? []) {
        if (node.stageType === 'script') {
          for (const r of node.targetRoles ?? []) roles.add(r)
        }
      }
      setScriptRoles(Array.from(roles))
    } catch {
      setScriptRoles([])
    }
  }

  async function handleSubmit(values: Record<string, unknown>) {
    try {
      await upsertPipelineBinding({
        productLineId,
        refKey: values.refKey as string,
        pipelineId: values.pipelineId as number,
        serverRoleAssignments: (values.serverRoleAssignments as Record<string, string[]>) ?? {},
        description: (values.description as string) ?? '',
      })
      message.success('保存成功')
      form.resetFields()
      onSuccess()
    } catch {
      message.error('保存失败')
    }
  }

  return (
    <Modal title={initialValue ? '编辑绑定' : '新增绑定'} open={open} onCancel={onCancel} footer={null} width={600}>
      <Form form={form} layout="vertical" onFinish={handleSubmit}>
        <Form.Item name="refKey" label="ref_key（引用标识）" rules={[{ required: true, pattern: /^[a-z0-9_]+$/, message: '只允许小写字母、数字、下划线' }]}>
          <AutoComplete
            disabled={!!initialValue}
            placeholder="输入任意标识，或从约定 key 中选择"
            options={RESERVED_REF_KEYS.map(k => ({
              value: k,
              label: <><Tag color="blue">约定</Tag> {k}</>,
            }))}
            filterOption={(input, option) => String(option?.value ?? '').includes(input)}
          />
        </Form.Item>

        <Form.Item name="pipelineId" label="引用 Pipeline" rules={[{ required: true }]}>
          <Select
            showSearch
            optionFilterProp="children"
            onChange={(val) => loadScriptRoles(val as number)}
          >
            {pipelines.map(p => (
              <Select.Option key={p.id} value={p.id}>{p.name} <small>(#{p.id})</small></Select.Option>
            ))}
          </Select>
        </Form.Item>

        {scriptRoles.length === 0 ? (
          <div style={{ color: '#999', marginBottom: 16 }}>此 pipeline 无需 server 分配</div>
        ) : scriptRoles.map(role => (
          <Form.Item key={role} name={['serverRoleAssignments', role]} label={`Server 分配 - ${role}`}>
            <Select mode="multiple" allowClear placeholder={`选择 ${role} 角色的 server`}>
              {servers.filter(s => s.role === role).map(s => (
                <Select.Option key={s.id} value={String(s.id)}>{s.name} ({s.host})</Select.Option>
              ))}
            </Select>
          </Form.Item>
        ))}

        <Form.Item name="description" label="描述">
          <Input.TextArea rows={2} />
        </Form.Item>

        <Form.Item>
          <Space>
            <Button type="primary" htmlType="submit">保存</Button>
            <Button onClick={onCancel}>取消</Button>
          </Space>
        </Form.Item>
      </Form>
    </Modal>
  )
}
