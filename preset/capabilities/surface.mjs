const ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)+$/
const DEFAULT_BASE_TOOLS = ['bash', 'str_replace_editor', 'web_search']
const NO_AGENT = {}

/** Native bundles are deliberately opt-in; the default route has no bundle. */
export const DEFAULT_NATIVE_BUNDLES = []

function nonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`native bundle ${field} must be a non-empty string`)
  }
  return value
}

function stringList(value, field) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`native bundle ${field} must be an array of non-empty strings`)
  }
  return [...new Set(value)]
}

function schemaOf(value) {
  if (value === null || typeof value !== 'object' || typeof value.name !== 'string') return undefined
  const schema = { name: value.name }
  for (const field of ['description', 'parameters', 'strict']) {
    if (value[field] !== undefined) schema[field] = value[field]
  }
  return schema
}

/**
 * Normalize one allowlisted bundle.
 *
 * `tools` may contain names (the host already registered the schemas) or
 * schema-shaped objects (useful for a preset that supplies the schema itself).
 */
export function normalizeNativeBundle(bundle) {
  if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle)) {
    throw new TypeError('native bundle must be an object')
  }
  const id = nonEmptyString(bundle.id ?? bundle.name, 'id')
  if (!ID_PATTERN.test(id)) throw new TypeError(`invalid native bundle id: ${id}`)

  const rawTools = bundle.tools ?? bundle.toolNames
  if (!Array.isArray(rawTools) || rawTools.length === 0) {
    throw new TypeError(`native bundle ${id} tools must be a non-empty array`)
  }

  const tools = []
  const schemas = new Map()
  for (const item of rawTools) {
    const name = typeof item === 'string' ? item : item?.name
    nonEmptyString(name, `tools for ${id}`)
    if (!tools.includes(name)) tools.push(name)
    const schema = schemaOf(item)
    if (schema !== undefined) schemas.set(name, schema)
  }

  return {
    id,
    summary: typeof bundle.summary === 'string' ? bundle.summary : '',
    tools,
    schemas,
  }
}

function normalizeBundles(value) {
  if (!Array.isArray(value)) throw new TypeError('native bundles must be an array')
  const result = new Map()
  for (const raw of value) {
    const bundle = normalizeNativeBundle(raw)
    if (result.has(bundle.id)) throw new Error(`native bundle already registered: ${bundle.id}`)
    result.set(bundle.id, bundle)
  }
  return result
}

function currentTurnFromEvents(events = []) {
  const event = [...events].reverse().find((candidate) => candidate?.type === 'turn/start')
  const turn = event?.data?.turn
  return turn === undefined ? undefined : turn
}

export function currentTurnOf(agent) {
  return currentTurnFromEvents(agent?.session?.events ?? [])
}

function agentKey(agent) {
  return agent === undefined || agent === null ? NO_AGENT : agent
}

function dedupe(values) {
  return [...new Set(values)]
}

/**
 * Per-agent, per-turn native surface.
 *
 * Selection is reset when the turn changes and only grows within one turn.
 * Bundle IDs and tool names are both allowlisted; router output is never
 * interpreted as a schema or an arbitrary tool name.
 */
export class NativeToolSurface {
  #enabled
  #baseTools
  #bundles
  #selections = new Map()

  constructor({ enabled = false, bundles = DEFAULT_NATIVE_BUNDLES, baseTools = DEFAULT_BASE_TOOLS } = {}) {
    if (!Array.isArray(baseTools) || baseTools.some((name) => typeof name !== 'string' || name.length === 0)) {
      throw new TypeError('native surface baseTools must be an array of non-empty strings')
    }
    this.#enabled = enabled === true
    this.#baseTools = dedupe(baseTools)
    this.#bundles = normalizeBundles(bundles)
  }

  get enabled() {
    return this.#enabled
  }

  bundleIds() {
    return this.#enabled ? [...this.#bundles.keys()] : []
  }

  hasBundle(id) {
    return this.#enabled && this.#bundles.has(id)
  }

