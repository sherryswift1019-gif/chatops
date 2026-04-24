/**
 * prd-submit 模块统一入口。
 * 被 src/server.ts import 后逐个调用 register* 函数向 coordinator 注册 handler。
 */
export { registerPrdSubmitHandler } from './submit-handler.js'
export { registerPrdCreateMrHandler } from './create-mr-handler.js'
export { registerPrdAiReviewHandler } from './review-handler.js'
export { registerPrdNotifyHandler } from './notify-handler.js'
