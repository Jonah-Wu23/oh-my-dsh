import { countRealUserMessages, hasInitialContextRound, isRealUserMessage } from '../events/projections.mjs'

export const name = 'turn-anchor'

/** Fixed text required by the multi-turn anchoring contract. */
export const ANCHOR_TEXT = [
  'We need to engage in a high-quality, in-depth thinking on the user input below.',
  'We need to think in English and begin every reasoning sentence with ‘We need…’.',
  'We need to keep the reasoning internal and return only the final answer to the user.',
  'We need to speak Chinese to users.',
].join(' ')
export const INITIAL_CONTEXT_TEXT = [
  'We need to treat this message only as the first-round context anchor, not as a user task.',
  'We need to carry out a test in this round.',
  'We need to be aware that the tool has not yet been enabled.',
  'We need to know that the tool will be enabled in the next round.',
  'We need to avoid calling Bash, inspecting the repository, inspecting files, or executing commands in this round.',
  'We need to wait for the first real user message before taking any action.',
].join(' ')

function isTopLevel(agent) {
  return (agent?.session?.header?.delegationDepth ?? 0) === 0
}

function sourceMessageId(message) {
  return typeof message?.id === 'string' ? message.id : undefined
}

export function createAnchorMessage() {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: ANCHOR_TEXT }],
    source: {
      kind: 'plugin',
      plugin: name,
      form: 'notice',
      summary: 'turn anchor',
    },
  }
}

export function createInitialContextMessage() {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: INITIAL_CONTEXT_TEXT }],
    source: {
      kind: 'plugin',
      plugin: name,
      form: 'initial-context',
      summary: 'initial session context',
    },
  }
}

/**
 * Insert one anchor before each real user message after the first one.
 * Only messages claimed from the inbox are candidates; runtime context added
 * by the downstream pre-step handler is therefore never mistaken for input.
 */
export function insertAnchors({ agent, claimedMessages, assembledMessages }) {
  if (!isTopLevel(agent) || !Array.isArray(claimedMessages) || !Array.isArray(assembledMessages)) {
    return assembledMessages
  }

  const claimed = new Set(claimedMessages)
  const claimedIds = new Set(claimedMessages.map(sourceMessageId).filter(Boolean))
  let seen = countRealUserMessages(agent.session?.events ?? [])
  const hasInitialContext = hasInitialContextRound(agent.session?.events ?? [])
  let changed = false

  const result = []
  for (const message of assembledMessages) {
    const isClaimed = claimed.has(message) || (sourceMessageId(message) !== undefined && claimedIds.has(sourceMessageId(message)))
    if (!isClaimed || !isRealUserMessage(message)) {
      result.push(message)
      continue
    }

    if (seen >= 1 || (seen === 0 && hasInitialContext)) {
      result.push(createAnchorMessage())
      changed = true
    }
    result.push(message)
    seen += 1
  }
  return changed ? result : assembledMessages
}

export function apply(ctx) {
  ctx.on('agent/session-start', ({ agent, source }) => {
    if (source !== 'startup' && source !== 'clear') return
    agent.followup(createInitialContextMessage())
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision?.kind === 'reject') return decision
    const messages = insertAnchors({
      agent: payload.agent,
      claimedMessages: payload.messages,
      assembledMessages: decision.messages,
    })
    return messages === decision.messages ? decision : { ...decision, messages }
  })
}
