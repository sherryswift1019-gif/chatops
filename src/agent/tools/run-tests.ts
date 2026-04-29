import { registerTool } from './index.js'
import { runCommandTool } from './run-command.js'
import type { AgentTool } from './types.js'

/**
 * Deprecated: 旧 capability 配置的别名。新代码统一用 run_command。
 * 复用 runCommandTool.execute，行为一致；保留独立条目以免破坏 capability JSON 中的 'run_tests'。
 */
const runTestsAlias: AgentTool = {
  ...runCommandTool,
  name: 'run_tests',
  description: '[deprecated] 旧名称，等价于 run_command；新 capability 请改用 run_command。',
}

registerTool(runTestsAlias)
export { runTestsAlias as runTestsTool }
