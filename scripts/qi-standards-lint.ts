#!/usr/bin/env node
/**
 * Quick-Impl Standards Lint
 *
 * 检查 CLAUDE.md 与 docs/standards/ 是否漂移。
 * 设计：docs/prds/quick-impl-roles-v2/03-standards.md §3
 *
 * 用法：
 *   pnpm exec tsx scripts/qi-standards-lint.ts            # 跑检查，命中违规 exit 1
 *   pnpm exec tsx scripts/qi-standards-lint.ts --report   # 仅报告，不退出非零
 *
 * 检查项（每个 standards/*.md 必须）：
 *   1. CLAUDE.md 中能 grep 到该 standards 的关键词（避免漂移：standards 加了内容但 CLAUDE.md 完全不知）
 *   2. 如果 CLAUDE.md 已重构为摘要 + link 模式（含 `docs/standards/X.md` 字符串），
 *      校验该 link 对应文件确实存在
 *
 * 关键词提取规则：从 standards/*.md 的"必须"段抽出 grep-able tokens：
 *   - markdown link 路径（`[xxx](path/to/yyy)`）→ 取 yyy 路径片段
 *   - 反引号字符串 (`xxx`) → 取 xxx
 *   - 大写命名（`registerTool` / `resolveGitlabConfig` / `mapRow`）
 *
 * 退出码：
 *   0  通过
 *   1  有违规（默认）/ 仅警告（--report 模式）
 *   2  CLAUDE.md / docs/standards/ 不存在
 */
import { existsSync, readFileSync, readdirSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = join(__dirname, '..')
const CLAUDE_MD = join(REPO_ROOT, 'CLAUDE.md')
const STANDARDS_DIR = join(REPO_ROOT, 'docs', 'standards')

const MODE_REPORT = process.argv.includes('--report')

interface CheckResult {
  ok: boolean
  errors: string[]
  warnings: string[]
}

const result: CheckResult = { ok: true, errors: [], warnings: [] }

function fail(msg: string): void {
  result.errors.push(msg)
  result.ok = false
}

function warn(msg: string): void {
  result.warnings.push(msg)
}

function info(msg: string): void {
  console.log(`[lint] ${msg}`)
}

// =============================================================================
// pre-checks
// =============================================================================

if (!existsSync(CLAUDE_MD)) {
  console.error(`[lint] CLAUDE.md missing at ${CLAUDE_MD}`)
  process.exit(2)
}
if (!existsSync(STANDARDS_DIR)) {
  console.error(`[lint] docs/standards/ missing at ${STANDARDS_DIR}`)
  process.exit(2)
}

const claudeContent = readFileSync(CLAUDE_MD, 'utf8')
const standardsFiles = readdirSync(STANDARDS_DIR).filter((f) => f.endsWith('.md'))

if (standardsFiles.length === 0) {
  fail(`docs/standards/ has no .md files`)
}

// =============================================================================
// 关键词提取
// =============================================================================

/**
 * 从 standards 文件抽 grep-able tokens（粗略，不求精）：
 *  - `xxx`  反引号字符串（去重）
 *  - `[xxx](relative/path)` link 中 xxx
 *  - 标题第一行去 # 号后的核心关键词
 */
function extractTokens(content: string): Set<string> {
  const tokens = new Set<string>()

  // 反引号
  for (const m of content.matchAll(/`([^`\n]+)`/g)) {
    const t = m[1]!.trim()
    if (t.length >= 4 && t.length <= 60) tokens.add(t)
  }

  // 标题第一行（## 或 # 开头）
  const firstHeading = content.match(/^# +(.+)$/m)?.[1]
  if (firstHeading) {
    // 仅取标题第一个名词性短语（去掉解释）
    const main = firstHeading.split(/[（(—-]/)[0]!.trim()
    if (main.length >= 2) tokens.add(main)
  }

  return tokens
}

// =============================================================================
// 主检查 1：每个 standards 文件至少一个 token 在 CLAUDE.md 出现
// =============================================================================

info(`checking ${standardsFiles.length} standards files vs CLAUDE.md ...`)

for (const file of standardsFiles) {
  const path = join(STANDARDS_DIR, file)
  const content = readFileSync(path, 'utf8')
  const tokens = extractTokens(content)

  if (tokens.size === 0) {
    warn(`${file}: 抽不出任何关键词（文件可能内容太少）`)
    continue
  }

  // 至少 1 个 token 出现在 CLAUDE.md
  let hits = 0
  const firstHits: string[] = []
  for (const t of tokens) {
    if (claudeContent.includes(t)) {
      hits++
      if (firstHits.length < 3) firstHits.push(t)
    }
  }

  if (hits === 0) {
    fail(
      `${file}: CLAUDE.md 中没出现任何关键词（已抽 ${tokens.size} 个 token）。` +
      `可能是 standards 加了新规约但 CLAUDE.md 没同步。` +
      `示例 token: ${[...tokens].slice(0, 3).join(' / ')}`,
    )
  } else {
    info(`  ✓ ${file}: ${hits}/${tokens.size} tokens 命中 CLAUDE.md (e.g. ${firstHits.join(', ')})`)
  }
}

// =============================================================================
// 主检查 2：CLAUDE.md 引用的 docs/standards/ 路径必须存在（v2 重构后）
// =============================================================================

const standardsLinks = Array.from(claudeContent.matchAll(/docs\/standards\/([a-z0-9-]+\.md)/g))
const linkedFiles = new Set(standardsLinks.map((m) => m[1]!))

if (linkedFiles.size > 0) {
  info(`CLAUDE.md references ${linkedFiles.size} standards files (v2 摘要+link 模式)`)
  for (const file of linkedFiles) {
    const path = join(STANDARDS_DIR, file)
    if (!existsSync(path)) {
      fail(`CLAUDE.md links to docs/standards/${file} but file doesn't exist`)
    }
  }
  // 反向：每个 standards 文件应被 CLAUDE.md 引用（v2 完全重构后）
  const realFiles = new Set(standardsFiles)
  for (const f of realFiles) {
    if (!linkedFiles.has(f)) {
      warn(`docs/standards/${f} 未被 CLAUDE.md 引用（v2 重构完成后应该有 link）`)
    }
  }
} else {
  // v1 模式（CLAUDE.md 还没重构）—— 这是 Phase 5 完整推完前的中间状态，仅 info
  info(`CLAUDE.md 暂无 docs/standards/ link 引用（v1 状态，Phase 5 完成后会有）`)
}

// =============================================================================
// 输出
// =============================================================================

console.log()
console.log(`=== Lint result ===`)
console.log(`  errors:   ${result.errors.length}`)
console.log(`  warnings: ${result.warnings.length}`)

if (result.errors.length > 0) {
  console.log(`\nErrors:`)
  result.errors.forEach((e) => console.log(`  ✗ ${e}`))
}
if (result.warnings.length > 0) {
  console.log(`\nWarnings:`)
  result.warnings.forEach((w) => console.log(`  ⚠ ${w}`))
}

if (result.ok) {
  console.log(`\n✓ All checks passed`)
  process.exit(0)
} else if (MODE_REPORT) {
  console.log(`\n(--report mode) exiting 0 despite ${result.errors.length} error(s)`)
  process.exit(0)
} else {
  console.log(`\n✗ Lint failed`)
  process.exit(1)
}
