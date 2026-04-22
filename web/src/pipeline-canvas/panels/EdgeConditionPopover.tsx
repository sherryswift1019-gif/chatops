import { Modal, Radio, Input, Form } from 'antd'
import { useEffect } from 'react'
import type { ConditionSpec } from '../types'

interface Props {
  open: boolean
  initial?: ConditionSpec
  onClose: () => void
  onSubmit: (c: ConditionSpec | undefined) => void
}

export function EdgeConditionPopover({ open, initial, onClose, onSubmit }: Props) {
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
            <Form.Item name="expression" label="表达式（首版仅支持两种模板）"
              extra="status === 'success'|'failed'|'skipped'  或  output.includes('...')">
              <Input placeholder="如: output.includes('RETRY')" />
            </Form.Item>
          ) : null}
        </Form.Item>
      </Form>
    </Modal>
  )
}
