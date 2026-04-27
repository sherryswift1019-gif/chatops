# 冒烟：pipeline DSL 增强（phase 3：12 节点类型 + 变量/表达式扩展 + fan_out）

phase 3 涵盖 T1-T20，关键交付：

- T1 schema-v34：`pipeline_node_types` 新增 7 行（http / dm / db_update /
  sql_query / file_read / template_render / fan_out），初始 `enabled=FALSE`。
- T9-T15 schema-v35：7 个 executor 落地后逐个 `enabled=TRUE`，最终 12 行全 TRUE。
- T17 schema-v36：`capability` key 重命名为 `llm_agent`，同时把
  `test_pipelines.graph` / `test_pipelines.stages` 里所有 `stageType='capability'`
  的节点改名。
- T2 `src/pipeline/variables.ts` 扩展点记法 + JSONPath 子集 + 4 内置过滤器
  （urlEncode / jsonStringify / lower / upper），fan_out scope 注入。
- T3 `src/pipeline/expressions.ts` retry_when / shortCircuitWhen / 边 when
  共用的布尔表达式语言。
- T15 fan_out NodeExecutor + Promise.all 子运行（v1 body 限非 interrupt 节点）。
- T16 graph-validation 加 fan_out body 校验 / retry_when 语法预解析 /
  steps 引用 DFS 校验。
- T18-T19 NodeInspector：JSON Schema 驱动的动态参数表单（7 新节点共用）+
  retry_when / 重试间隔 折叠面板。

## 验收清单

### 1. DB 状态：12 节点类型全启用

```bash
psql "$DATABASE_URL" -c "SELECT key, category, enabled FROM pipeline_node_types ORDER BY category, key;"
```

预期：

```
       key       |  category   | enabled
-----------------+-------------+---------
 db_update       | general     | t
 dm              | general     | t
 file_read       | general     | t
 http            | general     | t
 script          | general     | t
 sql_query       | general     | t
 template_render | general     | t
 approval        | flow        | t
 fan_out         | flow        | t
 im_input        | flow        | t
 wait_webhook    | flow        | t
 llm_agent       | llm         | t
(12 rows)
```

⚠️ `category` 分组顺序、行数任一偏离 12 都说明 schema-v34/v35/v36 没全跑成功。

### 2. 启动日志：代码侧 12 注册一致

```bash
pnpm dev
```

预期日志含：

```
[server] node-type registry verified: 12 types
```

注意：T1-T17 完成后所有 `enabled=TRUE`，启动 server 走 `assertRegistryConsistent`
对比 DB enabled keys 与 `getRegisteredNodeTypeKeys()`，两边都应是 12。

故障：日志若是 `Node type registry mismatch:` 含 `Code only: capability` ——
说明 DB 还未跑 schema-v36（capability → llm_agent rename），跑 `pnpm migrate`。
若是 `DB only: <key>` —— 说明对应 executor 还没注册，检查
`src/pipeline/node-types/<key>.ts` 是否被 `index.ts` barrel 导入。

### 3. 现有 pipeline 行为零回归

触发 schema-v19 的 `deploy-im-demo` pipeline，跑通 IM 入口 → im_input →
approval → llm_agent（旧名 capability）三阶段。

⚠️ schema-v36 已经把现有 graph 里所有 `stageType='capability'` 改名为
`'llm_agent'`，日志/UI 显示应该是 `LLM Agent` 而不是 capability。

### 4. 变量插值器扩展（T2）

#### 4.1 点记法 + JSONPath 子集

创建 demo pipeline，节点 A（sql_query）输出 `{rows: [{id: 1, name: 'foo'}]}`，
节点 B（template_render）参数 `template = '{{steps.A.output.rows[0].id}}-{{steps.A.output.rows[0].name}}'`。

预期：B 的输出 `text='1-foo'`。

#### 4.2 4 个内置过滤器

template_render 各试一次：

| 模板                                    | 输入                       | 期望输出              |
| --------------------------------------- | -------------------------- | --------------------- |
| `{{vars.url \| urlEncode}}`             | `vars.url='a&b=c'`         | `a%26b%3Dc`           |
| `{{steps.x.output \| jsonStringify}}`   | `{a:1}`                    | `{"a":1}`             |
| `{{vars.s \| upper}}`                   | `vars.s='hello'`           | `HELLO`               |
| `{{vars.s \| lower}}`                   | `vars.s='Hello'`           | `hello`               |

#### 4.3 fan_out scope 注入

fan_out 节点配置 `source={{steps.A.output.items}}`、`as=item`，body 内子节点
模板 `{{item.name}}` 应解析为对应 item 的 name 字段（priority: scopes > steps > vars > triggerParams）。

### 5. 表达式解析器（T3）

#### 5.1 retry_when 触发重试

