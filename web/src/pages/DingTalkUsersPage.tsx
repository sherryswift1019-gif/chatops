import { useEffect, useState, useRef } from 'react'
import { Card, Table, Button, Input, Avatar, Space, message } from 'antd'
import { SyncOutlined, UserOutlined } from '@ant-design/icons'
import { getDingTalkUsersPaged, syncDingTalkUsers } from '../api/dingtalk-users'
import { usePagination } from '../hooks/usePagination'
import type { DingTalkUser } from '../types'

export default function DingTalkUsersPage() {
  const [data, setData] = useState<DingTalkUser[]>([])
  const [loading, setLoading] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [keyword, setKeyword] = useState('')
  const searchTimer = useRef<ReturnType<typeof setTimeout>>()
  const abortRef = useRef<AbortController | null>(null)

  const { page, limit, total, setTotal, resetPage, tableProps } = usePagination(20)

  useEffect(() => {
    abortRef.current?.abort()
    abortRef.current = new AbortController()
    load()
  }, [page, limit, keyword])

  async function load() {
    setLoading(true)
    try {
      const res = await getDingTalkUsersPaged({ keyword: keyword || undefined, page, limit }, abortRef.current?.signal)
      setData(res.data)
      setTotal(res.total)
    } catch {
      // ignore abort errors
    } finally {
      setLoading(false)
    }
  }

  function handleSearch(value: string) {
    clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => {
      resetPage()
      setKeyword(value)
    }, 300)
  }

  async function handleSync() {
    setSyncing(true)
    try {
      const res = await syncDingTalkUsers()
      if (res.success) {
        message.success(res.synced != null ? `同步成功，共同步 ${res.synced} 名用户` : '同步成功')
        load()
      } else {
        message.error(res.error ?? '同步失败')
      }
    } catch {
      message.error('同步失败，请稍后重试')
    } finally {
      setSyncing(false)
    }
  }

  const columns = [
    {
      title: '头像', dataIndex: 'avatar',
      render: (src: string) => (
        <Avatar src={src || undefined} icon={!src ? <UserOutlined /> : undefined} />
      ),
    },
    { title: '姓名', dataIndex: 'name' },
    { title: '用户ID', dataIndex: 'userId' },
    { title: '部门', dataIndex: 'department', ellipsis: true },
    {
      title: '同步时间', dataIndex: 'syncedAt',
      render: (v: string) => v ? new Date(v).toLocaleString() : '-',
    },
  ]

  return (
    <Card
      title={`钉钉用户（共 ${total} 人）`}
      extra={
        <Space>
          <Input.Search
            placeholder="搜索姓名或部门"
            allowClear
            style={{ width: 220 }}
            onSearch={handleSearch}
            onChange={e => handleSearch(e.target.value)}
          />
          <Button
            icon={<SyncOutlined spin={syncing} />}
            loading={syncing}
            onClick={handleSync}
          >
            同步用户
          </Button>
        </Space>
      }
    >
      <Table
        rowKey="userId"
        columns={columns}
        dataSource={data}
        loading={loading}
        {...tableProps}
      />
    </Card>
  )
}
