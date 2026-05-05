# PoC Smoke 测试规约

## 背景

最小烟测，验证沙盒部署完成后 chatops 服务可达。**不验业务正确性**，只验"链路能跑通"。

## 场景

### poc.smoke — 沙盒可达性

- 打开沙盒 web 入口 (`endpoints.web_base_url`)
- 页面 body 渲染（任何非空白页都成立）
- `GET /health` 返回 200

## 验收

| 类型 | 说明 |
|---|---|
| dom_visible | 选择器 `body` 存在 |
| api_response | `GET /health` → 200 |

成功标准：两条 acceptance 都 pass 即视为沙盒部署通过。
