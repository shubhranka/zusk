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
  | 'ai'
  | 'template'

export interface AppError {
  kind: ErrorKind
  message: string
  detail?: string
  hint?: string
  code?: string
  /** 0-based UTF-16 offset into the SQL that was run. */
  position?: number
  /** The statement that failed, or for a template error, the failing tag. */
  statementRange?: [number, number]
  elapsedMs?: number
  transaction?: TxState
}

export type Loadable<T> =
  | { state: 'loading' }
  | { state: 'ready'; data: T }
  | { state: 'error'; error: string }

/** Which wire format to speak. 'openai' covers any OpenAI-compatible server (OpenRouter, Ollama, …). */
export type AiProvider = 'openai' | 'anthropic' | 'gemini'

export interface AiStatus {
  provider: AiProvider
  baseUrl: string
  model: string
  hasKey: boolean
}

export interface AiInput {
  provider: AiProvider
  baseUrl: string
  model: string
  /** undefined keeps the saved key, '' removes it. */
  apiKey?: string
}

export interface FixInput {
  /** Just the failing statement. */
  sql: string
  message: string
  detail?: string
  hint?: string
  code?: string
  /** 1-based line and column of the error within `sql`. */
  line?: number
  col?: number
}

export interface FixResult {
  sql: string
  explanation: string
}
