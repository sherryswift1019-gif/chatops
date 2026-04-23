import { Button, Dropdown, Space, Tooltip } from 'antd'
import type { MenuProps } from 'antd'
import {
  SaveOutlined, PlayCircleOutlined, DeploymentUnitOutlined,
  RollbackOutlined, UndoOutlined, PlusOutlined,
} from '@ant-design/icons'
import type { StageType } from '../types'

interface Props {
  pipelineName: string
  dirty: boolean
  onSave: () => void
  onAutoLayout: () => void
  onTrigger: () => void
  onUndo: () => void
  onBackToList: () => void
  onAddNode: (type: StageType) => void
}

const addMenuItems: MenuProps['items'] = [
  { key: 'script', label: '运行脚本' },
  { key: 'approval', label: '人员审批' },
  { key: 'capability', label: 'Agent Capability' },
  { key: 'wait_webhook', label: '等待 Webhook' },
  { key: 'im_input', label: 'IM 参数采集' },
]

export function CanvasToolbar(p: Props) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', padding: '8px 16px', borderBottom: '1px solid #f0f0f0', background: '#fff' }}>
      <div style={{ fontWeight: 600, marginRight: 16 }}>
        {p.pipelineName}
        {p.dirty && <span style={{ color: '#faad14', marginLeft: 8, fontSize: 12 }}>● 未保存</span>}
      </div>
      <Space style={{ marginLeft: 'auto' }}>
        <Dropdown menu={{ items: addMenuItems, onClick: (e) => p.onAddNode(e.key as StageType) }}>
          <Button icon={<PlusOutlined />}>添加节点</Button>
        </Dropdown>
        <Tooltip title="撤销"><Button icon={<UndoOutlined />} onClick={p.onUndo} /></Tooltip>
        <Button icon={<DeploymentUnitOutlined />} onClick={p.onAutoLayout}>自动排版</Button>
        <Button icon={<PlayCircleOutlined />} onClick={p.onTrigger}>触发执行</Button>
        <Button type="primary" icon={<SaveOutlined />} onClick={p.onSave} disabled={!p.dirty}>保存</Button>
        <Button icon={<RollbackOutlined />} onClick={p.onBackToList}>返回列表</Button>
      </Space>
    </div>
  )
}
