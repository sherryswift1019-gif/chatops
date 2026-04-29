import { useEffect, useState, useMemo, useCallback, useRef } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { ReactFlowProvider } from '@xyflow/react'
import { Spin, message, Modal, Drawer } from 'antd'
import { ulid } from 'ulidx'
import { getTestPipeline } from '../api/test-pipelines'
import { triggerTestRun } from '../api/test-runs'
import { getPipelineVariables } from '../api/pipeline-variables'
import { getDingTalkUsers } from '../api/dingtalk-users'
import { getTestServers } from '../api/test-servers'
import { getCapabilities } from '../api/capabilities'
import { getPipelineGraph, putPipelineGraph } from './api'
import { usePipelineGraph } from './hooks/usePipelineGraph'
import { useAutoLayout } from './hooks/useAutoLayout'
import { PipelineCanvas } from './canvas/PipelineCanvas'
import { NodeInspector } from './panels/NodeInspector'
import { VariablesPanel } from './panels/VariablesPanel'
import { EdgeConditionPopover } from './panels/EdgeConditionPopover'
import { CanvasToolbar } from './toolbar/CanvasToolbar'
import { useDryRunSSE } from './dryrun/useDryRunSSE'
import { DryRunStartModal } from './dryrun/DryRunStartModal'
import { SideEffectDecisionModal } from './dryrun/SideEffectDecisionModal'
import { WaitingExternalBanner } from './dryrun/WaitingExternalBanner'
import WebhooksPanel from './panels/WebhooksPanel'
import PipelineSettingsPanel from './panels/PipelineSettingsPanel'
import type { TestPipeline } from '../types'
import type { StageType, StageFields } from './types'
import { firstGraphIssue } from './graph-validation'
export { firstGraphIssue } from './graph-validation'

export interface CapabilityOption {
  key: string
  displayName: string
}

/** BFS upstream: returns set of all node IDs that are ancestors of targetId */
function computeAncestors(
  edges: ReadonlyArray<{ source: string; target: string }>,
  targetId: string,
): Set<string> {
  const parentMap = new Map<string, string[]>()
  for (const e of edges) {
    if (!parentMap.has(e.target)) parentMap.set(e.target, [])
    parentMap.get(e.target)!.push(e.source)
  }
  const visited = new Set<string>()
  const queue = [targetId]
  while (queue.length > 0) {
    const cur = queue.shift()!
    for (const parent of parentMap.get(cur) ?? []) {
      if (!visited.has(parent)) {
        visited.add(parent)
        queue.push(parent)
      }
    }
  }
  return visited
}

// computeGraphHash 已移除：前后端 hash 算法 / 数据形态对不齐，
// dry-run 的 dirty 检查改由前端 graph.dirty 闸门 + 后端 /snapshots
// 的 computeUpstreamHash（按节点维度）兜底。

const defaultStageFields = (type: StageType, id: string): StageFields => ({
  id,
  name: `新${stageTypeLabel(type)}节点`,
  stageType: type,
  targetRoles: [],
  parallel: false,
  timeoutSeconds: 300,
  retryCount: 0,
  onFailure: 'stop',
  ...(type === 'script' ? { script: '' } : {}),
  ...(type === 'approval' ? { approverIds: [], approvalDescription: '' } : {}),
  ...(type === 'llm_agent' ? { capabilityKey: '' } : {}),
  ...(type === 'wait_webhook' ? { webhookTag: '' } : {}),
  // phase 3 7 新节点共用 params 容器；具体字段由 NodeInspector 按 paramSchema 渲染
  ...(['http', 'dm', 'db_update', 'sql_query', 'file_read', 'template_render', 'fan_out', 'switch'].includes(type)
    ? { params: {} }
    : {}),
})

function stageTypeLabel(t: StageType): string {
  switch (t) {
    case 'script': return '脚本'
    case 'approval': return '审批'
    case 'llm_agent': return 'LLM Agent'
    case 'wait_webhook': return 'Webhook'
    case 'http': return 'HTTP'
    case 'dm': return 'IM 私聊'
    case 'db_update': return 'DB 写入'
    case 'sql_query': return 'DB 查询'
    case 'file_read': return '文件读取'
    case 'template_render': return '模板渲染'
    case 'fan_out': return '数组扇出'
    case 'switch': return 'Switch 分支'
  }
}

