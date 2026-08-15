/** Pure projections over the durable Session Event Log. */

export function eventMessage(event) {
  return event?.type === 'user/message' ? event.data : undefined
}

export function isPluginMessage(message) {
  return message?.source?.kind === 'plugin'
}

export function isInitialContextMessage(message) {
  return message?.source?.kind === 'plugin'
    && message.source.plugin === 'turn-anchor'
    && message.source.form === 'initial-context'
}

export function isRealUserMessage(message) {
  return message?.role === 'user' && !isPluginMessage(message)
}

export function realUserMessages(events = []) {
  return events
    .filter((event) => event?.type === 'user/message')
    .map(eventMessage)
    .filter(isRealUserMessage)
}

export function countRealUserMessages(events = []) {
  return realUserMessages(events).length
}

export function hasInitialContextRound(events = []) {
  return events.some((event) => event?.type === 'user/message' && isInitialContextMessage(event.data))
}

export function textFromMessage(message) {
  if (!Array.isArray(message?.content)) return ''
  return message.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

export function latestRealUserText(events = []) {
  return textFromMessage(realUserMessages(events).at(-1))
}

export function derivePhase(events = []) {
  const text = latestRealUserText(events).toLowerCase()
  if (/\b(repair|fix|debug|修复|故障|失败)\b/.test(text)) return 'repair'
  if (/\b(test|testing|测试|验证)\b/.test(text)) return 'test'
  if (/\b(review|审查|评审)\b/.test(text)) return 'review'
  return 'implement'
}

function capabilityIdsFromSource(source) {
  if (source?.kind !== 'plugin' || source.plugin !== 'capability-runtime') return []
  if (source.form === 'snapshot' && Array.isArray(source.sections)) {
    return source.sections
      .map((section) => section?.name)
      .filter((id) => typeof id === 'string' && id.length > 0)
  }
  return []
}

export function activeCapabilityIds(events = []) {
  let latest = []
  for (const event of events) {
    const message = eventMessage(event)
    const ids = capabilityIdsFromSource(message?.source)
    if (ids.length > 0) latest = ids
  }
  return [...new Set(latest)]
}

export function recentToolFacts(events = [], limit = 8) {
  return events
    .filter((event) => event?.type === 'tool/call' || event?.type === 'tool/result')
    .slice(-limit)
    .map((event) => {
      if (event.type === 'tool/call') return { type: event.type, name: event.data?.name ?? '' }
      return { type: event.type, name: event.data?.message?.source?.kind ?? '' }
    })
}

export function latestRequestContract(events = []) {
  const event = events.findLast?.((candidate) => candidate?.type === 'request/header')
    ?? [...events].reverse().find((candidate) => candidate?.type === 'request/header')
  const header = event?.data?.header
  if (!header) return undefined
  return {
    system: typeof header.system === 'string' ? header.system : '',
    tools: Array.isArray(header.tools) ? header.tools.map((tool) => tool.name).filter(Boolean) : [],
    provider: header.config?.provider,
    model: header.config?.model,
  }
}

export function projectSession(events = [], availableCapabilities = []) {
  return {
    realUserMessages: countRealUserMessages(events),
    phase: derivePhase(events),
    activeCapabilities: activeCapabilityIds(events),
    availableCapabilities: [...availableCapabilities],
    recentToolFacts: recentToolFacts(events),
    requestContract: latestRequestContract(events),
  }
}
