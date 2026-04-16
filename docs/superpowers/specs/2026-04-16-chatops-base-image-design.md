# ChatOps Base 镜像分层构建设计

**日期：** 2026-04-16
**架构：** linux/amd64
**目标：** 抽离 node_modules 到 base 镜像，业务镜像仅替换源码；日常发版无需重装依赖。

## 背景

当前 `Dockerfile` 每次 build 都会：
1. 多阶段先 `pnpm install` 前端依赖 (~186M)
2. 再 `pnpm install` 后端依赖 (~221M)
3. `tsc --noEmit` 类型检查

在 Paraview 10.10.1.166 无公网环境下，每次都装依赖非常耗时，且需要可达的 npm 源。

## 方案

**两个镜像，分层：**

### chatops-base （依赖层）

- `FROM node:20-slim`
- `corepack enable && corepack prepare pnpm@10 --activate`
- `/app/package.json` + `/app/pnpm-lock.yaml`
- `pnpm install --frozen-lockfile --prod=false`
- 产物：`/app/node_modules` （含 devDeps，tsx 运行 TypeScript 需要）

Tag 策略：
- `harbor.paraview.cn/chatops/chatops-base:latest`（滚动）
- `harbor.paraview.cn/chatops/chatops-base:deps-<lockfileSha8>`（归档）

仅在 `pnpm-lock.yaml` 变化时重建。

### chatops （业务层）

- `FROM ${BASE_IMAGE}` （默认 harbor.paraview.cn/chatops/chatops-base:latest）
- `COPY tsconfig.json src/ web/dist/`
- `tsc --noEmit` 验证编译
- 非 root `chatops` 用户、`/data/chatops/test-runs`、HEALTHCHECK 保持不变
- `CMD ["node", "--import", "tsx/esm", "src/server.ts"]`

## 文件变更

| 文件 | 动作 |
|---|---|
| `Dockerfile.base` | 新增 — 只装 node_modules |
| `Dockerfile` | 改写 — FROM base，只 COPY 源码+前端产物 |
| `build-base.sh` | 新增 — `docker buildx build --platform linux/amd64 --push` 到 harbor |
| `build.sh` | 改写 — 先 `cd web && pnpm build`，再 amd64 业务镜像 |
| `docker-compose.yml` | 加 `BASE_IMAGE` build arg |
| `CLAUDE.md` | Commands 章节加 base 镜像流程 |

## 构建流程

**日常（仅代码改动）：**
```
cd web && pnpm build       # 本地生成 web/dist
./build.sh                 # 只重建业务镜像（秒级）
```

**依赖升级（lockfile 变化）：**
```
./build-base.sh            # 重建 + push base 到 harbor
./build.sh                 # 业务镜像从新 base 构建
```

## 关键细节

- **devDeps 必须在 base 里。** 运行时 `node --import tsx/esm src/server.ts` 依赖 `tsx` + `typescript`，两者都在 devDependencies。如果 base 只装 `--prod` 会让镜像跑不起来。
- **前端构建放 host。** 用户选择只后端依赖进 base，前端每次在 host 上 `pnpm build`，docker 层只 COPY `web/dist`。
- **amd64 平台。** Paraview 部署目标为 amd64；开发机可能是 arm64/amd64 混合，统一用 `docker buildx --platform linux/amd64`。
- **harbor 自签证书。** 推送前 docker daemon 要信任 `harbor.paraview.cn`（见 `reference_paraview_infra` 记忆）。
- **lockfile hash。** `sha256sum pnpm-lock.yaml | head -c 8` 作为 `deps-<hash>` tag，用于精确回滚。