  getBundle(id) {
    const bundle = this.#bundles.get(id)
    if (bundle === undefined || !this.#enabled) return undefined
    return {
      id: bundle.id,
      summary: bundle.summary,
      tools: [...bundle.tools],
      schemas: new Map([...bundle.schemas.entries()].map(([name, schema]) => [name, { ...schema }])),
    }
  }

  /** Add bundle IDs to the current turn; never remove an already selected ID. */
  select(agent, turn, bundleIds = []) {
    if (!this.#enabled) return []
    const requested = stringList(bundleIds, 'selection')
    const key = agentKey(agent)
    const previous = this.#selections.get(key)
    const ids = previous !== undefined && Object.is(previous.turn, turn)
      ? new Set(previous.ids)
      : new Set()
    for (const id of requested) {
      if (this.#bundles.has(id)) ids.add(id)
    }
    const selection = { turn, ids: [...ids] }
    this.#selections.set(key, selection)
    return [...selection.ids]
  }

  selectedBundleIds(agent, turn) {
    if (!this.#enabled) return []
    const selection = this.#selections.get(agentKey(agent))
    if (selection === undefined || !Object.is(selection.turn, turn)) return []
    return [...selection.ids]
  }

  selectedBundles(agent, turn) {
    return this.selectedBundleIds(agent, turn)
      .map((id) => this.#bundles.get(id))
      .filter(Boolean)
  }

  visibleToolNames(agent, turn, baseTools = this.#baseTools) {
    const names = [...baseTools]
    for (const bundle of this.selectedBundles(agent, turn)) names.push(...bundle.tools)
    return dedupe(names)
  }

  /** Filter a host assembly without ever returning an unrestricted catalog. */
  filterTools(assembled, { agent, turn, baseTools = this.#baseTools } = {}) {
    const available = new Map((Array.isArray(assembled?.tools) ? assembled.tools : []).map((tool) => [tool.name, tool]))
    const bundledSchemas = new Map()
    for (const bundle of this.selectedBundles(agent, turn)) {
      for (const [name, schema] of bundle.schemas) bundledSchemas.set(name, schema)
    }

    return this.visibleToolNames(agent, turn, baseTools)
      .map((name) => available.get(name) ?? bundledSchemas.get(name))
      .filter(Boolean)
  }

  isVisible(agent, name, turn = currentTurnOf(agent)) {
    return this.visibleToolNames(agent, turn).includes(name)
  }

  /** Return a monotonic denial reason for a hidden direct tool call. */
  executionDenial(exec) {
    const agent = exec?.agent
    if ((agent?.session?.header?.delegationDepth ?? 0) !== 0) return undefined
    if (typeof exec?.name !== 'string') return 'native surface rejected a tool call without a name'
    return this.isVisible(agent, exec.name)
      ? undefined
      : `tool "${exec.name}" is not visible on the current Minimal/native surface`
  }

  clear(agent) {
    this.#selections.delete(agentKey(agent))
  }

  dispose() {
    this.#selections.clear()
  }
}

function getService(ctx, key) {
  try {
    return ctx.get?.(key)
  } catch {
    return undefined
  }
}

/** Install the execution-side deny gate when the Harness tool runtime exists. */
export function installNativeExecutionGuard(ctx, surface) {
  const tools = getService(ctx, 'tools')
  if (typeof tools?.guard === 'function') {
    try {
      return tools.guard((exec) => surface.executionDenial(exec))
    } catch {
      // Fall through to the event seam for lightweight/fake runtimes.
    }
  }
  if (typeof ctx.on !== 'function' || typeof ctx.get !== 'function' || getService(ctx, 'tools') === undefined) return undefined
  return ctx.on('tools/pre-execute', (exec, next) => {
    const reason = surface.executionDenial(exec)
    return reason === undefined ? next() : { kind: 'deny', reason }
  })
}

export { DEFAULT_BASE_TOOLS, currentTurnFromEvents, normalizeBundles }
