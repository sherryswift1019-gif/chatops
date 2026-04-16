import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import AdminLayout from './layout/AdminLayout'
import SystemConfigPage from './pages/SystemConfigPage'
import EnvironmentListPage from './pages/EnvironmentListPage'
import ProductLineListPage from './pages/ProductLineListPage'
import ProductLineDetailPage from './pages/ProductLineDetailPage'
import DingTalkUsersPage from './pages/DingTalkUsersPage'
import CapabilitiesPage from './pages/CapabilitiesPage'
import TestServersPage from './pages/TestServersPage'
import TestPipelinesPage from './pages/TestPipelinesPage'
import TestRunsPage from './pages/TestRunsPage'
// 研发 AI 助手页面
import ModuleOwnersPage from './pages/ModuleOwnersPage'
import BugRunsPage from './pages/BugRunsPage'
import ProductKnowledgePage from './pages/ProductKnowledgePage'
import MetricsPage from './pages/MetricsPage'

export default function App() {
  return (
    <ConfigProvider locale={zhCN}>
      <BrowserRouter>
        <Routes>
          <Route element={<AdminLayout />}>
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
            {/* 研发 AI 助手 */}
            <Route path="/bug-runs" element={<BugRunsPage />} />
            <Route path="/module-owners" element={<ModuleOwnersPage />} />
            <Route path="/product-knowledge" element={<ProductKnowledgePage />} />
            <Route path="/metrics" element={<MetricsPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ConfigProvider>
  )
}
