import { z } from 'zod'
import 'dotenv/config'

// Only bootstrap-required values live in .env. All integration credentials
// (DingTalk/Feishu/GitLab/Harbor/Claude) are stored in the system_config DB
// table and managed via the admin UI.
const schema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().default(3000),
  // LangSmith / LangChain tracing. The LangChain SDK picks these up from
  // process.env on its own; we surface them here so config changes are visible.
  LANGSMITH_API_KEY: z.string().optional(),
  LANGCHAIN_TRACING_V2: z.coerce.boolean().default(false),
})

export const config = schema.parse(process.env)
