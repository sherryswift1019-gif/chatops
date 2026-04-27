import { BaseEdge, EdgeLabelRenderer, getBezierPath, useNodes } from '@xyflow/react'
import type { EdgeProps } from '@xyflow/react'
import type { StageNode, StageEdge, ConditionEdgeData } from '../../types'

function labelOf(data: ConditionEdgeData | undefined): string {
  if (!data?.condition) return ''
  const c = data.condition
  if (c.kind === 'onSuccess') return '成功时'
  if (c.kind === 'onFailure') return '失败时'
  return `expr: ${c.expression.slice(0, 20)}`
}

export function ConditionalEdge(props: EdgeProps<StageEdge>) {
  const [path, labelX, labelY] = getBezierPath(props)
  const nodes = useNodes<StageNode>()

  // 判断是否为 switch 出边，计算标签
  const sourceNode = nodes.find(n => n.id === props.source)
  let switchLabel: string | null = null
  let switchLabelColor: string | undefined

  if (sourceNode?.data.stageType === 'switch') {
    const isDefault = props.data?.isDefault === true || props.sourceHandleId === 'default'
    if (isDefault) {
      switchLabel = 'default'
      switchLabelColor = '#722ed1'
    } else {
      // 计算当前 edge 是第几个 case（基于 switch.params.cases 的顺序）
      const cases = ((sourceNode.data.params as any)?.cases ?? []) as Array<{ when: string; target: string }>
      const caseIdx = cases.findIndex(c => c.target === props.target)
      switchLabel = caseIdx >= 0 ? `case#${caseIdx + 1}` : 'case'
      switchLabelColor = '#b37feb'
    }
  }

  const label = switchLabel ?? labelOf(props.data)
  const labelColor = switchLabelColor

  // stroke color for switch default edges
  const strokeColor = (sourceNode?.data.stageType === 'switch' && (props.data?.isDefault === true || props.sourceHandleId === 'default'))
    ? '#722ed1'
    : undefined

  return (
    <>
      <BaseEdge id={props.id} path={path} markerEnd={props.markerEnd}
        style={strokeColor ? { stroke: strokeColor, strokeWidth: 2 } : undefined} />
      {label && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%,-50%) translate(${labelX}px, ${labelY}px)`,
              background: labelColor ? labelColor : '#fff',
              color: labelColor ? '#fff' : undefined,
              padding: '2px 6px', border: `1px solid ${labelColor ?? '#d9d9d9'}`,
              borderRadius: 4, fontSize: 11, pointerEvents: 'all',
            }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}
