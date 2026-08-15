import { parseRouterText } from './schema.mjs'
import { snapshotFingerprint } from './snapshot.mjs'

export class RouterController {
  #available
  #call
  #cache = new Map()
  #lastValid = { capabilities: [], ttl: 'turn', reason: 'no router result' }
  #maxCacheEntries

  constructor({ availableCapabilities, call, maxCacheEntries = 32 }) {
    if (typeof availableCapabilities !== 'function' && !Array.isArray(availableCapabilities)) {
      throw new TypeError('availableCapabilities must be an array or function')
    }
    if (typeof call !== 'function') throw new TypeError('call must be a function')
    this.#available = availableCapabilities
    this.#call = call
    this.#maxCacheEntries = Math.max(1, maxCacheEntries)
  }

  availableCapabilities() {
    const value = typeof this.#available === 'function' ? this.#available() : this.#available
    return [...new Set(value)]
  }

  /**
   * Restore the last validated selection from a durable session projection.
   * The process-local cache is only an optimization; a resumed session must
   * still have a safe router fallback when the next Flash call is unavailable.
   */
  restore(result) {
    if (result === undefined || result === null) return
    const parsed = parseRouterText(JSON.stringify(result), this.availableCapabilities())
    this.#lastValid = parsed
  }

  async route(snapshot, signal) {
    const fingerprint = snapshotFingerprint(snapshot)
    const cached = this.#cache.get(fingerprint)
    if (cached !== undefined) return { ...cached, fromCache: true }

    try {
      const raw = await this.#call(snapshot, signal)
      const result = typeof raw === 'string'
        ? parseRouterText(raw, this.availableCapabilities())
        : parseRouterText(JSON.stringify(raw), this.availableCapabilities())
      this.#lastValid = result
      this.#cache.set(fingerprint, result)
      while (this.#cache.size > this.#maxCacheEntries) this.#cache.delete(this.#cache.keys().next().value)
      return { ...result, fromCache: false }
    } catch {
      // The main agent remains on its fixed Minimal surface.  A router outage
      // can only reuse a previously validated selection, never expose a
      // broader catalog or invent a tool schema.
      return { ...this.#lastValid, fallback: true }
    }
  }

  clear() {
    this.#cache.clear()
    this.#lastValid = { capabilities: [], ttl: 'turn', reason: 'router cache cleared' }
  }
}

/** Create the optional Flash call used by the runtime plugin. */
export function createLlmRouterCall(ctx, {
  provider = 'deepseek-official',
  model = 'deepseek-v4-flash',
  maxTokens = 2048,
  reasoningEffort = 'off',
} = {}) {
  return async (snapshot, signal) => {
    const llm = ctx.get?.('llm')
    if (!llm) throw new Error('llm service is unavailable')

    const stream = llm.stream({
      provider,
      model,
      reasoningEffort,
      maxTokens,
      tools: [],
      system: 'You are a capability classifier. Return only one JSON object with the shape {"capabilities":["known.id"],"ttl":"turn","reason":"short reason"}. Never write code and never include markdown fences.',
      messages: [{
        id: crypto.randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: `Select only from available_capability_ids.\n${JSON.stringify(snapshot)}` }],
        source: { kind: 'plugin', plugin: 'capability-runtime', form: 'notice', summary: 'router snapshot' },
      }],
      signal,
    })

    let text = ''
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta' || chunk?.type === 'reasoning-delta') text += chunk.text ?? ''
    }
    return text
  }
}
