import { useEffect, useState, useMemo, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ReactFlowProvider } from '@xyflow/react'
import { Spin, message, Modal } from 'antd'
import { ulid } from 'ulidx'
import { getTestPipeline } from '../api/test-pipelines'
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
import type { TestPipeline } from '../types'
import type { StageType, StageFields } from './types'

export interface CapabilityOption {
  key: string
  displayName: string
}

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
  ...(type === 'im_input'
    ? {
        imInputConfig: {
          prompt: '请提供以下参数：',
          paramSchema: { type: 'object', properties: {}, required: [] },
          timeoutSeconds: 600,
        },
      }
    : {}),
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
    case 'im_input': return 'IM 输入'
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

function firstGraphIssue(nodes: ReadonlyArray<{ id: string; data: StageFields }>):
  | { nodeId: string; message: string }
  | null {
  for (const n of nodes) {
    const d = n.data
    if (!d.name?.trim()) return { nodeId: n.id, message: '节点缺少名称' }
    if (d.stageType === 'llm_agent' && !d.capabilityKey?.trim()) {
      return { nodeId: n.id, message: `节点 ${d.name}: 未选择 Capability` }
    }
    if (d.stageType === 'wait_webhook' && !d.webhookTag?.trim()) {
      return { nodeId: n.id, message: `节点 ${d.name}: Webhook Tag 为空` }
    }
    if (d.stageType === 'im_input') {
      if (!d.imInputConfig?.prompt?.trim()) {
        return { nodeId: n.id, message: `节点 ${d.name}: 引导语为空` }
      }
      const ps = d.imInputConfig.paramSchema
      if (!ps || typeof ps !== 'object' || Array.isArray(ps)) {
        return { nodeId: n.id, message: `节点 ${d.name}: paramSchema 不是合法 object` }
      }
    }
    if (d.stageType === 'approval' && (!d.approverIds || d.approverIds.length === 0)) {
      return { nodeId: n.id, message: `节点 ${d.name}: 未选择审批人` }
    }
  }
  return null
}

export default function PipelineCanvasPage() {
  const { id } = useParams<{ id: string }>()
  const nav = useNavigate()
  const pipelineId = Number(id)

  const [pipeline, setPipeline] = useState<TestPipeline | null>(null)
  const [variableCatalog, setVariableCatalog] = useState<{ key: string; description: string; category: string }[]>([])
  const [dingtalkUsers, setDingtalkUsers] = useState<{ userId: string; name: string }[]>([])
  const [availableRoles, setAvailableRoles] = useState<string[]>([])
  const [capabilityOptions, setCapabilityOptions] = useState<CapabilityOption[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editingEdgeId, setEditingEdgeId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

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
        const servers = await getTestServers(p.productLineId)
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

  function handleTrigger() {
    if (graph.dirty) {
      message.warning('请先保存再触发')
      return
    }
    nav('/test-pipelines')
    message.info('回到列表页触发执行')
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

  return (
    <ReactFlowProvider>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
        <CanvasToolbar
          pipelineName={pipeline?.name ?? ''}
          dirty={graph.dirty}
          onSave={handleSave}
          onAutoLayout={handleAutoLayout}
          onTrigger={handleTrigger}
          onUndo={graph.undo}
          onBackToList={handleBackToList}
          onAddNode={handleAddNode}
        />
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          <div style={{ flex: 1 }}>
            <PipelineCanvas
              nodes={graph.nodes} edges={graph.edges}
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
          availableRoles={availableRoles}
          dingtalkUsers={dingtalkUsers}
          capabilities={capabilityOptions}
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
        />
      </div>
    </ReactFlowProvider>
  )
}
