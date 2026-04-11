import { useState, useRef } from 'react'
import { Select, Avatar, Space } from 'antd'
import { UserOutlined } from '@ant-design/icons'
import { getDingTalkUsers } from '../api/dingtalk-users'
import type { DingTalkUser } from '../types'

interface Props {
  value?: string | string[]
  onChange?: (value: string | string[]) => void
  onUserSelect?: (user: DingTalkUser) => void
  mode?: 'multiple'
  placeholder?: string
  style?: React.CSSProperties
}

export default function DingTalkUserSelect({ value, onChange, onUserSelect, mode, placeholder = '搜索钉钉用户', style }: Props) {
  const [options, setOptions] = useState<DingTalkUser[]>([])
  const [fetching, setFetching] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout>>()

  const handleSearch = (keyword: string) => {
    clearTimeout(timerRef.current)
    if (!keyword) { setOptions([]); return }
    timerRef.current = setTimeout(async () => {
      setFetching(true)
      try {
        const res = await getDingTalkUsers(keyword)
        setOptions(res.users)
      } finally { setFetching(false) }
    }, 300)
  }

  const handleChange = (val: string | string[]) => {
    onChange?.(val)
    // Find user object and notify
    const selectedId = Array.isArray(val) ? val[val.length - 1] : val
    const user = options.find(u => u.userId === selectedId)
    if (user && onUserSelect) onUserSelect(user)
  }

  return (
    <Select
      showSearch
      value={value}
      mode={mode}
      placeholder={placeholder}
      style={style ?? { width: '100%' }}
      filterOption={false}
      onSearch={handleSearch}
      onChange={handleChange as (value: string | string[]) => void}
      loading={fetching}
      notFoundContent={fetching ? '搜索中...' : '无结果'}
      options={options.map(u => ({
        value: u.userId,
        label: (
          <Space>
            <Avatar size="small" src={u.avatar || undefined} icon={!u.avatar ? <UserOutlined /> : undefined} />
            <span>{u.name}</span>
            <span style={{ color: '#999', fontSize: 12 }}>{u.department}</span>
          </Space>
        ),
      }))}
    />
  )
}
