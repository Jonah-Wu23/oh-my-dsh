import assert from 'node:assert/strict'
import test from 'node:test'

import { ANCHOR_TEXT, INITIAL_CONTEXT_TEXT, apply, insertAnchors, name } from '../preset/anchor/turn-anchor.mjs'

function user(id, text = id) {
  return { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

function plugin(id) {
  return { id, role: 'user', content: [{ type: 'text', text: 'capability' }], source: { kind: 'plugin', plugin: 'capability-runtime', form: 'notice', summary: 'capability' } }
}

function register() {
  let listener
  apply({ on(event, callback) { if (event === 'agent/pre-step') listener = callback } })
  return listener
}

function agent(events = [], depth = 0) {
  return { session: { events, header: { delegationDepth: depth } } }
}

test('first real user message has no anchor', async () => {
  const listener = register()
  const first = user('u1')
  const decision = await listener({ agent: agent(), messages: [first] }, async () => ({ kind: 'enter', messages: [first] }))
  assert.deepEqual(decision.messages, [first])
})

test('second real user message gets exactly one anchor before it', async () => {
  const listener = register()
  const first = user('u1')
  const second = user('u2')
  const decision = await listener({ agent: agent([{ type: 'user/message', data: first }]), messages: [second] }, async () => ({ kind: 'enter', messages: [second] }))
  assert.equal(decision.messages.length, 2)
  assert.equal(decision.messages[0].source.plugin, name)
  assert.equal(decision.messages[0].content[0].text, ANCHOR_TEXT)
  assert.equal(decision.messages[1], second)
})

test('the first user input after the initial context is the second round', async () => {
  const initialContext = {
    type: 'user/message',
    data: {
      id: 'initial-context',
      role: 'user',
      content: [{ type: 'text', text: INITIAL_CONTEXT_TEXT }],
      source: { kind: 'plugin', plugin: name, form: 'initial-context' },
    },
  }
  const listener = register()
  const firstUserInput = user('u1')
  const decision = await listener({ agent: agent([initialContext]), messages: [firstUserInput] }, async () => ({ kind: 'enter', messages: [firstUserInput] }))
  assert.equal(decision.messages.length, 2)
  assert.equal(decision.messages[0].content[0].text, ANCHOR_TEXT)
  assert.equal(decision.messages[1], firstUserInput)
})

test('new sessions enqueue the fixed initial context before user input', () => {
  let start
  apply({ on(event, callback) { if (event === 'agent/session-start') start = callback } })
  const queued = []
  start({ agent: { followup(message) { queued.push(message) } }, source: 'startup' })
  assert.equal(queued.length, 1)
  assert.equal(queued[0].content[0].text, INITIAL_CONTEXT_TEXT)
  assert.equal(queued[0].source.form, 'initial-context')
})

test('the fixed prompts identify context-only work and keep the We need prefix', () => {
  const initialSentences = INITIAL_CONTEXT_TEXT.split(/(?<=\.)\s+/).filter(Boolean)
  const anchorSentences = ANCHOR_TEXT.split(/(?<=\.)\s+/).filter(Boolean)
  assert.ok(initialSentences.every((sentence) => sentence.startsWith('We need ')))
  assert.ok(anchorSentences.every((sentence) => sentence.startsWith('We need ')))
  assert.match(INITIAL_CONTEXT_TEXT, /not as a user task/)
  assert.match(INITIAL_CONTEXT_TEXT, /avoid calling Bash/)
  assert.match(ANCHOR_TEXT, /keep the reasoning internal/)
  assert.match(ANCHOR_TEXT, /We need to speak Chinese to users\.$/)
})

test('queued messages and capability context keep capability, anchor, user order', () => {
  const first = user('u1')
  const second = user('u2')
  const result = insertAnchors({
    agent: agent([{ type: 'user/message', data: first }]),
    claimedMessages: [second],
    assembledMessages: [plugin('cap'), second],
  })
  assert.equal(result.length, 3)
  assert.equal(result[0].id, 'cap')
  assert.equal(result[1].source.plugin, name)
  assert.equal(result[2].id, 'u2')
})

test('plugin messages and subagents are never anchored', () => {
  const pluginMessage = plugin('p1')
  const fromPlugin = insertAnchors({
    agent: agent([{ type: 'user/message', data: user('u1') }]),
    claimedMessages: [pluginMessage],
    assembledMessages: [pluginMessage],
  })
  assert.deepEqual(fromPlugin, [pluginMessage])

  const second = user('u2')
  const subagent = insertAnchors({
    agent: agent([{ type: 'user/message', data: user('u1') }], 1),
    claimedMessages: [second],
    assembledMessages: [second],
  })
  assert.deepEqual(subagent, [second])
})
