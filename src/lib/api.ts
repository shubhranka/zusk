// Typed wrappers around the Rust commands in src-tauri/src/commands.rs.
// The UI never talks to Postgres directly; everything goes through here.

import { invoke } from '@tauri-apps/api/core'
import type {
  AppError,
  ConnectionInput,
  ConnectionProfile,
  RelationRef,
  RunResult,
  SchemaInfo,
  SchemaObjects,
  ServerInfo,
  TableDetails,
} from './types'

export function toAppError(e: unknown): AppError {
  if (e && typeof e === 'object' && 'kind' in e && 'message' in e) return e as AppError
  return { kind: 'invalid', message: e instanceof Error ? e.message : String(e) }
}

const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  // In a plain browser during development, talk to the Rust dev bridge
  // (src-tauri/examples/dev_bridge.rs). Production builds drop this branch.
  if (import.meta.env.DEV && !inTauri) return viaDevBridge<T>(command, args)
  try {
    return await invoke<T>(command, args)
  } catch (e) {
    throw toAppError(e)
  }
}

async function viaDevBridge<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  let response: Response
  try {
    response = await fetch(`http://127.0.0.1:1421/invoke/${command}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args ?? {}),
    })
  } catch {
    throw toAppError('Dev bridge is not running. Start it with: npm run dev:bridge')
  }
  const body = await response.json().catch(() => null)
  if (!response.ok) throw toAppError(body ?? `Dev bridge error ${response.status}`)
  return body as T
}

export const api = {
  listConnections: () => call<ConnectionProfile[]>('list_connections'),
  saveConnection: (input: ConnectionInput) => call<ConnectionProfile>('save_connection', { input }),
  deleteConnection: (id: string) => call<void>('delete_connection', { id }),
  testConnection: (input: ConnectionInput) => call<ServerInfo>('test_connection', { input }),
  connect: (id: string) => call<ServerInfo>('connect', { id }),
  disconnect: (id: string) => call<void>('disconnect', { id }),

  listSchemas: (id: string) => call<SchemaInfo[]>('list_schemas', { id }),
  listSchemaObjects: (id: string, schema: string) => call<SchemaObjects>('list_schema_objects', { id, schema }),
  describeTable: (id: string, schema: string, name: string) => call<TableDetails>('describe_table', { id, schema, name }),
  listRelations: (id: string) => call<RelationRef[]>('list_relations', { id }),
  functionDefinition: (id: string, oid: number) => call<string>('function_definition', { id, oid }),

  runQuery: (id: string, sql: string) => call<RunResult>('run_query', { id, sql }),
  cancelQuery: (id: string) => call<void>('cancel_query', { id }),
  getReadOnly: () => call<boolean>('get_read_only'),
  setReadOnly: (value: boolean) => call<boolean>('set_read_only', { value }),
}
