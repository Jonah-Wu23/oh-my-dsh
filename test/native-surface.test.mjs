import assert from 'node:assert/strict'
import test from 'node:test'

import { apply as applyMinimal } from '../preset/minimal-surface.mjs'
import { apply as applyRuntime } from '../preset/capability-runtime.mjs'
import {
  DEFAULT_NATIVE_BUNDLES,
  installNativeExecutionGuard,
  NativeToolSurface,
} from '../preset/capabilities/surface.mjs'

const bundles = [
  {
    id: 'native.ui',
    tools: [{ name: 'ask_user', description: 'Ask the user a question.', parameters: { type: 'object' } }],
  },
  {
    id: 'native.browser',
    tools: ['browser_open'],
  },
]

function agent() {
  return {
    session: {
      header: { delegationDepth: 0 },
      events: [
        { type: 'user/message', data: { id: 'initial-context', role: 'user', content: [{ type: 'text', text: 'initial context' }], source: { kind: 'plugin', plugin: 'turn-anchor', form: 'initial-context' } } },
        { type: 'turn/start', data: { turn: 1 } },
      ],
    },
  }
}

test('native outlet is disabled by default', () => {
  const surface = new NativeToolSurface({ bundles })
  const current = agent()
  surface.select(current, 1, ['native.ui'])
  assert.deepEqual(surface.bundleIds(), [])
  assert.deepEqual(surface.visibleToolNames(current, 1), ['bash', 'str_replace_editor', 'web_search'])
  assert.equal(DEFAULT_NATIVE_BUNDLES.length, 0)
})

test('native bundle selection is allowlisted and monotonic within one turn', () => {
  const surface = new NativeToolSurface({ enabled: true, bundles })
  const current = agent()

  assert.deepEqual(surface.select(current, 1, ['native.ui', 'unknown.bundle']), ['native.ui'])
  assert.deepEqual(surface.select(current, 1, ['native.browser']), ['native.ui', 'native.browser'])
  assert.deepEqual(surface.select(current, 1, []), ['native.ui', 'native.browser'])
  assert.deepEqual(surface.visibleToolNames(current, 1), [
    'bash',
    'str_replace_editor',
    'web_search',
    'ask_user',
    'browser_open',
  ])

  current.session.events.push({ type: 'turn/start', data: { turn: 2 } })
  assert.deepEqual(surface.visibleToolNames(current, 2), ['bash', 'str_replace_editor', 'web_search'])
})

test('assembly contains only the selected native schemas, never the host catalog', async () => {
  const surface = new NativeToolSurface({ enabled: true, bundles })
  const current = agent()
  surface.select(current, 1, ['native.ui'])
  let listener

  applyMinimal({
    get(key) {
      return key === 'ohMyDshNativeSurface' ? surface : undefined
    },
    on(event, callback) {
      assert.equal(event, 'system-prompt/assemble')
      listener = callback
    },
    logger: { warn() {} },
  })

  const assembled = await listener(undefined, { agent: current }, async () => ({
    tools: [
      { name: 'standard-only' },
      { name: 'browser_open' },
      { name: 'ask_user' },
      { name: 'web_search' },
      { name: 'bash' },
      { name: 'str_replace_editor' },
      { name: 'another-standard-tool' },
    ],
  }))

  assert.deepEqual(assembled.tools.map((tool) => tool.name), [
    'bash',
    'str_replace_editor',
    'web_search',
    'ask_user',
  ])
})

test('execution guard rejects hidden native calls and allows the current surface', () => {
  const surface = new NativeToolSurface({ enabled: true, bundles })
  const current = agent()
  surface.select(current, 1, ['native.ui'])
  let guard
  const dispose = installNativeExecutionGuard({
    get(key) {
      if (key !== 'tools') return undefined
      return { guard(callback) { guard = callback; return () => {} } }
    },
  }, surface)

  assert.equal(typeof dispose, 'function')
  assert.equal(guard({ agent: current, name: 'bash' }), undefined)
  assert.equal(guard({ agent: current, name: 'ask_user' }), undefined)
  assert.match(guard({ agent: current, name: 'standard-only' }), /not visible/)
  current.session.events.push({ type: 'turn/start', data: { turn: 2 } })
  assert.match(guard({ agent: current, name: 'ask_user' }), /not visible/)
})

test('capability runtime routes a configured native bundle into the current turn', async () => {
  const listeners = new Map()
  const provided = new Map()
  let routerCalls = 0
  let routerInput = ''
  const ctx = {
    provide(key, value) { provided.set(key, value) },
    effect() {},
    get(key) {
      if (key === 'systemPrompt') return {}
      if (key !== 'llm') return undefined
      return {
        stream(options) {
          routerCalls += 1
          routerInput = options.messages[0].content[0].text
          return (async function* stream() {
            yield { type: 'text-delta', text: '{"capabilities":["native.ui"],"ttl":"turn","reason":"needs UI"}' }
          })()
        },
      }
    },
    on(event, callback) {
      listeners.set(event, callback)
      return () => {}
    },
  }

  applyRuntime(ctx, {
    nativeTools: { enabled: true, bundles },
  })

  const current = agent()
  const user = { id: 'u-native', role: 'user', content: [{ type: 'text', text: 'ask me one question' }], source: { kind: 'user' } }
  listeners.get('agent/inbox/claimed')({ agent: current, message: user, turn: 1 })
  await listeners.get('system-prompt/assemble')(
    undefined,
    { agent: current, signal: new AbortController().signal },
    async () => ({ tools: [] }),
  )

  const surface = provided.get('ohMyDshNativeSurface')
  assert.deepEqual(surface.selectedBundleIds(current, 1), ['native.ui'])
  assert.match(routerInput, /native\.ui/)

  await listeners.get('agent/pre-step')(
    { agent: current, messages: [user], turn: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [user] }),
  )
  assert.equal(routerCalls, 1)
})
