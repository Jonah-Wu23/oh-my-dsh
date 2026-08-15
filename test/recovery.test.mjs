import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Session, interruptedTurnClosers } from '../desktop/runtime/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import { RouterController } from '../preset/router/controller.mjs'
import {
  compactSession,
  compactSessionFacts,
  formatRecoveryFacts,
  restoreSessionState,
} from '../preset/events/recovery.mjs'

function createSession(id = `recovery-${crypto.randomUUID()}`) {
  return Session.create(id, [], {
    version: 0,
    id,
    createdAt: Date.now(),
    cwd: process.cwd(),
    delegationDepth: 0,
  })
}

function appendUser(session, id, text, source = { kind: 'user' }) {
  return session.append('user/message', {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source,
  }, { surfaceOp: 'append' })
}

function sessionHeaderLine(header) {
  return {
    type: 'session',
    version: header.version,
    id: header.id,
    createdAt: header.createdAt,
    cwd: header.cwd,
    delegationDepth: header.delegationDepth,
  }
}

test('bounded facts restore anchors, router capabilities, and the task ledger from a real Session log', async () => {
  const session = createSession('recovery-facts')
  appendUser(session, 'initial', 'We need to carry out a test in this round.', {
    kind: 'plugin',
    plugin: 'turn-anchor',
    form: 'initial-context',
  })
  for (let index = 0; index < 9; index += 1) {
    appendUser(session, `user-${index}`, `Implement and verify the recovery path. Requirement ${index}. ${'x'.repeat(180)}`)
  }
  appendUser(session, 'capability', 'capability snapshot', {
    kind: 'plugin',
    plugin: 'capability-runtime',
    form: 'snapshot',
    sections: [{ name: 'ci.inspect', text: 'Inspect checks.' }, { name: 'git.review', text: 'Inspect diff.' }],
  })
  session.append('todo/write', {
    todos: [
      { content: 'Run the recovery integration test', status: 'in_progress' },
      { content: 'Resume after restart', status: 'pending' },
    ],
  })

  const facts = compactSessionFacts(session.events, {
    maxRequirements: 3,
    maxChangedFiles: 2,
    maxTestConclusions: 2,
    maxLedgerItems: 2,
  })
  assert.equal(facts.anchor.initialContext, true)
  assert.equal(facts.anchor.realUserMessages, 9)
  assert.deepEqual(facts.route.activeCapabilities, ['ci.inspect', 'git.review'])
  assert.equal(facts.taskLedger.todos[0].status, 'in_progress')
  assert.equal(facts.requirements.length, 3)

  const result = compactSession(session, {
    maxSurfaceNodes: 6,
    retainSurfaceNodes: 2,
    maxSurfaceChars: 1,
    maxFactChars: 6000,
  })
  assert.ok(result)
  assert.equal(session.surface.nodes.length, 3)
  assert.equal(session.events.at(-1).type, 'compaction/end')
  assert.match(result.summaryText, /^\[oh-my-dsh recovery facts\]/)
  assert.doesNotMatch(result.summaryText, /Treat the captured context|Continue the task directly/)

  const logDir = await mkdtemp(join(tmpdir(), 'oh-my-dsh-recovery-'))
  const logPath = join(logDir, 'session.jsonl')
  const lines = [sessionHeaderLine(session.header), ...session.events]
  await writeFile(logPath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8')
  const restoredLines = (await readFile(logPath, 'utf8')).trimEnd().split(/\r?\n/).map((line) => JSON.parse(line))
  const restored = Session.fromRestore(
    restoredLines[0].id,
    restoredLines.slice(1),
    {
      version: restoredLines[0].version,
      id: restoredLines[0].id,
      createdAt: restoredLines[0].createdAt,
      cwd: restoredLines[0].cwd,
      delegationDepth: restoredLines[0].delegationDepth,
    },
  )
  const recovered = restoreSessionState(restored.events, ['ci.inspect', 'git.review'])
  assert.equal(recovered.anchor.realUserMessages, 9)
  assert.equal(recovered.anchor.initialContext, true)
  assert.deepEqual(recovered.route.activeCapabilities, ['ci.inspect', 'git.review'])
  assert.equal(recovered.taskLedger.todos[1].content, 'Resume after restart')
  assert.equal(restored.deriveMessages().length, 3)
  await rm(logDir, { recursive: true, force: true })
})

test('router fallback uses the restored event-log selection after a process restart', async () => {
  const session = createSession('router-restart')
  appendUser(session, 'user-1', 'Inspect the failed checks.')
  appendUser(session, 'capability', 'capability snapshot', {
    kind: 'plugin',
    plugin: 'capability-runtime',
    form: 'snapshot',
    sections: [{ name: 'ci.inspect', text: 'Inspect checks.' }],
  })
  const state = restoreSessionState(session.events, ['ci.inspect'])
  const router = new RouterController({
    availableCapabilities: ['ci.inspect'],
    call: async () => { throw new Error('router process unavailable') },
  })
  router.restore({ capabilities: state.route.activeCapabilities, ttl: 'turn', reason: 'restored' })
  const result = await router.route({ latest_user_input: 'continue', available_capability_ids: ['ci.inspect'] })
  assert.equal(result.fallback, true)
  assert.deepEqual(result.capabilities, ['ci.inspect'])
})

test('a real interrupted Session log is closed, persisted, and reopened for continuation', () => {
  const session = createSession('interrupted-restart')
  appendUser(session, 'user-1', 'Run the test and continue after interruption.')
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 0 })
  session.append('assistant/message', {
    turn: 1,
    step: 0,
    message: {
      id: 'assistant-1',
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{}' }],
      source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    },
  }, { surfaceOp: 'append', sourceEventSeqs: [] })
  session.append('tool/call', { turn: 1, step: 0, callId: 'call-1', name: 'bash', arguments: '{}' })

  const closers = interruptedTurnClosers(session.events)
  assert.equal(closers.at(-1).type, 'turn/end')
  for (const event of closers) {
    const surface = event.surfaceOp === undefined
      ? undefined
      : { surfaceOp: event.surfaceOp, ...(event.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: event.sourceEventSeqs }) }
    session.append(event.type, event.data, surface)
  }
  assert.equal(session.events.at(-1).data.reason.kind, 'interrupted')

  const restored = Session.fromRestore(
    session.id,
    JSON.parse(JSON.stringify(session.events)),
    JSON.parse(JSON.stringify(session.header)),
  )
  const restoredTurnEnd = [...restored.events].reverse().find((event) => event.type === 'turn/end')
  assert.ok(restoredTurnEnd)
  assert.equal(restoredTurnEnd.data.reason.kind, 'interrupted')
  assert.equal(interruptedTurnClosers(restored.events).length, 0)
})

test('recovery facts are bounded and contain only factual sections', () => {
  const facts = {
    phase: 'test',
    anchor: { realUserMessages: 2, initialContext: true },
    requirements: ['run tests'],
    changedFiles: ['preset/events/recovery.mjs'],
    testConclusions: ['npm test passed'],
    route: { activeCapabilities: ['ci.inspect'] },
    taskLedger: { todos: [{ status: 'completed', content: 'Run tests' }] },
  }
  const text = formatRecoveryFacts(facts, 400)
  assert.ok(text.length <= 400)
  assert.match(text, /modified files:/)
  assert.match(text, /test conclusions:/)
  assert.doesNotMatch(text, /You are|must|should|continue the task/i)
})
