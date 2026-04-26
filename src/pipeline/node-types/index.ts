// 触发自注册 —— 任何模块 import 此 barrel 都会让 5 种 node type 注册到 registry
import './script.js'
import './approval.js'
import './capability.js'
import './wait-webhook.js'
import './im-input.js'
// Phase 3 T9-T14 simple executor
import './http.js'
import './dm.js'
import './db-update.js'

export * from './registry.js'
export * from './types.js'
