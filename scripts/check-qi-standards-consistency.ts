#!/usr/bin/env tsx
// Check QI standards consistency:
//   1. each role.md references qi-spec-quality.md
//   2. no dead §X chapter (every §X is consumed by at least one role.md or lint)
//   3. EnrichedInput schema fields referenced consistently across role.md + schema file

import { readFileSync, existsSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = join(__dirname, '..')

const ROLES = [
  '.claude/skills/quick-impl-artifact-author/roles/brainstorm-host.md',
  '.claude/skills/quick-impl-artifact-author/roles/spec-author.md',
  '.claude/skills/quick-impl-artifact-author/roles/spec-reviewer.md',
].map((r) => join(REPO_ROOT, r))

const STANDARD = join(REPO_ROOT, 'docs/standards/qi-spec-quality.md')
const SCHEMA = join(REPO_ROOT, 'src/quick-impl/enriched-input-schema.ts')
const LINT = join(REPO_ROOT, 'scripts/qi-spec-lint.ts')

let failed = false
let warnings = 0

function fail(msg: string): void {
  console.error(`[FAIL] ${msg}`)
  failed = true
}
function warn(msg: string): void {
  console.warn(`[WARN] ${msg}`)
  warnings++
}
function ok(msg: string): void {
  console.log(`[ OK ] ${msg}`)
}

// === Check 0: required artifacts exist ===
if (!existsSync(STANDARD)) {
  fail(`missing: docs/standards/qi-spec-quality.md`)
}
if (!existsSync(SCHEMA)) {
  fail(`missing: src/quick-impl/enriched-input-schema.ts`)
}

// === Check 1: each role.md references qi-spec-quality.md ===
const presentRoles: string[] = []
for (const r of ROLES) {
  const rel = r.replace(REPO_ROOT + '/', '')
  if (!existsSync(r)) {
    warn(`role.md gitignored or not yet synced: ${rel} (skipping check 1)`)
    continue
  }
  presentRoles.push(r)
  const c = readFileSync(r, 'utf-8')
  if (!c.includes('qi-spec-quality.md')) {
    fail(`${rel} does not reference qi-spec-quality.md`)
  } else {
    ok(`${rel} references qi-spec-quality.md`)
  }
}

// === Check 2: no dead chapter ===
if (existsSync(STANDARD)) {
  const standard = readFileSync(STANDARD, 'utf-8')
  const chapterIds = [...standard.matchAll(/^##\s+§(\d+)/gm)].map((m) => `§${m[1]}`)
  const consumers = [...presentRoles, ...(existsSync(LINT) ? [LINT] : [])]
  for (const ch of chapterIds) {
    if (consumers.length === 0) {
      warn(`cannot verify ${ch} consumption — no role.md present and no lint`)
      continue
    }
    const referenced = consumers.some(
      (f) =>
        readFileSync(f, 'utf-8').includes(`qi-spec-quality.md ${ch}`) ||
        readFileSync(f, 'utf-8').includes(`${ch}`),
    )
    if (!referenced) {
      warn(`dead chapter suspect: ${ch} in qi-spec-quality.md`)
    } else {
      ok(`${ch} consumed`)
    }
  }
}

// === Check 3: EnrichedInput schema consistency ===
if (existsSync(SCHEMA)) {
  const schemaSrc = readFileSync(SCHEMA, 'utf-8')
  const expectedFields = [
    'actors',
    'objective',
    'scope',
    'noGos',
    'historicalRefs',
    'codebaseEvidence',
    'conversationSummary',
    'qaTurnCount',
    'partial',
  ]
  for (const f of expectedFields) {
    if (!schemaSrc.includes(f)) {
      fail(`enriched-input-schema.ts missing field: ${f}`)
    } else {
      ok(`enriched-input-schema.ts has field: ${f}`)
    }
  }
  for (const role of presentRoles) {
    const rel = role.replace(REPO_ROOT + '/', '')
    const c = readFileSync(role, 'utf-8')
    const refsSchema =
      c.includes('enriched-input-schema') ||
      c.includes('EnrichedInput') ||
      c.includes('enrichedInput')
    if (!refsSchema) {
      warn(`${rel} does not reference EnrichedInput schema`)
    } else {
      ok(`${rel} references EnrichedInput schema`)
    }
  }
}

// === Summary ===
console.log('')
if (warnings > 0) {
  console.log(`${warnings} warning(s) (role.md gitignored or other soft issues). Not fatal.`)
}
if (failed) {
  console.error('FAIL: qi standards consistency check found hard errors.')
  process.exit(1)
}
console.log('PASS: qi standards consistency check passed')
