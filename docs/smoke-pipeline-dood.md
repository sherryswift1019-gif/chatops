# Pipeline DooD 冒烟

## 前置
- 宿主机 `/srv/chatops/test-runs` 存在且属主 1000:1000
- `.env` 含 `DOCKER_GID=<getent group docker | cut -d: -f3>`
- chatops 容器内 `docker version` 正常

## 用例 1：script 节点继承 pipeline 镜像
1. 新建 pipeline，pipeline 设置中容器镜像 `harbor.xxx/golang:1.21`
2. 加 script 节点 `go version`，触发 dry-run
3. 应输出 go1.21 版本号

## 用例 2：llm_agent capability 用节点级镜像
1. 加 llm_agent → 选 capability `analyze_bug` → 节点镜像 `python:3.11`
2. 触发执行，观察 docker logs：
   - `docker pull python:3.11`
   - `docker run -d --name chatops-cap-<runId>-<idx>`
   - capability 结束后 `docker rm -f`

## 用例 3：custom 模式 + run_command 路由进容器
1. 加 llm_agent → custom → containerImage=`harbor.xxx/golang:1.21`
2. allowedTools 选 `mcp__chatops__run_command`
3. customPrompt：`使用 run_command 跑 'go version'，把输出贴出来`
4. 应看到容器内的 go1.21，不是 chatops 容器（chatops 内无 go）

## 用例 4：未选 run_command 的 warning
1. 同上但 allowedTools 留空
2. UI 立刻显示橙色 Alert
3. 触发执行：容器照常起停，Claude 跑不了 shell（log 无 docker exec）
