import { useState } from 'react'
import { Card, Radio, Input, Button, Space, Alert, Typography } from 'antd'
import { submitBrainstormAnswer } from '../../api/brainstorm'

const { Paragraph } = Typography

export function BrainstormTab({ requirementId }: { requirementId: number }) {
  const [chosenOption, setChosenOption] = useState<string | undefined>()
  const [freeText, setFreeText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [feedback, setFeedback] = useState<{
    kind: 'info' | 'warning' | 'success' | 'error'
    msg: string
  } | null>(null)

  const canSubmit = !!chosenOption || freeText.trim().length > 0

  const handleSubmit = async () => {
    setSubmitting(true)
    setFeedback(null)
    try {
      const res = await submitBrainstormAnswer(requirementId, {
        chosenOption,
        freeText: freeText.trim() || undefined,
      })
      if (res.ok) {
        setFeedback({ kind: 'success', msg: '已提交' })
        setChosenOption(undefined)
        setFreeText('')
      } else if (res.error === 'no_active_brainstorm_waiter') {
        setFeedback({
          kind: 'info',
          msg: 'Brainstorm 当前未启用（节点处于 skeleton 模式）。等多轮交互完整路径上线后可在此提交答复。',
        })
      } else {
        setFeedback({ kind: 'error', msg: res.message ?? res.error ?? '提交失败' })
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card title="Brainstorm 多轮澄清" bordered={false}>
      <Paragraph type="secondary">
        当 LLM 需要你确认多轮澄清问题时，在此选择选项或自由文本提交。
        当前 brainstorm 多轮交互节点处于 skeleton 模式（forward-compatible），
        提交会返回 no_active_waiter，等完整路径上线后无缝接通。
      </Paragraph>

      <Space direction="vertical" style={{ width: '100%', marginTop: 16 }} size="middle">
        <div>
          <Paragraph strong>选项</Paragraph>
          <Radio.Group
            value={chosenOption}
            onChange={(e) => setChosenOption(e.target.value)}
          >
            <Space wrap>
              {['A', 'B', 'C', 'D'].map((k) => (
                <Radio key={k} value={k}>{k}</Radio>
              ))}
            </Space>
          </Radio.Group>
        </div>

        <div>
          <Paragraph strong>自由文本（可选）</Paragraph>
          <Input.TextArea
            rows={3}
            placeholder="或自由描述，例如：A 但默认勾选 / 都不对，我想要 XX / 输入 /done 结束"
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
          />
        </div>

        <Button
          type="primary"
          onClick={handleSubmit}
          disabled={!canSubmit}
          loading={submitting}
        >
          提交答复
        </Button>

        {feedback && (
          <Alert type={feedback.kind} message={feedback.msg} showIcon />
        )}
      </Space>
    </Card>
  )
}
