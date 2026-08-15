import assert from 'node:assert/strict'
import test from 'node:test'

import { Session } from '../desktop/runtime/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import { apply, isPromoted, name } from '../preset/zero-tool-bootstrap.mjs'

function register() {
  let listener
  apply({
    on(event, callback) {
      assert.equal(event, 'system-prompt/assemble')
      listener = callback
    },
  })
  return listener
}

function createSession(id, delegationDepth = 0) {
  return Session.create(id, [], {
    version: 0,
    id,
    createdAt: Date.now(),
    cwd: process.cwd(),
    delegationDepth,
  })
}

function appendInitialContext(session) {
  session.append('user/message', {
    id: 'initial-context',
    role: 'user',
    content: [{ type: 'text', text: 'We need to treat this message only as the first-round context anchor.' }],
    source: { kind: 'plugin', plugin: 'turn-anchor', form: 'initial-context' },
  }, { surfaceOp: 'append' })
}

function appendAssistant(session) {
  session.append('assistant/message', {
    turn: 1,
    step: 0,
    message: {
      id: 'assistant-1',
      role: 'assistant',
      content: [{ type: 'text', text: 'We need to wait for the next round.' }],
      source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    },
  }, { surfaceOp: 'append', sourceEventSeqs: [] })
}

function assemble(listener, session, tools) {
  return listener(
    undefined,
    { agent: { session } },
    async () => ({ system: 'minimal persona', tools }),
  )
}

test('the active bootstrap exposes zero tools on the first top-level request', async () => {
  const listener = register()
  const tools = [{ name: 'bash' }, { name: 'str_replace_editor' }, { name: 'web_search' }]
  const session = createSession('active-bootstrap-first')
  appendInitialContext(session)
  const result = await assemble(listener, session, tools)
  assert.deepEqual(result.tools, [])
})

test('a durable assistant message enables the fixed Minimal tools', async () => {
  const listener = register()
  const tools = [{ name: 'bash' }, { name: 'str_replace_editor' }, { name: 'web_search' }]
  const session = createSession('active-bootstrap-promoted')
  appendInitialContext(session)
  appendAssistant(session)
  const result = await assemble(listener, session, tools)
  assert.deepEqual(result.tools, tools)
})

test('subagents keep tools on their first request', async () => {
  const listener = register()
  const tools = [{ name: 'bash' }, { name: 'str_replace_editor' }, { name: 'web_search' }]
  const session = createSession('active-bootstrap-subagent', 1)
  const result = await assemble(listener, session, tools)
  assert.deepEqual(result.tools, tools)
})

test('promotion is derived from the current durable event log after restart', async () => {
  const tools = [{ name: 'bash' }, { name: 'str_replace_editor' }, { name: 'web_search' }]
  const promotedSession = createSession('active-bootstrap-restored')
  appendAssistant(promotedSession)
  const freshSession = createSession('active-bootstrap-fresh')
  assert.equal(isPromoted({ session: promotedSession }), true)
  assert.equal(isPromoted({ session: freshSession }), false)

  const listener = register()
  const restored = Session.fromRestore(
    promotedSession.id,
    JSON.parse(JSON.stringify(promotedSession.events)),
    JSON.parse(JSON.stringify(promotedSession.header)),
  )
  const promoted = await assemble(listener, restored, tools)
  const fresh = await assemble(listener, freshSession, tools)
  assert.deepEqual(promoted.tools, tools)
  assert.deepEqual(fresh.tools, [])
})

test('exports the active bootstrap plugin name', () => {
  assert.equal(name, 'zero-tool-bootstrap')
})
