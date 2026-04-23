import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Card,
  Table,
  Tag,
  Button,
  Drawer,
  Select,
  Space,
  message,
  Tabs,
  Alert,
  Descriptions,
  List,
  Input,
  Modal,
  Popconfirm,
  Row,
  Col,
  Statistic,
  Segmented,
} from 'antd'
import {
  ReloadOutlined,
  PlusOutlined,
  MessageOutlined,
  AimOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import {
  listPrdDocuments,
  getPrdDocument,
  submitReviewDecision,
  rerunPrdReview,
  deletePrdDocument,
  updatePrdStatus,
} from '../api/prd-documents'
import { createPrdChatSession } from '../api/prd-chat'
import { getProductLines } from '../api/product-lines'
import { me } from '../api/auth'
import type {
  PrdDocument,
  PrdReviewFinding,
  PrdStatus,
  ProductLine,
} from '../types'
import MarkdownViewer from '../components/MarkdownViewer'

const STATUS_COLORS: Record<PrdStatus, string> = {
  drafting: 'default',
  reviewing: 'processing',
  review_blocked: 'red',
  draft: 'blue',
  approved: 'green',
  archived: 'default',
}

const STATUS_LABELS: Record<PrdStatus, string> = {
  drafting: '起草中',
  reviewing: '自审中',
  review_blocked: '待人工处理',
  draft: '草稿已交付',
  approved: '已批准',
  archived: '归档',
}

const SEVERITY_COLORS: Record<string, string> = {
  blocker: 'red',
  major: 'orange',
  minor: 'default',
}

const OWNERSHIP_LABELS: Record<string, string> = {
  pm: '需 PM 补充',
  admin: '需管理员补充',
  business: '业务决策',
}

const ACTION_LABELS: Record<string, string> = {
  approve: '放行',
  approve_with_edits: '人工修改后放行',
  reject: '驳回给 PM',
}

// V2.0：findings.dimension 字段承接 rules.ts 的 ruleId。前端按 ruleId 映射人类可读名。
// 未命中时直接显示原始字符串（兼容 V1 旧数据的数字维度名 "1"/"格式完整性" 等）。
const RULE_LABELS: Record<string, string> = {
  chapter_complete: '章节完整',
  source_traceable: '来源可追溯',
  measurable_acceptance: '验收可度量',
  no_soft_language: '避免软化用语',
  no_impl_leak: '避免实现泄露',
  scope_consistent: '范围一致',
  no_contradiction: '无内部矛盾',
  impact_enum: '影响类型合法',
  breaking_change_detail: '破坏性变更有迁移策略',
  closed_loop: '动作闭环 (5W)',
  submit_review_missing: '自审契约失败',
}

const PHASE_LABELS: Record<string, string> = {
  discovery: 'Phase 1 · 项目发现',
  features: 'Phase 2 · 核心功能',
  scope: 'Phase 3 · 范围确认',
  scope_confirmation: 'Phase 3 · 范围确认',
  generating: 'Phase 4 · PRD 生成',
  generated: 'Phase 4 · 已生成',
}

export default function PrdDocumentsPage() {
  const navigate = useNavigate()
  const [data, setData] = useState<PrdDocument[]>([])
  const [productLines, setProductLines] = useState<ProductLine[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedPL, setSelectedPL] = useState<number | undefined>()
  const [statusFilter, setStatusFilter] = useState<PrdStatus | undefined>()
  const [currentUsername, setCurrentUsername] = useState<string | undefined>()
  const [ownerFilter, setOwnerFilter] = useState<'all' | 'mine'>('all')

  const [drawerOpen, setDrawerOpen] = useState(false)
  const [detail, setDetail] = useState<PrdDocument | null>(null)
  const [activeTab, setActiveTab] = useState<'review' | 'prd' | 'history'>('review')
  const prdScrollRef = useRef<HTMLDivElement>(null)
  const pendingJumpRef = useRef<string | null>(null)

  const [editModalOpen, setEditModalOpen] = useState(false)
  const [editedMarkdown, setEditedMarkdown] = useState('')
  const [editComment, setEditComment] = useState('')

  const [rejectModalOpen, setRejectModalOpen] = useState(false)
  const [rejectComment, setRejectComment] = useState('')

  const [newChatOpen, setNewChatOpen] = useState(false)
  const [newChatPL, setNewChatPL] = useState<number | undefined>()
  const [newChatBusy, setNewChatBusy] = useState(false)

  useEffect(() => {
    getProductLines().then(setProductLines)
    me().then((u) => setCurrentUsername(u.username)).catch(() => {})
  }, [])

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPL, statusFilter, ownerFilter, currentUsername])

  // 有 reviewing / drafting 的 PRD 时短轮询：自审是后台异步走的（可能 10+ 分钟），
  // 终态落盘后列表不会主动刷新，用户看到的状态会一直停在"自审中"。
  // 轮询到所有行都进入终态就自动停（load 无参，会尊重当前 selectedPL/statusFilter）。
  useEffect(() => {
    const hasActive = data.some((p) => p.status === 'reviewing' || p.status === 'drafting')
    if (!hasActive) return
    const t = window.setInterval(() => {
      void load()
    }, 10000)
    return () => window.clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  async function load() {
    setLoading(true)
    try {
      const res = await listPrdDocuments({
        productLineId: selectedPL,
        status: statusFilter,
        createdBy: ownerFilter === 'mine' ? currentUsername : undefined,
      })
      setData(res.data)
    } finally {
      setLoading(false)
    }
  }

  async function openDetail(id: number, tab: typeof activeTab = 'review') {
    try {
      const prd = await getPrdDocument(id)
      setDetail(prd)
      setActiveTab(tab)
      setDrawerOpen(true)
    } catch {
      message.error('加载详情失败')
    }
  }

  async function handleApprove() {
    if (!detail) return
    try {
      await submitReviewDecision(detail.id, { action: 'approve', decidedBy: 'admin' })
      message.success(`PRD #${detail.id} 已放行`)
      setDrawerOpen(false)
      void load()
    } catch {
      message.error('放行失败')
    }
  }

  async function handleApproveWithEdits() {
    if (!detail) return
    if (editedMarkdown.trim().length < 200) {
      message.warning('修改后的 PRD 内容至少 200 字符')
      return
    }
    try {
      await submitReviewDecision(detail.id, {
        action: 'approve_with_edits',
        editedMarkdown,
        comment: editComment || undefined,
        decidedBy: 'admin',
      })
      message.success(`PRD #${detail.id} 修改已提交，将重新自审`)
      setEditModalOpen(false)
      setDrawerOpen(false)
      void load()
    } catch {
      message.error('提交失败')
    }
  }

  async function handleReject() {
    if (!detail) return
    if (!rejectComment.trim()) {
      message.warning('请填写驳回理由')
      return
    }
    try {
      await submitReviewDecision(detail.id, {
        action: 'reject',
        comment: rejectComment,
        decidedBy: 'admin',
      })
      message.success(`PRD #${detail.id} 已驳回给 PM`)
      setRejectModalOpen(false)
      setRejectComment('')
      const fresh = await getPrdDocument(detail.id).catch(() => null)
      if (fresh) setDetail(fresh)
      void load()
    } catch {
      message.error('驳回失败')
    }
  }

  async function handleRerun(id: number) {
    try {
      await rerunPrdReview(id)
      message.success('自审已重新触发')
      void load()
    } catch {
      message.error('触发自审失败')
    }
  }

  async function handleDelete(id: number) {
    try {
      await deletePrdDocument(id)
      message.success('已删除')
      void load()
    } catch {
      message.error('删除失败')
    }
  }

  async function handleArchive(id: number) {
    try {
      await updatePrdStatus(id, 'archived')
      message.success('已归档')
      void load()
    } catch {
      message.error('归档失败')
    }
  }

  async function handleStartNewChat() {
    if (!newChatPL) {
      message.warning('请选择产线')
      return
    }
    setNewChatBusy(true)
    try {
      const res = await createPrdChatSession({ productLineId: newChatPL })
      setNewChatOpen(false)
      navigate(`/prd-chat/${res.sessionKey}`)
    } catch {
      message.error('创建对话失败')
    } finally {
      setNewChatBusy(false)
    }
  }

  async function handleContinueChat(prd: PrdDocument) {
    try {
      const res = await createPrdChatSession({
        productLineId: prd.productLineId,
        prdId: prd.id,
      })
      navigate(`/prd-chat/${res.sessionKey}`)
    } catch {
      message.error('创建对话失败')
    }
  }

  // 「回到对话修改」— 新建一个 chat session，seed_rejection=true 让后端把驳回原因
  // 作为首屏 assistant 消息落盘，同时系统提示里也会带上驳回摘要。
  async function handleResumeChatWithReject(prd: PrdDocument) {
    try {
      const res = await createPrdChatSession({
        productLineId: prd.productLineId,
        prdId: prd.id,
        seedRejection: true,
      })
      setDrawerOpen(false)
      navigate(`/prd-chat/${res.sessionKey}`)
    } catch {
      message.error('创建对话失败')
    }
  }

  // Finding location → 章节跳转
  function jumpToLocation(loc: string) {
    setActiveTab('prd')
    pendingJumpRef.current = loc
  }

  useEffect(() => {
    if (activeTab !== 'prd' || !pendingJumpRef.current) return
    const loc = pendingJumpRef.current
    pendingJumpRef.current = null
    // wait for Markdown 渲染
    const t = setTimeout(() => {
      const root = prdScrollRef.current
      if (!root) return
      const headings = root.querySelectorAll('h1, h2, h3, h4, h5, h6')
      // 提取章节号前缀 "3.2 CSV" 或 "## 3."
      const m = loc.match(/(\d+(?:\.\d+)*)\s*([^>]*?)$/)
      const num = m?.[1]
      const text = (m?.[2] ?? '').trim()
      let target: Element | null = null
      for (const h of headings) {
        const t = (h.textContent ?? '').trim()
        if (num && t.startsWith(num)) {
          target = h
          break
        }
        if (text && t.includes(text) && text.length > 2) {
          target = h
          break
        }
      }
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' })
        ;(target as HTMLElement).style.background = 'rgba(75,139,255,0.15)'
        setTimeout(() => {
          ;(target as HTMLElement).style.transition = 'background 0.5s'
          ;(target as HTMLElement).style.background = 'transparent'
        }, 1200)
      } else {
        message.warning(`未在正文中找到章节：${loc}`)
      }
    }, 120)
    return () => clearTimeout(t)
  }, [activeTab, detail])

  // 统计
  const stats = useMemo(() => {
    const now = new Date()
    const monday = new Date(now)
    const day = now.getDay() || 7
    monday.setDate(now.getDate() - (day - 1))
    monday.setHours(0, 0, 0, 0)
    return {
      blocked: data.filter((d) => d.status === 'review_blocked').length,
      drafting: data.filter((d) => d.status === 'drafting' || d.status === 'reviewing')
        .length,
      delivered: data.filter((d) => d.status === 'draft' || d.status === 'approved').length,
      newThisWeek: data.filter((d) => new Date(d.createdAt) >= monday).length,
    }
  }, [data])

  const columns = [
    { title: 'ID', dataIndex: 'id', width: 60 },
    { title: '标题', dataIndex: 'title', ellipsis: true },
    {
      title: '版本',
      dataIndex: 'version',
      width: 70,
      render: (v: number) => `v${v}`,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 130,
      render: (v: PrdStatus) => (
        <Tag color={STATUS_COLORS[v]}>{STATUS_LABELS[v]}</Tag>
      ),
    },
    { title: '创建者', dataIndex: 'createdBy', width: 120 },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      width: 160,
      render: (v: string) => new Date(v).toLocaleString(),
    },
    {
      title: '操作',
      width: 320,
      render: (_: unknown, r: PrdDocument) => (
        <Space size="small">
          {r.status === 'review_blocked' ? (
            <Button type="primary" size="small" onClick={() => openDetail(r.id, 'review')}>
              处理
            </Button>
          ) : (
            <a onClick={() => openDetail(r.id, 'prd')}>查看</a>
          )}
          {r.status !== 'approved' && r.status !== 'archived' && (
            <a onClick={() => handleContinueChat(r)}>
              <MessageOutlined /> 继续对话
            </a>
          )}
          <a onClick={() => handleRerun(r.id)}>重审</a>
          {r.status === 'draft' && <a onClick={() => handleArchive(r.id)}>归档</a>}
          <Popconfirm title="确认删除？" onConfirm={() => handleDelete(r.id)}>
            <a style={{ color: '#cf1322' }}>删除</a>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <>
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}>
          <Card
            hoverable
            onClick={() => setStatusFilter('review_blocked')}
            styles={{ body: { padding: '16px 20px' } }}
          >
            <Statistic
              title="待人工处理"
              value={stats.blocked}
              valueStyle={{ color: '#cf1322' }}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card
            hoverable
            onClick={() => setStatusFilter('drafting')}
            styles={{ body: { padding: '16px 20px' } }}
          >
            <Statistic
              title="起草/自审中"
              value={stats.drafting}
              valueStyle={{ color: '#4B8BFF' }}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card
            hoverable
            onClick={() => setStatusFilter('draft')}
            styles={{ body: { padding: '16px 20px' } }}
          >
            <Statistic
              title="已交付草稿"
              value={stats.delivered}
              valueStyle={{ color: '#16a34a' }}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card
            hoverable
            onClick={() => setStatusFilter(undefined)}
            styles={{ body: { padding: '16px 20px' } }}
          >
            <Statistic title="本周新增" value={stats.newThisWeek} />
          </Card>
        </Col>
      </Row>

      <Card
        title="PRD 文档"
        extra={
          <Space>
            <Segmented
              value={ownerFilter}
              onChange={(v) => setOwnerFilter(v as 'all' | 'mine')}
              options={[
                { label: '全部', value: 'all' },
                { label: '我的 PRD', value: 'mine', disabled: !currentUsername },
              ]}
            />
            <Select
              style={{ width: 200 }}
              placeholder="全部产品线"
              value={selectedPL}
              allowClear
              onChange={setSelectedPL}
              options={productLines.map((pl) => ({ value: pl.id, label: pl.displayName }))}
            />
            <Select
              style={{ width: 150 }}
              placeholder="状态过滤"
              value={statusFilter}
              allowClear
              onChange={setStatusFilter}
              options={(Object.keys(STATUS_LABELS) as PrdStatus[]).map((k) => ({
                value: k,
                label: STATUS_LABELS[k],
              }))}
            />
            <Button icon={<ReloadOutlined />} onClick={load}>
              刷新
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                setNewChatPL(selectedPL)
                setNewChatOpen(true)
              }}
            >
              新建 PRD 对话
            </Button>
          </Space>
        }
      >
        <Table
          rowKey="id"
          columns={columns}
          dataSource={data}
          loading={loading}
          pagination={{ pageSize: 20 }}
        />
      </Card>

      <Drawer
        title={detail ? `PRD #${detail.id}「${detail.title}」v${detail.version}` : ''}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={980}
        destroyOnClose
        extra={
          detail && (
            <Button
              icon={<MessageOutlined />}
              onClick={() => handleContinueChat(detail)}
            >
              继续对话
            </Button>
          )
        }
      >
        {detail && (
          <PrdDetailBody
            prd={detail}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            onApprove={handleApprove}
            onOpenEdit={() => {
              setEditedMarkdown(detail.contentMarkdown)
              setEditComment('')
              setEditModalOpen(true)
            }}
            onOpenReject={() => {
              setRejectComment('')
              setRejectModalOpen(true)
            }}
            onJumpLocation={jumpToLocation}
            onResumeWithReject={() => handleResumeChatWithReject(detail)}
            prdScrollRef={prdScrollRef}
          />
        )}
      </Drawer>

      {/* 人工修改后放行 Modal — 左右双栏预览 */}
      <Modal
        title="人工修改后放行（左侧编辑，右侧实时预览）"
        open={editModalOpen}
        onCancel={() => setEditModalOpen(false)}
        onOk={handleApproveWithEdits}
        width={1400}
        okText="提交"
      >
        <Row gutter={12}>
          <Col span={12}>
            <Input.TextArea
              rows={28}
              value={editedMarkdown}
              onChange={(e) => setEditedMarkdown(e.target.value)}
              style={{ fontFamily: 'Menlo, Monaco, monospace', fontSize: 12.5 }}
            />
          </Col>
          <Col span={12}>
            <div
              style={{
                border: '1px solid #EEF0F4',
                borderRadius: 6,
                padding: 16,
                height: 'calc(28 * 1.5715em + 8px)',
                overflow: 'auto',
                background: '#FFF',
              }}
            >
              <MarkdownViewer source={editedMarkdown} />
            </div>
          </Col>
        </Row>
        <div style={{ marginTop: 12 }}>
          <Input.TextArea
            rows={2}
            placeholder="修改说明（可选）"
            value={editComment}
            onChange={(e) => setEditComment(e.target.value)}
          />
        </div>
        <Alert
          style={{ marginTop: 12 }}
          type="info"
          showIcon
          message="提交后将重新触发自审；若再次 blocked 会再次提示处理。"
        />
      </Modal>

      {/* 驳回给 PM Modal */}
      <Modal
        title="驳回给 PM"
        open={rejectModalOpen}
        onCancel={() => setRejectModalOpen(false)}
        onOk={handleReject}
        okText="确认驳回"
        okButtonProps={{ danger: true }}
      >
        <Input.TextArea
          rows={4}
          placeholder="驳回理由（将通知 PM）"
          value={rejectComment}
          onChange={(e) => setRejectComment(e.target.value)}
        />
      </Modal>

      {/* 新建 PRD 对话 Modal */}
      <Modal
        title="新建 PRD 对话"
        open={newChatOpen}
        onCancel={() => setNewChatOpen(false)}
        onOk={handleStartNewChat}
        okText="开始对话"
        confirmLoading={newChatBusy}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="选择要归属的产线后，进入对话界面。你可以直接告诉 Agent 你想写什么 PRD，它会通过多轮对话逐步帮你打磨。"
        />
        <Select
          style={{ width: '100%' }}
          placeholder="选择产线"
          value={newChatPL}
          onChange={setNewChatPL}
          options={productLines.map((pl) => ({ value: pl.id, label: pl.displayName }))}
        />
      </Modal>
    </>
  )
}

