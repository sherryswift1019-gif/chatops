---
name: e2e-fix
description: Use when an automated E2E test scenario has failed in a sandbox and you need to diagnose and fix the product bug without human interaction. You are running autonomously inside a Docker container with Read, Edit, and Bash tools.
---

# E2E Automated Fix

## Overview

You are an automated bug-fix agent running inside a sandboxed Docker container.
A test scenario has failed. Your job: diagnose the root cause, fix the product code,
commit the fix to the iteration branch — all without human interaction.

**Core principle (from debug-fix):** Find root cause before touching code. Symptom fixes are failure.

**You will receive in your first user message:**
- `scenarioId` — the failing scenario ID
- `evidenceDir` — path to evidence directory (contains `manifest.json` + `artifacts/`)
- `iterationBranch` — the git branch to commit the fix on

**Your final output MUST be a single JSON line as the very last line:**
```json
{"success":true,"commitSha":"<sha>","verdict":"product_bug","rootCauseSummary":"<one sentence>","fixedFiles":["src/..."],"failureReason":""}
```

---

## Phase 1: Read the Evidence

Read `<evidenceDir>/manifest.json` first. Note:
- `summary` — failure description
- `contextHint` — what kind of system this is, what to focus on
- `artifacts` — list of evidence files

Then read each artifact:
- `text/*` artifacts: use Read tool; for large logs focus on ERROR/PANIC/FATAL/Exception lines and the tail
- `image/*` artifacts: use Read tool (vision) — look for visible error states
- `application/json`: read directly

**From debug-fix Phase 1:** Don't skip past errors. Read stack traces completely. Note line numbers, file paths, error codes.

---

## Phase 2: Investigate the Code

1. Use Bash (grep/find) + Read to locate code paths mentioned in the evidence
2. Check recent changes: `git log --oneline -20`
3. For each suspect file: `git diff HEAD~10..HEAD -- <file>` to see what changed
4. **Form a single hypothesis:** "I think X is the root cause because Y"
   - Be specific, not vague
   - Focus on what *changed*, not what has always been there

**From debug-fix Phase 3:** One hypothesis at a time. If your first hypothesis is refuted by evidence, form a new one with fresh information — don't pile additional guesses on top of a failed one.

---

## Phase 3: Reproduce (TDD-lite)

Run the failing scenario to confirm you can reproduce it:

```bash
./test.sh --scenario <scenarioId> --evidence-dir=<evidenceDir>-repro
```

Parse the last JSON line: `{"result":"pass|fail|error|timeout","summary":"...","duration_ms":...}`

**If result == "pass":** The failure was transient.
→ Set `verdict=test_flakiness`, `success=false`
→ Skip to Phase 7, output JSON and stop.

**If result == "fail" or "error":** Reproduction confirmed. Proceed to Phase 4.

**If result == "timeout":** Likely infra issue.
→ Set `verdict=infra_issue`, `success=false`
→ Skip to Phase 7, output JSON and stop.

---

## Phase 4: Fix the Code

Edit the minimum set of files necessary to fix the confirmed root cause.

**Rules (from debug-fix):**
- Fix the root cause, not just the symptom
- One file at a time, within the confirmed scope
- Do NOT modify test files (`*.spec.ts`, `*.test.ts`)
- Do NOT add TODO comments
- Do NOT change unrelated code
- No "while I'm here" cleanup

---

## Phase 5: Verify the Fix

Run the scenario again:

```bash
./test.sh --scenario <scenarioId> --evidence-dir=<evidenceDir>-verify
```

**If result == "pass":** Fix works. Proceed to Phase 6.

**If result != "pass" (first fix attempt):** Assess:
- Evidence points to a different cause → form new hypothesis, go back to Phase 4 (one more attempt only)
- Evidence shows infrastructure problem → `verdict=infra_issue`, `success=false`, skip to Phase 7

**If result != "pass" (second fix attempt):**
→ `verdict=uncertain`, `success=false`, skip to Phase 7.
→ Do NOT make a third fix attempt.

---

## Phase 6: Commit and Push

```bash
git add -A
git commit -m "e2e-fix: <scenarioId> <one-line root cause summary>"
git push origin <iterationBranch>
SHA=$(git rev-parse HEAD)
echo "Committed: $SHA"
```

`fixedFiles` = the relative paths of files you edited (not test files, not `git add -A` —
list only what you actually changed).

---

## Phase 7: Output JSON

Print as the **very last line** of your entire output (nothing after it):

**On success:**
```json
{"success":true,"commitSha":"<SHA from git rev-parse HEAD>","verdict":"product_bug","rootCauseSummary":"<one sentence describing the root cause>","fixedFiles":["src/path/to/file.ts"],"failureReason":""}
```

**On failure:**
```json
{"success":false,"commitSha":null,"verdict":"test_flakiness|infra_issue|uncertain","rootCauseSummary":"<what you found, even if inconclusive>","fixedFiles":[],"failureReason":"<why fix was not possible or not needed>"}
```

---

## Verdict Guide

| Verdict | When to use |
|---|---|
| `product_bug` | Root cause is a product code bug; you fixed it and the test passes |
| `test_flakiness` | Scenario passed on re-run with zero code changes |
| `infra_issue` | Network timeout, port conflict, OOM, docker daemon issue — not a code bug |
| `uncertain` | Could not determine root cause after 2 fix attempts |

---

## Hard Rules

- **Never push to any branch other than the `iterationBranch` given in the user message**
- **Never modify test files** (`*.spec.ts`, `*.test.ts`, `*.spec.js`)
- **Always output the JSON as the very last line** — even if something went wrong mid-process
- **Maximum 2 fix attempts** — if still failing after attempt 2, output `success=false`
- **`commitSha` must be the actual SHA** from `git rev-parse HEAD` — never a placeholder
- **`fixedFiles` must list actual file paths** you edited — not all staged files

---

## Common Failure Patterns (ChatOps-specific)

- **DB schema mismatch**: check `src/db/schema-v*.sql` and recent migrations
- **Import cycle / missing export**: check TypeScript errors with `tsc --noEmit`
- **Async race condition**: look for missing `await`, wrong Promise chain, race in session-manager
- **Config not read**: check `resolveGitlabConfig()` vs `process.env.GITLAB_URL` direct read (always use the former)
- **MCP tool not registered**: check `src/server.ts` and `src/agent/mcp-server.ts` imports
