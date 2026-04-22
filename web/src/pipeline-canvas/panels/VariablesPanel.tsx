import { Collapse, Tag, Typography, message } from 'antd'
import type { TestPipeline } from '../../types'

interface Props {
  pipeline: TestPipeline | null
  variableCatalog: { key: string; description: string; category: string }[]
}

export function VariablesPanel({ pipeline, variableCatalog }: Props) {
  if (!pipeline) return null

  function copy(s: string) {
    navigator.clipboard.writeText(s).then(() => message.success(`已复制 ${s}`))
  }

  const items = [
    {
      key: 'vars',
      label: '自定义变量',
      children: (
        <div>
          {Object.entries(pipeline.variables ?? {}).map(([k, v]) => (
            <Tag key={k} color="blue" style={{ cursor: 'pointer', marginBottom: 4 }}
              onClick={() => copy(`{{vars.${k}}}`)} title={v}>
              {`{{vars.${k}}}`}
            </Tag>
          ))}
          <Typography.Text type="secondary" style={{ display: 'block', fontSize: 11, marginTop: 4 }}>
            * 变量值在列表页编辑
          </Typography.Text>
        </div>
      ),
    },
    {
      key: 'artifacts',
      label: '制品输入',
      children: (
        <div>
          {(pipeline.artifactInputs ?? []).map((a) => (
            <Tag key={a.outputVar} color="purple" style={{ cursor: 'pointer', marginBottom: 4 }}
              onClick={() => copy(`{{vars.${a.outputVar}}}`)}>
              {`{{vars.${a.outputVar}}}`}
            </Tag>
          ))}
        </div>
      ),
    },
    {
      key: 'serverRoles',
      label: '服务器角色',
      children: (
        <div>
          {Object.entries(pipeline.serverRoles ?? {}).map(([r, c]) => (
            <Tag key={r} color="green">{r} × {c.count}</Tag>
          ))}
        </div>
      ),
    },
    {
      key: 'builtin',
      label: '内置变量',
      children: (
        <div>
          {variableCatalog.map(v => (
            <Tag key={v.key} color="default" style={{ cursor: 'pointer', marginBottom: 4 }}
              onClick={() => copy(`{{${v.key}}}`)} title={v.description}>
              {`{{${v.key}}}`}
            </Tag>
          ))}
        </div>
      ),
    },
  ]

  return <Collapse items={items} defaultActiveKey={['vars', 'artifacts']} size="small" />
}
