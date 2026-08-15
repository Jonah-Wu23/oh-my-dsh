import assert from 'node:assert/strict'
import test from 'node:test'

import { CapabilityRegistry, formatCapability } from '../preset/capabilities/registry.mjs'
import { apply as applyRuntime } from '../preset/capability-runtime.mjs'

const manifest = {
  id: 'ci.inspect',
  summary: 'Inspect checks.',
  use: 'dshx ci inspect --format json',
  output: 'JSON check facts.',
}

test('capability registry supports registration and independent disposal', () => {
  const registry = new CapabilityRegistry()
  const dispose = registry.register(manifest)
  assert.equal(registry.has('ci.inspect'), true)
  assert.deepEqual(registry.ids(), ['ci.inspect'])
  assert.match(formatCapability(registry.get('ci.inspect')), /dshx ci inspect/)
  dispose()
  assert.equal(registry.has('ci.inspect'), false)
})

test('registry rejects duplicates and unregisters on dispose', () => {
  const registry = new CapabilityRegistry([manifest])
  assert.throws(() => registry.register(manifest), /already registered/)
  registry.dispose()
  assert.deepEqual(registry.list(), [])
  assert.throws(() => registry.register(manifest), /disposed/)
})

test('capability runtime injects a validated snapshot without changing tools', async () => {
  let listener
  const provided = new Map()
  const ctx = {
    provide(key, value) { provided.set(key, value) },
    effect() {},
    get(key) {
      if (key !== 'llm') return undefined
      return {
        stream() {
          return (async function* stream() {
            yield { type: 'text-delta', text: '{"capabilities":["ci.inspect"],"ttl":"turn","reason":"test"}' }
          })()
        },
      }
    },
    on(event, callback) {
      assert.equal(event, 'agent/pre-step')
      listener = callback
    },
  }
  applyRuntime(ctx)
  const user = { id: 'u1', role: 'user', content: [{ type: 'text', text: 'inspect CI' }], source: { kind: 'user' } }
  const decision = await listener({
    agent: {
      session: {
        header: { delegationDepth: 0 },
        events: [{ type: 'user/message', data: { id: 'previous', role: 'user', content: [{ type: 'text', text: 'previous turn' }], source: { kind: 'user' } } }],
      },
    },
    messages: [user],
    signal: new AbortController().signal,
  }, async () => ({ kind: 'enter', messages: [user] }))
  assert.equal(provided.has('ohMyDshCapabilities'), true)
  assert.equal(provided.has('ohMyDshRouter'), true)
  assert.equal(decision.messages[0].source.plugin, 'capability-runtime')
  assert.match(decision.messages[0].content[0].text, /ci\.inspect/)
  assert.equal(decision.messages[1], user)
})

test('capability runtime keeps the first user turn at the fixed surface', async () => {
  let listener
  let routeCalls = 0
  const ctx = {
    provide() {},
    effect() {},
    get(key) {
      if (key !== 'llm') return undefined
      return {
        stream() {
          routeCalls += 1
          return (async function* stream() {
            yield { type: 'text-delta', text: '{"capabilities":["ci.inspect"],"ttl":"turn","reason":"test"}' }
          })()
        },
      }
    },
    on(event, callback) {
      assert.equal(event, 'agent/pre-step')
      listener = callback
    },
  }
  applyRuntime(ctx)
  const user = { id: 'u1', role: 'user', content: [{ type: 'text', text: 'inspect CI' }], source: { kind: 'user' } }
  const decision = await listener({
    agent: { session: { header: { delegationDepth: 0 }, events: [] } },
    messages: [user],
    signal: new AbortController().signal,
  }, async () => ({ kind: 'enter', messages: [user] }))
  assert.deepEqual(decision.messages, [user])
  assert.equal(routeCalls, 0)
})
