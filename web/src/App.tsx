import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { ConfigProvider, theme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import AdminLayout from './layout/AdminLayout'
import AuthGuard from './components/AuthGuard'
// Auth pages are small and always needed — keep eager
import LoginPage from './pages/LoginPage'
import ChangePasswordPage from './pages/ChangePasswordPage'

// Route-level code splitting: each page becomes its own chunk
const SystemConfigPage       = lazy(() => import('./pages/SystemConfigPage'))
const EnvironmentListPage    = lazy(() => import('./pages/EnvironmentListPage'))
const ProductLineListPage    = lazy(() => import('./pages/ProductLineListPage'))
const ProductLineDetailPage  = lazy(() => import('./pages/ProductLineDetailPage'))
const DingTalkUsersPage      = lazy(() => import('./pages/DingTalkUsersPage'))
const CapabilitiesPage       = lazy(() => import('./pages/CapabilitiesPage'))
const TestServersPage        = lazy(() => import('./pages/TestServersPage'))
const TestPipelinesPage      = lazy(() => import('./pages/TestPipelinesPage'))
const TestRunsPage           = lazy(() => import('./pages/TestRunsPage'))
// 研发 AI 助手页面
const BugRunsPage            = lazy(() => import('./pages/BugRunsPage'))
const ModuleOwnersPage       = lazy(() => import('./pages/ModuleOwnersPage'))
const ProductKnowledgePage   = lazy(() => import('./pages/ProductKnowledgePage'))
const MetricsPage            = lazy(() => import('./pages/MetricsPage'))

const FONT = "'Urbanist', -apple-system, BlinkMacSystemFont, sans-serif"

export default function App() {
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: theme.darkAlgorithm,
        token: {
          fontFamily: FONT,
          fontSize: 14,
          // Primary accent: electric blue
          colorPrimary: '#4B8BFF',
          // Backgrounds
          colorBgBase: '#0F1117',
          colorTextBase: '#E6EAF3',
          colorBgLayout: '#0F1117',
          colorBgContainer: '#161B27',
          colorBgElevated: '#1E2535',
          colorBgSpotlight: '#1E2535',
          // Borders
          borderRadius: 8,
          borderRadiusSM: 6,
          borderRadiusLG: 10,
          colorBorder: 'rgba(255,255,255,0.1)',
          colorBorderSecondary: 'rgba(255,255,255,0.06)',
          // Shadows
          boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
          boxShadowSecondary: '0 2px 12px rgba(0,0,0,0.3)',
          // Motion
          motionDurationMid: '0.15s',
          motionDurationSlow: '0.2s',
        },
        components: {
          Layout: {
            headerBg: '#111827',
            bodyBg: '#0F1117',
            siderBg: '#0B0D14',
            triggerBg: '#0B0D14',
            triggerColor: 'rgba(255,255,255,0.35)',
            headerHeight: 56,
            headerPadding: '0 24px',
          },
          Menu: {
            darkItemBg: '#0B0D14',
            darkSubMenuItemBg: '#0B0D14',
            darkItemSelectedBg: 'rgba(75,139,255,0.15)',
            darkItemSelectedColor: '#4B8BFF',
            darkItemHoverBg: 'rgba(255,255,255,0.06)',
            darkItemColor: '#8B93A8',
            darkGroupTitleColor: 'rgba(255,255,255,0.22)',
            itemHeight: 38,
            fontSize: 13,
            iconSize: 15,
            iconMarginInlineEnd: 10,
          },
          Table: {
            headerBg: 'rgba(255,255,255,0.03)',
            headerColor: '#6B7590',
            rowHoverBg: 'rgba(75,139,255,0.05)',
            borderColor: 'rgba(255,255,255,0.07)',
            fontSize: 13,
            headerSplitColor: 'transparent',
          },
          Card: {
            colorBgContainer: '#161B27',
            colorBorderSecondary: 'rgba(255,255,255,0.08)',
          },
          Modal: {
            contentBg: '#161B27',
            headerBg: '#161B27',
            footerBg: '#161B27',
          },
          Drawer: {
            colorBgElevated: '#161B27',
          },
          Input: {
            colorBgContainer: '#0F1117',
            colorBgContainerDisabled: 'rgba(255,255,255,0.04)',
            hoverBorderColor: '#4B8BFF',
            activeBorderColor: '#4B8BFF',
          },
          Select: {
            colorBgContainer: '#0F1117',
            optionSelectedBg: 'rgba(75,139,255,0.15)',
            colorBgElevated: '#1E2535',
          },
          Button: {
            defaultBg: 'transparent',
            defaultBorderColor: 'rgba(255,255,255,0.12)',
            defaultColor: '#C8D0E0',
            defaultHoverBg: 'rgba(255,255,255,0.06)',
            defaultHoverBorderColor: 'rgba(255,255,255,0.2)',
            defaultHoverColor: '#E6EAF3',
          },
          Tabs: {
            itemColor: '#6B7590',
            itemSelectedColor: '#4B8BFF',
            inkBarColor: '#4B8BFF',
            itemHoverColor: '#E6EAF3',
            cardBg: '#161B27',
          },
          Form: {
            labelColor: '#8B93A8',
            labelRequiredMarkColor: '#EF4444',
          },
          Switch: {
            colorPrimary: '#4B8BFF',
            handleBg: '#fff',
          },
          Checkbox: {
            colorPrimary: '#4B8BFF',
          },
          Tag: {
            fontSizeSM: 11,
          },
          Descriptions: {
            colorTextSecondary: '#8B93A8',
          },
          Timeline: {
            colorText: '#E6EAF3',
          },
          Popconfirm: {
            colorBgElevated: '#1E2535',
          },
          Tooltip: {
            colorBgSpotlight: '#1E2535',
          },
          Dropdown: {
            colorBgElevated: '#1E2535',
          },
          Message: {
            colorBgElevated: '#1E2535',
          },
          Notification: {
            colorBgElevated: '#1E2535',
          },
        },
      }}
    >
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/change-password" element={<AuthGuard><ChangePasswordPage /></AuthGuard>} />
          <Route element={<AuthGuard><AdminLayout /></AuthGuard>}>
            <Route index element={<Navigate to="/product-lines" replace />} />
            <Route path="/product-lines" element={
              <Suspense fallback={null}><ProductLineListPage /></Suspense>
            } />
            <Route path="/product-lines/:id" element={
              <Suspense fallback={null}><ProductLineDetailPage /></Suspense>
            } />
            <Route path="/environments" element={
              <Suspense fallback={null}><EnvironmentListPage /></Suspense>
            } />
            <Route path="/dingtalk-users" element={
              <Suspense fallback={null}><DingTalkUsersPage /></Suspense>
            } />
            <Route path="/capabilities" element={
              <Suspense fallback={null}><CapabilitiesPage /></Suspense>
            } />
            <Route path="/system-config" element={
              <Suspense fallback={null}><SystemConfigPage /></Suspense>
            } />
            <Route path="/test-servers" element={
              <Suspense fallback={null}><TestServersPage /></Suspense>
            } />
            <Route path="/test-pipelines" element={
              <Suspense fallback={null}><TestPipelinesPage /></Suspense>
            } />
            <Route path="/test-runs" element={
              <Suspense fallback={null}><TestRunsPage /></Suspense>
            } />
            {/* 研发 AI 助手 */}
            <Route path="/bug-runs" element={
              <Suspense fallback={null}><BugRunsPage /></Suspense>
            } />
            <Route path="/module-owners" element={
              <Suspense fallback={null}><ModuleOwnersPage /></Suspense>
            } />
            <Route path="/product-knowledge" element={
              <Suspense fallback={null}><ProductKnowledgePage /></Suspense>
            } />
            <Route path="/metrics" element={
              <Suspense fallback={null}><MetricsPage /></Suspense>
            } />
          </Route>
        </Routes>
      </BrowserRouter>
    </ConfigProvider>
  )
}
