import { useMemo, useState } from 'react'
import { Modal, Form, Input, Select, Collapse, Checkbox, Space, Typography, message } from 'antd'
import { FileTextOutlined } from '@ant-design/icons'
import {
  requirementsApi,
  type ApprovalWaiterDTO,
  type ApprovalDecision,
  type RequirementDetailDTO,
} from '../api/requirements'
import {
  findStageForWaiter, shouldWarnPlanRework,
  buildDecisionModalTitle, buildDecisionOptions,
} from '../pages/requirements-helpers'
import MarkdownViewer from './MarkdownViewer'
import { V2StructuredView } from './V2StructuredView'

const { Text } = Typography
const { TextArea } = Input

interface Props {
  open: boolean
  waiter: ApprovalWaiterDTO | null
  requirementId: number
  detail: RequirementDetailDTO | null
  onClose: () => void
  /** 决策成功回调，父组件 fetch detail + 清 URL ?openWaiter */
  onDecided: () => void
}

export function DecideModal({ open, waiter, requirementId, detail, onClose, onDecided }: Props) {
  const [form] = Form.useForm()
  const selectedDecision = Form.useWatch('decision', form)
  const [loading, setLoading] = useState(false)

  // PRD §7 step 6：从 contextSummary 解析 task IDs 与 AI notes，给 rejected_plan 表单用
  const planEscalationOptions = useMemo(() => {
    const cs = waiter?.contextSummary ?? ''
    const taskIds = Array.from(cs.matchAll(/\|\s*(T\d+)\s*\|/g)).map(m => m[1])
    const uniqueTasks = Array.from(new Set(taskIds))
    const aiNotes: string[] = []
    const noteSection = cs.match(/AI Reviewer 拒绝原因[\s\S]*?(?=\n\n###|\n\n##|$)/)
    if (noteSection) {
      const noteLines = noteSection[0].matchAll(/^\d+\.\s+[🔴🟡⚪]\s+(.+?)(?:\s+·\s+`[^`]+`)?$/gm)
      for (const m of noteLines) aiNotes.push(m[1].trim())
    }
    return { taskIds: uniqueTasks, aiNotes }
  }, [waiter?.contextSummary])

  const handleSubmit = async (values: {
    decision: ApprovalDecision
    rejectReason?: string
    budgetDelta?: number
    decidedBy?: string
    targetTaskId?: string
    citedAiNotes?: string[]
  }) => {
    if (!waiter) return

    if (shouldWarnPlanRework(waiter, values.decision)) {
      const confirmed = await new Promise<boolean>((resolve) => {
        Modal.confirm({
          title: '提醒：可能触发 plan 重做',
          content: (
            <div>
              <p>spec 已是第 <Text strong>{waiter.round}</Text> 轮，再次拒绝可能让 AI 修改验收标准（AC）。</p>
              <p>如果新一轮 AC 与上一轮有差异（acDiff 非空），系统会<Text strong type="warning">自动重置 plan 节点</Text>让 plan-decomposer 重新拆任务。</p>
              <p>这会消耗额外 token，并可能让已 commit 的代码失效。确认继续吗？</p>
            </div>
          ),
          okText: '确认拒绝',
          cancelText: '取消',
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        })
      })
      if (!confirmed) return
    }

    setLoading(true)
    try {
      const res = await requirementsApi.decide(requirementId, waiter.id, {
        decision: values.decision,
        rejectReason: values.rejectReason ?? null,
        budgetDelta: values.budgetDelta ?? null,
        decidedBy: values.decidedBy ?? null,
        targetTaskId: values.targetTaskId === '__GLOBAL__' ? null : (values.targetTaskId ?? null),
        citedAiNotes: values.citedAiNotes ?? null,
      })
      if (res.ok) {
        message.success(res.resumed ? '已决策，流水线已恢复' : '已决策（流水线未恢复，可能已离线）')
        onDecided()
      }
    } catch (e: any) {
      const data = e?.response?.data
      if (data?.error === 'already claimed') {
        message.warning(`已被 ${data.claimedBy} 端率先决策`)
      } else {
        message.error('决策失败')
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal
      title={buildDecisionModalTitle(waiter)}
      open={open}
      onCancel={onClose}
      onOk={() => form.submit()}
      confirmLoading={loading}
      okText="提交决策"
      cancelText="取消"
      width={720}
      destroyOnClose
    >
      {(waiter?.contextSummary || detail?.specContent) && (() => {
        // 不同 approvalKind 的"审批依据"含义不同：
        //   spec → spec.md 全文（需求规格）
        //   plan → plan 摘要 + plan.md
        //   final → 代码审查 + 测试 + commit log（buildFinalApprovalSummary 输出）
        //   其它（escalation/dev/...）→ 上下文摘要
        const kindLabel =
          waiter?.approvalKind === 'spec' ? '需求规格（Spec）—— 请阅读后再决策' :
          waiter?.approvalKind === 'plan' ? '实施方案（Plan）—— 请阅读后再决策' :
          waiter?.approvalKind === 'final' ? '最终审批依据 —— 代码审查 / 测试结果 / 实现内容' :
          waiter?.approvalKind === 'dev' ? '代码实现摘要 —— 请阅读后再决策' :
          '审批上下文 —— 请阅读后再决策'
        return (
          <Collapse
            size="small"
            defaultActiveKey={['spec']}
            style={{ marginBottom: 16 }}
            items={[{
              key: 'spec',
              label: <Space><FileTextOutlined /><span>{kindLabel}</span></Space>,
              children: (
                <div style={{ maxHeight: 400, overflowY: 'auto', fontSize: 13 }} className="spec-markdown">
                  <MarkdownViewer source={waiter?.contextSummary ?? detail?.specContent ?? ''} />
                </div>
              ),
            }]}
          />
        )
      })()}
      <V2StructuredView stage={findStageForWaiter(detail?.stageResults ?? null, waiter)} />
      <Form form={form} layout="vertical" onFinish={handleSubmit}>
        <Form.Item name="decision" label="决策" rules={[{ required: true, message: '请选择决策' }]}>
          <Select
            options={buildDecisionOptions(
              waiter,
              detail?.retryCounters as { reject_counts?: Record<string, number> } | null,
            )}
          />
        </Form.Item>
        {(selectedDecision === 'rejected' || selectedDecision === 'rejected_plan' || selectedDecision === 'rejected_spec') && (
          <Form.Item name="rejectReason" label="拒绝原因" rules={[{ required: true, message: '请说明拒绝原因' }]}>
            <TextArea rows={3} placeholder="请具体说明需要修改的内容..." />
          </Form.Item>
        )}
        {selectedDecision === 'rejected_plan' && waiter?.decisionSet === 'plan_escalation' && (
          <>
            <Form.Item
              name="targetTaskId"
              label="问题在哪个 task？"
              tooltip="选具体 task → plan-decomposer 下轮只修订该 task；选全局问题 → 整体重拆"
            >
              <Select
                placeholder="选择 task 或全局问题"
                options={[
                  { value: '__GLOBAL__', label: '🌐 全局问题（整体粒度 / 任务划分错）' },
                  ...planEscalationOptions.taskIds.map(id => ({ value: id, label: `📌 ${id}` })),
                ]}
                allowClear
              />
            </Form.Item>
            {planEscalationOptions.aiNotes.length > 0 && (
              <Form.Item
                name="citedAiNotes"
                label='勾选你认可的 AI 拒绝理由（人审"已确认是真问题"的子集）'
                tooltip="未勾选的 AI notes 视为 nitpick，下轮可降级为 warn"
              >
                <Checkbox.Group options={planEscalationOptions.aiNotes.map(n => ({ value: n, label: n }))} />
              </Form.Item>
            )}
          </>
        )}
        {selectedDecision === 'budget_extended' && (
          <Form.Item name="budgetDelta" label="追加预算（轮次）" rules={[{ required: true, message: '请输入追加轮次' }]}>
            <Input type="number" min={1} placeholder="例如 2" />
          </Form.Item>
        )}
        <Form.Item name="decidedBy" label="决策人">
          <Input placeholder="留空使用当前登录用户" />
        </Form.Item>
      </Form>
    </Modal>
  )
}
