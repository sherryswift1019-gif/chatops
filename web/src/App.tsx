import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import AdminLayout from './layout/AdminLayout'
import SystemConfigPage from './pages/SystemConfigPage'
import EnvironmentListPage from './pages/EnvironmentListPage'
import ProductLineListPage from './pages/ProductLineListPage'
import ProductLineDetailPage from './pages/ProductLineDetailPage'
import ProjectsPage from './pages/ProjectsPage'
import DingTalkUsersPage from './pages/DingTalkUsersPage'
import CapabilitiesPage from './pages/CapabilitiesPage'

export default function App() {
  return (
    <ConfigProvider locale={zhCN}>
      <BrowserRouter>
        <Routes>
          <Route element={<AdminLayout />}>
            <Route index element={<Navigate to="/product-lines" replace />} />
            <Route path="/product-lines" element={<ProductLineListPage />} />
            <Route path="/product-lines/:id" element={<ProductLineDetailPage />} />
            <Route path="/projects" element={<ProjectsPage />} />
            <Route path="/environments" element={<EnvironmentListPage />} />
            <Route path="/dingtalk-users" element={<DingTalkUsersPage />} />
            <Route path="/capabilities" element={<CapabilitiesPage />} />
            <Route path="/system-config" element={<SystemConfigPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ConfigProvider>
  )
}
