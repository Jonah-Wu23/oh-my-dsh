const MAX_INPUT_CHARS = 12000
const MAX_FACTS = 16

function boundedText(value, max = MAX_INPUT_CHARS) {
  if (typeof value !== 'string') return ''
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

export function createRouterSnapshot({
  latestUserInput = '',
  currentPhase = 'implement',
  recentToolFacts = [],
  activeCapabilities = [],
  availableCapabilityIds = [],
} = {}) {
  return {
    latest_user_input: boundedText(latestUserInput),
    current_phase: currentPhase,
    recent_tool_facts: Array.isArray(recentToolFacts) ? recentToolFacts.slice(-MAX_FACTS) : [],
    active_capabilities: Array.isArray(activeCapabilities) ? [...new Set(activeCapabilities)] : [],
    available_capability_ids: Array.isArray(availableCapabilityIds) ? [...new Set(availableCapabilityIds)].sort() : [],
  }
}

export function snapshotFingerprint(snapshot) {
  return JSON.stringify(snapshot)
}

export { MAX_INPUT_CHARS }
