import client from './client'

export type BrainstormAnswerBody = {
  chosenOption?: string
  freeText?: string
}

export type BrainstormAnswerResponse = {
  ok?: boolean
  error?: string
  message?: string
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
    // 400 no_active_brainstorm_waiter 等错误体在 err.response.data
    return err?.response?.data ?? { error: 'network_error' }
  }
}
