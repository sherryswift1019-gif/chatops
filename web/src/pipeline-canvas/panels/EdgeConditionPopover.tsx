import { Modal, Radio, Input, Form, Alert, Button, Space } from 'antd'
import { useEffect } from 'react'
import type { ConditionSpec, StageEdge, StageNode } from '../types'

interface Props {
  open: boolean
  initial?: ConditionSpec
  onClose: () => void
  onSubmit: (c: ConditionSpec | undefined) => void
  /** 当前编辑的 edge（switch edge 特化路径需要） */
  edge?: StageEdge | null
  /** 所有节点（用于找 source 节点 stageType） */
  nodes?: StageNode[]
  /** 写回 switch case when 表达式 */
  updateSwitchCaseWhen?: (switchId: string, caseIdx: number, when: string) => void
  /** switch case 上移 / 下移 */
  moveCase?: (switchId: string, fromIdx: number, toIdx: number) => void
}

export function EdgeConditionPopover({ open, initial, onClose, onSubmit, edge, nodes, updateSwitchCaseWhen, moveCase }: Props) {
  // 如果有 edge + nodes，判断是否是 switch 出边
  const sourceNode = edge && nodes ? nodes.find(n => n.id === edge.source) : undefined
  const isSwitchEdge = sourceNode?.data.stageType === 'switch'
  const isDefaultEdge = isSwitchEdge && (edge?.data?.isDefault === true || edge?.sourceHandle === 'default')

  if (isSwitchEdge) {
    return (
      <Modal title="Switch 出边编辑" open={open} onCancel={onClose} footer={null} destroyOnClose>
        <SwitchEdgeEditor
          edge={edge!}
          switchNode={sourceNode!}
          isDefault={isDefaultEdge}
          updateSwitchCaseWhen={updateSwitchCaseWhen}
          moveCase={moveCase}
          onClose={onClose}
        />
      </Modal>
    )
  }

  return <NormalEdgeEditor open={open} initial={initial} onClose={onClose} onSubmit={onSubmit} />
}

// ---------------------------------------------------------------------------
// Switch 出边编辑器
// ---------------------------------------------------------------------------

interface SwitchEdgeEditorProps {
  edge: StageEdge
  switchNode: StageNode
  isDefault: boolean
  updateSwitchCaseWhen?: (switchId: string, caseIdx: number, when: string) => void
  moveCase?: (switchId: string, fromIdx: number, toIdx: number) => void
  onClose: () => void
}

function SwitchEdgeEditor({ edge, switchNode, isDefault, updateSwitchCaseWhen, moveCase, onClose }: SwitchEdgeEditorProps) {
  const [form] = Form.useForm()

  const cases = ((switchNode.data.params as any)?.cases ?? []) as Array<{ when: string; target: string }>
  const caseIdx = isDefault ? -1 : cases.findIndex((c) => c.target === edge.target)
  const initialWhen = caseIdx >= 0 ? cases[caseIdx].when : ''

  useEffect(() => {
    form.setFieldsValue({ when: initialWhen })
  }, [initialWhen, form])

  if (isDefault) {
    return <Alert message="Default 边不需要表达式（未命中任何 case 时跳转）" type="info" showIcon />
  }

  return (
    <Form
      form={form}
      layout="vertical"
      initialValues={{ when: initialWhen }}
      onFinish={(values: { when: string }) => {
        if (updateSwitchCaseWhen && caseIdx >= 0) {
          updateSwitchCaseWhen(switchNode.id, caseIdx, values.when)
        }
        onClose()
      }}
    >
      <Form.Item
        label={`Case #${caseIdx + 1} 表达式`}
        name="when"
        extra="parseExpression 引擎，支持 ==/!=/</>/>=/&&/||/!/contains，路径访问 steps.x.output.y"
      >
        <Input placeholder="steps.upstream.output.score > 80" />
      </Form.Item>
      <Space>
        <Button
          onClick={() => moveCase && caseIdx > 0 && moveCase(switchNode.id, caseIdx, caseIdx - 1)}
          disabled={caseIdx <= 0}
        >
          ↑ 上移
        </Button>
        <Button
          onClick={() => moveCase && caseIdx < cases.length - 1 && moveCase(switchNode.id, caseIdx, caseIdx + 1)}
          disabled={caseIdx >= cases.length - 1}
        >
          ↓ 下移
        </Button>
        <Button type="primary" htmlType="submit">保存</Button>
      </Space>
    </Form>
  )
}

// ---------------------------------------------------------------------------
// 普通 edge 编辑器（原有逻辑，更新 expression hint）
// ---------------------------------------------------------------------------

interface NormalEdgeEditorProps {
  open: boolean
  initial?: ConditionSpec
  onClose: () => void
  onSubmit: (c: ConditionSpec | undefined) => void
}

function NormalEdgeEditor({ open, initial, onClose, onSubmit }: NormalEdgeEditorProps) {
  const [form] = Form.useForm()
  useEffect(() => {
    if (open) {
      form.setFieldsValue({
        kind: initial?.kind ?? 'none',
        expression: initial?.kind === 'expression' ? initial.expression : '',
      })
    }
  }, [open, initial, form])

  async function handleOk() {
    try {
      const { kind, expression } = await form.validateFields()
      if (kind === 'none') { onSubmit(undefined); onClose(); return }
      if (kind === 'expression') {
        if (!expression?.trim()) {
          form.setFields([{ name: 'expression', errors: ['必填'] }])
          return
        }
        onSubmit({ kind: 'expression', expression: expression.trim() })
      } else {
        onSubmit({ kind })
      }
      onClose()
    } catch { /* validateFields threw — keep modal open */ }
  }

  return (
    <Modal title="连线条件" open={open} onOk={handleOk} onCancel={onClose} destroyOnClose>
      <Form form={form} layout="vertical">
        <Form.Item name="kind" label="触发条件">
          <Radio.Group>
            <Radio value="none">无条件（总是走）</Radio>
            <Radio value="onSuccess">上游成功时</Radio>
            <Radio value="onFailure">上游失败时</Radio>
            <Radio value="expression">自定义表达式</Radio>
          </Radio.Group>
        </Form.Item>
        <Form.Item shouldUpdate={(p, c) => p.kind !== c.kind} noStyle>
          {({ getFieldValue }) => getFieldValue('kind') === 'expression' ? (
            <Form.Item name="expression" label="表达式"
              extra="parseExpression 引擎，支持 ==/!=/</>/>=/&&/||/!/contains，路径访问 steps.x.output.y">
              <Input placeholder="steps.upstream.output.score > 80" />
            </Form.Item>
          ) : null}
        </Form.Item>
      </Form>
    </Modal>
  )
}
