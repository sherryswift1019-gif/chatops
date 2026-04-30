// src/e2e/pipeline-a/nodes/llm-generator.ts
import { readFileSync } from 'fs'
import { executeCapabilityDirectForE2e } from '../llm-bridge.js'

export async function runE2eLlmGenerator(specPath: string, title: string): Promise<string> {
  let specContent = ''
  try { specContent = readFileSync(specPath, 'utf8') } catch { /* spec in git, not local */ }

  const prompt = `你是一个 Playwright 测试工程师。根据以下 markdown 验收规约，生成对应的 Playwright TypeScript 测试脚本。
要求：
1. 每个场景生成一个 test() block，test name 与场景 ID 一致
2. 使用 Playwright locator API（getByRole / getByTestId），避免 CSS 类选择器
3. 每个断言用 expect()，超时用 { timeout: 10000 }
4. 不使用 page.waitForTimeout()，改用 waitForSelector / expect().toBeVisible()
5. 文件头 import { test, expect } from '@playwright/test'

spec 路径: ${specPath}
spec 标题: ${title}

spec 内容:
${specContent || '(文件需要从 GitLab 读取，请根据路径推断场景)'}

请直接输出 TypeScript 代码，不要额外解释。`

  const result = await executeCapabilityDirectForE2e(prompt, 'generate_script')
  return result
}