interface PrdDetailBodyProps {
  prd: PrdDocument
  activeTab: 'review' | 'prd' | 'history'
  onTabChange: (tab: 'review' | 'prd' | 'history') => void
  onApprove: () => void
  onOpenEdit: () => void
  onOpenReject: () => void
  onJumpLocation: (loc: string) => void
  onResumeWithReject: () => void
  prdScrollRef: React.RefObject<HTMLDivElement>
}

function PrdDetailBody({
  prd,
  activeTab,
  onTabChange,
  onApprove,
  onOpenEdit,
  onOpenReject,
  onJumpLocation,
  onResumeWithReject,
  prdScrollRef,
}: PrdDetailBodyProps) {
  const review = prd.reviewResult
  const blockers = useMemo(
    () => review?.findings.filter((f) => f.severity === 'blocker') ?? [],
    [review]
  )
  const needsAction = prd.status === 'review_blocked'
  const showSnapshot = prd.status === 'drafting' || prd.status === 'reviewing'

  // 最近一次人工驳回 → 用 Alert 把原因顶在最上面，引导 PM 回到对话。
  const history = prd.reviewHistory ?? []
  const lastReview = history.length > 0 ? history[history.length - 1] : undefined
  const isRejected =
    prd.status === 'drafting' &&
    lastReview?.result?.recommendation?.action === 'reject'

  return (
    <>
      {isRejected && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="该 PRD 已被驳回，请按下方原因修改后重新提交"
          description={
            <div>
              <div>
                <b>驳回原因</b>：{lastReview?.result?.recommendation?.reason ?? '（无备注）'}
              </div>
              <div style={{ color: '#7A8296', marginTop: 4 }}>
                点击「回到对话修改」将新开一个 Agent 会话，已自动附带驳回上下文。
              </div>
            </div>
          }
          action={
            <Button type="primary" onClick={onResumeWithReject}>
              回到对话修改
            </Button>
          }
        />
      )}

      {showSnapshot && <WorkflowSnapshotCard prd={prd} />}

      {needsAction && review && (
        <L1ApprovalPanel
          recommendation={review.recommendation}
          blockerCount={blockers.length}
          onApprove={onApprove}
          onOpenEdit={onOpenEdit}
          onOpenReject={onOpenReject}
        />
      )}

      <Tabs
        activeKey={activeTab}
        onChange={(k) => onTabChange(k as typeof activeTab)}
        items={[
          {
            key: 'review',
            label: `自审报告${review ? `（${review.findings.length}）` : ''}`,
            children: <ReviewTab review={review} onJumpLocation={onJumpLocation} />,
          },
          {
            key: 'prd',
            label: 'PRD 内容',
            children: (
              <div>
                <Descriptions size="small" column={2} bordered style={{ marginBottom: 12 }}>
                  <Descriptions.Item label="状态">
                    <Tag color={STATUS_COLORS[prd.status]}>{STATUS_LABELS[prd.status]}</Tag>
                  </Descriptions.Item>
                  <Descriptions.Item label="创建者">{prd.createdBy}</Descriptions.Item>
                  <Descriptions.Item label="产品线">{prd.productLineId}</Descriptions.Item>
                  <Descriptions.Item label="更新时间">
                    {new Date(prd.updatedAt).toLocaleString()}
                  </Descriptions.Item>
                </Descriptions>
                <div
                  ref={prdScrollRef}
                  style={{
                    background: '#FFF',
                    border: '1px solid #EEF0F4',
                    borderRadius: 6,
                    padding: 20,
                    overflow: 'auto',
                    maxHeight: 'calc(100vh - 360px)',
                  }}
                >
                  <MarkdownViewer source={prd.contentMarkdown} />
                </div>
              </div>
            ),
          },
          {
            key: 'history',
            label: `历史（${prd.reviewHistory.length}）`,
            children: <HistoryTab prd={prd} />,
          },
        ]}
      />
    </>
  )
}

