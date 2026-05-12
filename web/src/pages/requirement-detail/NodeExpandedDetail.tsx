import { Typography } from 'antd'
import type { ApprovalWaiterDTO, V2StageResult } from '../../api/requirements'
import { V2StructuredView } from '../../components/V2StructuredView'
import { QiE2eProgress } from '../QiE2eProgress'
import { NodeCommitsView } from './NodeCommitsView'
import { NodeApprovalView } from './NodeApprovalView'
import { NodeOutputView } from './NodeOutputView'

const { Text } = Typography

interface Props {
  stage: V2StageResult
  waiters: ApprovalWaiterDTO[]
  /** 整个 stageResults 列表，给 qi_e2e_runner 节点用 */
  allStages: V2StageResult[]
}

export function NodeExpandedDetail({ stage, waiters, allStages }: Props) {
  // error 优先：失败节点先展示 error
  const errorBlock = stage.error ? (
    <div style={{
      background: '#FFF1F0',
      border: '1px solid #FFCCC7',
      borderRadius: 6,
      padding: 10,
      marginBottom: 12,
      fontSize: 12,
      color: '#CF1322',
      whiteSpace: 'pre-wrap',
    }}>
      <Text strong style={{ color: '#CF1322' }}>错误</Text>
      <div style={{ marginTop: 4 }}>{stage.error}</div>
    </div>
  ) : null

  // 按 type 分发主体
  let body: React.ReactNode
  switch (stage.type) {
    case 'llm_author':
    case 'llm_review':
      body = <V2StructuredView stage={stage} />
      break
    case 'git_commit_push':
      body = <NodeCommitsView stage={stage} />
      break
    case 'human_gate':
      body = <NodeApprovalView stage={stage} waiters={waiters} />
      break
    case 'qi_e2e_runner':
      // QiE2eProgress 接收 stageResults 数组（按现签名），传入全部 stages 让它筛选
      body = <QiE2eProgress stageResults={allStages} />
      break
    case 'mr_create':
    case 'init_qi_branch':
    case 'cleanup':
    case 'switch':
    case 'end':
    case 'im_input':
    default:
      body = <NodeOutputView stage={stage} />
  }

  return (
    <div style={{ paddingLeft: 24, paddingTop: 8, paddingBottom: 8 }}>
      {errorBlock}
      {body}
    </div>
  )
}
