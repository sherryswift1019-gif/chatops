import { useEffect, useState } from 'react'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import { Layout, Menu, Button, Space } from 'antd'
import {
  AppstoreOutlined,
  CloudServerOutlined,
  TeamOutlined,
  ThunderboltOutlined,
  SettingOutlined,
  ExperimentOutlined,
  LogoutOutlined,
} from '@ant-design/icons'
import { me, logout, type MeResponse } from '../api/auth'

const { Sider, Content, Header } = Layout

const menuItems = [
  { key: '/product-lines', icon: <AppstoreOutlined />, label: '产线管理' },
  { key: '/environments', icon: <CloudServerOutlined />, label: '环境管理' },
  { key: '/dingtalk-users', icon: <TeamOutlined />, label: '钉钉用户' },
  { key: '/capabilities', icon: <ThunderboltOutlined />, label: '能力管理' },
  { key: '/system-config', icon: <SettingOutlined />, label: '系统配置' },
  { key: '/test-servers', icon: <CloudServerOutlined />, label: '服务器' },
  { key: '/test-pipelines', icon: <ExperimentOutlined />, label: '流水线' },
  { key: '/test-runs', icon: <ExperimentOutlined />, label: '执行记录' },
]

export default function AdminLayout() {
  const [collapsed, setCollapsed] = useState(false)
  const [user, setUser] = useState<MeResponse | null>(null)
  const navigate = useNavigate()
  const location = useLocation()

  useEffect(() => { me().then(setUser).catch(() => {}) }, [])

  const onLogout = async () => {
    await logout()
    navigate('/login', { replace: true })
  }

  const selectedKey = location.pathname === '/' ? '/product-lines' : location.pathname.split('/').slice(0, 2).join('/')

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider collapsible collapsed={collapsed} onCollapse={setCollapsed}>
        <div style={{ height: 32, margin: 16, color: '#fff', fontSize: 16, textAlign: 'center', fontWeight: 'bold', lineHeight: '32px' }}>
          {collapsed ? 'CO' : 'ChatOps 管理'}
        </div>
        <Menu theme="dark" mode="inline" selectedKeys={[selectedKey]} items={menuItems} onClick={({ key }) => navigate(key)} />
      </Sider>
      <Layout>
        <Header style={{ background: '#fff', padding: '0 24px', fontSize: 16, fontWeight: 500, borderBottom: '1px solid #f0f0f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>ChatOps 管理控制台</span>
          <Space>
            {user && <span>{user.username}</span>}
            <Button type="text" icon={<LogoutOutlined />} onClick={onLogout}>登出</Button>
          </Space>
        </Header>
        <Content style={{ margin: 24 }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  )
}
