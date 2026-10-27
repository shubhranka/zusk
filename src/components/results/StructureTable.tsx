import type { ColumnInfo, TableDetails } from '../../lib/types'

function defaultLabel(c: ColumnInfo): string {
  if (c.identity) return `identity (${c.identity})`
  if (c.generated) return `generated: ${c.generated}`
  if (c.defaultValue) return c.defaultValue
  return c.nullable ? 'NULL' : '—'
}

export function StructureTable({ details }: { details: TableDetails }) {
  return (
    <div className="structure-scroll">
      <table className="structure">
        <thead>
          <tr>
            <th>Column</th>
            <th>Type</th>
            <th>Nullable</th>
            <th>Key</th>
            <th>Default</th>
          </tr>
        </thead>
        <tbody>
          {details.columns.map((c) => (
            <tr key={c.name}>
              <td className="s-name">
                {c.name}
                {c.comment && <span className="s-comment">{c.comment}</span>}
              </td>
              <td className="s-type">{c.dataType}</td>
              <td className="s-null">{c.nullable ? 'Yes' : 'No'}</td>
              <td>
                <span className="key-pills">
                  {c.isPrimaryKey && <span className="key-pill pk">PK</span>}
                  {c.isForeignKey && (
                    <span className="key-pill fk" title={c.references ? `References ${c.references}` : undefined}>
                      FK
                    </span>
                  )}
                  {c.isUnique && <span className="key-pill">UNIQUE</span>}
                </span>
              </td>
              <td className="s-default">{defaultLabel(c)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