export default function PipelineCanvasPage() {
  const { id } = useParams<{ id: string }>()
  const nav = useNavigate()
  const [searchParams] = useSearchParams()
  const pipelineId = Number(id)
  const autoRunRef = useRef(searchParams.get('run') === '1')

  const [pipeline, setPipeline] = useState<TestPipeline | null>(null)
  const [variableCatalog, setVariableCatalog] = useState<{ key: string; description: string; category: string }[]>([])
  const [dingtalkUsers, setDingtalkUsers] = useState<{ userId: string; name: string }[]>([])
  const [availableRoles, setAvailableRoles] = useState<string[]>([])
  const [capabilityOptions, setCapabilityOptions] = useState<CapabilityOption[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editingEdgeId, setEditingEdgeId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // Dry-run state
  const dryRunHook = useDryRunSSE()
  const [startModalOpen, setStartModalOpen] = useState(false)
  const [targetNodeId, setTargetNodeId] = useState<string>('*')
  const [webhooksOpen, setWebhooksOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const graph = usePipelineGraph({ nodes: [], edges: [] })
  const autoLayout = useAutoLayout()

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const [p, cat, usersRes, wire, caps] = await Promise.all([
          getTestPipeline(pipelineId),
          getPipelineVariables(),
          getDingTalkUsers(),
          getPipelineGraph(pipelineId),
          getCapabilities(),
        ])
        if (cancelled) return
        const users = usersRes.users.map(u => ({ userId: u.userId, name: u.name }))
        const servers = await getTestServers()
        if (cancelled) return
        setPipeline(p)
        setVariableCatalog(cat)
        setDingtalkUsers(users)
        setAvailableRoles([...new Set(servers.map(s => s.role).filter(Boolean))])
        setCapabilityOptions(
          caps.map(c => ({
            key: c.key,
            displayName: c.displayName,
          })),
        )
        graph.replaceGraph(wire)
      } catch (e) {
        const err = e as { response?: { data?: { error?: string } } }
        message.error(err?.response?.data?.error ?? '加载失败')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipelineId])

  // Auto-trigger when navigated with ?run=1
  useEffect(() => {
    if (!loading && pipeline && autoRunRef.current) {
      autoRunRef.current = false
      triggerTestRun({ pipelineId, servers: {}, triggerType: 'manual' })
        .then(({ runId }) => message.success(`已触发，执行记录 #${runId}`))
        .catch((e: any) => message.error(e?.response?.data?.error ?? '触发失败'))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, pipeline])

  const selectedNode = useMemo(
    () => graph.nodes.find(n => n.id === selectedId) ?? null,
    [graph.nodes, selectedId]
  )
  const editingEdge = useMemo(
    () => graph.edges.find(e => e.id === editingEdgeId) ?? null,
    [graph.edges, editingEdgeId]
  )

  async function handleSave() {
    const issue = firstGraphIssue(graph.nodes as { id: string; data: StageFields }[])
    if (issue) {
      message.error(issue.message)
      setSelectedId(issue.nodeId)
      return
    }
    try {
      await putPipelineGraph(pipelineId, graph.toWire())
      graph.resetDirty()
      message.success('已保存')
    } catch (e) {
      const err = e as { response?: { data?: { error?: string; details?: string[] } } }
      const details = err?.response?.data?.details
      if (details?.length) {
        message.error(`校验失败：${details.join('; ')}`)
      } else {
        message.error(err?.response?.data?.error ?? '保存失败')
      }
    }
  }

  const handleAutoLayout = useCallback(() => {
    graph.setNodes(autoLayout(graph.nodes, graph.edges))
  }, [graph, autoLayout])

  function handleBackToList() {
    if (graph.dirty) {
      Modal.confirm({
        title: '有未保存改动',
        content: '离开会丢失未保存内容，确定吗？',
        onOk: () => nav('/test-pipelines'),
      })
    } else {
      nav('/test-pipelines')
    }
  }

  async function handleTrigger() {
    if (graph.dirty) {
      message.warning('请先保存再触发')
      return
    }
    try {
      const { runId } = await triggerTestRun({ pipelineId, servers: {}, triggerType: 'manual' })
      message.success(`已触发，执行记录 #${runId}`)
    } catch (e: any) {
      message.error(e?.response?.data?.error ?? '触发失败')
    }
  }

  function handleNodeRunHere(nodeId: string) {
    if (graph.dirty) {
      message.warning('有未保存改动，请先保存再试运行')
      return
    }
    setTargetNodeId(nodeId)
    setStartModalOpen(true)
  }

  function handleStart(payload: { triggerParams: Record<string, unknown>; triggerType: string }) {
    setStartModalOpen(false)
    dryRunHook.start({
      pipelineId,
      targetNodeId,
      triggerParams: payload.triggerParams,
      triggerType: payload.triggerType,
      triggeredBy: 'canvas-user',
    })
  }

  function handleDecide(decision: { decision: 'real' | 'stub' | 'manual'; manualOutput?: Record<string, unknown>; remember: boolean }) {
    const { sessionId } = dryRunHook.state
    const { pendingDecision } = dryRunHook.state
    if (!sessionId || !pendingDecision?.nodeId) return
    void dryRunHook.submitDecision(pipelineId, sessionId, {
      nodeId: pendingDecision.nodeId as string,
      decision: decision.decision,
      manualOutput: decision.manualOutput,
      remember: decision.remember,
    })
  }

  function handleAddNode(type: StageType) {
    const id = ulid()
    const baseY = graph.nodes.length === 0 ? 100 : Math.max(...graph.nodes.map(n => n.position.y)) + 140
    graph.setNodes([
      ...graph.nodes,
      {
        id, type, position: { x: 200, y: baseY },
        data: defaultStageFields(type, id),
      },
    ])
  }

  if (loading) return <Spin style={{ margin: 48 }} />

  const { phase, progressByNode, staleNodeIds, pendingDecision, pendingExternal } = dryRunHook.state

  // Inject dry-run callbacks and phase into node data
  const nodesWithDryRun = graph.nodes.map(n => ({
    ...n,
    data: {
      ...n.data,
      __onRunHere: () => handleNodeRunHere(n.id),
      __dryRunPhase: progressByNode[n.id] ?? 'idle',
    },
  }))

  // Compute ancestors for NodeInspector upstream tab
  const selectedAncestors = selectedId
    ? computeAncestors(graph.edges, selectedId)
    : new Set<string>()

  return (
    <ReactFlowProvider>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
        {phase === 'awaiting-external' && pendingExternal && (
          <WaitingExternalBanner chunk={pendingExternal} />
        )}
        <CanvasToolbar
          pipelineName={pipeline?.name ?? ''}
          dirty={graph.dirty}
          onSave={handleSave}
          onAutoLayout={handleAutoLayout}
          onTrigger={handleTrigger}
          onUndo={graph.undo}
          onBackToList={handleBackToList}
          onAddNode={handleAddNode}
          onRunAll={() => handleNodeRunHere('*')}
          onWebhooks={() => setWebhooksOpen(true)}
          onSettings={() => setSettingsOpen(true)}
        />
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          <div style={{ flex: 1 }}>
            <PipelineCanvas
              nodes={nodesWithDryRun} edges={graph.edges}
              setNodes={graph.setNodes} setEdges={graph.setEdges}
              onSelectNode={setSelectedId}
              onEdgeClick={setEditingEdgeId}
              isSwitch={graph.isSwitch}
              syncSwitchParams={graph.syncSwitchParams}
            />
          </div>
          <div style={{ width: 280, borderLeft: '1px solid #f0f0f0', padding: 12, overflow: 'auto' }}>
            <VariablesPanel pipeline={pipeline} variableCatalog={variableCatalog} />
          </div>
        </div>
        <NodeInspector
          node={selectedNode}
          onClose={() => setSelectedId(null)}
          onChange={graph.updateNodeData}
          onDelete={(id) => {
            graph.deleteNode(id)
            setSelectedId(null)
          }}
          availableRoles={availableRoles}
          dingtalkUsers={dingtalkUsers}
          capabilities={capabilityOptions}
          pipelineId={pipelineId}
          ancestors={selectedAncestors}
          onRunUpstream={(nodeId) => handleNodeRunHere(nodeId)}
          pipelineContainerImage={pipeline?.containerImage}
        />
        <EdgeConditionPopover
          open={!!editingEdge}
          initial={editingEdge?.data?.condition}
          onClose={() => setEditingEdgeId(null)}
          onSubmit={(c) => {
            if (!editingEdgeId) return
            graph.updateEdgeCondition(editingEdgeId, c ? { condition: c } : undefined)
          }}
          edge={editingEdge}
          nodes={graph.nodes}
          updateSwitchCaseWhen={graph.updateSwitchCaseWhen}
          moveCase={graph.moveCase}
          deleteEdge={graph.deleteEdge}
        />
        <DryRunStartModal
          open={startModalOpen}
          pipelineId={pipelineId}
          pipelineDefaultTriggerParams={pipeline?.triggerParams}
          onCancel={() => setStartModalOpen(false)}
          onConfirm={handleStart}
        />
        {phase === 'awaiting-decision' && (
          <SideEffectDecisionModal
            chunk={pendingDecision}
            onSubmit={handleDecide}
            onCancel={() => dryRunHook.reset()}
          />
        )}
        <Drawer
          title="Webhook 触发器"
          open={webhooksOpen}
          onClose={() => setWebhooksOpen(false)}
          width={800}
          destroyOnClose
        >
          {pipelineId && <WebhooksPanel pipelineId={pipelineId} />}
        </Drawer>
        <Drawer
          title="Pipeline 设置"
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          width={480}
          destroyOnClose
        >
          {pipeline && (
            <PipelineSettingsPanel
              pipeline={pipeline}
              onSaved={(updated) => {
                setPipeline(updated)
                setSettingsOpen(false)
              }}
            />
          )}
        </Drawer>
      </div>
    </ReactFlowProvider>
  )
}
