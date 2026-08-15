import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_TOOLS, apply, name } from '../preset/minimal-surface.mjs'

function register(config) {
  let listener
  const warns = []
  apply({
    on(event, callback) {
      assert.equal(event, 'system-prompt/assemble')
      listener = callback
    },
    logger: { warn(message) { warns.push(message) } },
  }, config)
  return { listener, warns }
}

test('fixed surface keeps the Minimal tool order and hides extras', async () => {
  const { listener } = register()
  const tools = [{ name: 'web_search' }, { name: 'bash' }, { name: 'standard-only' }, { name: 'str_replace_editor' }]
  const result = await listener(undefined, {}, async () => ({ system: 'minimal', tools }))
  assert.deepEqual(result.tools.map((tool) => tool.name), DEFAULT_TOOLS)
})

test('fixed surface never falls back to a full catalog when a tool is missing', async () => {
  const { listener, warns } = register({ tools: ['bash', 'str_replace_editor', 'web_search'] })
  const tools = [{ name: 'bash' }, { name: 'standard-only' }]
  const result = await listener(undefined, {}, async () => ({ tools }))
  assert.deepEqual(result.tools.map((tool) => tool.name), ['bash'])
  assert.equal(warns.length, 1)
})

test('plugin exposes a diagnostic name', () => {
  assert.equal(name, 'minimal-surface')
})
