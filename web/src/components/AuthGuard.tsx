import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { Spin } from 'antd'
import { me, type MeResponse } from '../api/auth'

interface Props {
  children: ReactNode
}

export default function AuthGuard({ children }: Props) {
  const [user, setUser] = useState<MeResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()
  const location = useLocation()

  useEffect(() => {
    let cancelled = false
    me()
      .then((u) => {
        if (cancelled) return
        setUser(u)
        if (u.mustChangePassword && location.pathname !== '/change-password') {
          navigate('/change-password', { replace: true })
        }
      })
      .catch(() => { /* 401 already redirected by axios interceptor */ })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [location.pathname, navigate])

  if (loading || !user) {
    return <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}><Spin /></div>
  }
  return <>{children}</>
}
