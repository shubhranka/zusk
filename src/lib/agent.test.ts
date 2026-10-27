import { describe, expect, it } from 'vitest'

import { activityLabel, agentTurns, forModel, providerName, queryConnection } from './agent'
import type { AgentMessage, AgentToolResult, ConnectionProfile, RunResult } from './types'

const profiles: ConnectionProfile[] = [
  { id: 'p1', name: 'Shop', host: 'localhost', port: 5432, database: 'shop_dev', user: 'u', sslMode: 'prefer' },
  { id: 'p2', name: 'Warehouse', host: 'localhost', port: 5432, database: 'warehouse', user: 'u', sslMode: 'prefer' },
]

const result = (callId: string, extra: Partial<AgentToolResult> = {}): AgentToolResult => ({
  callId,
  name: 'run_query',
  content: 'rows',
  isError: false,
  summary: '1 row',
  ...extra,
})

const preview = (connId: string) => ({ connId, result: { rows: [] } as unknown as RunResult })

const messages: AgentMessage[] = [
  { role: 'user', text: 'How many orders?' },
  {
    role: 'assistant',
    text: 'Looking for the table.',
    toolCalls: [
      { id: 'a', name: 'search_names', args: { text: 'order' } },
      { id: 'b', name: 'describe_table', args: { schema: 'public', table: 'orders', connection: 'p1' } },
    ],
  },
  { role: 'tool', results: [result('a', { name: 'search_names' }), result('b', { name: 'describe_table' })] },
  { role: 'assistant', text: '', toolCalls: [{ id: 'c', name: 'run_query', args: { sql: 'select count(*) from orders', connection: 'warehouse' } }] },
  { role: 'tool', results: [result('c', { preview: preview('p2') })] },
  { role: 'assistant', text: 'There are **42** orders.', toolCalls: [] },
  { role: 'user', text: 'And customers?' },
]

describe('agentTurns', () => {
  it('groups each question with its steps and answer', () => {
    const turns = agentTurns(messages)
    expect(turns).toHaveLength(2)
    expect(turns[0].index).toBe(0)
    expect(turns[0].steps.map((s) => [s.call.id, s.result?.callId, s.note])).toEqual([
      ['a', 'a', 'Looking for the table.'],
      ['b', 'b', undefined],
      ['c', 'c', undefined],
    ])
    expect(turns[0].answer).toBe('There are **42** orders.')
    expect(turns[1]).toEqual({ index: 6, question: 'And customers?', steps: [] })
  })
})

describe('queryConnection', () => {
  it('opens SQL from an answer where that query ran', () => {
    const turn = agentTurns([
      { role: 'user', text: 'compare' },
      {
        role: 'assistant',
        text: '',
        toolCalls: [
          { id: 'a', name: 'run_query', args: { sql: 'select count(*)\nfrom orders' } },
          { id: 'b', name: 'run_query', args: { sql: 'select 2', connection: 'Warehouse' } },
        ],
      },
      { role: 'tool', results: [result('a', { preview: preview('p1') }), result('b', { isError: true })] },
    ])[0]
    expect(queryConnection(turn, 'SELECT count(*) FROM orders;', profiles)).toBe('p1')
    expect(queryConnection(turn, 'select 2', profiles)).toBe('p2')
    // A query it never ran opens on the selected connection, since two were queried.
    expect(queryConnection(turn, 'select 3', profiles)).toBeUndefined()
    // With only one connection queried, everything opens there.
    const one = { ...turn, steps: turn.steps.slice(0, 1) }
    expect(queryConnection(one, 'select 3', profiles)).toBe('p1')
  })
})

describe('forModel', () => {
  it('drops previews and leaves everything else', () => {
    const sent = forModel(messages)
    const tool = sent[4]
    expect(tool.role === 'tool' && tool.results[0]).toEqual(result('c'))
    expect(sent[1]).toBe(messages[1])
    expect(messages[4].role === 'tool' && messages[4].results[0].preview).toBeTruthy()
  })
})

describe('activityLabel', () => {
  it('says what each tool did, with the connection by name', () => {
    const label = (name: string, args: unknown) => activityLabel({ id: 'x', name, args }, profiles)
    expect(label('describe_table', { schema: 'public', table: 'orders', connection: 'p1' })).toBe('Described public.orders on Shop')
    expect(label('run_query', { sql: 'select 1', connection: 'WAREHOUSE' })).toBe('Ran a query on Warehouse')
    expect(label('run_query', { sql: 'select 1', connection: 'other' })).toBe('Ran a query on other')
    expect(label('run_query', { sql: 'select 1' })).toBe('Ran a query')
    expect(activityLabel({ id: 'x', name: 'run_query', args: { sql: 'select 1' } }, profiles, 'p1')).toBe('Ran a query on Shop')
    expect(label('search_names', { text: 'email' })).toBe('Searched for “email”')
    expect(label('list_tables', '{broken')).toBe('Listed a schema')
    expect(label('mystery', {})).toBe('mystery')
  })
})

describe('providerName', () => {
  it('names the provider, or the host of an OpenAI-compatible one', () => {
    expect(providerName({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'm', hasKey: true })).toBe('Anthropic')
    expect(providerName({ provider: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'm', hasKey: false })).toBe('localhost:11434')
  })
})
