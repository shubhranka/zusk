import { useMemo, type ReactNode } from 'react'

import { toAppError } from '../../lib/api'
import { copyText } from '../../lib/clipboard'
import { isSqlBlock, parseInline, parseMarkdown, type Block, type Inline } from '../../lib/markdown'
import { useApp } from '../../store/app'

/** Which connection a SQL block opens on in the editor; undefined is the selected one. */
type ConnFor = (sql: string) => string | undefined

/** The agent's answer. */
export function Markdown({ text, connFor }: { text: string; connFor?: ConnFor }) {
  const blocks = useMemo(() => parseMarkdown(text), [text])
  return <div className="md">{blocks.map((b, i) => renderBlock(b, i, connFor))}</div>
}

function renderBlock(block: Block, key: number, connFor?: ConnFor): ReactNode {
  switch (block.type) {
    case 'heading': {
      // Answers are small; h4 and below all look the same.
      const Tag = (['h3', 'h3', 'h4', 'h5', 'h5', 'h5'] as const)[block.level - 1]
      return <Tag key={key}>{inline(block.text)}</Tag>
    }
    case 'paragraph':
      return <p key={key}>{inline(block.text)}</p>
    case 'code':
      return <CodeBlock key={key} block={block} connFor={connFor} />
    case 'list': {
      const items = block.items.map((item, i) => <li key={i}>{item.map((b, j) => renderBlock(b, j, connFor))}</li>)
      return block.ordered ? (
        <ol key={key} start={block.start === 1 ? undefined : block.start}>
          {items}
        </ol>
      ) : (
        <ul key={key}>{items}</ul>
      )
    }
    case 'table':
      return (
        <div key={key} className="md-table">
          <table>
            <thead>
              <tr>
                {block.header.map((cell, i) => (
                  <th key={i} style={{ textAlign: block.align[i] ?? undefined }}>
                    {inline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, i) => (
                    <td key={i} style={{ textAlign: block.align[i] ?? undefined }}>
                      {inline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'quote':
      return <blockquote key={key}>{block.blocks.map((b, i) => renderBlock(b, i, connFor))}</blockquote>
    case 'rule':
      return <hr key={key} />
  }
}

function inline(text: string): ReactNode[] {
  return parseInline(text).map(renderInline)
}

function renderInline(node: Inline, key: number): ReactNode {
  switch (node.type) {
    case 'text':
      return node.text
    case 'code':
      return <code key={key}>{node.text}</code>
    case 'strong':
      return <strong key={key}>{node.children.map(renderInline)}</strong>
    case 'em':
      return <em key={key}>{node.children.map(renderInline)}</em>
    case 'del':
      return <del key={key}>{node.children.map(renderInline)}</del>
    case 'link':
      // Following a link would navigate the app's own window away.
      return (
        <span key={key} className="md-link" title={node.href}>
          {node.children.map(renderInline)}
        </span>
      )
    case 'break':
      return <br key={key} />
  }
}

function CodeBlock({ block, connFor }: { block: { lang: string; text: string }; connFor?: ConnFor }) {
  const { openSql, toast } = useApp.getState()
  const sql = isSqlBlock(block)

  const copy = async () => {
    try {
      await copyText(block.text)
      toast(sql ? 'SQL copied' : 'Copied')
    } catch (e) {
      toast(toAppError(e).message, 'danger')
    }
  }

  return (
    <div className="md-code">
      <pre>{block.text}</pre>
      <div className="foot">
        <span className="lang">{block.lang || (sql ? 'sql' : '')}</span>
        {sql && (
          <button className="link-btn" onClick={() => openSql(block.text, connFor?.(block.text))} title="Put this SQL in the editor">
            Open in editor
          </button>
        )}
        <button className="link-btn" onClick={() => void copy()}>
          Copy
        </button>
      </div>
    </div>
  )
}
