import {
  activeCapabilityIds,
  countRealUserMessages,
  derivePhase,
  isInitialContextMessage,
  isRealUserMessage,
  latestRealUserText,
  latestRequestContract,
  projectSession,
  textFromMessage,
} from './projections.mjs'

export const name = 'session-recovery'

export const DEFAULT_RECOVERY_CONFIG = Object.freeze({
  maxSurfaceNodes: 32,
  retainSurfaceNodes: 8,
  maxSurfaceChars: 24000,
  maxRequirements: 8,
  maxChangedFiles: 32,
  maxTestConclusions: 16,
  maxLedgerItems: 32,
  maxFactChars: 12000,
})

const COMPACTION_PLUGIN = 'oh-my-dsh-recovery'

function boundedText(value, limit) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(1, limit - 1))}…`
}

function boundedList(values, limit, itemLimit = 120) {
  const result = []
  for (const value of values ?? []) {
    const text = boundedText(value, itemLimit)
    if (text && !result.includes(text)) result.push(text)
    if (result.length >= limit) break
  }
  return result
}

function messageEvents(events = []) {
  return events
    .filter((event) => event?.type === 'user/message')
    .map((event) => ({ event, message: event.data }))
    .filter(({ message }) => message && Array.isArray(message.content))
}

function latestCapabilitySnapshot(events = []) {
  for (const { event, message } of messageEvents(events).reverse()) {
    const source = message.source
    if (source?.kind !== 'plugin' || source.plugin !== 'capability-runtime' || source.form !== 'snapshot') continue
    const sections = Array.isArray(source.sections)
      ? source.sections
        .filter((section) => typeof section?.name === 'string' && section.name.length > 0)
        .map((section) => ({ name: section.name, text: boundedText(section.text, 240) }))
      : []
    return {
      eventSeq: event.seq,
      capabilities: [...new Set(sections.map((section) => section.name))],
      sections,
    }
  }
  return undefined
}

function latestAnchorState(events = []) {
  const anchorMessages = messageEvents(events)
    .filter(({ message }) => message?.source?.kind === 'plugin' && message.source.plugin === 'turn-anchor')
  const initialContext = anchorMessages.some(({ message }) => isInitialContextMessage(message))
  const anchors = anchorMessages.filter(({ message }) => message.source.form === 'notice')
  const realUserMessages = countRealUserMessages(events)
  return {
    initialContext,
    realUserMessages,
    anchorMessages: anchors.length,
    expectedNextRealUserRound: realUserMessages + 2,
  }
}

function collectKeyedValues(value, keys, output, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) collectKeyedValues(item, keys, output, depth + 1)
    return
  }
  for (const [key, child] of Object.entries(value)) {
    if (keys.has(key) && Array.isArray(child)) {
      for (const item of child) if (typeof item === 'string') output.push(item)
    }
    collectKeyedValues(child, keys, output, depth + 1)
  }
}

function changedFiles(events = [], config) {
  const values = []
  for (const event of events) {
    collectKeyedValues(
      event?.data,
      new Set(['changedFiles', 'modifiedFiles', 'files']),
      values,
    )
  }
  return boundedList(values, config.maxChangedFiles, 260)
}

function eventText(event) {
  if (event?.type === 'user/message') return textFromMessage(event.data)
  if (event?.type === 'assistant/message') return textFromMessage(event.data?.message)
  if (event?.type === 'tool/result') return textFromMessage(event.data?.message)
  if (typeof event?.data?.text === 'string') return event.data.text
  if (typeof event?.data?.output === 'string') return event.data.output
  return ''
}

function testConclusions(events = [], config) {
  const result = []
  for (const event of events) {
    if (!['assistant/message', 'tool/result', 'oh-my-dsh/capability-result', 'command/done'].includes(event?.type)) continue
    const text = boundedText(eventText(event), 320)
    if (!text || !/(test|testing|passed|pass|failed|failure|error|verified|验证|测试|通过|失败|错误)/i.test(text)) continue
    result.push(text)
  }
  return boundedList(result.slice(-config.maxTestConclusions), config.maxTestConclusions, 320)
}

function latestTodos(events = [], config) {
  const event = [...events].reverse().find((candidate) => candidate?.type === 'todo/write')
  if (!Array.isArray(event?.data?.todos)) return []
  return event.data.todos
    .filter((todo) => typeof todo?.content === 'string' && typeof todo?.status === 'string')
    .slice(0, config.maxLedgerItems)
    .map((todo) => ({
      content: boundedText(todo.content, 240),
      status: todo.status,
    }))
}

function latestGoal(events = []) {
  const event = [...events].reverse().find((candidate) => candidate?.type === 'goal/change')
  if (!event?.data || typeof event.data !== 'object') return undefined
  if (event.data.operation === 'clear' || event.data.goal === null) return undefined
  return event.data.goal ?? event.data
}

function taskLedger(events = [], config) {
  const todos = latestTodos(events, config)
  const goal = latestGoal(events)
  return {
    todos,
    ...(goal === undefined ? {} : { goal }),
  }
}

function surfaceTextLength(session, nodes) {
  return nodes.reduce((total, seq) => {
    const event = session.events?.[seq]
    return total + eventText(event).length
  }, 0)
}

function hasOpenTurn(events = []) {
  let open = false
  for (const event of events) {
    if (event?.type === 'turn/start') open = true
    if (event?.type === 'turn/end') open = false
  }
  return open
}

function hasOpenCompaction(events = []) {
  let open = false
  for (const event of events) {
    if (event?.type === 'compaction/start') open = true
    if (event?.type === 'compaction/end') open = false
  }
  return open
}

function toolCallId(event) {
  if (event?.type === 'tool/call') return event.data?.callId
  if (event?.type === 'tool/result') return event.data?.message?.source?.callId
  return undefined
}

function balancedEndIndex(session, nodes, candidateEndIndex) {
  const pending = new Set()
  for (let index = 0; index <= candidateEndIndex; index += 1) {
    const event = session.events?.[nodes[index]]
    if (event?.type === 'tool/call') {
      const callId = toolCallId(event)
      if (callId) pending.add(callId)
    } else if (event?.type === 'tool/result') {
      const callId = toolCallId(event)
      if (callId) pending.delete(callId)
    }
  }
  if (pending.size === 0) return candidateEndIndex
  for (let index = candidateEndIndex - 1; index >= 0; index -= 1) {
    const candidate = new Set()
    for (let cursor = 0; cursor <= index; cursor += 1) {
      const event = session.events?.[nodes[cursor]]
      if (event?.type === 'tool/call') {
        const callId = toolCallId(event)
        if (callId) candidate.add(callId)
      } else if (event?.type === 'tool/result') {
        const callId = toolCallId(event)
        if (callId) candidate.delete(callId)
      }
    }
    if (candidate.size === 0) return index
  }
  return -1
}

function resolveConfig(config = {}) {
  const resolved = { ...DEFAULT_RECOVERY_CONFIG, ...config }
  for (const key of Object.keys(DEFAULT_RECOVERY_CONFIG)) {
    if (!Number.isInteger(resolved[key]) || resolved[key] <= 0) {
      throw new TypeError(`${name}: ${key} must be a positive integer`)
    }
  }
  if (resolved.retainSurfaceNodes >= resolved.maxSurfaceNodes) {
    throw new TypeError(`${name}: retainSurfaceNodes must be less than maxSurfaceNodes`)
  }
  return resolved
}

export function compactSessionFacts(events = [], config = {}) {
  const resolved = resolveConfig(config)
  const project = projectSession(events)
  const snapshot = latestCapabilitySnapshot(events)
  const requirements = boundedList(
    events
      .filter((event) => event?.type === 'user/message')
      .map((event) => event.data)
      .filter(isRealUserMessage)
      .map((message) => textFromMessage(message)),
    resolved.maxRequirements,
    500,
  )
  const facts = {
    version: 1,
    lastEventSeq: events.at(-1)?.seq ?? -1,
    phase: project.phase,
    anchor: latestAnchorState(events),
    requirements,
    changedFiles: changedFiles(events, resolved),
    testConclusions: testConclusions(events, resolved),
    route: {
      activeCapabilities: snapshot?.capabilities ?? activeCapabilityIds(events),
      latestSnapshotEventSeq: snapshot?.eventSeq,
      latestUserInput: boundedText(latestRealUserText(events), 500),
      requestContract: latestRequestContract(events),
    },
    taskLedger: taskLedger(events, resolved),
  }
  return facts
}

export function formatRecoveryFacts(facts, maxChars = DEFAULT_RECOVERY_CONFIG.maxFactChars) {
  const lines = [
    '[oh-my-dsh recovery facts]',
    `phase: ${facts.phase ?? 'implement'}`,
    `real user messages: ${facts.anchor?.realUserMessages ?? 0}`,
    `initial context recorded: ${facts.anchor?.initialContext === true ? 'yes' : 'no'}`,
    '',
    'user requirements:',
    ...(facts.requirements?.length ? facts.requirements.map((item) => `- ${item}`) : ['- (none)']),
    '',
    'modified files:',
    ...(facts.changedFiles?.length ? facts.changedFiles.map((item) => `- ${item}`) : ['- (none)']),
    '',
    'test conclusions:',
    ...(facts.testConclusions?.length ? facts.testConclusions.map((item) => `- ${item}`) : ['- (none)']),
    '',
    'active capabilities:',
    ...(facts.route?.activeCapabilities?.length ? facts.route.activeCapabilities.map((item) => `- ${item}`) : ['- (none)']),
    '',
    'task ledger:',
    ...(facts.taskLedger?.todos?.length
      ? facts.taskLedger.todos.map((todo) => `- [${todo.status}] ${todo.content}`)
      : ['- (none)']),
  ]
  return boundedText(lines.join('\n'), maxChars)
}

export function restoreSessionState(events = [], availableCapabilities = []) {
  const facts = compactSessionFacts(events, { maxFactChars: DEFAULT_RECOVERY_CONFIG.maxFactChars })
  const project = projectSession(events, availableCapabilities)
  return {
    ...project,
    anchor: facts.anchor,
    route: facts.route,
    capabilities: {
      active: [...facts.route.activeCapabilities],
      available: [...availableCapabilities],
    },
    taskLedger: facts.taskLedger,
    facts,
  }
}

export function compactSession(session, config = {}) {
  const resolved = resolveConfig(config)
  if (!session || typeof session.append !== 'function' || !Array.isArray(session.events)) return null
  if (hasOpenTurn(session.events) || hasOpenCompaction(session.events)) return null
  const nodes = Array.isArray(session.surface?.nodes) ? [...session.surface.nodes] : []
  if (nodes.length <= resolved.maxSurfaceNodes) return null

  const candidateEndIndex = nodes.length - resolved.retainSurfaceNodes - 1
  const endIndex = balancedEndIndex(session, nodes, candidateEndIndex)
  if (endIndex < 1) return null
  const shadowedSeqs = nodes.slice(0, endIndex + 1)
  const rawChars = surfaceTextLength(session, shadowedSeqs)
  if (rawChars <= resolved.maxSurfaceChars && nodes.length <= resolved.maxSurfaceNodes) return null

  const facts = compactSessionFacts(session.events, resolved)
  const summaryText = formatRecoveryFacts(facts, resolved.maxFactChars)
  if (!summaryText || summaryText.length >= Math.max(rawChars, resolved.maxFactChars)) return null

  const start = shadowedSeqs[0]
  const end = shadowedSeqs.at(-1)
  const compactionId = crypto.randomUUID()
  const summary = [{ type: 'text', text: summaryText }]
  let started
  try {
    started = session.append('compaction/start', { compactionId, turn: null })
    const summaryEvent = session.append('compaction/summary', {
      compactionId,
      summary,
      shadowedRange: { start, end },
      shadowedSeqs,
      shadowedTokenCount: Math.max(1, Math.ceil(rawChars / 4)),
      provider: 'oh-my-dsh',
      model: 'event-log-facts',
    })
    const checkpoint = {
      id: crypto.randomUUID(),
      role: 'user',
      content: summary,
      source: {
        kind: 'plugin',
        plugin: COMPACTION_PLUGIN,
        form: 'compacted-facts',
        compactionId,
      },
    }
    const replacement = session.append('user/message', checkpoint, {
      surfaceOp: { op: 'replace', start, end },
      sourceEventSeqs: [started.seq, summaryEvent.seq, ...shadowedSeqs],
    })
    const ended = session.append('compaction/end', { compactionId, turn: null })
    return {
      compactionId,
      startSeq: started.seq,
      summarySeq: summaryEvent.seq,
      replacementSeq: replacement.seq,
      endSeq: ended.seq,
      shadowedSeqs,
      facts,
      summaryText,
    }
  } catch (error) {
    if (started) {
      try {
        session.append('compaction/end', {
          compactionId,
          turn: null,
          error: error instanceof Error ? error.message : String(error),
        })
      } catch {
        // Preserve the original failure; the unmatched marker remains durable.
      }
    }
    throw error
  }
}

export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config)
  const recovery = {
    compact: (session) => compactSession(session, resolved),
    facts: (events) => compactSessionFacts(events, resolved),
    restore: (events, available) => restoreSessionState(events, available),
  }
  ctx.provide?.('ohMyDshRecovery', recovery)
  ctx.on?.('agent/pre-step', async ({ agent, signal }, next) => {
    if (signal?.aborted || !agent?.session) return next()
    try {
      const result = compactSession(agent.session, resolved)
      if (result) ctx.logger?.info?.(`session recovery compacted ${result.shadowedSeqs.length} surface nodes`)
    } catch (error) {
      ctx.logger?.warn?.(`session recovery compaction skipped: ${error instanceof Error ? error.message : String(error)}`)
    }
    return next()
  })
}

export { latestAnchorState, latestCapabilitySnapshot, resolveConfig }
