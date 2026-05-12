import { Tooltip, Typography } from 'antd'
import {
  CheckCircleFilled, CloseCircleFilled,
  SyncOutlined, MinusCircleFilled,
} from '@ant-design/icons'
import type { V2StageResult } from '../../api/requirements'
import { STEPPER_STAGES, type StepperStage, stageStatus, mapNodeNameToStage } from './qi-stage-map'

const { Text } = Typography

const STAGE_LABEL: Record<StepperStage, string> = {
  init: 'Init', spec: 'Spec', plan: 'Plan',
  dev: 'Dev', review: 'Review', e2e: 'E2E', mr: 'MR',
}

interface Props {
  stageResults: V2StageResult[]
  skipE2E: boolean
}

export function ProgressStepper({ stageResults, skipE2E }: Props) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 0, fontSize: 12 }}>
      {STEPPER_STAGES.map((stage, idx) => {
        const isE2eSkipped = stage === 'e2e' && skipE2E
        const status = isE2eSkipped ? 'skipped' : stageStatus(stage, stageResults)
        const isLast = idx === STEPPER_STAGES.length - 1

        const subnodes = stageResults
          .filter(n => mapNodeNameToStage(n.name) === stage)
          .map(n => `${n.name}: ${n.status}`).join('\n')

        let dot: React.ReactNode
        let dotColor: string
        switch (status) {
          case 'done':
            dot = <CheckCircleFilled />; dotColor = '#52c41a'; break
          case 'running':
            dot = <SyncOutlined spin />; dotColor = '#1677ff'; break
          case 'failed':
            dot = <CloseCircleFilled />; dotColor = '#ff4d4f'; break
          case 'skipped':
            dot = <MinusCircleFilled />; dotColor = '#bfbfbf'; break
          case 'pending':
          default:
            dot = <span style={{ width: 14, height: 14, borderRadius: '50%', border: '2px solid #d9d9d9', display: 'inline-block' }} />
            dotColor = '#d9d9d9'
        }

        return (
          <Tooltip
            key={stage}
            title={
              isE2eSkipped
                ? '已配置 skipE2E=true，整段 E2E 跳过'
                : subnodes || `${STAGE_LABEL[stage]}：尚未到达`
            }
            overlayInnerStyle={{ whiteSpace: 'pre-line', fontSize: 12 }}
          >
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, minWidth: 64 }}>
                <span style={{ color: dotColor, fontSize: 14 }}>{dot}</span>
                <Text style={{ fontSize: 11, color: status === 'pending' ? '#8c8c8c' : '#1A1F2E' }}>
                  {STAGE_LABEL[stage]}
                </Text>
              </div>
              {!isLast && (
                <div style={{
                  width: 24,
                  height: 2,
                  background: status === 'done' ? '#52c41a' : '#EEF0F4',
                  marginTop: -16,
                }} />
              )}
            </div>
          </Tooltip>
        )
      })}
    </div>
  )
}
