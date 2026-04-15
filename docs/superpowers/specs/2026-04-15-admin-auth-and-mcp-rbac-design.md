# Admin Auth + MCP RBAC 设计

> 同时修复 P0-1（admin 全链路无认证）与 P0-3（MCP tool 列表对所有 role 无差别暴露）。

## 背景

整体审查发现两条同级严重的安全缺口：

1. `/admin/*` 无任何认证 hook。任何能访问 3000 端口的人都能通过 `PUT /admin/system-config/harbor` / `POST /admin/test-servers` 改凭证、拿到 SSH 密码、触发 RCE。
2. MCP 子进程的 `ListToolsRequestSchema` handler 返回 `getAllTools()`，不经 RBAC 过滤。`DEFAULT_TOOL_ROLES` / `getPermittedTools()` 写好了但从未被调用。一个 `developer` role 用户只要让 Claude 选到 `execute_deploy` / `manage_role`，就能越权。

两条修复互补：管理后台把外部攻击面封住，MCP RBAC 把内部权限边界立起来。

## 目标

- `/admin/*` 除登录/登出/改密/健康以外，全部需有效 session 才能访问
- IM 侧发起的任务在调用 MCP 工具时，按调用者 role + productLineId 过滤可用工具；`ListTools` 和 `CallTool` 两处都校验，防止 LLM 绕过 list 直接 call
- 首次部署 `admin / admin`，登录即强制改密；改密前无法访问任何业务路由

## 非目标

- 不引入多角色权限粒度（admin_users 表单一角色；IM 侧 `Role` 枚举维持原样，互不干涉）
- 不做 SSO / LDAP / 扫码登录（YAGNI）
- 不建 session 管理页（stateless cookie 场景下，单个会话无法精确踢；如果确实要强制所有人重登可以临时轮换 `system_config.session.key`）
- 不改其他 P0 问题（P0-2 shell 注入、P0-4 飞书签名、P0-5 DROP TABLE 单独 PR）

## 架构

### 数据与会话

- **`admin_users` 表**（`schema-v9.sql`）：`id / username UNIQUE / password_hash / must_change_password / last_login_at / created_at / updated_at`
- **Password hash**：bcrypt，12 rounds
- **Session**：`@fastify/secure-session`，签名+加密 cookie，载荷 `{username, userId, iat}`，7 天滚动过期
- **Session key**：启动时从 `system_config` 读 `session.key`；不存在则生成 32 字节随机值并写回，保证重启不掉登录态

### 请求链

```
浏览器 → Fastify
      ├─ /webhook/*   → 直通（白名单）
      ├─ /health      → 直通
      ├─ /admin/auth/login | logout | change-password → 直通
      ├─ /admin/*     → session preHandler → 路由
      └─ /、/assets/* → 静态资源（直通）

IM 消息 → ClaudeRunner → [context.initiatorRole, productLineId 已注入] 
       → CHATOPS_TASK_CONTEXT env → MCP 子进程
       → ListTools: getPermittedTools(role, productLineId) 过滤
       → CallTool: 同一过滤器二次校验，防 list 外直调
```

### 首次改密流程

1. migration 插入 `admin / bcrypt('admin')`，`must_change_password=true`
2. 用户用默认账号登录，session 建立
3. `GET /admin/auth/me` 返回 `{username, mustChangePassword: true}`
4. 前端 `AuthGuard` 看到 `mustChangePassword` 强制跳 `/change-password`
5. 用户提交旧+新密码 → 后端验证旧密 + hash 新密 + `must_change_password=false`
6. 下一次 `/me` 返回正常，进入业务页

## 改动清单

### 后端新增

| 文件 | 职责 |
|---|---|
| `src/db/schema-v9.sql` | 建 `admin_users` 表 + seed `admin / admin`（bcrypt 预计算） |
| `src/db/repositories/admin-users.ts` | `getByUsername / create / updatePassword / updateLastLogin` |
| `src/admin/auth/password.ts` | `hashPassword(plain)` / `verifyPassword(plain, hash)` |
| `src/admin/auth/session-plugin.ts` | 注册 `@fastify/secure-session`，导出 `requireAuth` preHandler |
| `src/admin/routes/auth.ts` | `POST /login`、`POST /logout`、`POST /change-password`、`GET /me` |
| `src/__tests__/unit/admin-auth.test.ts` | 覆盖上述所有行为 |

### 后端修改

| 文件 | 改动 |
|---|---|
| `src/admin/index.ts` | 注册 session-plugin、auth 路由；对所有非 `/auth/*` 路由挂 `requireAuth` preHandler |
| `src/db/migrate.ts` | 顺序加执行 `schema-v9.sql` |
| `src/agent/mcp-server.ts` | `ListToolsRequestSchema` 改用 `getPermittedTools(ctx.initiatorRole, ctx.productLineId)`；`CallToolRequestSchema` 加同一过滤器二次校验 |
| `package.json` | 新增依赖 `@fastify/secure-session`、`@fastify/cookie`、`bcrypt`；devDep 加 `@types/bcrypt` |

### 前端新增

