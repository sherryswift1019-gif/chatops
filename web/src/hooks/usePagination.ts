import { useState, useCallback } from 'react'

export function usePagination(defaultLimit = 20) {
  const [page, setPage] = useState(1)
  const [limit, setLimit] = useState(defaultLimit)
  const [total, setTotal] = useState(0)

  const resetPage = useCallback(() => setPage(1), [])

  const tableProps = {
    pagination: {
      current: page,
      pageSize: limit,
      total,
      showSizeChanger: true,
      pageSizeOptions: ['10', '20', '50', '100'],
      showTotal: (t: number) => `共 ${t} 条`,
      onChange: (p: number, l: number) => {
        setPage(p)
        setLimit(l)
      },
    },
  }

  return { page, limit, total, setTotal, resetPage, tableProps }
}
