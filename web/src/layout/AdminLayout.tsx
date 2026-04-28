import { useEffect, useState } from 'react'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import { Layout, Menu, Button } from 'antd'
import {
  AppstoreOutlined,
  CloudOutlined,
  UserOutlined,
  ThunderboltOutlined,
  ToolOutlined,
  SettingOutlined,
  HddOutlined,
  PartitionOutlined,
  HistoryOutlined,
  LogoutOutlined,
  BugOutlined,
  BookOutlined,
  DashboardOutlined,
  FileTextOutlined,
  MessageOutlined,
} from '@ant-design/icons'
import { me, logout, type MeResponse } from '../api/auth'

const { Sider, Content, Header } = Layout

const PAGE_NAMES: Record<string, string> = {
  '/product-lines': '产线管理',
  '/environments': '环境管理',
  '/test-servers': '服务器管理',
  '/dingtalk-users': '组织成员',
  '/capabilities': '能力管理',
  '/im-triggers': 'IM 触发器',
  '/test-pipelines': '流水线管理',
  '/test-runs': '执行记录',
  '/capability-invocations': 'Capability 调用',
  '/tools': '工具管理',
  '/system-config': '系统配置',
  '/bug-runs': 'Bug 修复',
  '/metrics': 'Bug 修复指标',
  '/prd-documents': 'PRD 文档',
  '/prd-metrics': 'PRD 指标',
  '/prd-chat': 'PRD 对话',
  '/product-knowledge': '知识库',
}

const menuItems = [
  {
    type: 'group' as const,
    label: '运维资源',
    children: [
      { key: '/product-lines', icon: <AppstoreOutlined />, label: '产线管理' },
      { key: '/environments', icon: <CloudOutlined />, label: '环境管理' },
      { key: '/test-servers', icon: <HddOutlined />, label: '服务器管理' },
      { key: '/dingtalk-users', icon: <UserOutlined />, label: '组织成员' },
    ],
  },
  {
    type: 'group' as const,
    label: '能力配置',
    children: [
      { key: '/capabilities', icon: <ThunderboltOutlined />, label: '能力管理' },
      { key: '/im-triggers', icon: <MessageOutlined />, label: 'IM 触发器' },
      { key: '/test-pipelines', icon: <PartitionOutlined />, label: '流水线管理' },
      { key: '/test-runs', icon: <HistoryOutlined />, label: '执行记录' },
      { key: '/capability-invocations', icon: <HistoryOutlined />, label: 'Capability 调用' },
    ],
  },
  {
    type: 'group' as const,
    label: 'AI 助手',
    children: [
      { key: '/bug-runs', icon: <BugOutlined />, label: 'Bug 修复' },
      { key: '/metrics', icon: <DashboardOutlined />, label: 'Bug 修复指标' },
      { key: '/prd-documents', icon: <FileTextOutlined />, label: 'PRD 文档' },
      { key: '/prd-metrics', icon: <DashboardOutlined />, label: 'PRD 指标' },
      { key: '/product-knowledge', icon: <BookOutlined />, label: '知识库' },
    ],
  },
  {
    type: 'group' as const,
    label: '平台',
    children: [
      { key: '/tools', icon: <ToolOutlined />, label: '工具管理' },
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

  const pageTitle = PAGE_NAMES[selectedKey] ?? 'Mewtwo'
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
          <div className="chatops-logo-icon">MT</div>
          {!collapsed && <span className="chatops-logo-text">Mewtwo</span>}
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
