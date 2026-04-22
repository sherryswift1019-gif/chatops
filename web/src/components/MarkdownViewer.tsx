import { memo, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSlug from 'rehype-slug'

interface Props {
  source: string
  className?: string
  style?: React.CSSProperties
}

function MarkdownViewerImpl({ source, className, style }: Props) {
  const plugins = useMemo(() => ({ remark: [remarkGfm], rehype: [rehypeSlug] }), [])

  return (
    <div
      className={`chatops-md ${className ?? ''}`}
      style={{
        fontSize: 13,
        lineHeight: 1.7,
        color: '#1A1F2E',
        ...style,
      }}
    >
      <ReactMarkdown
        remarkPlugins={plugins.remark}
        rehypePlugins={plugins.rehype}
        components={{
          h1: (p) => <h1 style={{ fontSize: 22, margin: '16px 0 12px', fontWeight: 600 }} {...p} />,
          h2: (p) => (
            <h2
              style={{
                fontSize: 18,
                margin: '20px 0 10px',
                fontWeight: 600,
                borderBottom: '1px solid #EEF0F4',
                paddingBottom: 6,
              }}
              {...p}
            />
          ),
          h3: (p) => <h3 style={{ fontSize: 15, margin: '14px 0 8px', fontWeight: 600 }} {...p} />,
          h4: (p) => <h4 style={{ fontSize: 14, margin: '12px 0 6px', fontWeight: 600 }} {...p} />,
          p: (p) => <p style={{ margin: '8px 0' }} {...p} />,
          ul: (p) => <ul style={{ paddingLeft: 22, margin: '6px 0' }} {...p} />,
          ol: (p) => <ol style={{ paddingLeft: 22, margin: '6px 0' }} {...p} />,
          li: (p) => <li style={{ margin: '3px 0' }} {...p} />,
          code: ({ className: cn, children, ...rest }) => {
            // react-markdown v9 不再传 inline 属性。用两条线索判定块级：
            //   1) 有 language-* 类（带语言的 fenced block）
            //   2) 内容包含换行（无语言的 fenced block 也会命中）
            // 块级 code 交给 pre 渲染，这里不再额外加 inline 背景，避免在深色 pre 里出现条带。
            const text = typeof children === 'string' ? children : Array.isArray(children)
              ? children.map((c) => (typeof c === 'string' ? c : '')).join('')
              : ''
            const isBlock = /language-/.test(cn ?? '') || text.includes('\n')
            if (isBlock) {
              return (
                <code className={cn} {...rest}>
                  {children}
                </code>
              )
            }
            return (
              <code
                style={{
                  background: '#F6F7FA',
                  padding: '1px 6px',
                  borderRadius: 4,
                  fontSize: 12,
                  fontFamily: 'Menlo, Monaco, monospace',
                  color: '#1A1F2E',
                }}
                {...rest}
              >
                {children}
              </code>
            )
          },
          pre: (p) => (
            <pre
              style={{
                background: '#F6F8FA',
                color: '#1A1F2E',
                border: '1px solid #E4E7EE',
                padding: 14,
                borderRadius: 6,
                overflow: 'auto',
                fontSize: 12.5,
                lineHeight: 1.6,
                margin: '10px 0',
                fontFamily: 'Menlo, Monaco, monospace',
              }}
              {...p}
            />
          ),
          table: (p) => (
            <div style={{ overflowX: 'auto', margin: '10px 0' }}>
              <table
                style={{
                  borderCollapse: 'collapse',
                  width: '100%',
                  border: '1px solid #E4E7EE',
                }}
                {...p}
              />
            </div>
          ),
          th: (p) => (
            <th
              style={{
                background: '#FAFBFC',
                border: '1px solid #E4E7EE',
                padding: '6px 10px',
                textAlign: 'left',
                fontWeight: 600,
                color: '#5C6578',
              }}
              {...p}
            />
          ),
          td: (p) => (
            <td
              style={{
                border: '1px solid #EEF0F4',
                padding: '6px 10px',
                verticalAlign: 'top',
              }}
              {...p}
            />
          ),
          blockquote: (p) => (
            <blockquote
              style={{
                borderLeft: '3px solid #4B8BFF',
                background: '#F6F9FF',
                padding: '6px 12px',
                margin: '10px 0',
                color: '#5C6578',
              }}
              {...p}
            />
          ),
          hr: () => (
            <hr style={{ border: 0, borderTop: '1px solid #EEF0F4', margin: '16px 0' }} />
          ),
          a: (p) => <a style={{ color: '#4B8BFF' }} target="_blank" rel="noreferrer" {...p} />,
          input: (p) =>
            p.type === 'checkbox' ? (
              <input
                type="checkbox"
                disabled
                checked={p.checked}
                readOnly
                style={{ marginRight: 6 }}
              />
            ) : (
              <input {...p} />
            ),
        }}
      >
        {source || ''}
      </ReactMarkdown>
    </div>
  )
}

const MarkdownViewer = memo(MarkdownViewerImpl)
export default MarkdownViewer
