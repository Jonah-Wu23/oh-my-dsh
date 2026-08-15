function assertManifest(manifest) {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new TypeError('capability manifest must be an object')
  }
  for (const field of ['id', 'summary', 'use', 'output']) {
    if (typeof manifest[field] !== 'string' || manifest[field].trim().length === 0) {
      throw new TypeError(`capability manifest ${field} must be a non-empty string`)
    }
  }
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)+$/.test(manifest.id)) {
    throw new TypeError(`invalid capability id: ${manifest.id}`)
  }
  return {
    id: manifest.id,
    summary: manifest.summary,
    use: manifest.use,
    output: manifest.output,
  }
}

export class CapabilityRegistry {
  #entries = new Map()
  #disposed = false

  constructor(manifests = []) {
    for (const manifest of manifests) this.register(manifest)
  }

  register(manifest) {
    if (this.#disposed) throw new Error('capability registry is disposed')
    const entry = assertManifest(manifest)
    if (this.#entries.has(entry.id)) throw new Error(`capability already registered: ${entry.id}`)
    this.#entries.set(entry.id, entry)
    return () => this.unregister(entry.id)
  }

  unregister(id) {
    return this.#entries.delete(id)
  }

  has(id) {
    return !this.#disposed && this.#entries.has(id)
  }

  get(id) {
    const entry = this.#entries.get(id)
    return entry === undefined ? undefined : { ...entry }
  }

  list() {
    return [...this.#entries.values()].map((entry) => ({ ...entry }))
  }

  ids() {
    return [...this.#entries.keys()]
  }

  dispose() {
    this.#entries.clear()
    this.#disposed = true
  }
}

export function formatCapability(entry) {
  return [
    `Available capability: ${entry.id}`,
    `Use:\n  ${entry.use}`,
    `Output:\n  ${entry.output}`,
  ].join('\n')
}

export { assertManifest }
