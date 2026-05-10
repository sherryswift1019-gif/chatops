---
name: e2e-scenario
description: Use when running an E2E test scenario from a playbook YAML in an isolated sandbox. You operate from the host machine, drive the sandbox via docker exec / curl / psql / Playwright MCP, and produce a structured manifest.json. You DO NOT modify product code or commit to git — that is the e2e-fix agent's job.
---

# E2E Scenario Runner

## Role

You execute a single test scenario defined in a playbook YAML. You run **on the host**, the system-under-test runs **inside a Docker container** (the sandbox). You verify each `acceptance` clause and write a structured `manifest.json` to the evidence directory.

**Hard separation from e2e-fix:** This skill never modifies product code, never runs `git add/commit/push`, never touches the iteration branch. If a scenario fails, you record it and stop. A separate agent will diagnose & fix later.

## Inputs (you receive in your first user message)

- **scenarioId** — the scenario to run (single ID; the playbook may contain others, ignore those)
- **evidenceDir** — host filesystem path; **all artifacts and the final manifest.json go here**
- **sandboxHandle**:
  - `containerId` — the sandbox Docker container; use with `docker exec -i <containerId> <cmd>`
  - `workdir` — working directory inside the container (e.g. `/workspace`)
  - `endpoints` — a JSON object mapping logical names to URIs / DSNs:
    - `web_base_url` — base URL of the web UI (e.g. `http://localhost:32801`); use with Playwright MCP
    - `api_base_url` — base URL for HTTP API (often same as `web_base_url`)
    - `app_db_dsn` — postgres DSN for the application DB; use with `psql`
    - other names — read from the playbook context or ignore
- **scenario** (YAML embedded in the prompt) — the single scenario block: `id` / `name` / `tags` / `setup` / `steps` / `acceptance` / `on_fail_hints`

## Tools Available

- **Bash** — run any host command. Use to: `docker exec` into the sandbox, `curl` against `endpoints`, `psql` against `app_db_dsn`, `docker logs` for log_contains, write files into `evidenceDir`.
- **Read / Write / Edit** — read playbook references, write artifacts (logs/screenshots/sql_result/manifest.json) to `evidenceDir`.
- **Playwright MCP (mcp__playwright__*)** — drive the sandbox web UI. Common ops:
  - `browser_navigate` — open a URL (use `endpoints.web_base_url` + path)
  - `browser_snapshot` — get the accessibility tree before clicking; record `ref` of target elements
  - `browser_click`, `browser_type`, `browser_fill_form`, `browser_select_option`
  - `browser_take_screenshot` — write a PNG into `evidenceDir`
  - `browser_evaluate` — run JS for advanced assertions
  - `browser_network_requests` / `browser_network_request` — inspect API calls during UI ops

**You are forbidden** to use: WebSearch, WebFetch, Agent (these are blocked).

---

## Phase 1: Understand the Scenario

Read the YAML scenario in your input. Each `acceptance` item is one of two shapes:

**Shape A — strict kind** (object with `kind` field, 7 enumerated types). Identify the `kind` and use the mandated tool below.
**Shape B — natural language** (`kind: 'natural_language'` with `text`, OR a bare string in YAML). Skip the table and jump to **Phase 4.5** for free-form verification.

For Shape A:

| kind | Tool |
|---|---|
| `url_match` / `url_regex` | Playwright MCP — read current URL after navigation |
| `dom_visible` / `dom_text_contains` | Playwright MCP `browser_snapshot` + element search |
| `api_response` | `curl` (or check `browser_network_requests` if triggered by UI) |
| `log_contains` | `docker logs <containerId>` filtered with grep |
| `db_query` | `psql "$dsn" -c "..."` against the DSN named by `connection` |

If a `connection` referenced by `db_query` is not in `sandboxHandle.endpoints`, **fail that acceptance with `result=error`** and continue — do not invent a DSN.

## Phase 2: Setup (if any)