function WorkflowSnapshotCard({ prd }: { prd: PrdDocument }) {
  const cj = prd.contentJson as {
    phase?: string
    dialogueRounds?: number
    contextSummary?: string
    pendingQuestions?: string[]
  }
  const phase = cj?.phase
  const rounds = cj?.dialogueRounds
  const summary = cj?.contextSummary
  const pending = cj?.pendingQuestions

  return (
    <Card
      size="small"
      style={{
        marginBottom: 12,
        borderLeft: '3px solid #4B8BFF',
        background: '#F6F9FF',
      }}
      title={
        <Space>
          <span>工作流快照</span>
          {phase && <Tag color="blue">{PHASE_LABELS[phase] ?? phase}</Tag>}
          {typeof rounds === 'number' && <Tag>已对话 {rounds} 轮</Tag>}
        </Space>
      }
    >
      {summary ? (
        <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, color: '#1A1F2E' }}>
          {summary}
        </div>
      ) : (
        <span style={{ color: '#999' }}>暂无对话摘要。Agent 将在首次持久化后写入此处。</span>
      )}
      {Array.isArray(pending) && pending.length > 0 && (
        <>
          <div style={{ marginTop: 10, fontWeight: 600, color: '#5C6578' }}>待确认问题：</div>
          <List
            size="small"
            dataSource={pending}
            renderItem={(q) => <List.Item style={{ padding: '4px 0' }}>• {q}</List.Item>}
          />
        </>
      )}
    </Card>
  )
}

