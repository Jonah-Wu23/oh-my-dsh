import assert from 'node:assert/strict'
import test from 'node:test'

import { activeCapabilityIds, countRealUserMessages, derivePhase, hasInitialContextRound, projectSession } from '../preset/events/projections.mjs'

function message(id, source = { kind: 'user' }, text = id) {
  return { id, role: 'user', content: [{ type: 'text', text }], source }
}

test('session projections ignore plugin context when counting user turns', () => {
  const events = [
    { type: 'user/message', data: message('one', { kind: 'user' }, 'implement the fix') },
    { type: 'user/message', data: message('cap', { kind: 'plugin', plugin: 'capability-runtime', form: 'snapshot', sections: [{ name: 'ci.inspect', text: '...' }] }) },
    { type: 'user/message', data: message('two', { kind: 'user' }, 'repair the failed test') },
  ]
  assert.equal(countRealUserMessages(events), 2)
  assert.equal(derivePhase(events), 'repair')
  assert.deepEqual(activeCapabilityIds(events), ['ci.inspect'])
  assert.equal(projectSession(events, ['ci.inspect']).realUserMessages, 2)
})

test('initial context is a durable first round but not a real user message', () => {
  const events = [{
    type: 'user/message',
    data: message('initial', { kind: 'plugin', plugin: 'turn-anchor', form: 'initial-context' }, 'We need to carry out a test in this round.'),
  }]
  assert.equal(countRealUserMessages(events), 0)
  assert.equal(hasInitialContextRound(events), true)
})
