import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Form, Input, Button, message } from 'antd'
import { login } from '../api/auth'

export default function LoginPage() {
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()

  const onFinish = async (values: { username: string; password: string }) => {
    setLoading(true)
    try {
      const res = await login(values.username, values.password)
      if (res.mustChangePassword) {
        navigate('/change-password', { replace: true })
      } else {
        navigate('/', { replace: true })
      }
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'unknown_error'
      message.error(msg === 'invalid_credentials' ? '用户名或密码错误' : `登录失败：${msg}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-bg">
      <div className="login-grid" />
      <div className="login-glow" />

      <div className="login-card">
        {/* Logo mark */}
        <div className="login-logo">
          <div className="login-logo-icon">MT</div>
          <div className="login-logo-info">
            <h1>Mewtwo</h1>
            <p>DEVOPS MANAGEMENT CONSOLE</p>
          </div>
        </div>

        <div className="login-separator" />

        <Form layout="vertical" onFinish={onFinish} requiredMark={false}>
          <Form.Item
            name="username"
            label={<span className="login-field-label">用户名</span>}
            rules={[{ required: true, message: '请输入用户名' }]}
            style={{ marginBottom: 16 }}
          >
            <Input
              autoFocus
              autoComplete="username"
              size="large"
              style={{ background: '#0B0E18', borderColor: 'rgba(255,255,255,0.1)', color: '#E6EAF3', borderRadius: 8 }}
              placeholder="输入用户名"
            />
          </Form.Item>

          <Form.Item
            name="password"
            label={<span className="login-field-label">密码</span>}
            rules={[{ required: true, message: '请输入密码' }]}
            style={{ marginBottom: 24 }}
          >
            <Input.Password
              autoComplete="current-password"
              size="large"
              style={{ background: '#0B0E18', borderColor: 'rgba(255,255,255,0.1)', color: '#E6EAF3', borderRadius: 8 }}
              placeholder="输入密码"
            />
          </Form.Item>

          <Form.Item style={{ marginBottom: 0 }}>
            <Button type="primary" htmlType="submit" loading={loading} block size="large">
              登录
            </Button>
          </Form.Item>
        </Form>
      </div>
    </div>
  )
}
