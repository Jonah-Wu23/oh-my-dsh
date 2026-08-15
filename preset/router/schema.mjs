const MAX_REASON_CHARS = 240

export function validateRouterResult(value, availableIds) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('router result must be an object')
  }
  if (!Array.isArray(value.capabilities)) {
    throw new TypeError('router result capabilities must be an array')
  }

  const available = new Set(availableIds)
  const capabilities = [...new Set(value.capabilities)]
  if (capabilities.some((id) => typeof id !== 'string' || id.length === 0)) {
    throw new TypeError('router result capabilities must contain non-empty strings')
  }
  if (value.ttl !== undefined && value.ttl !== 'turn') {
    throw new TypeError('router result ttl must be "turn"')
  }

  return {
    capabilities: capabilities.filter((id) => available.has(id)),
    ttl: 'turn',
    reason: typeof value.reason === 'string' ? value.reason.slice(0, MAX_REASON_CHARS) : '',
  }
}

export function parseRouterText(text, availableIds) {
  const trimmed = String(text ?? '').trim()
  if (trimmed.length === 0) throw new TypeError('router returned empty output')
  return validateRouterResult(JSON.parse(trimmed), availableIds)
}
