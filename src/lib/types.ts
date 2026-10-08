// Mirrors the serde types in src-tauri/src. Keep the two in sync.

export type SslMode = 'disable' | 'prefer' | 'require' | 'verify-ca' | 'verify-full'

export interface ConnectionProfile {
  id: string
  name: string
  host: string
  port: number
  database: string
  user: string
  sslMode: SslMode
}

export interface ConnectionInput extends Omit<ConnectionProfile, 'id'> {
  id?: string
  /** undefined keeps the saved password, '' removes it. */
  password?: string
}

export interface ServerInfo {
  version: string
  encoding: string
  user: string
  database: string
  host: string
  port: number
  ssl: boolean
}

export interface SchemaInfo {
  name: string
  /** Tables and views in the schema. */
  relationCount: number
}

export type RelationKind = 'table' | 'partitionedTable' | 'foreignTable' | 'view' | 'materializedView'

export interface RelationInfo {
  name: string
  kind: RelationKind
  rowEstimate: number | null
  sizeBytes: number | null
}

export interface FunctionInfo {
  oid: number
  name: string
  arguments: string
  result: string | null
  isProcedure: boolean
}

export interface SchemaObjects {
  tables: RelationInfo[]
  views: RelationInfo[]
  functions: FunctionInfo[]
}

export interface ColumnInfo {
  name: string
  dataType: string
  nullable: boolean
  defaultValue: string | null
  identity: 'always' | 'by default' | null
  generated: string | null
  isPrimaryKey: boolean
  isForeignKey: boolean
  isUnique: boolean
  references: string | null
  comment: string | null
}

export interface TableDetails {
  schema: string
  name: string
  kind: RelationKind
  rowEstimate: number | null
  sizeBytes: number | null
  indexCount: number
  comment: string | null
  columns: ColumnInfo[]
}

export interface RelationRef {
  schema: string
  name: string
  kind: RelationKind
}

export type ValueKind = 'num' | 'bool' | 'date' | 'json' | 'text'

export interface ResultColumn {
  name: string
  typeName: string
  kind: ValueKind
}

export type TxState = 'readOnly' | 'idle' | 'inTransaction' | 'failed'

export interface RunResult {
  columns: ResultColumn[]
  rows: (string | null)[][]
  hasResultSet: boolean
  truncated: boolean
  rowCount: number
  command: string
  statementCount: number
  elapsedMs: number
  transaction: TxState
}

export type ErrorKind =
  | 'database'
  | 'connection'
  | 'notConnected'
  | 'readOnly'
  | 'cancelled'
  | 'keychain'
  | 'config'
  | 'invalid'

export interface AppError {
  kind: ErrorKind
  message: string
  detail?: string
  hint?: string
  code?: string
  /** 0-based UTF-16 offset into the SQL that was run. */
  position?: number
  statementRange?: [number, number]
  elapsedMs?: number
  transaction?: TxState
}

export type Loadable<T> =
  | { state: 'loading' }
  | { state: 'ready'; data: T }
  | { state: 'error'; error: string }
