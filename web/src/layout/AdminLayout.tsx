import { useEffect, useState } from 'react'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import { Layout, Menu, Button } from 'antd'
import {
  AppstoreOutlined,
  CloudOutlined,
  UserOutlined,
  ThunderboltOutlined,
  SettingOutlined,
  HddOutlined,
  PartitionOutlined,
  HistoryOutlined,
  LogoutOutlined,
  BugOutlined,
  BookOutlined,
  DashboardOutlined,
  UserSwitchOutlined,
  FileTextOutlined,
} from '@ant-design/icons'
import { me, logout, type MeResponse } from '../api/auth'

const { Sider, Content, Header } = Layout

const PAGE_NAMES: Record<string, string> = {
  '/product-lines': '产线管理',
  '/environments': '环境管理',
  '/dingtalk-users': '钉钉用户',
  '/capabilities': '能力管理',
  '/system-config': '系统配置',
  '/test-servers': '服务器管理',
  '/test-pipelines': '流水线管理',
  '/test-runs': '执行记录',
  '/bug-runs': 'Bug 修复实例',
  '/product-knowledge': '知识库配置',
  '/metrics': '价值仪表盘',
  '/prd-documents': 'PRD 文档',
  '/prd-chat': 'PRD 对话',
}

const menuItems = [
  {
    type: 'group' as const,
    label: '运维管理',
    children: [
      { key: '/product-lines', icon: <AppstoreOutlined />, label: '产线管理' },
      { key: '/environments', icon: <CloudOutlined />, label: '环境管理' },
      { key: '/dingtalk-users', icon: <UserOutlined />, label: '钉钉用户' },
      { key: '/capabilities', icon: <ThunderboltOutlined />, label: '能力管理' },
    ],
  },
  {
    type: 'group' as const,
    label: '测试中心',
    children: [
      { key: '/test-servers', icon: <HddOutlined />, label: '服务器' },
      { key: '/test-pipelines', icon: <PartitionOutlined />, label: '流水线' },
      { key: '/test-runs', icon: <HistoryOutlined />, label: '执行记录' },
    ],
  },
  {
    type: 'group' as const,
    label: '研发 AI 助手',
    children: [
      { key: '/bug-runs', icon: <BugOutlined />, label: 'Bug 修复实例' },
      { key: '/prd-documents', icon: <FileTextOutlined />, label: 'PRD 文档' },
      { key: '/module-owners', icon: <UserSwitchOutlined />, label: '模块负责人' },
      { key: '/product-knowledge', icon: <BookOutlined />, label: '知识库配置' },
      { key: '/metrics', icon: <DashboardOutlined />, label: '价值仪表盘' },
    ],
  },
  {
    type: 'group' as const,
    label: '系统',
    children: [
      { key: '/system-config', icon: <SettingOutlined />, label: '系统配置' },
    ],
  },
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

  const selectedKey = location.pathname === '/'
    ? '/product-lines'
    : location.pathname.split('/').slice(0, 2).join('/')

  const pageTitle = PAGE_NAMES[selectedKey] ?? 'ChatOps'
  const userInitial = user?.username?.[0]?.toUpperCase() ?? 'U'

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        width={200}
        style={{ boxShadow: '1px 0 0 rgba(0,0,0,0.04)' }}
      >
        {/* Logo */}
        <div className="chatops-logo">
          <div className="chatops-logo-icon">CO</div>
          {!collapsed && <span className="chatops-logo-text">ChatOps</span>}
        </div>

        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selectedKey]}
          items={menuItems}
          onClick={({ key }) => navigate(key)}
          style={{ borderRight: 'none', paddingTop: 8 }}
        />
      </Sider>

      <Layout>
        <Header className="chatops-header">
          <div className="chatops-header-left">
            <span className="chatops-page-title">{pageTitle}</span>
          </div>
          <div className="chatops-header-right">
            {user && (
              <>
                <div className="chatops-avatar">{userInitial}</div>
                <span className="chatops-username">{user.username}</span>
                <div className="chatops-divider" />
              </>
            )}
            <Button
              type="text"
              icon={<LogoutOutlined />}
              onClick={onLogout}
              size="small"
              style={{ color: '#7A8296', fontSize: 13 }}
            >
              登出
            </Button>
          </div>
        </Header>

        <Content className="admin-content">
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  )
}