配置 http stage：
```jsonc
{
  "stageType": "http",
  "retryCount": 2,
  "retryWhen": "output.statusCode >= 500",
  "params": { "method": "GET", "url": "https://httpbin.org/status/503" }
}
```

预期：3 次调用（首次 + 2 次重试），全部 503。日志含 `retry triggered by retry_when`。
若改 `retryWhen="output.statusCode >= 600"`，应只调用 1 次（不命中 → 不重试）。

#### 5.2 边 when 表达式

两条边从 stage A 出发：
- 边 1: `{when: "output.statusCode == 200"}` → 走 success 分支
- 边 2: `{when: "output.statusCode != 200"}` → 走 failure 分支

verify graph-runner 只激活命中的下游。

#### 5.3 语法错误在保存时拦截

PUT pipeline graph 时填 `retryWhen="output.statusCode >="`（语法残缺），
预期 admin API 返回 422，details 含 `node "<id>" retry_when 语法错误: ...`。

### 6. fan_out 子运行（T15）

demo pipeline:
```
[A: template_render] → [B: fan_out] → [C: http]
```

A 输出 `items: [{id:1},{id:2},{id:3}]`；B 配置：
```jsonc
{
  "stageType": "fan_out",
  "params": {
    "source": "{{steps.A.output.items}}",
    "as": "item",
    "parallel": 2,
    "onItemFailure": "continue",
    "body": ["C"]
  }
}
```

C 配置 `params.url = "https://httpbin.org/anything?id={{item.id}}"`。

预期：
- 3 个子运行并行（最多 2 并发）。
- B 输出 `{items: [...3 个 C 的 output...], failed: []}`。
- 任一 C 失败时（`onItemFailure=continue`），失败被收进 `failed` 数组，B 整体 status=success。
- 改 `onItemFailure=stop`，第一个失败的 C 即让 B status=failed。

⚠️ v1 限制：body 节点不允许 interrupt 类型（approval / im_input / wait_webhook）；
graph-validation 应在保存时拦截违反此约束的图。

### 7. 7 新节点 demo 各一例

#### 7.1 http
```jsonc
{ "stageType": "http",
  "params": { "method": "POST", "url": "{{vars.endpoint}}",
              "headers": {"X-Trace": "{{run.id}}"},
              "body": {"foo": "bar"}, "timeoutMs": 10000 } }
```
2xx → status=success；4xx/5xx → status=failed, error=`HTTP <code>`。

#### 7.2 dm
```jsonc
{ "stageType": "dm",
  "params": { "platform": "dingtalk", "userId": "manager_a",
              "text": "Pipeline {{pipeline.name}} 完成,run={{run.id}}" } }
```
成功返回 `{messageId, deliveredAt}`。

#### 7.3 db_update
```jsonc
{ "stageType": "db_update",
  "params": { "sqlTemplate": "UPDATE test_runs SET note=$1 WHERE id=$2",
              "params": ["{{steps.A.output.note}}", "{{run.id}}"] } }
```
返回 `{rowsAffected: 1}`。⚠️ sqlTemplate 内的 `$1/$2` 是 pg 占位符，
不是模板插值；params 数组每个元素先经过变量插值再当占位值传给 pg。

#### 7.4 sql_query
```jsonc
{ "stageType": "sql_query",
  "params": { "sqlTemplate": "SELECT id, name FROM products WHERE owner=$1",
              "params": ["{{run.triggeredBy}}"] } }
```
返回 `{rows: [{id, name}, ...]}`，下游可用 `{{steps.x.output.rows[0].id}}` 读取。

#### 7.5 file_read
```jsonc
{ "stageType": "file_read",
  "params": { "target": "ssh-server-1", "path": "/var/log/app.log",
              "maxBytes": 65536 } }
```
返回 `{content, size}`。`target='local'` 走本地 fs；其它走对应 ssh 服务器。

#### 7.6 template_render
```jsonc
{ "stageType": "template_render",
  "params": { "template": "Hello {{vars.user}} at {{run.id}}",
              "vars": {"user": "{{run.triggeredBy}}"} } }
```
返回 `{text: "Hello alice at 42"}`。

#### 7.7 fan_out
（见 §6）

### 8. 前端 NodeInspector 动态表单（T18-T19）

#### 8.1 7 新类型自动用 paramSchema 渲染

打开 pipeline 画布 → "添加节点" 下拉 → 看到 5 个 bespoke 项 + 7 个新项（分隔线分组）。

任选 http / dm / db_update / sql_query / file_read / template_render / fan_out
之一，节点选中后右侧 Inspector：
- 上方公共字段：name / 类型 / 超时 / retryCount / onFailure / parallel
- 中部根据 paramSchema 渲染对应控件：
  - `method`: enum → Select
  - `url`: string → Input
  - `headers`: object → JSON 文本框（onBlur 解析）
  - `timeoutMs`: number → InputNumber
  - `params`(数组): array of string → tags Select
  - `sqlTemplate`: string + format=textarea → 多行 monospace TextArea
