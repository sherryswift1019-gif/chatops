# chatops-skills

ChatOps 团队内部 Claude Code 技能市场。所有成员（产品、研发、设计、QA）都可以通过一行命令装上团队共享的 AI 能力。

## 当前可用 plugin

| 名称 | 分类 | 说明 |
|------|------|------|
| `prd-review` | product | 资深产品视角结构化评审 PRD，打分 + 逐条修改建议 |

## 安装方式（团队成员）

### 前置条件
- 安装 [Claude Code](https://claude.com/claude-code)（CLI、桌面版或 VS Code 扩展均可）
- 已 clone chatops 仓库到本地

### Step 1 — 注册 marketplace

在任意目录打开 Claude Code，执行：

```
/plugin marketplace add /绝对路径/到/chatops/chatops-skills
```

例如：
```
/plugin marketplace add ~/code/chatops/chatops-skills
```

> 如果 chatops 仓库地址稳定，以后也可以改成直接从 GitLab 拉：
> `/plugin marketplace add git@code.paraview.cn:<group>/chatops-skills.git`
> （需要先把本目录剥离成独立仓库，当前放在 chatops 内是 monorepo 模式。）

### Step 2 — 安装 plugin

```
/plugin install prd-review@chatops-skills
```

### Step 3 — 验证

新开一个 Claude Code 会话，输入：
```
帮我 review 这份 PRD： @docs/prds/xxx.md
```
如果回复里开始输出「PRD Review 报告 / 维度评分 / 详细扣分项」，说明已加载成功。

## 更新

```
/plugin marketplace update chatops-skills
/plugin update prd-review@chatops-skills
```

## 卸载

```
/plugin uninstall prd-review@chatops-skills
```

## 给 plugin 作者：新增 plugin 流程

1. 在 `plugins/` 下新建 `<name>/` 目录
2. 按以下最小结构组织：
   ```
   plugins/<name>/
   ├── .claude-plugin/
   │   └── plugin.json        # name/description/version/author
   └── skills/
       └── <skill-name>/
           └── SKILL.md       # YAML frontmatter: name + description
   ```
3. 在根目录 `.claude-plugin/marketplace.json` 的 `plugins` 数组里追加一项：
   ```json
   {
     "name": "<name>",
     "description": "...",
     "category": "development | product | qa | ...",
     "source": "./plugins/<name>"
   }
   ```
4. 本地测试：`/plugin marketplace update chatops-skills` → `/plugin install <name>@chatops-skills`
5. 通过后提 MR 合入 chatops 主干，其他人 `git pull` 并执行 `/plugin marketplace update` 即可拿到更新

## Plugin 开发约定

- **`SKILL.md` 的 `description` 字段必须把「何时触发」讲清**，Claude 会依据它判断是否调用。例：「当用户说『review 产品文档 / PRD』时触发」
- **不要把敏感信息写进 SKILL.md**（token、内网 URL）；如需环境相关能力，让 skill 调用项目里既有的 MCP 工具
- **优先引用而非复制**：如果某份规范文档已经在 chatops 仓库里，skill 里直接 Read 路径，不要把内容嵌进 SKILL.md，避免规范更新时要同步改两处
- **每个 plugin 至多 3 个 skill**，超过就拆成独立 plugin，方便按需安装

## 目录结构

```
chatops-skills/
├── .claude-plugin/
│   └── marketplace.json      # 市场元数据 + plugin 列表
├── plugins/
│   └── prd-review/
│       ├── .claude-plugin/
│       │   └── plugin.json   # plugin 元数据
│       └── skills/
│           └── prd-review/
│               └── SKILL.md  # skill 本体（含 frontmatter 定义）
└── README.md
```
