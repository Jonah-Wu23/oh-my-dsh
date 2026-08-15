/**
 * Legacy upstream bootstrap plugin retained for comparison tests.
 * It is not mounted by the current oh-my-dsh preset; the active composition
 * uses `minimal-surface.mjs` and keeps the model catalog fixed.
 *
 * Anchored tool bootstrap — keep the FIRST model request on a small tool
 * surface, then expose the full preset catalog once the session has produced
 * its first durable promotion signal.
 *
 * The phase is derived from durable session events, so resume and reload
 * preserve it. By default (`promoteOn: 'either'`) a session promotes after the
 * first `tool/call` OR the first `assistant/message`, whichever comes first:
 * request #1 always sees the bootstrap catalog and request #2 always sees the
 * full catalog. The original `'tool-call'` mode is kept for compatibility, but
 * it can trap a session in bootstrap forever when the first model reply makes
 * no tool call — the `'either'` default removes that trap while keeping the
 * first-request anchor intact.
 *
 * Robustness:
 *  - Promotion decisions are memoized per session id for this process; the
 *    durable event scan runs once per session per process, then O(1).
 *  - A missing bootstrap tool degrades to the full catalog with a one-time
 *    warning instead of throwing, so a composition drift can never brick
 *    every request of a session.
 *  - Invalid config (bad tool lists, unknown `promoteOn`) fails at apply
 *    time, i.e. at preset mount, where it is visible and fixable.
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'anchored-tool-bootstrap'

/** Prompt assembly must exist before this request filter can register. */
export const inject = ['systemPrompt']

/** Durable session event types that count as a promotion signal per mode. */
const PROMOTE_EVENTS = {
  'tool-call': ['tool/call'],
  'assistant-message': ['assistant/message'],
  either: ['tool/call', 'assistant/message'],
}

function stringList(value, field) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`${name}: ${field} must be a non-empty array of non-empty strings`)
  }
  return [...new Set(value)]
}

function parsePromoteOn(value) {
  if (value === undefined || value === 'either') return PROMOTE_EVENTS.either
  if (value === 'tool-call' || value === 'assistant-message') return PROMOTE_EVENTS[value]
  throw new TypeError(`${name}: promoteOn must be one of "tool-call", "assistant-message", "either"; got ${JSON.stringify(value)}`)
}

/** Register the per-session bootstrap filter. */
export function apply(ctx, config) {
  const commonTools = stringList(config.commonTools, 'commonTools')
  const shellTools = stringList(config.shellTools, 'shellTools')
  const promoteEvents = parsePromoteOn(config.promoteOn)

  /** Sessions already promoted in this process. Promotion is append-only, so a Set is sound. */
  const promoted = new Set()
  let warned = false
  const warnOnce = (message) => {
    if (warned) return
    warned = true
    try {
      ctx.logger.warn(message)
    } catch {
      // Logger unavailable — the guard exists only to avoid spamming.
    }
  }

  /**
   * Whether the session has reached the promoted phase.
   * @param agent - the assembly context's agent, or undefined outside an agent.
   */
  const isPromoted = (agent) => {
    if (agent === undefined) return true
    const session = agent.session
    if (session === undefined) return true
    if (promoted.has(session.id)) return true
    const hit = session.events.some((event) => promoteEvents.includes(event.type))
    if (hit) promoted.add(session.id)
    return hit
  }

  /** Narrow the assembled catalog to one platform shell plus the common tools. */
  const applyBootstrap = (assembled) => {
    const available = new Set(assembled.tools.map((tool) => tool.name))
    const selectedShells = shellTools.filter((toolName) => available.has(toolName))
    const missingCommon = commonTools.filter((toolName) => !available.has(toolName))
    if (selectedShells.length !== 1 || missingCommon.length > 0) {
      warnOnce(
        `${name}: expected exactly one bootstrap shell and every common tool; `
        + `shells=${JSON.stringify(selectedShells)}, missing=${JSON.stringify(missingCommon)} — `
        + 'bootstrap disabled, full catalog exposed',
      )
      return assembled
    }
    const bootstrap = new Set([...selectedShells, ...commonTools])
    return {
      ...assembled,
      tools: assembled.tools.filter((tool) => bootstrap.has(tool.name)),
    }
  }

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    // Downstream errors propagate untouched; only this filter's own logic is guarded.
    const assembled = await next()
    try {
      if (isPromoted(context.agent)) return assembled
      return applyBootstrap(assembled)
    } catch (error) {
      // A filter bug must never brick a session: degrade to the full catalog.
      warnOnce(`${name}: bootstrap filter failed, exposing the full catalog: ${String((error && error.message) || error)}`)
      return assembled
    }
  })
}