- 底部 Collapse "高级：重试策略"：retry_when 表达式 + 重试间隔 (ms)
- stageType=fan_out 时多一个 "高级：fan_out 子运行" 提示面板

#### 8.2 切换类型清空旧字段

bespoke 节点（如 script）已有 `script="echo hi"`，切到 http →
弹 Modal "切换类型将清空字段：script"，确认后 params 重置为 `{}`。

#### 8.3 stale stageType 兼容

DB 里手动把 graph 内某节点的 stageType 改成不存在的 key（如
`UPDATE test_pipelines SET graph=jsonb_set(...)`），打开画布 →
节点显示 `<warning> <key>（已禁用）`，不崩溃。

### 9. 现有 5 种 bespoke 节点 UI 零回归

打开任意已存在 pipeline，依次点 script / approval / llm_agent /
wait_webhook / im_input 节点：

- script → 目标角色 + 脚本 TextArea（保留）
- approval → 审批人 multi-select + 描述（保留）
- llm_agent → Capability Select（保留 stale 兼容）
- wait_webhook → Webhook Tag Input（保留）
- im_input → 引导语 + paramSchema JSON 文本框 + 关联 capability + 采集超时（保留）

任一节点的 retryCount / onFailure 仍在公共字段处展示。

## 回滚

⚠️ 生产不建议回滚 phase 3：schema-v36 改的是 `test_pipelines.graph` 里嵌入的
`stageType` 字符串，反向 SQL 复杂；schema-v34 加的 7 节点类型若被某条
graph 引用，DROP 行会让该 pipeline 加载报错。

开发期回滚步骤：

```sql
-- 9.1 先把 7 新节点 disable（仅在没有 graph 引用时安全）
UPDATE pipeline_node_types SET enabled=FALSE
 WHERE key IN ('http','dm','db_update','sql_query','file_read','template_render','fan_out');

-- 9.2 还原 capability key（仅在没有新写入 llm_agent stageType 时安全）
UPDATE pipeline_node_types SET key='capability', display_name='Capability'
 WHERE key='llm_agent';

UPDATE test_pipelines tp
   SET graph = (
     SELECT jsonb_set(tp.graph, '{nodes}', new_nodes)
     FROM (
       SELECT jsonb_agg(
         CASE WHEN n->>'stageType' = 'llm_agent'
              THEN jsonb_set(n, '{stageType}', '"capability"'::jsonb)
              ELSE n
         END
       ) AS new_nodes
       FROM jsonb_array_elements(tp.graph->'nodes') n
     ) sub
   )
 WHERE tp.graph IS NOT NULL;

-- 9.3 删除 7 新节点行（仅在 disable 后无引用时）
DELETE FROM pipeline_node_types
 WHERE key IN ('http','dm','db_update','sql_query','file_read','template_render','fan_out');
```

随后 `git revert <phase 3 commits>` 把代码侧 12 注册回退到 5。

## 故障诊断

### 启动 `[server] node-type registry verified: 5 types`

migrate 没跑 schema-v34/v35/v36：

```bash
pnpm migrate
```

### `Node type registry mismatch: DB only: capability`

schema-v36 没跑成功（已经 disable 了 7 新节点但没 rename 完）。
检查 `pipeline_node_types WHERE key='capability'` 是否还在；手动跑
`src/db/schema-v36.sql` 即可。

### `Node type registry mismatch: Code only: llm_agent`

代码侧已重命名但 DB 没跑 v36 → 同上。

### graph 保存时 `node "<id>" retry_when 语法错误: ...`

retry_when 表达式语法不对。允许的运算：`==` `!=` `>` `>=` `<` `<=` `&&` `||`
`!`，字面量支持 string / number / boolean / null，标识符支持点记法
（`output.statusCode`）。

### graph 保存时 `node "<id>" 引用未定义的 step "<x>"`

retry_when / 边 when / params 模板里 `{{steps.x.*}}` 引用的 x
不在当前节点上游 DFS 可达集合内。检查节点连线方向，或把 x 加到上游。

### fan_out body 包含 interrupt 节点

graph-validation 拦截：`node "<fanOutId>" body 不能包含 interrupt 节点
(approval/im_input/wait_webhook)`。v1 限制：fan_out 内部不允许中断；
把 interrupt 节点移到 fan_out 外面，或拆成两个 pipeline。

## 已知 pre-existing 问题（不阻塞 phase 3）

- `src/__tests__/unit/dingtalk-sync.test.ts` 6 个 fail：mock url
  `https://oapi.dingtalk.com/topapi/v2/department/get` 缺失，phase 0 已
  记录为 pre-existing，phase 1/2/3 都没引入新的 fail。
