/**
 * Keep the first top-level model request on an empty tool surface.
 *
 * The initial turn-anchor is a durable plugin message. The model must finish
 * that context-only turn before the Minimal tools become visible. Promotion is
 * derived from the durable Session Event Log so restart and resume keep the
 * same phase; no process-local turn counter is used.
 */

export const name = 'zero-tool-bootstrap'
export const inject = ['systemPrompt']

function isPromoted(agent) {
  if (agent === undefined) return true

  const session = agent.session
  if (session === undefined) return true

  // Subagents are real workers and need their tools on their first request.
  if ((session.header?.delegationDepth ?? 0) > 0) return true

  return Array.isArray(session.events)
    && session.events.some((event) => event?.type === 'assistant/message')
}

export function apply(ctx) {
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    return isPromoted(context?.agent)
      ? assembled
      : { ...assembled, tools: [] }
  })
}

export { isPromoted }
