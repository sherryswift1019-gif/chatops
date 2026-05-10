# MCP 工具自注册约定

> 来源：[CLAUDE.md](../../CLAUDE.md) "Tool 自注册"
> 消费 role：dev-loop / code-quality-reviewer

## 必须（MUST）

新增 MCP 工具时必须做完三件事，缺一不可：

1. **创建工具文件**：`src/agent/tools/<name>.ts`，实现 `AgentTool` 接口并调用 `registerTool()` 自注册到全局 registry

2. **服务器端注册**：在 [src/server.ts](../../src/server.ts) 添加 `import './tools/<name>.js'`

3. **MCP Server 端注册**：在 [src/agent/mcp-server.ts](../../src/agent/mcp-server.ts) 添加同样的 `import './tools/<name>.js'`

如果工具需要 RBAC 默认角色：

4. 在 [src/agent/tools/types.ts](../../src/agent/tools/types.ts) 的 `DEFAULT_TOOL_ROLES` 中添加映射

## 不得（MUST NOT）

- **不得**只加一处 import 漏另一处（registry 不一致 → 工具消失，session 看到不同列表）
- **不得**手动维护 tool 列表（必须通过 `registerTool()` 自注册）
- **不得**在工具实现里硬编码角色判断（统一走 RBAC 入口）

## 检查方式（HOW TO VERIFY）

```bash
# 1. 找新增的工具文件
NEW_TOOLS=$(git -C {worktree_path} diff origin/main..HEAD --name-only --diff-filter=A | grep "^src/agent/tools/.*\.ts$")

# 2. 对每个新工具，检查两处 import 都加了
for f in $NEW_TOOLS; do
  basename=$(basename "$f" .ts)
  in_server=$(grep -c "from './tools/${basename}\.js'" src/server.ts)
  in_mcp=$(grep -c "from './tools/${basename}\.js'" src/agent/mcp-server.ts)
  if [ "$in_server" -lt 1 ] || [ "$in_mcp" -lt 1 ]; then
    echo "ERROR: $f 没在 server.ts ($in_server) + mcp-server.ts ($in_mcp) 都注册"
  fi
done
```

reviewer 输出 JSON 中：
- 漏注册 → `notes` 加 `{severity: "error", msg: "工具 X 未在 server.ts/mcp-server.ts 双注册", file: "..."}`
- 通过 → `evidence.selfCheck` 加 `{item: "Tool 自注册三件套", passed: true}`
