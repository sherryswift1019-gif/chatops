import { registerNodeType } from './registry.js'

/**
 * v1 阶段 0：空壳注册——execute 永不被调用。
 * pipeline 实际执行仍在 graph-builder.ts 走原 stage handler。
 * 阶段 3 该 executor 才会被 graph-runner 真正调用。
 */
registerNodeType({
  key: 'approval',
  async execute() {
    throw new Error('approval executor not invoked in phase 0; routed via graph-builder')
  },
})