interface L1PanelProps {
  recommendation?: { action: string; reason: string }
  blockerCount: number
  onApprove: () => void
  onOpenEdit: () => void
  onOpenReject: () => void
}

function L1ApprovalPanel({
  recommendation,
  blockerCount,
  onApprove,
  onOpenEdit,
  onOpenReject,
}: L1PanelProps) {
  const action = recommendation?.action ?? 'reject'
  return (
    <Alert
      type={action === 'approve' ? 'success' : action === 'approve_with_edits' ? 'warning' : 'error'}
      showIcon
      style={{ marginBottom: 16 }}
      message={
        <Space>
          <strong>AI 建议：{ACTION_LABELS[action] ?? action}</strong>
          <Tag color="red">{blockerCount} 条 blocker</Tag>
        </Space>
      }
      description={
        <>
          <div style={{ marginBottom: 12 }}>{recommendation?.reason ?? '无建议原因'}</div>
          <Space>
            <Button type={action === 'approve' ? 'primary' : 'default'} onClick={onApprove}>
              放行
            </Button>
            <Button
              type={action === 'approve_with_edits' ? 'primary' : 'default'}
              onClick={onOpenEdit}
            >
              人工修改后放行
            </Button>
            <Button
              danger
              type={action === 'reject' ? 'primary' : 'default'}
              onClick={onOpenReject}
            >
              驳回给 PM
            </Button>
          </Space>
        </>
      }
    />
  )
}