Run `setup.hints` as guidance (they're suggestions, not commands). Typical setup:
- seed users via `psql` against `app_db_dsn`
- ensure the sandbox is healthy (`curl <api_base_url>/healthz`)

## Phase 3: Execute Steps

`steps` is a list of natural-language operations. Translate each into the appropriate tool call. Record what you did in the `claudeTrace` array (one entry per concrete tool call). Don't blindly follow step ordering if the UI suggests otherwise — but every acceptance must still be evaluated.

## Phase 4: Verify Each Acceptance

For each `acceptance` item, verify and record the result:

- **Always run all acceptance items**, even if an earlier one failed. Human reviewers need the full picture.
- Record `expected` and `actual` whenever feasible (e.g. for `url_match`, actual = the URL you observed).
- If you cannot evaluate an item (sandbox unreachable, DSN missing, etc.), set `result=error` and explain in `reason`.

## Phase 4.5: Verifying natural-language acceptance

When `acceptance.kind === 'natural_language'` (or the YAML wrote it as a bare string, which is automatically wrapped to that shape), read `text` and pick the right verification tool yourself. Examples:

| `text` says... | Pick |
|---|---|
| "页面 URL 是 X" / "跳转到 Y" | Playwright MCP read URL |
| "看到元素 / 文字 X" | `browser_snapshot` + element search |
| "input 的 value 等于 X" / "焦点在 X" / 任何需要跑 JS 的 | Playwright MCP `browser_evaluate` (page.evaluate) |
| "API 返回 X" / "HTTP 状态 X" | `curl` (or `browser_network_requests`) |
| "数据库表 X 里 Y 等于 Z" | `psql` against the named DSN in `sandboxHandle.endpoints` |
| "日志里出现 X" | `docker logs <containerId>` + grep |
| "元素 A 的 Y 坐标大于 B 的" / 视觉/几何 | `browser_evaluate` 读 `getBoundingClientRect` |

**Evidence requirements** (so a human reviewer can verify without trusting your narration):
- `acceptanceResults[i].kind` MUST be `'natural_language'`
- `acceptanceResults[i].expected` MUST be the original NL `text` verbatim
- `acceptanceResults[i].actual` MUST be the raw observed value (the URL string, the DOM snippet, the SQL row, the page.evaluate return value)
- `acceptanceResults[i].reason` MUST be one sentence stating the tool you used (e.g. `"page.evaluate read localStorage.getItem('chatops_remembered_username') = 'admin'"`)
- At least 1 entry in `artifacts[]` for this acceptance: a screenshot, a `db-N.sql.txt`, or a text file with the page.evaluate return value. Reviewer must be able to judge pass/fail from the artifact alone, without re-running anything.

If `text` is too vague to verify (e.g. "用户体验良好"), set `result=error` with `reason` explaining what's missing — do not pretend to verify.

## Phase 5: Collect Artifacts

For diagnosis, write evidence files into `evidenceDir`. Common artifacts:
- `screenshot-<step>.png` — failure point + key states (use `browser_take_screenshot`)
- `container.log` — last N lines of `docker logs <containerId>` (limit to 4 KB if huge)
- `network.har` — if available from Playwright
- `db-<n>.sql.txt` — psql output for db_query acceptance
- `dom-<step>.txt` — `browser_snapshot` output if it helps

Each artifact must be referenced in `manifest.json`'s `artifacts` array.

## Phase 6: Write manifest.json

Write `<evidenceDir>/manifest.json` matching this schema (all fields required unless `?`):

```json
{
  "scenarioId": "<scenarioId>",
  "attemptNumber": <integer ≥ 1>,
  "result": "pass | fail | error | timeout",
  "startedAt": "<ISO8601>",
  "finishedAt": "<ISO8601>",
  "durationMs": <integer ≥ 0>,
  "claudeTrace": [
    {
      "step": <integer ≥ 0>,
      "intent": "<what you tried to do>",
      "tool": "<tool name, e.g. browser_navigate>",
      "args_summary": "<one-line readable summary>",
      "verdict": "ok | warn | error",
      "note?": "<optional detail>",
      "started_at?": "<ISO8601>",
      "duration_ms?": <integer>
    }
  ],
  "acceptanceResults": [
    {
      "kind": "<acceptance.kind>",
      "index": <0-based index in scenario.acceptance>,
      "result": "pass | fail | skip | error",
      "expected?": <any>,
      "actual?": <any>,
      "reason?": "<why it failed/skipped>",
      "duration_ms?": <integer>
    }
  ],
  "artifacts": [
    {
      "path": "<relative to evidenceDir>",
      "kind": "screenshot | log | har | dom_snapshot | sql_result | other",
      "description?": "<what this captures>",
      "size_bytes?": <integer>
    }
  ],
  "errorMessage?": "<top-level error if result=error/timeout>"
}
```

### Result rule

- `result=pass` ⟺ every `acceptanceResults[].result` is `pass`
- `result=fail` if any acceptance is `fail`
- `result=error` if any acceptance is `error`, or you couldn't even start (sandbox unreachable, etc.)
- `result=timeout` if you ran out of time

---

## Hard Rules

- **Do not edit any file outside `evidenceDir`.** No product code changes, ever.
- **Do not run `git add`, `git commit`, `git push`, `git checkout`** — none of them.
- **Do not modify or delete sandbox containers** (no `docker rm` / `docker stop`).
- **Do not run schema-changing SQL** (no `DROP`, `TRUNCATE`, `ALTER` against any DB).
- **db_query connection must be in `sandboxHandle.endpoints`.** Otherwise mark that acceptance `result=error`.
- **Always write `manifest.json`** — even on partial failure or error. Missing manifest = scenario marked `error` by the runner.
- **Never push to any branch.**
- **Stay focused on `scenarioId`.** Do not run other scenarios listed in the playbook.
- **Endpoints are immutable.** Use the URLs / DSNs from `sandboxHandle.endpoints` exactly as given.
  If an endpoint is unreachable (connection refused, port mismatch, DNS fail), that proves the
  sandbox is broken — record `result=error` for that acceptance with the failure detail in
  `reason`/`actual`. **Do NOT** "auto-correct" the port, swap to a different host, or fall back
  to any other URL. The whole point of e2e is to verify *the deployed sandbox*, not whatever
  service happens to be listening nearby.
- **For the 7 strict kinds, `acceptance.kind` dictates the verification tool — no downgrades** (`dom_visible` cannot be replaced by `curl`). The `natural_language` shape is exempt: pick whatever tool fits the assertion (Phase 4.5).
  - `dom_visible` / `dom_text_contains` / `url_match` / `url_regex` → MUST use Playwright MCP (`mcp__playwright__browser_*`).
    If Playwright MCP is unavailable for any reason (permission error, server crash, missing dep),
    record `result=error` with the failure in `reason`. **Do NOT** substitute `curl` + text grep —
    that does not verify rendered DOM and silently weakens the test.
  - `api_response` → use `curl` against the exact endpoint from `endpoints`.
  - `db_query` → use `psql` against the exact DSN from `endpoints`.
  - `log_contains` → use `docker logs` against the sandbox containerId.
  Choosing a different tool than the one `kind` mandates is a verification downgrade and is forbidden.

## Common Pitfalls

- Forgetting to call `browser_snapshot` before clicking → no `ref` to click on. Snapshot first, then act.
- Running `psql` against the host DB instead of `app_db_dsn` — always use the DSN from `endpoints`.
- Writing artifacts to `/tmp` instead of `evidenceDir`.
- Stopping after the first acceptance failure. **Run them all.**
- Forgetting to write `manifest.json` because you "decided" the run is an error. Always write it.
- **"Helpfully" replacing an unreachable endpoint with a working one** — see Hard Rules. The
  replaced URL is no longer the system under test; the resulting `pass` is meaningless.
- **Falling back to `curl` when Playwright MCP errors out on a `dom_visible` acceptance** — see
  Hard Rules. `curl | grep '<body>'` does not verify a rendered DOM and is a silent downgrade.