| 文件 | 职责 |
|---|---|
| `web/src/api/auth.ts` | `login / logout / changePassword / me` |
| `web/src/pages/LoginPage.tsx` | 用户名+密码 antd Form |
| `web/src/pages/ChangePasswordPage.tsx` | 旧密码+新密码+确认新密码 |
| `web/src/components/AuthGuard.tsx` | 外层路由守卫，调 `/me` 判断 |

### 前端修改

| 文件 | 改动 |
|---|---|
| `web/src/App.tsx` | 加 `/login`、`/change-password` 为顶层 Route；其余挂在 `<AuthGuard>` 下 |
| `web/src/api/client.ts` | `withCredentials: true`；response interceptor 401 → redirect `/login` |
| `web/src/layout/AdminLayout.tsx` | 右上角显示 username + 登出按钮 |

## 接口契约

### POST `/admin/auth/login`
```
Req:  { username: string, password: string }
Resp: 200 { username, mustChangePassword }  + Set-Cookie chatops_admin_session=...
      401 { error: 'invalid_credentials' }
```

### POST `/admin/auth/logout`
```
Resp: 200 { ok: true }  + 清 cookie
```

### POST `/admin/auth/change-password`
```
Req:  { oldPassword: string, newPassword: string }
Resp: 200 { ok: true }
      401 { error: 'invalid_credentials' }（旧密码错）
      400 { error: 'weak_password' }（长度 < 8 或全数字）
```

### GET `/admin/auth/me`
```
Resp: 200 { username, mustChangePassword }
      401 { error: 'not_authenticated' }
```

## 权限/过滤行为

### `requireAuth` preHandler
- 从 cookie 解签；失败或 cookie 缺失 → 401
- 校验通过：把 `{username, userId}` 挂到 `request.session`
- `mustChangePassword=true` 时除 `/admin/auth/change-password` 外全部拒绝，返 403 `{error: 'must_change_password'}`

### MCP ListTools / CallTool
- 用 `getPermittedTools(role, productLineId)` 过滤
- `role` 为 null 或缺失时视为 `'developer'`
- CallTool 二次校验防 LLM 硬编码工具名绕过 list

## 错误与兜底

| 场景 | 行为 |
|---|---|
| Session key 损坏/换了 | 所有旧 cookie 解签失败 → 返 401 → 用户重新登录 |
| `/me` 无 session | 401（非错误日志） |
| 密码校验失败 | 通用 `invalid_credentials`，不区分"用户不存在"vs"密码错" |
| bcrypt.compare 异常 | 记日志 + 返 500 |
| MCP role 未注入（空 context） | `getPermittedTools(null)` → fallback `developer` role |

## 测试

### `src/__tests__/unit/admin-auth.test.ts`

1. `hashPassword` → `verifyPassword` roundtrip
2. `verifyPassword` 对错误密码返 false
3. `POST /login` 成功：返 cookie + mustChangePassword 字段正确
4. `POST /login` 账号不存在 / 密码错 → 401 `invalid_credentials`
5. `POST /login` 更新 `last_login_at`
6. `POST /change-password` 旧密错 → 401
7. `POST /change-password` 新密 < 8 字符 → 400 `weak_password`
8. `POST /change-password` 成功 → `must_change_password` 变 false
9. `GET /me` 无 cookie → 401；有 cookie → 正常字段
10. preHandler：白名单路径放行；非白名单无 cookie → 401
11. preHandler：`mustChangePassword=true` 下访问 `/admin/environments` → 403

### MCP RBAC 测试

12. mock `getPermittedTools` 返 `[view_deployments]`；ListTools 结果只含该工具
13. CallTool 调一个未在 permitted 列表的工具 → isError=true

## 验收

- [ ] `npx tsc --noEmit` 通过
- [ ] `pnpm test` 通过（新增 12+ tests，原有保持绿）
- [ ] 部署到 10.10.1.166 后：
  - [ ] 未登录访问 `/admin/system-config` 返 401 JSON
  - [ ] 未登录访问 `/` 跳登录页
  - [ ] 用 `admin / admin` 登录成功后立即要求改密
  - [ ] 改密后能正常浏览所有管理页
  - [ ] 钉钉群 @机器人 发"有哪些模块"仍正常工作（MCP 侧未破坏 happy path）
  - [ ] 用一个没有 admin role 的 membership 测 deploy 触发：机器人拒绝或路由不到 execute_deploy

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| bcrypt 原生模块在 Alpine base 缺 libc 头 | 改用 `bcryptjs`（纯 JS，性能略差但部署简单）作为 fallback |
| secure-session cookie 4KB 限制 | 只存 `{username, userId}`；不塞大数据 |
| 浏览器缓存了旧登录页，401 循环 | SPA 登录页走 `window.location.replace`（不是 history push），避免 axios 401 回调再次访问 `/me` 重进循环；登录成功后 `history.replaceState` |
| MCP 二次校验破坏现有调用 | 先在生产环境非强制模式跑一轮，观察日志是否有"permitted 缺某工具"情况；确认无问题再强制拦截。实际上 `getPermittedTools` 已经兜底 `['developer','tester','ops','admin']`，不会意外踢掉任何用户 |
| 首次部署 admin/admin 泄密 | 文档里写清"部署后第一件事是登录改密"；在 README 和 deploy.sh 输出里提醒 |