function ReviewTab({
  review,
  onJumpLocation,
}: {
  review: PrdDocument['reviewResult']
  onJumpLocation: (loc: string) => void
}) {
  if (!review) {
    return <Alert type="info" message="尚无自审结果" />
  }
  return (
    <>
      <Descriptions size="small" column={3} bordered style={{ marginBottom: 12 }}>
        <Descriptions.Item label="轮次">#{review.round}</Descriptions.Item>
        <Descriptions.Item label="状态">
          <Tag color={review.status === 'passed' ? 'green' : 'red'}>{review.status}</Tag>
        </Descriptions.Item>
        <Descriptions.Item label="时间">
          {new Date(review.reviewedAt).toLocaleString()}
        </Descriptions.Item>
      </Descriptions>
      <List
        bordered
        dataSource={review.findings}
        locale={{ emptyText: '无 findings（PRD 完全通过）' }}
        renderItem={(f: PrdReviewFinding) => (
          <List.Item style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}>
            <Space wrap>
              <Tag color={SEVERITY_COLORS[f.severity]}>{f.severity.toUpperCase()}</Tag>
              <Tag title={f.dimension}>
                {RULE_LABELS[f.dimension] ?? f.dimension}
              </Tag>
              {f.ownership && <Tag color="blue">{OWNERSHIP_LABELS[f.ownership]}</Tag>}
              {f.location && (
                <Button
                  type="link"
                  size="small"
                  icon={<AimOutlined />}
                  onClick={() => onJumpLocation(f.location)}
                  style={{ padding: 0, height: 'auto', color: '#5C6578' }}
                >
                  {f.location}
                </Button>
              )}
            </Space>
            <div>
              <strong>问题：</strong>
              {f.description}
            </div>
            {f.suggestion && (
              <div>
                <strong>建议：</strong>
                {f.suggestion}
              </div>
            )}
            {!f.canAutoFix && f.autoFixBlockedReason && (
              <div style={{ color: '#999' }}>
                无法自动修复：{f.autoFixBlockedReason}
              </div>
            )}
          </List.Item>
        )}
      />
    </>
  )
}

function HistoryTab({ prd }: { prd: PrdDocument }) {
  if (prd.reviewHistory.length === 0) {
    return <Alert type="info" message="尚无审查历史" />
  }
  return (
    <List
      dataSource={prd.reviewHistory}
      renderItem={(entry) => (
        <List.Item style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
          <Space>
            <Tag>round {entry.round}</Tag>
            <Tag color={entry.result.status === 'passed' ? 'green' : 'red'}>
              {entry.result.status}
            </Tag>
            <span style={{ color: '#999' }}>
              {new Date(entry.result.reviewedAt).toLocaleString()}
            </span>
          </Space>
          {entry.repairSummary && <div>修复：{entry.repairSummary}</div>}
          <div style={{ color: '#666' }}>
            findings: {entry.result.findings.length}
            {entry.result.recommendation &&
              ` · 建议: ${ACTION_LABELS[entry.result.recommendation.action] ?? entry.result.recommendation.action}`}
          </div>
        </List.Item>
      )}
    />
  )
}
