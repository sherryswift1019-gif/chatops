import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import AdminLayout from './layout/AdminLayout'
import SystemConfigPage from './pages/SystemConfigPage'
import EnvironmentListPage from './pages/EnvironmentListPage'
import ProductLineListPage from './pages/ProductLineListPage'
import ProductLineDetailPage from './pages/ProductLineDetailPage'

// Placeholder pages for routes not yet implemented
function Placeholder({ name }: { name: string }) {
  return <div style={{ padding: 24 }}>{name} - 开发中...</div>
}

export default function App() {
  return (
    <ConfigProvider locale={zhCN}>
      <BrowserRouter>
        <Routes>
          <Route element={<AdminLayout />}>
            <Route index element={<Navigate to="/product-lines" replace />} />
            <Route path="/product-lines" element={<ProductLineListPage />} />
            <Route path="/product-lines/:id" element={<ProductLineDetailPage />} />
            <Route path="/projects" element={<Placeholder name="项目管理" />} />
            <Route path="/environments" element={<EnvironmentListPage />} />
            <Route path="/dingtalk-users" element={<Placeholder name="钉钉用户" />} />
            <Route path="/approval-rules" element={<Placeholder name="审批规则" />} />
            <Route path="/system-config" element={<SystemConfigPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ConfigProvider>
  )
}
