import { useEffect, useState, useRef } from 'react'
import {
  Card, Table, Button, Input, Avatar, Space, message, Tag, Modal, Segmented, Typography, List,
} from 'antd'
import {
  SyncOutlined, UserOutlined, DeleteOutlined, WarningOutlined,
} from '@ant-design/icons'
import {
  getDingTalkUsersPaged, syncDingTalkUsers, getUserReferences, deleteUser,
} from '../api/dingtalk-users'
import { usePagination } from '../hooks/usePagination'
import type { DingTalkUser } from '../types'

type StatusFilter = 'all' | 'active' | 'resigned'

export default function DingTalkUsersPage() {
  const [data, setData] = useState<DingTalkUser[]>([])
  const [loading, setLoading] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const searchTimer = useRef<ReturnType<typeof setTimeout>>()
  const abortRef = useRef<AbortController | null>(null)

  const { page, limit, total, setTotal, resetPage, tableProps } = usePagination(20)

  useEffect(() => {
    abortRef.current?.abort()
    abortRef.current = new AbortController()
    load()
  }, [page, limit, keyword, statusFilter])

  async function load() {
    setLoading(true)
    try {
      const res = await getDingTalkUsersPaged(
        { keyword: keyword || undefined, page, limit, status: statusFilter },
        abortRef.current?.signal
      )
      setData(res.data)
      setTotal(res.total)
    } catch {
      // ignore abort
    } finally {
      setLoading(false)
    }
  }

  function handleSearch(value: string) {
    clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => { resetPage(); setKeyword(value) }, 300)
  }

  async function handleSync() {
    setSyncing(true)
    try {
      const res = await syncDingTalkUsers()
      if (res.success) {
        const parts = [`共同步 ${res.synced ?? 0} 名用户`]
        if (res.resigned) parts.push(`新增 ${res.resigned} 名离职`)
        if (res.rejoined) parts.push(`恢复 ${res.rejoined} 名在职`)
        message.success(`同步成功，${parts.join('，')}`)
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

  async function handleDelete(user: DingTalkUser) {
    setDeletingId(user.userId)
    try {
      const refs = await getUserReferences(user.userId)
      if (refs.blocked) {
        Modal.error({
          title: `无法删除「${user.name}」`,
          icon: <WarningOutlined />,
          content: (
            <div>
              <p>该用户仍被以下资源引用，请先解除引用后再删除：</p>
              <List
                size="small"
                dataSource={refs.references}
                renderItem={r => (
                  <List.Item>
                    <Typography.Text>{r.label}</Typography.Text>
                    <Tag style={{ marginLeft: 8 }}>{r.count} 条</Tag>
                  </List.Item>
                )}
              />
            </div>
          ),
        })
        return
      }

      Modal.confirm({
        title: `确认删除「${user.name}」？`,
        content: '删除后不可恢复，该用户的历史记录将保留。',
        okText: '确认删除',
        okType: 'danger',
        cancelText: '取消',
        onOk: async () => {
          await deleteUser(user.userId)
          message.success(`已删除用户「${user.name}」`)
          load()
        },
      })
    } catch {
      message.error('操作失败，请稍后重试')
    } finally {
      setDeletingId(null)
    }
  }

  const columns = [
    {
      title: '头像', dataIndex: 'avatar', width: 60,
      render: (src: string) => (
        <Avatar src={src || undefined} icon={!src ? <UserOutlined /> : undefined} />
      ),
    },
    { title: '姓名', dataIndex: 'name' },
    { title: '用户ID', dataIndex: 'userId' },
    { title: '部门', dataIndex: 'department', ellipsis: true },
    {
      title: '状态', dataIndex: 'resignedAt', width: 90,
      render: (v: string | null) =>
        v ? <Tag color="orange">已离职</Tag> : <Tag color="green">在职</Tag>,
    },
    {
      title: '离职时间', dataIndex: 'resignedAt', width: 160,
      render: (v: string | null) => v ? new Date(v).toLocaleString() : '-',
    },
    {
      title: '同步时间', dataIndex: 'syncedAt', width: 160,
      render: (v: string) => v ? new Date(v).toLocaleString() : '-',
    },
    {
      title: '操作', width: 80, align: 'center' as const,
      render: (_: unknown, record: DingTalkUser) =>
        record.resignedAt ? (
          <Button
            type="link"
            danger
            size="small"
            icon={<DeleteOutlined />}
            loading={deletingId === record.userId}
            onClick={() => handleDelete(record)}
          >
            删除
          </Button>
        ) : null,
    },
  ]

  const segmentedOptions = [
    { label: '全部', value: 'all' },
    { label: '在职', value: 'active' },
    { label: '已离职', value: 'resigned' },
  ]

  return (
    <Card
      title={`钉钉用户（共 ${total} 人）`}
      extra={
        <Space>
          <Segmented
            options={segmentedOptions}
            value={statusFilter}
            onChange={v => { setStatusFilter(v as StatusFilter); resetPage() }}
          />
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
        rowClassName={(r: DingTalkUser) => r.resignedAt ? 'ant-table-row-disabled' : ''}
        {...tableProps}
      />
    </Card>
  )
}
