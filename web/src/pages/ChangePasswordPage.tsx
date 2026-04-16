import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Form, Input, Button, Card, message, Alert } from 'antd'
import { changePassword } from '../api/auth'

export default function ChangePasswordPage() {
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()

  const onFinish = async (values: { oldPassword: string; newPassword: string; confirm: string }) => {
    if (values.newPassword !== values.confirm) {
      message.error('两次输入的新密码不一致')
      return
    }
    setLoading(true)
    try {
      await changePassword(values.oldPassword, values.newPassword)
      message.success('密码已修改')
      navigate('/', { replace: true })
    } catch (err: unknown) {
      const data = (err as { response?: { data?: { error?: string; reason?: string } } })?.response?.data
      if (data?.error === 'weak_password') {
        message.error(data.reason ?? '密码强度不足')
      } else if (data?.error === 'invalid_credentials') {
        message.error('旧密码错误')
      } else {
        message.error(`修改失败：${data?.error ?? 'unknown'}`)
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
      <Card title="修改密码" style={{ width: 420 }}>
        <Alert
          style={{ marginBottom: 16 }}
          type="warning"
          showIcon
          message="首次登录需要设置新密码"
          description="为账号安全，请立即修改初始密码。密码需至少 8 位且不能为纯数字。"
        />
        <Form layout="vertical" onFinish={onFinish}>
          <Form.Item name="oldPassword" label="旧密码" rules={[{ required: true }]}>
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Form.Item name="newPassword" label="新密码" rules={[{ required: true, min: 8, message: '至少 8 位' }]}>
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item name="confirm" label="确认新密码" rules={[{ required: true }]}>
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={loading} block>修改密码</Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  )
}
