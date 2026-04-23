import { z } from 'zod'
import 'dotenv/config'

// Only bootstrap-required values live in .env. All integration credentials
// (DingTalk/Feishu/GitLab/Harbor/Claude) are stored in the system_config DB
// table and managed via the admin UI.
const schema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().default(3000),
  // 对外可访问的 Web 后台 URL，用于在 IM 通知中构造 PRD 详情链接。
  // 未配置时通知里省略链接行，正文仍照发。
  WEB_BASE_URL: z.string().url().optional(),
  // LangSmith / LangChain tracing. The LangChain SDK picks these up from
  // process.env on its own; we surface them here so config changes are visible.
  LANGSMITH_API_KEY: z.string().optional(),
  LANGCHAIN_TRACING_V2: z.coerce.boolean().default(false),
  // PRD Agent V2.0 自审开关（见 docs/prds/prd-agent-v2-iteration.md §8）：
  //   - on     : 完整 V2 行为（submit_review + 机械校验 + 自修复 + 阻断态）
  //   - shadow : 跑一轮 V2 自审只为观测，findings 入 history 但 finalStatus 强制 draft，不自修复
  //   - off    : 完全跳过 AI 自审，PRD 保存后直接 draft（紧急 kill-switch）
  // 默认 on：当前生产行为；设 off 可瞬时下线自审，不用重启就回退最安全路径
  PRD_AGENT_V2_MODE: z.enum(['off', 'shadow', 'on']).default('on'),
})

export const config = schema.parse(process.env)
