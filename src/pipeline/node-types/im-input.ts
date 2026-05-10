import { registerNodeType } from './registry.js'

/**
 * im_input — IM 卡片单次人工介入，interrupt-bound 节点。
 *
 * 实际执行路径：graph-builder.ts:buildImInputNode（interrupt-bound 节点）。
 * 直接调用 NodeExecutor.execute() 会抛出——interrupt() 需 LangGraph supergraph 接住。
 */
registerNodeType({
  key: 'im_input',
  async execute() {
    throw new Error(
      'im_input is interrupt-bound: must be invoked via graph-builder switch (buildImInputNode). See src/pipeline/node-types/im-input.ts.',
    )
  },
})
