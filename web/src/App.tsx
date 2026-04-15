import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import AdminLayout from './layout/AdminLayout'
import AuthGuard from './components/AuthGuard'
import LoginPage from './pages/LoginPage'
import ChangePasswordPage from './pages/ChangePasswordPage'
import SystemConfigPage from './pages/SystemConfigPage'
import EnvironmentListPage from './pages/EnvironmentListPage'
import ProductLineListPage from './pages/ProductLineListPage'
import ProductLineDetailPage from './pages/ProductLineDetailPage'
import DingTalkUsersPage from './pages/DingTalkUsersPage'
import CapabilitiesPage from './pages/CapabilitiesPage'
import TestServersPage from './pages/TestServersPage'
import TestPipelinesPage from './pages/TestPipelinesPage'
import TestRunsPage from './pages/TestRunsPage'

export default function App() {
  return (
    <ConfigProvider locale={zhCN}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/change-password" element={<AuthGuard><ChangePasswordPage /></AuthGuard>} />
          <Route element={<AuthGuard><AdminLayout /></AuthGuard>}>
            <Route index element={<Navigate to="/product-lines" replace />} />
            <Route path="/product-lines" element={<ProductLineListPage />} />
            <Route path="/product-lines/:id" element={<ProductLineDetailPage />} />
            <Route path="/environments" element={<EnvironmentListPage />} />
            <Route path="/dingtalk-users" element={<DingTalkUsersPage />} />
            <Route path="/capabilities" element={<CapabilitiesPage />} />
            <Route path="/system-config" element={<SystemConfigPage />} />
            <Route path="/test-servers" element={<TestServersPage />} />
            <Route path="/test-pipelines" element={<TestPipelinesPage />} />
            <Route path="/test-runs" element={<TestRunsPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ConfigProvider>
  )
}
