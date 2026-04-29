-- v54: 删除 im_input 节点类型（该 stage type 已从代码中移除）
DELETE FROM pipeline_node_types WHERE key = 'im_input';
