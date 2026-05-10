# GitLab 配置读取约定

> 来源：[CLAUDE.md](../../CLAUDE.md) "GitLab 配置读取约定（2026-04-20）"
> 消费 role：dev-loop / code-quality-reviewer

## 必须（MUST）

所有访问 GitLab 的代码必须调 [resolveGitlabConfig()](../../src/config/gitlab.ts) 读 GitLab 配置（url / token / skipTlsVerify）。

读取顺序由 `resolveGitlabConfig()` 内部处理：
1. DB `system_config.gitlab` 中的 `{url, token, skipTlsVerify}`
2. 任一为空时回退读 `process.env.GITLAB_URL` / `GITLAB_TOKEN` / `GITLAB_SKIP_TLS_VERIFY`
3. 都空则返回空值，调用方自行判断并报错

## 不得（MUST NOT）

- **不得**直接读 `process.env.GITLAB_URL` / `process.env.GITLAB_TOKEN` / `process.env.GITLAB_SKIP_TLS_VERIFY`
- **不得**裸调 `getConfig('gitlab')` 拿原始值
- **不得**在新建文件中重新实现配置读取逻辑

## 例外（EXCEPTIONS）

[src/pipeline/executor.ts:29](../../src/pipeline/executor.ts#L29) 严益昌原创代码保持 `process.env.GITLAB_URL` 不动。这是 6 文件零改动硬约束。

新增代码**不得**援引此例外。

## 检查方式（HOW TO VERIFY）

```bash
# 1. 检查 git diff 中有没有违规读 env
git -C {worktree_path} diff origin/main..HEAD | \
  grep -E "process\.env\.(GITLAB_URL|GITLAB_TOKEN|GITLAB_SKIP_TLS_VERIFY)"

# 命中即 error（除非命中位置在 src/pipeline/executor.ts:29 周边）
```

reviewer 输出 JSON 中：
- 命中违规 → `notes` 加 `{severity: "error", msg: "...", file: "..."}`
- 检查通过 → `evidence.standardsConsulted` 加 `"docs/standards/gitlab-config.md"`，`evidence.selfCheck` 加 `{item: "GitLab 配置统一入口", passed: true}`
