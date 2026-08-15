import assert from 'node:assert/strict'
import test from 'node:test'

import { RouterController } from '../preset/router/controller.mjs'
import { createRouterSnapshot } from '../preset/router/snapshot.mjs'
import { parseRouterText } from '../preset/router/schema.mjs'

const snapshot = createRouterSnapshot({
  latestUserInput: 'inspect the CI failure',
  currentPhase: 'repair',
  availableCapabilityIds: ['ci.inspect', 'git.review'],
})

test('router accepts only registry capability ids and caches identical snapshots', async () => {
  let calls = 0
  const router = new RouterController({
    availableCapabilities: ['ci.inspect', 'git.review'],
    call: async () => {
      calls += 1
      return { capabilities: ['ci.inspect', 'unknown.capability'], ttl: 'turn', reason: 'repair signal' }
    },
  })
  const first = await router.route(snapshot)
  const second = await router.route(snapshot)
  assert.deepEqual(first.capabilities, ['ci.inspect'])
  assert.equal(first.fromCache, false)
  assert.equal(second.fromCache, true)
  assert.equal(calls, 1)
})

test('router failure reuses the last validated choice without opening tools', async () => {
  let fail = false
  const router = new RouterController({
    availableCapabilities: ['git.review'],
    call: async () => {
      if (fail) throw new Error('router offline')
      return { capabilities: ['git.review'], reason: 'repository review' }
    },
  })
  const first = await router.route(snapshot)
  fail = true
  const fallback = await router.route({ ...snapshot, latest_user_input: 'another request' })
  assert.deepEqual(first.capabilities, ['git.review'])
  assert.deepEqual(fallback.capabilities, ['git.review'])
  assert.equal(fallback.fallback, true)
})

test('malformed router output is rejected', () => {
  assert.throws(() => parseRouterText('{"capabilities":"ci.inspect"}', ['ci.inspect']), /array/)
  assert.throws(() => parseRouterText('', ['ci.inspect']), /empty/)
  assert.throws(() => parseRouterText('{"capabilities":[],"ttl":"session"}', []), /ttl/)
})
