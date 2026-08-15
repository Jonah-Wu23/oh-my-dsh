function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalizeWindows(value) {
  return value.replaceAll('/', '\\').replace(/[\\]+$/, '').toLowerCase()
}

export function toMsysPath(value) {
  const normalized = String(value).replaceAll('\\', '/')
  const drive = normalized.match(/^([A-Za-z]):\/(.*)$/)
  if (drive) return `/${drive[1].toLowerCase()}/${drive[2]}`
  return normalized
}

export class WorkspacePathMap {
  constructor(workspaceRoot, virtualRoot = '/workspace') {
    if (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0) throw new TypeError('workspaceRoot must be non-empty')
    this.workspaceRoot = workspaceRoot.replace(/[\\/]+$/, '')
    this.virtualRoot = virtualRoot.replace(/[\\/]+$/, '') || '/'
    this.msysWorkspaceRoot = toMsysPath(this.workspaceRoot)
  }

  toShellPath(value) {
    const raw = String(value).replaceAll('\\', '/')
    const virtualRoot = this.virtualRoot.replaceAll('\\', '/')
    if (raw === virtualRoot) return this.msysWorkspaceRoot
    if (raw.startsWith(`${virtualRoot}/`)) {
      return `${this.msysWorkspaceRoot}/${raw.slice(virtualRoot.length + 1)}`
    }
    return toMsysPath(raw)
  }

  /** Translate model-facing virtual workspace paths in a shell command. */
  rewriteCommand(value) {
    const text = String(value)
    const virtualRoot = this.virtualRoot.replaceAll('\\', '/')
    const pattern = new RegExp(`(^|[^A-Za-z0-9_./-])${escapeRegExp(virtualRoot)}(?=$|[^A-Za-z0-9_.-])`, 'g')
    return text.replace(pattern, (_match, prefix) => `${prefix}${this.msysWorkspaceRoot}`)
  }

  toVirtualPath(value) {
    const raw = String(value)
    const normalized = normalizeWindows(raw)
    const root = normalizeWindows(this.workspaceRoot)
    if (normalized === root) return this.virtualRoot
    if (normalized.startsWith(`${root}\\`)) {
      return `${this.virtualRoot}/${raw.slice(this.workspaceRoot.length).replaceAll('\\', '/').replace(/^\/+/, '')}`
    }
    const msys = raw.replaceAll('\\', '/')
    const msysRoot = this.msysWorkspaceRoot.toLowerCase()
    if (msys.toLowerCase() === msysRoot) return this.virtualRoot
    if (msys.toLowerCase().startsWith(`${msysRoot}/`)) {
      return `${this.virtualRoot}/${msys.slice(this.msysWorkspaceRoot.length).replace(/^\/+/, '')}`
    }
    return raw
  }

  rewriteOutput(text) {
    let result = String(text)
    const variants = [
      this.workspaceRoot,
      this.workspaceRoot.replaceAll('\\', '/'),
      this.msysWorkspaceRoot,
    ].filter(Boolean).sort((a, b) => b.length - a.length)
    for (const variant of variants) {
      result = result.replace(new RegExp(escapeRegExp(variant), 'gi'), this.virtualRoot)
    }
    result = result.replaceAll(`${this.virtualRoot}\\`, `${this.virtualRoot}/`)
    return result
  }
}
