// The agent's conversation as the chat panel shows it: each question, the
// steps taken for it, and the answer.

import type { AgentMessage, AgentToolCall, AgentToolResult, AiStatus, ConnectionProfile } from './types'

export interface AgentActivity {
  call: AgentToolCall
  result?: AgentToolResult
  /** What the model said alongside this call, if it said anything. */
  note?: string
}

export interface AgentTurn {
  /** Where the question is in the messages; stable, so it works as a key. */
  index: number
  question: string
  steps: AgentActivity[]
  /** The text of the last reply without tool calls. */
  answer?: string
}

export function agentTurns(messages: AgentMessage[]): AgentTurn[] {
  const turns: AgentTurn[] = []
  messages.forEach((m, index) => {
    if (m.role === 'user') {
      turns.push({ index, question: m.text, steps: [] })
      return
    }
    const turn = turns.at(-1)
    if (!turn || m.role !== 'assistant') return
    if (m.toolCalls.length === 0) {
      if (m.text.trim()) turn.answer = m.text
      return
    }
    // Results come in the message right after their calls.
    const next = messages[index + 1]
    const results = next?.role === 'tool' ? next.results : []
    const note = m.text.trim() || undefined
    m.toolCalls.forEach((call, i) => {
      turn.steps.push({ call, result: results.find((r) => r.callId === call.id), note: i === 0 ? note : undefined })
    })
  })
  return turns
}

/** The conversation as the backend reads it: without the result previews. */
export function forModel(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((m) => (m.role === 'tool' ? { ...m, results: m.results.map(({ preview: _, ...r }) => r) } : m))
}

/** A string argument of a tool call, if the model passed one. */
export function arg(call: AgentToolCall, name: string): string | undefined {
  const args = call.args
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined
  const value = (args as Record<string, unknown>)[name]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** The saved connection a tool call named, the same way the backend finds it. */
export function namedConnection(call: AgentToolCall, profiles: ConnectionProfile[]): ConnectionProfile | undefined {
  const name = arg(call, 'connection')
  if (!name) return undefined
  const lower = name.toLowerCase()
  return (
    profiles.find((p) => p.id === name) ??
    profiles.find((p) => p.name.toLowerCase() === lower) ??
    profiles.find((p) => p.database.toLowerCase() === lower)
  )
}

/**
 * What a step did, in a few words: "Described public.orders on Shop".
 * `ranOn` is the connection a query ran on, which names the one the model left out.
 */
export function activityLabel(call: AgentToolCall, profiles: ConnectionProfile[], ranOn?: string): string {
  const named = arg(call, 'connection')
  const conn = profiles.find((p) => p.id === ranOn)?.name ?? (named ? (namedConnection(call, profiles)?.name ?? named) : undefined)
  const on = conn ? ` on ${conn}` : ''
  switch (call.name) {
    case 'list_connections':
      return 'Listed the saved connections'
    case 'list_schemas':
      return `Listed schemas${on}`
    case 'list_tables':
      return `Listed ${arg(call, 'schema') ?? 'a schema'}${on}`
    case 'describe_table': {
      const schema = arg(call, 'schema')
      const table = arg(call, 'table') ?? 'a table'
      return `Described ${schema ? `${schema}.${table}` : table}${on}`
    }
    case 'search_names': {
      const text = arg(call, 'text')
      return `Searched for “${text ?? ''}”${conn ? ` in ${conn}` : ''}`
    }
    case 'run_query':
      return `Ran a query${on}`
    default:
      return call.name
  }
}

const normalSql = (sql: string) => sql.replace(/;\s*$/, '').replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * Where SQL from a turn's answer should open: the connection of the step
 * that ran that same query, or the only connection the turn queried.
 * Undefined means the selected connection.
 */
export function queryConnection(turn: AgentTurn, sql: string, profiles: ConnectionProfile[]): string | undefined {
  const wanted = normalSql(sql)
  const queried = new Set<string>()
  for (const step of [...turn.steps].reverse()) {
    if (step.call.name !== 'run_query') continue
    const connId = step.result?.preview?.connId ?? namedConnection(step.call, profiles)?.id
    const ran = arg(step.call, 'sql')
    if (ran && normalSql(ran) === wanted) return connId
    if (connId) queried.add(connId)
  }
  return queried.size === 1 ? [...queried][0] : undefined
}

/** "Anthropic", "Gemini", or the host of an OpenAI-compatible server. */
export function providerName(ai: AiStatus): string {
  if (ai.provider === 'anthropic') return 'Anthropic'
  if (ai.provider === 'gemini') return 'Gemini'
  try {
    return new URL(ai.baseUrl).host || 'your AI provider'
  } catch {
    return 'your AI provider'
  }
}
