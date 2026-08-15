import { currentTurnOf } from './capabilities/surface.mjs'

/**
 * Keep the model-facing catalog on the fixed Minimal contract.
 *
 * The composition normally contains only these tools. The optional native
 * surface may append an explicitly selected bundle, but it never changes the
 * base list into an unrestricted catalog.
 */

export const name = 'minimal-surface'
export const inject = ['systemPrompt']

const DEFAULT_TOOLS = ['bash', 'str_replace_editor', 'web_search']

function toolNames(value) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`${name}: tools must be a non-empty array of non-empty strings`)
  }
  return [...new Set(value)]
}

/**
 * Register the fixed model surface filter.
 *
 * @param {object} ctx - Cordis plugin context.
 * @param {{tools?: string[]}} config - ordered model-facing tool names.
 */
export function apply(ctx, config = {}) {
  const allowed = toolNames(config.tools ?? DEFAULT_TOOLS)
  let warned = false

  const warnOnce = (message) => {
    if (warned) return
    warned = true
    try {
      ctx.logger?.warn(message)
    } catch {
      // Logging is diagnostic only; the surface filter must remain usable.
    }
  }

  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next()
    const available = new Map((Array.isArray(assembled.tools) ? assembled.tools : []).map((tool) => [tool.name, tool]))
    const missing = allowed.filter((toolName) => !available.has(toolName))
    if (missing.length > 0) {
      warnOnce(`${name}: fixed tool surface is missing ${JSON.stringify(missing)}; keeping the remaining Minimal tools`)
    }

    const nativeSurface = (() => {
      try {
        return ctx.get?.('ohMyDshNativeSurface')
      } catch {
        return undefined
      }
    })()
    const tools = nativeSurface?.filterTools?.(assembled, {
      agent: _context?.agent,
      turn: currentTurnOf(_context?.agent),
      baseTools: allowed,
    }) ?? allowed.map((toolName) => available.get(toolName)).filter(Boolean)

    return {
      ...assembled,
      // Preserve the contract order and only append the selected allowlisted
      // bundle. Missing base tools still degrade to the remaining Minimal
      // tools; they never trigger a full-catalog fallback.
      tools,
    }
  })
}

export { DEFAULT_TOOLS }
