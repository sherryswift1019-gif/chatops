## T30 review 发现 — aiReviewMaxRounds 语义微调

当前 `handleAiReviewFailure` 的 cap 语义是"**retry limit**"——`maxRounds=3` 允许 spec_author 重写 3 次（即跑 round 1 init + round 2/3/4 retry，共 4 次 LLM 调用）。但 spec design §1 描述 "默认 3" 似乎是 "**review limit**"——即只允许 3 次 review（spec_author 共跑 3 次）。

**当前行为**：最坏路径 spec_author 跑 1 (initial) + 3 (after each AI fail) + 2 (after each human reject) = **6 次**，与 design §4 R1 "最多 6 次" 的描述对齐——语义其实一致。

修法（无需立刻改）：
- 选项 A：保持现状，把 `aiReviewMaxRounds` 重命名为 `aiReviewMaxRetries` 让语义清晰
- 选项 B：把 cap 检查改为 `if (currentCount + 1 >= aiReviewMaxRounds)`，让 maxRounds=3 时 spec_author 只跑 3 次
- 选项 C：在 design §1 文字里把"默认 3"改为"默认 3 次重试"，对齐 implementer 语义

scope：1 commit，文字 + 测试期望调整。建议先观察 dogfood 几次再定。

---

## Sync 时机（重申）

在 worktree merge 回 main **之后**，在 `/Users/zhangshanshan/AI-ChatOps/` 主仓库直接 Edit 上述 `.claude/` 文件。注意 `.claude/` 改动**不会进 git commit history**——这是项目本身的设计选择。
