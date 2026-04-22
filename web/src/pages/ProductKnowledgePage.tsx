import { useEffect, useState } from 'react'
import { Card, Form, Input, Button, Descriptions, message, Empty, Select, Space } from 'antd'
import { getProductKnowledge, createProductKnowledge, updateProductKnowledge } from '../api/product-knowledge'
import { getProductLines } from '../api/product-lines'
import type { ProductKnowledgeRepo, ProductLine } from '../types'

export default function ProductKnowledgePage() {
  const [productLines, setProductLines] = useState<ProductLine[]>([])
  const [selectedPL, setSelectedPL] = useState<number | undefined>()
  const [config, setConfig] = useState<ProductKnowledgeRepo | null>(null)
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState(false)
  const [form] = Form.useForm()

  useEffect(() => {
    getProductLines().then(list => {
      setProductLines(list)
      setSelectedPL(prev => prev ?? list[0]?.id)
    })
  }, [])

  useEffect(() => { if (selectedPL) load() }, [selectedPL])

  async function load() {
    if (!selectedPL) return
    setLoading(true)
    try {
      const data = await getProductKnowledge(selectedPL)
      setConfig(data)
      if (data) form.setFieldsValue(data)
      setEditing(false)
    } finally { setLoading(false) }
  }

  async function handleSave() {
    const values = await form.validateFields()
    try {
      if (config) {
        await updateProductKnowledge(selectedPL!, values)
        message.success('更新成功')
      } else {
        await createProductKnowledge({ ...values, productLineId: selectedPL! })
        message.success('创建成功')
      }
      await load()
    } catch { message.error('保存失败') }
  }

  return (
    <Card
      title="知识库配置"
      extra={
        <Space>
          <Select style={{ width: 200 }} placeholder="选择产线" value={selectedPL} onChange={setSelectedPL}
            options={productLines.map(pl => ({ value: pl.id, label: pl.displayName }))} />
        </Space>
      }
    >
      {!selectedPL ? (
        <Empty description="请先选择产线" />
      ) : !config && !editing ? (
        <Empty description="该产线未配置知识库">
          <Button type="primary" onClick={() => { form.resetFields(); setEditing(true) }}>配置知识库</Button>
        </Empty>
      ) : (
        <div style={{ maxWidth: 600 }}>
          {!editing && config ? (
            <>
              <Descriptions column={1} bordered size="small">
                <Descriptions.Item label="代码仓库">{config.codeRepoUrl}</Descriptions.Item>
                <Descriptions.Item label="默认分支">{config.codeDefaultBranch}</Descriptions.Item>
                <Descriptions.Item label="知识库仓库">{config.knowledgeRepoUrl}</Descriptions.Item>
                <Descriptions.Item label="AI 摘要路径">{config.aiSummaryPath}</Descriptions.Item>
              </Descriptions>
              <Button style={{ marginTop: 16 }} onClick={() => { form.setFieldsValue(config); setEditing(true) }}>编辑</Button>
            </>
          ) : (
            <Form form={form} layout="vertical" style={{ paddingTop: 16 }}>
              <Form.Item name="codeRepoUrl" label="代码仓库 URL" rules={[{ required: true }]}>
                <Input placeholder="git@gitlab.example.com:pam/pas.git" />
              </Form.Item>
              <Form.Item name="codeDefaultBranch" label="默认分支" initialValue="develop">
                <Input />
              </Form.Item>
              <Form.Item name="knowledgeRepoUrl" label="知识库仓库 URL" rules={[{ required: true }]}>
                <Input placeholder="git@gitlab.example.com:pam/pam-knowledge.git" />
              </Form.Item>
              <Form.Item name="aiSummaryPath" label="AI 摘要路径" initialValue="docs/ai">
                <Input />
              </Form.Item>
              <Space>
                <Button type="primary" onClick={handleSave}>保存</Button>
                <Button onClick={() => { setEditing(false); if (config) form.setFieldsValue(config) }}>取消</Button>
              </Space>
            </Form>
          )}
        </div>
      )}
    </Card>
  )
}
