import { z } from 'zod'
import 'dotenv/config'

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  CLAUDE_CODE_OAUTH_TOKEN: z.string().default(''),
  DINGTALK_CLIENT_ID: z.string().default(''),
  DINGTALK_CLIENT_SECRET: z.string().default(''),
  FEISHU_APP_ID: z.string().default(''),
  FEISHU_APP_SECRET: z.string().default(''),
  FEISHU_VERIFICATION_TOKEN: z.string().default(''),
  GITLAB_WEBHOOK_SECRET: z.string().default(''),
  HARBOR_URL: z.string().default(''),
  HARBOR_USERNAME: z.string().default(''),
  HARBOR_PASSWORD: z.string().default(''),
  GITLAB_URL: z.string().default(''),
  GITLAB_TOKEN: z.string().default(''),
  PORT: z.coerce.number().default(3000),
})

export const config = schema.parse(process.env)
