import { useEffect, useState } from 'react'
import { Tree, Button, Tag, message, Empty } from 'antd'
import { ExclamationCircleTwoTone, ReloadOutlined } from '@ant-design/icons'
import { listSnapshots, type DryRunSnapshot } from '../../api/dryrun'

interface Props {
  pipelineId: number
  currentNodeId: string
  ancestors: Set<string>     // 由 PipelineCanvasPage 用 computeAncestors 算好传入
  onRunUpstream: (nodeId: string) => void  // 试跑上游某节点
}

interface TreeNode {
  title: React.ReactNode
  key: string
  children?: TreeNode[]
  isLeaf?: boolean
  path?: string  // 完整 {{steps.<id>.output.<path>}} 表达式
}

function buildTree(snapshot: DryRunSnapshot): TreeNode[] {
  const value = snapshot.output
  function recurse(v: unknown, path: string, key: string): TreeNode[] {
    if (v === null || typeof v !== 'object') {
      return [{
        title: <span><span style={{ color: '#999' }}>{path.split('.').pop()}: </span><code>{JSON.stringify(v)}</code></span>,
        key, path: `{{${path}}}`, isLeaf: true,
      }]
    }
    if (Array.isArray(v)) {
      return v.slice(0, 5).flatMap((item, i) => recurse(item, `${path}[${i}]`, `${key}-${i}`))
    }
    return Object.entries(v as Record<string, unknown>).flatMap(([k, sub]): TreeNode[] => {
      const childPath = `${path}.${k}`
      const childKey = `${key}-${k}`
      if (sub === null || typeof sub !== 'object') {
        return [{
          title: <span>{k}: <code>{JSON.stringify(sub)}</code></span>,
          key: childKey, path: `{{${childPath}}}`, isLeaf: true,
        }]
      }
      return [{
        title: k,
        key: childKey,
        children: recurse(sub, childPath, childKey),
      }]
    })
  }
  return recurse(value, `steps.${snapshot.nodeId}.output`, snapshot.nodeId)
}

const SOURCE_TAG: Record<string, { color: string; label: string }> = {
  real: { color: 'green', label: '真跑' },
  stub: { color: 'gold', label: 'Stub' },
  manual: { color: 'blue', label: '手填' },
}

export function UpstreamFieldsTab(p: Props) {
  const [snapshots, setSnapshots] = useState<DryRunSnapshot[]>([])
  const [loading, setLoading] = useState(false)

  async function load() {
    setLoading(true)
    try { setSnapshots(await listSnapshots(p.pipelineId)) }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [p.pipelineId])

  const upstreamSnapshots = snapshots.filter(s => p.ancestors.has(s.nodeId))

  if (p.ancestors.size === 0) {
    return <Empty description="此节点没有上游" />
  }

  if (upstreamSnapshots.length === 0) {
    return (
      <div>
        <Empty description="上游节点尚未试跑" />
        <div style={{ marginTop: 12 }}>
          {Array.from(p.ancestors).map(nid => (
            <Button key={nid} size="small" onClick={() => p.onRunUpstream(nid)} style={{ marginRight: 4, marginBottom: 4 }}>
              ▶ 试跑 {nid}
            </Button>
          ))}
        </div>
      </div>
    )
  }

  const onSelect = (_: unknown, info: { node: TreeNode }) => {
    if (info.node.isLeaf && info.node.path) {
      navigator.clipboard.writeText(info.node.path).catch(() => {
        message.error('复制失败，请手动复制')
      })
      void message.success(`已复制 ${info.node.path}`)
    }
  }

  return (
    <div>
      <Button size="small" icon={<ReloadOutlined />} onClick={() => { void load() }} loading={loading} style={{ marginBottom: 8 }}>
        刷新
      </Button>
      {upstreamSnapshots.map(s => {
        const tag = SOURCE_TAG[s.source] ?? { color: 'default', label: s.source }
        return (
          <div key={s.nodeId} style={{ marginBottom: 16 }}>
            <div style={{ marginBottom: 4 }}>
              <strong>{s.nodeId}</strong>
              <Tag color={tag.color} style={{ marginLeft: 6 }}>{tag.label}</Tag>
              <span style={{ fontSize: 11, color: '#999' }}>
                {new Date(s.ranAt).toLocaleString()}
              </span>
              {s.stale && (
                <>
                  <ExclamationCircleTwoTone twoToneColor="#faad14" style={{ marginLeft: 8 }} />
                  <span style={{ fontSize: 11, color: '#faad14', marginLeft: 4 }}>上游已变</span>
                  <Button size="small" type="link" onClick={() => p.onRunUpstream(s.nodeId)}>重跑</Button>
                </>
              )}
              {!s.stale && (
                <Button size="small" type="link" onClick={() => p.onRunUpstream(s.nodeId)}>试跑此节点</Button>
              )}
            </div>
            <Tree
              treeData={buildTree(s)}
              onSelect={onSelect as (keys: unknown, info: unknown) => void}
              selectable
              defaultExpandAll
              style={{ background: '#fafafa', padding: 8, borderRadius: 4 }}
            />
          </div>
        )
      })}
    </div>
  )
}
