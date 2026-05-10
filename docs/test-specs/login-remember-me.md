---
id: login-remember-me
title: 登录页「记住密码」Checkbox
target_project: chatops
scenarios:
  - login-remember-first-visit
  - login-remember-check-and-login
  - login-remember-prefill-on-return
  - login-remember-uncheck-clears-storage
  - login-remember-return-uncheck-login
  - login-remember-no-password-stored
  - login-remember-login-fail-no-change
tags:
  - smoke
  - login
  - localStorage
---

# 登录页「记住密码」Checkbox（/login）

`LoginPage` — 登录表单新增「记住密码」Checkbox，勾选后将用户名存入 `localStorage`，
下次访问自动回填用户名输入框；取消勾选立即清除。

localStorage key：`chatops_remembered_username`（以下简称 STORAGE_KEY）。

## 前置条件

- 用户未登录（或已登出，访问 `/login` 页）
- admin 用户存在（username: `admin`，password: 已知）
- 各场景开始前根据需要手动清除 `localStorage.getItem('chatops_remembered_username')`

## Seed 数据

无需数据库 Seed，所有状态均在 `localStorage` 中维护。

---

## 场景

### login-remember-first-visit：首次访问 — 初始状态

**目的**：验证 localStorage 中无记录时，Checkbox 默认未勾选、用户名框为空、autoFocus 在用户名输入框。

**前置**：`localStorage.removeItem('chatops_remembered_username')`

**步骤**：
1. 访问 `/login`

**预期结果**：
- 「记住密码」Checkbox 未勾选（`checked=false`）
- 用户名输入框值为空
- 用户名输入框获得焦点（`document.activeElement` 为 username `<input>`）
- 密码输入框未获焦点
- `localStorage.getItem('chatops_remembered_username')` 为 `null`

---

### login-remember-check-and-login：勾选后登录 — 用户名写入 localStorage

**目的**：验证勾选 Checkbox 后成功登录，用户名被写入 localStorage，密码不被存储。

**前置**：`localStorage.removeItem('chatops_remembered_username')`

**步骤**：
1. 访问 `/login`
2. 用户名输入框填入 `admin`
3. 勾选「记住密码」Checkbox
4. 密码输入框填入正确密码
5. 点击「登录」按钮

**预期结果**：
- 登录成功，页面跳转到 `/`（或 `/change-password`）
- `localStorage.getItem('chatops_remembered_username')` === `'admin'`
- `localStorage` 中不存在任何含 `password` 关键字的 key（密码不被存储）

---

### login-remember-prefill-on-return：已记住后回访 — 自动回填 + autoFocus 在密码框

**目的**：验证 localStorage 有记录时，用户名自动回填、Checkbox 自动勾选、autoFocus 在密码框。

**前置**：`localStorage.setItem('chatops_remembered_username', 'admin')`

**步骤**：
1. 访问 `/login`

**预期结果**：
- 「记住密码」Checkbox 已勾选（`checked=true`）
- 用户名输入框值为 `'admin'`（自动回填）
- 密码输入框获得焦点（`document.activeElement` 为 password `<input>`）
- 用户名输入框未获焦点
- 页面无错误，表单可正常提交

---

### login-remember-uncheck-clears-storage：取消勾选 — 立即清除 localStorage

**目的**：验证在 localStorage 有记录的情况下取消勾选 Checkbox，立即清除 localStorage（无需登录）。

**前置**：`localStorage.setItem('chatops_remembered_username', 'admin')`

**步骤**：
1. 访问 `/login`（用户名已自动回填为 `admin`，Checkbox 已勾选）
2. 取消勾选「记住密码」Checkbox

**预期结果**：
- Checkbox 变为未勾选
- `localStorage.getItem('chatops_remembered_username')` === `null`（立即清除，无需点登录）
- 用户名输入框的值保留（只是不再记忆，不清空输入）

---

### login-remember-return-uncheck-login：回访后取消勾选再登录 — 登录后清除 localStorage

**目的**：验证已记住状态下，用户主动取消勾选并完成登录后，localStorage 中的记录被删除。

**前置**：`localStorage.setItem('chatops_remembered_username', 'admin')`

**步骤**：
1. 访问 `/login`（用户名自动回填为 `admin`，Checkbox 勾选）
2. 取消勾选「记住密码」Checkbox（此时 localStorage 已立即清除）
3. 密码输入框填入正确密码
4. 点击「登录」按钮

**预期结果**：
- 登录成功，页面跳转
- `localStorage.getItem('chatops_remembered_username')` === `null`（登录后仍为空）
- 重新访问 `/login`：Checkbox 未勾选，用户名框为空

---

### login-remember-no-password-stored：密码永不写入 localStorage

**目的**：安全验证 — 无论是否勾选「记住密码」，密码均不写入 localStorage。

**前置**：`localStorage.clear()`

**步骤（勾选分支）**：
1. 访问 `/login`
2. 用户名填 `admin`，勾选 Checkbox，密码填正确密码，登录成功

**步骤（不勾选分支）**：
1. 访问 `/login`
2. 用户名填 `admin`，不勾选 Checkbox，密码填正确密码，登录成功

**预期结果（两个分支均需满足）**：
- 登录后遍历所有 `localStorage` key，无任何 key 的值包含密码字符串
- 无任何 key 名称含 `password` / `passwd` / `pwd`

---

### login-remember-login-fail-no-change：登录失败 — localStorage 不变

**目的**：验证凭据错误时 localStorage 状态不受影响（不写入、不清除）。

**子场景 A — 勾选时登录失败**：

**前置**：`localStorage.removeItem('chatops_remembered_username')`

**步骤**：
1. 访问 `/login`
2. 用户名填 `admin`，勾选 Checkbox，密码填错误密码，点「登录」

**预期结果**：
- 登录失败，显示「用户名或密码错误」Toast
- `localStorage.getItem('chatops_remembered_username')` === `null`（登录失败不写入）

---

**子场景 B — 已记住时登录失败**：

**前置**：`localStorage.setItem('chatops_remembered_username', 'admin')`

**步骤**：
1. 访问 `/login`（自动回填 admin，Checkbox 勾选）
2. 密码填错误密码，点「登录」

**预期结果**：
- 登录失败，显示错误 Toast
- `localStorage.getItem('chatops_remembered_username')` === `'admin'`（登录失败不清除已有记录）
- 用户名框仍显示 `admin`

---

## 实现注意

| 要点 | 说明 |
|------|------|
| localStorage key | `chatops_remembered_username` |
| 立即清除时机 | Checkbox `onChange` 切换为 unchecked 时，**不等登录**，立即 `localStorage.removeItem` |
| 写入时机 | `onFinish`（登录 API 成功返回后）才写 `localStorage.setItem` |
| 不写密码 | 只存 `values.username`，password 字段不做任何持久化 |
| autoFocus 逻辑 | `rememberMe=true` → password 框 focus；`rememberMe=false` → username 框 focus |
| Checkbox 文案 | 当前文案「记住密码」实际只记住用户名，建议改为「记住用户名」（reviewer 已标记） |
