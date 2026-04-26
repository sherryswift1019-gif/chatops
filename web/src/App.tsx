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
const ToolsPage              = lazy(() => import('./pages/ToolsPage'))
const TestServersPage        = lazy(() => import('./pages/TestServersPage'))
const TestPipelinesPage      = lazy(() => import('./pages/TestPipelinesPage'))
const TestRunsPage           = lazy(() => import('./pages/TestRunsPage'))
const PipelineCanvasPage     = lazy(() => import('./pipeline-canvas/PipelineCanvasPage'))
// 研发 AI 助手页面
const BugRunsPage            = lazy(() => import('./pages/BugRunsPage'))
const ProductKnowledgePage   = lazy(() => import('./pages/ProductKnowledgePage'))
const MetricsPage            = lazy(() => import('./pages/MetricsPage'))
const PrdDocumentsPage       = lazy(() => import('./pages/PrdDocumentsPage'))
const PrdChatPage            = lazy(() => import('./pages/PrdChatPage'))
const PrdMetricsPage         = lazy(() => import('./pages/PrdMetricsPage'))

const FONT = "'Urbanist', -apple-system, BlinkMacSystemFont, sans-serif"

export default function App() {
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: theme.defaultAlgorithm,
        token: {
          fontFamily: FONT,
          fontSize: 14,
          // Primary accent: electric blue (shared across dark sider + light content)
          colorPrimary: '#4B8BFF',
          // Light content surfaces
          colorBgBase: '#FFFFFF',
          colorTextBase: '#1A1F2E',
          colorBgLayout: '#F6F7FA',
          colorBgContainer: '#FFFFFF',
          colorBgElevated: '#FFFFFF',
          colorBgSpotlight: '#1A1F2E',
          // Borders
          borderRadius: 8,
          borderRadiusSM: 6,
          borderRadiusLG: 10,
          colorBorder: '#E4E7EE',
          colorBorderSecondary: '#EEF0F4',
          // Shadows — refined, not heavy
          boxShadow: '0 4px 20px rgba(15, 23, 42, 0.06)',
          boxShadowSecondary: '0 2px 8px rgba(15, 23, 42, 0.05)',
          // Motion
          motionDurationMid: '0.15s',
          motionDurationSlow: '0.2s',
        },
        components: {
          Layout: {
            // Header + body = light; sider stays dark (bicolor precision)
            headerBg: '#FFFFFF',
            bodyBg: '#F6F7FA',
            siderBg: '#0B0D14',
            triggerBg: '#0B0D14',
            triggerColor: 'rgba(255,255,255,0.35)',
            headerHeight: 56,
            headerPadding: '0 24px',
          },
          Menu: {
            // Dark sider menu — untouched by light algorithm
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
            headerBg: '#FAFBFC',
            headerColor: '#5C6578',
            rowHoverBg: 'rgba(75,139,255,0.05)',
            borderColor: '#EEF0F4',
            fontSize: 13,
            headerSplitColor: 'transparent',
          },
          Card: {
            colorBgContainer: '#FFFFFF',
            colorBorderSecondary: '#EEF0F4',
          },
          Modal: {
            contentBg: '#FFFFFF',
            headerBg: '#FFFFFF',
            footerBg: '#FFFFFF',
          },
          Drawer: {
            colorBgElevated: '#FFFFFF',
          },
          Input: {
            colorBgContainer: '#FFFFFF',
            colorBgContainerDisabled: '#F6F7FA',
            hoverBorderColor: '#4B8BFF',
            activeBorderColor: '#4B8BFF',
          },
          Select: {
            colorBgContainer: '#FFFFFF',
            optionSelectedBg: 'rgba(75,139,255,0.10)',
            colorBgElevated: '#FFFFFF',
          },
          Button: {
            defaultBg: '#FFFFFF',
            defaultBorderColor: '#E4E7EE',
            defaultColor: '#1A1F2E',
            defaultHoverBg: '#F6F7FA',
            defaultHoverBorderColor: '#C9CFDB',
            defaultHoverColor: '#4B8BFF',
          },
          Tabs: {
            itemColor: '#5C6578',
            itemSelectedColor: '#4B8BFF',
            inkBarColor: '#4B8BFF',
            itemHoverColor: '#1A1F2E',
            cardBg: '#FFFFFF',
          },
          Form: {
            labelColor: '#5C6578',
            labelRequiredMarkColor: '#EF4444',
          },
          Switch: {
            colorPrimary: '#4B8BFF',
            handleBg: '#FFFFFF',
          },
          Checkbox: {
            colorPrimary: '#4B8BFF',
          },
          Tag: {
            fontSizeSM: 11,
          },
          Descriptions: {
            colorTextSecondary: '#5C6578',
          },
          Timeline: {
            colorText: '#1A1F2E',
          },
          Popconfirm: {
            colorBgElevated: '#FFFFFF',
          },
          Tooltip: {
            colorBgSpotlight: '#1A1F2E',
          },
          Dropdown: {
            colorBgElevated: '#FFFFFF',
          },
          Message: {
            colorBgElevated: '#FFFFFF',
          },
          Notification: {
            colorBgElevated: '#FFFFFF',
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
            <Route path="/tools" element={
              <Suspense fallback={null}><ToolsPage /></Suspense>
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
            <Route path="/test-pipelines/:id/canvas" element={
              <Suspense fallback={null}><PipelineCanvasPage /></Suspense>
            } />
            <Route path="/test-runs" element={
              <Suspense fallback={null}><TestRunsPage /></Suspense>
            } />
            {/* 研发 AI 助手 */}
            <Route path="/bug-runs" element={
              <Suspense fallback={null}><BugRunsPage /></Suspense>
            } />
            <Route path="/product-knowledge" element={
              <Suspense fallback={null}><ProductKnowledgePage /></Suspense>
            } />
            <Route path="/metrics" element={
              <Suspense fallback={null}><MetricsPage /></Suspense>
            } />
            <Route path="/prd-documents" element={
              <Suspense fallback={null}><PrdDocumentsPage /></Suspense>
            } />
            <Route path="/prd-metrics" element={
              <Suspense fallback={null}><PrdMetricsPage /></Suspense>
            } />
            <Route path="/prd-chat/:sessionKey" element={
              <Suspense fallback={null}><PrdChatPage /></Suspense>
            } />
          </Route>
        </Routes>
      </BrowserRouter>
    </ConfigProvider>
  )
}
