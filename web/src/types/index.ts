export interface ProductLine {
  id: number; name: string; displayName: string; description: string; createdAt: string; updatedAt: string
}

export interface ProductLineMember {
  id: number; productLineId: number; userId: string; userName: string
  role: 'developer' | 'ops' | 'admin'; createdAt: string
}

export interface ProductLineEnv {
  id: number; productLineId: number; envId: number
  runtime: 'kubernetes' | 'docker'; namespace: string; enabled: boolean
}

export interface Project {
  id: number; productLineId: number; name: string; displayName: string
  gitlabPath: string; harborProject: string; ownerId: string; ownerName: string
  description: string; createdAt: string; updatedAt: string
}

export interface Environment {
  id: number; name: string; displayName: string; sortOrder: number; createdAt: string
}

export interface ApprovalRule {
  id: number; productLineId: number | null; action: string; env: string
  primaryApprovers: string[]; backupApprovers: string[]
  primaryTimeoutMin: number; totalTimeoutMin: number
}

export interface DingTalkUser {
  userId: string; name: string; avatar: string; department: string; syncedAt: string
}

export interface DingTalkUsersResponse { users: DingTalkUser[]; total: number }

export interface SystemConfigEntry {
  key: string; value: Record<string, unknown>; updatedAt: string
}
