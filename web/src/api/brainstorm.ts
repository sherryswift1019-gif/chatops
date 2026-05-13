import client from './client'

export type BrainstormOption = { id: string; label: string }

export type BrainstormAnswerBody = {
  waiterId?: number
  chosenOption?: string
  freeText?: string
}

export type BrainstormAnswerResponse = {
  ok?: boolean
  round?: number
  nextRound?: number
  error?: string
  message?: string
}

export type BrainstormHistoryTurn = {
  round: number
  questionMd: string
  chosenOption: string | null
  freeText: string | null
  answeredAt: string | null
  source: 'web' | 'im' | null
}

export type BrainstormActive = {
  waiterId: number
  round: number
  maxRounds: number
  questionMd: string
  options: BrainstormOption[]
  expiresAt: string
}

export type BrainstormState = {
  active: BrainstormActive | null
  history: BrainstormHistoryTurn[]
}

export async function getBrainstormState(requirementId: number): Promise<BrainstormState> {
  const { data } = await client.get(`/requirements/${requirementId}/brainstorm/state`)
  return data
}

export async function submitBrainstormAnswer(
  requirementId: number,
  body: BrainstormAnswerBody,
): Promise<BrainstormAnswerResponse> {
  try {
    const { data } = await client.post(
      `/requirements/${requirementId}/brainstorm/answer`,
      body,
    )
    return data
  } catch (err: any) {
    return err?.response?.data ?? { error: 'network_error' }
  }
}
