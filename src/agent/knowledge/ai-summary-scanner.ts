import { exec } from 'child_process'
import { readdirSync, statSync, existsSync, writeFileSync, mkdirSync } from 'fs'
import { join, basename } from 'path'
import { promisify } from 'util'

const execAsync = promisify(exec)

interface ScanResult {
  modules: string[]
  summaryFiles: string[]
  suggestedOwners: { module: string; topContributor: string }[]
}

/**
 * 扫描代码仓库目录结构，识别模块。
 * 约定：顶层目录（排除 docs/.git/node_modules 等）即为模块。
 */
function detectModules(repoPath: string): string[] {
  const skipDirs = new Set(['.git', 'node_modules', 'dist', 'build', 'target', '.idea', '.vscode', 'docs', 'sql', 'deploy'])
  const entries = readdirSync(repoPath)
  return entries.filter(name => {
    if (skipDirs.has(name) || name.startsWith('.')) return false
    const fullPath = join(repoPath, name)
    return statSync(fullPath).isDirectory()
  })
}

/**
 * 为每个模块生成初始 AI 摘要模板（实际内容需要 Claude 填充）。
 */
function generateSummaryTemplate(module: string): string {
  return `# ${module} AI 摘要

> 自动生成的初始模板。请 Review 后补充业务逻辑描述。
>
> **最后更新**：${new Date().toISOString().split('T')[0]}

## 模块定位

*待补充：该模块的核心职责和在系统中的位置*

## 核心类/文件

*待补充：关键类、文件及其作用*

## 依赖关系

*待补充：该模块依赖和被依赖的模块*

## 常见问题

*待补充：历史 Bug 模式和注意事项*
`
}

/**
 * 基于 git shortlog 推测模块的主要贡献者（作为负责人建议）。
 */
async function suggestOwners(repoPath: string, modules: string[]): Promise<{ module: string; topContributor: string }[]> {
  const results: { module: string; topContributor: string }[] = []

  for (const mod of modules) {
    try {
      const { stdout } = await execAsync(
        `git log --format='%aN' -- ${mod}/ | sort | uniq -c | sort -rn | head -1`,
        { cwd: repoPath, timeout: 30_000 }
      )
      const match = stdout.trim().match(/^\s*\d+\s+(.+)$/)
      if (match) {
        results.push({ module: mod, topContributor: match[1] })
      }
    } catch {
      // git log 失败（空模块等），跳过
    }
  }

  return results
}

/**
 * 主入口：扫描仓库 → 生成 AI 摘要模板 → 输出负责人建议。
 */
export async function scanAndGenerateSummaries(repoPath: string, aiSummaryPath = 'docs/ai'): Promise<ScanResult> {
  const modules = detectModules(repoPath)
  console.log(`[AISummary] detected ${modules.length} modules: ${modules.join(', ')}`)

  // 创建 AI 摘要目录
  const summaryDir = join(repoPath, aiSummaryPath)
  mkdirSync(summaryDir, { recursive: true })

  const summaryFiles: string[] = []

  // 生成 INDEX.md
  const indexContent = `# AI 摘要索引\n\n${modules.map(m => `- [${m}](./${m}.md)`).join('\n')}\n`
  const indexPath = join(summaryDir, 'INDEX.md')
  writeFileSync(indexPath, indexContent, 'utf8')
  summaryFiles.push(indexPath)

  // 为每个模块生成模板
  for (const mod of modules) {
    const filePath = join(summaryDir, `${mod}.md`)
    if (!existsSync(filePath)) {
      writeFileSync(filePath, generateSummaryTemplate(mod), 'utf8')
      summaryFiles.push(filePath)
      console.log(`[AISummary] generated template: ${aiSummaryPath}/${mod}.md`)
    } else {
      console.log(`[AISummary] skipped (exists): ${aiSummaryPath}/${mod}.md`)
    }
  }

  // 推测负责人
  const suggestedOwners = await suggestOwners(repoPath, modules)

  return { modules, summaryFiles, suggestedOwners }
}
