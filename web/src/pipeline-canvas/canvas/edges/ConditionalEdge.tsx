import { BaseEdge, EdgeLabelRenderer, getBezierPath } from '@xyflow/react'
import type { EdgeProps } from '@xyflow/react'
import type { StageEdge, ConditionEdgeData } from '../../types'

function labelOf(data: ConditionEdgeData | undefined): string {
  if (!data?.condition) return ''
  const c = data.condition
  if (c.kind === 'onSuccess') return '成功时'
  if (c.kind === 'onFailure') return '失败时'
  return `expr: ${c.expression.slice(0, 20)}`
}

export function ConditionalEdge(props: EdgeProps<StageEdge>) {
  const [path, labelX, labelY] = getBezierPath(props)
  const label = labelOf(props.data)
  return (
    <>
      <BaseEdge id={props.id} path={path} markerEnd={props.markerEnd} />
      {label && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%,-50%) translate(${labelX}px, ${labelY}px)`,
              background: '#fff', padding: '2px 6px', border: '1px solid #d9d9d9',
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
