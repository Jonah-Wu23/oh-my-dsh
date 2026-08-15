import { activeCapabilityIds, countRealUserMessages, derivePhase, hasInitialContextRound, isRealUserMessage, recentToolFacts, textFromMessage } from './events/projections.mjs'
import { restoreSessionState } from './events/recovery.mjs'
import { CapabilityRegistry, formatCapability } from './capabilities/registry.mjs'
import { DEFAULT_MANIFESTS } from './capabilities/manifests.mjs'
import { currentTurnOf, installNativeExecutionGuard, NativeToolSurface } from './capabilities/surface.mjs'
import { createLlmRouterCall, RouterController } from './router/controller.mjs'
import { createRouterSnapshot } from './router/snapshot.mjs'

export const name = 'capability-runtime'
export const inject = ['systemPrompt']

function isTopLevel(agent) {
  return (agent?.session?.header?.delegationDepth ?? 0) === 0
}

function isSecondOrLaterUserTurn(agent) {
  const events = agent?.session?.events ?? []
  return countRealUserMessages(events) >= 1 || hasInitialContextRound(events)
}

function capabilityMessage(entries) {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: entries.map(formatCapability).join('\n\n') }],
    source: {
      kind: 'plugin',
      plugin: name,
      form: 'snapshot',
      sections: entries.map((entry) => ({ name: entry.id, text: formatCapability(entry) })),
    },
  }
}

function latestClaimedUser(messages = []) {
  return [...messages].reverse().find(isRealUserMessage)
}

function getService(ctx, key) {
  try {
    return ctx.get?.(key)
  } catch {
    return undefined
  }
}

function availableIds(registry, nativeSurface) {
  return [...new Set([...registry.ids(), ...nativeSurface.bundleIds()])]
}

function nativeIds(selection, nativeSurface) {
  return selection.capabilities.filter((id) => nativeSurface.hasBundle(id))
}

function capabilityEntries(selection, registry) {
  return selection.capabilities.map((id) => registry.get(id)).filter(Boolean)
}

function routeSnapshot(agent, userMessage, available) {
  const sessionEvents = agent?.session?.events ?? []
  return createRouterSnapshot({
    latestUserInput: textFromMessage(userMessage),
    currentPhase: derivePhase(sessionEvents),
    recentToolFacts: recentToolFacts(sessionEvents),
    activeCapabilities: activeCapabilityIds(sessionEvents),
    availableCapabilityIds: available,
  })
}

function restoreRouterState(agent, router, available) {
  const state = restoreSessionState(agent?.session?.events ?? [], available)
  if (state.route?.latestSnapshotEventSeq === undefined) return state
  router.restore({
    capabilities: state.route.activeCapabilities,
    ttl: 'turn',
    reason: 'restored from the durable session event log',
  })
  return state
}

/**
 * Install the registry, optional Flash router, and pre-step capability broker.
 * Router failures are intentionally swallowed by RouterController. The native
 * outlet is opt-in and only contributes configured bundle tools.
 */
export function apply(ctx, config = {}) {
  const registry = new CapabilityRegistry(config.manifests ?? DEFAULT_MANIFESTS)
  const nativeSurface = new NativeToolSurface({
    ...(config.nativeTools ?? {}),
    baseTools: config.baseTools ?? config.nativeTools?.baseTools,
  })
  const call = createLlmRouterCall(ctx, config.router)
  const router = new RouterController({
    availableCapabilities: () => availableIds(registry, nativeSurface),
    call,
    maxCacheEntries: config.maxCacheEntries ?? 32,
  })

  ctx.provide?.('ohMyDshCapabilities', registry)
  ctx.provide?.('ohMyDshRouter', router)
  ctx.provide?.('ohMyDshNativeSurface', nativeSurface)
  const disposeGuard = installNativeExecutionGuard(ctx, nativeSurface)
  ctx.effect?.(() => () => {
    disposeGuard?.()
    nativeSurface.dispose()
    registry.dispose()
  }, 'capability and native surface teardown')

  // The agent loop assembles the system prompt before it dispatches
  // agent/pre-step. Remember the claimed user message so the downstream
  // surface filter can see the native selection in this very request.
  const claimedByAgent = new Map()
  if (getService(ctx, 'systemPrompt') !== undefined) {
    ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
      if (!isTopLevel(agent)) return
      const previous = claimedByAgent.get(agent)
      if (previous?.turn === turn) previous.messages.push(message)
      else claimedByAgent.set(agent, { turn, messages: [message] })
    })

    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const assembled = await next()
      const agent = context?.agent
      if (!isTopLevel(agent)) return assembled

      const claimed = claimedByAgent.get(agent)
      const userMessage = latestClaimedUser(claimed?.messages)
      if (!userMessage) return assembled
      if (!isSecondOrLaterUserTurn(agent)) {
        claimedByAgent.delete(agent)
        return assembled
      }

      const available = availableIds(registry, nativeSurface)
      restoreRouterState(agent, router, available)
      const selection = await router.route(
        routeSnapshot(agent, userMessage, available),
        context?.signal,
      )
      nativeSurface.select(agent, claimed.turn ?? currentTurnOf(agent), nativeIds(selection, nativeSurface))
      claimedByAgent.delete(agent)
      return assembled
    })
  }

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision?.kind === 'reject' || !isTopLevel(payload.agent)) return decision

    const userMessage = latestClaimedUser(payload.messages)
    if (!userMessage) return decision
    if (!isSecondOrLaterUserTurn(payload.agent)) return decision

    const available = availableIds(registry, nativeSurface)
    restoreRouterState(payload.agent, router, available)
    const snapshot = routeSnapshot(payload.agent, userMessage, available)
    const selection = await router.route(snapshot, payload.signal)
    nativeSurface.select(payload.agent, payload.turn ?? currentTurnOf(payload.agent), nativeIds(selection, nativeSurface))
    const selected = capabilityEntries(selection, registry)
    if (selected.length === 0) return decision

    const sessionEvents = payload.agent.session?.events ?? []
    const active = new Set(activeCapabilityIds(sessionEvents))
    if (selected.every((entry) => active.has(entry.id))) return decision

    const injected = capabilityMessage(selected)
    return { ...decision, messages: [injected, ...decision.messages] }
  })
}

export { capabilityMessage }
