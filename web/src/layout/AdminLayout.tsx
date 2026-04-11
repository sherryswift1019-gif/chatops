import { useState } from 'react'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import { Layout, Menu } from 'antd'
import {
  AppstoreOutlined,
  ProjectOutlined,
  CloudServerOutlined,
  TeamOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
} from '@ant-design/icons'

const { Sider, Content, Header } = Layout

const menuItems = [
  { key: '/product-lines', icon: <AppstoreOutlined />, label: '产线管理' },
  { key: '/projects', icon: <ProjectOutlined />, label: '项目管理' },
  { key: '/environments', icon: <CloudServerOutlined />, label: '环境管理' },
  { key: '/dingtalk-users', icon: <TeamOutlined />, label: '钉钉用户' },
  { key: '/approval-rules', icon: <SafetyCertificateOutlined />, label: '审批规则' },
  { key: '/system-config', icon: <SettingOutlined />, label: '系统配置' },
]

export default function AdminLayout() {
  const [collapsed, setCollapsed] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()

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
        <Header style={{ background: '#fff', padding: '0 24px', fontSize: 16, fontWeight: 500, borderBottom: '1px solid #f0f0f0' }}>
          ChatOps 管理控制台
        </Header>
        <Content style={{ margin: 24 }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  )
}
