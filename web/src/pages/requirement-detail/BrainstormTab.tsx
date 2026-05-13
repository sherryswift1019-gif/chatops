import { useEffect, useRef, useState } from 'react'
import {
  Card,
  Radio,
  Input,
  Button,
  Space,
  Alert,
  Typography,
  Tag,
  Collapse,
  Empty,
} from 'antd'
import ReactMarkdown from 'react-markdown'
import { submitBrainstormAnswer, type BrainstormState } from '../../api/brainstorm'

const { Paragraph, Text } = Typography

interface Props {
  requirementId: number
  state: BrainstormState | null
  loading: boolean
  onAnswered: () => void
}

export function BrainstormTab({ requirementId, state, loading, onAnswered }: Props) {
  const [chosenOption, setChosenOption] = useState<string | undefined>()
  const [freeText, setFreeText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [feedback, setFeedback] = useState<{
    kind: 'info' | 'warning' | 'success' | 'error'
    msg: string
  } | null>(null)

  if (loading && !state) {
    return <Card><Paragraph>加载中...</Paragraph></Card>
  }
  if (!state) {
    return <Card><Empty description="无法加载 brainstorm 状态" /></Card>
  }

  const { active, history } = state

  // 提交后写的乐观文案（"等待 LLM 生成下一轮..."）只在还有 active waiter 时有意义。
  // LLM 这一轮就 decision=ready 时 active 会立刻变 null，旧 feedback 会和"已结束"
  // 徽章打架，所以在 active truthy→falsy 翻转时清掉。
  const prevActiveRef = useRef(active)
  useEffect(() => {
    if (prevActiveRef.current && !active) {
      setFeedback(null)
    }
    prevActiveRef.current = active
  }, [active])

  const canSubmit = !!chosenOption || freeText.trim().length > 0
  const submitDisabled = !active || !canSubmit

  const handleSubmit = async () => {
    if (!active) return
    setSubmitting(true)
    setFeedback(null)
    try {
      const res = await submitBrainstormAnswer(requirementId, {
        waiterId: active.waiterId,
        chosenOption,
        freeText: freeText.trim() || undefined,
      })
      if (res.ok) {
        setFeedback({
          kind: 'success',
          msg: `第 ${res.round} 轮已提交，等待 LLM 生成下一轮...`,
        })
        setChosenOption(undefined)
        setFreeText('')
        onAnswered()
      } else if (res.error === 'already_answered') {
        setFeedback({
          kind: 'warning',
          msg: '该轮已被另一通道（IM / 并发提交）答复，正在刷新...',
        })
        onAnswered()
      } else if (res.error === 'no_active_brainstorm_waiter') {
        setFeedback({
          kind: 'info',
          msg: 'brainstorm 阶段已结束，无需回答。',
        })
        onAnswered()
      } else {
        setFeedback({
          kind: 'error',
          msg: res.message ?? res.error ?? '提交失败',
        })
      }
    } finally {
      setSubmitting(false)
    }
  }

  // 三态：尚未进入 / 进行中 / 已完成
  if (!active && history.length === 0) {
    return (
      <Card title="Brainstorm 多轮澄清" bordered={false}>
        <Empty description="尚未进入 brainstorm 阶段" />
      </Card>
    )
  }

  return (
    <Card
      title={
        <Space>
          <span>Brainstorm 多轮澄清</span>
          {active ? (
            <Tag color="orange">进行中 · 第 {active.round}/{active.maxRounds} 轮</Tag>
          ) : (
            <Tag color="green">已结束 · 共 {history.length} 轮</Tag>
          )}
        </Space>
      }
      bordered={false}
    >
      {active ? (
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <div
            style={{
              padding: 16,
              background: '#FAFBFC',
              borderRadius: 6,
              border: '1px solid #EEF0F4',
            }}
          >
            <ReactMarkdown>{active.questionMd}</ReactMarkdown>
          </div>

          {active.options.length > 0 && (
            <div>
              <Paragraph strong>选项</Paragraph>
              <Radio.Group
                value={chosenOption}
                onChange={(e) => setChosenOption(e.target.value)}
              >
                <Space direction="vertical">
                  {active.options.map((o) => (
                    <Radio key={o.id} value={o.id}>
                      <Text strong>{o.id}.</Text> {o.label}
                    </Radio>
                  ))}
                </Space>
              </Radio.Group>
            </div>
          )}

          <div>
            <Paragraph strong>自由文本（可选）</Paragraph>
            <Input.TextArea
              rows={3}
              placeholder='例如："A 但默认勾选" / "都不对，我想要 XX" / "/done" 提前结束'
              value={freeText}
              onChange={(e) => setFreeText(e.target.value)}
              maxLength={4096}
              showCount
            />
          </div>

          <Button
            type="primary"
            onClick={handleSubmit}
            disabled={submitDisabled}
            loading={submitting}
          >
            提交答复
          </Button>

          {feedback && (
            <Alert type={feedback.kind} message={feedback.msg} showIcon />
          )}
        </Space>
      ) : (
        feedback && (
          <Alert type={feedback.kind} message={feedback.msg} showIcon />
        )
      )}

      {history.length > 0 && (
        <Collapse
          ghost
          style={{ marginTop: 24 }}
          items={[
            {
              key: 'history',
              label: `历轮对话（${history.length} 轮）`,
              children: (
                <Space direction="vertical" style={{ width: '100%' }} size="middle">
                  {history.map((turn) => (
                    <div
                      key={turn.round}
                      style={{
                        padding: 12,
                        background: '#FAFBFC',
                        borderRadius: 6,
                        border: '1px solid #EEF0F4',
                      }}
                    >
                      <div style={{ marginBottom: 8 }}>
                        <Tag color="blue">Round {turn.round}</Tag>
                        <Tag>{turn.source ?? '?'}</Tag>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {turn.answeredAt ?? ''}
                        </Text>
                      </div>
                      <Paragraph strong style={{ marginBottom: 4 }}>问题：</Paragraph>
                      <div style={{ marginBottom: 8 }}>
                        <ReactMarkdown>{turn.questionMd}</ReactMarkdown>
                      </div>
                      <Paragraph>
                        <Text strong>答复：</Text>{' '}
                        {turn.chosenOption ? <Tag color="green">{turn.chosenOption}</Tag> : null}
                        {turn.freeText ?? ''}
                      </Paragraph>
                    </div>
                  ))}
                </Space>
              ),
            },
          ]}
        />
      )}
    </Card>
  )
}
