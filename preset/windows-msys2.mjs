import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { WorkspacePathMap } from './shell/path-map.mjs'

export const name = 'windows-msys2'
export const inject = ['terminals']

const DEFAULT_CANDIDATES = [
  'C:\\msys64\\usr\\bin\\bash.exe',
  'C:\\msys64\\ucrt64\\bin\\bash.exe',
  'C:\\Program Files\\Git\\bin\\bash.exe',
]

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

export function resolveShellPath(config = {}) {
  const candidates = [config.shellPath, process.env.DSH_MSYS2_BASH, ...DEFAULT_CANDIDATES]
    .filter((value) => typeof value === 'string' && value.length > 0)
  const resolved = candidates.find((candidate) => existsSync(candidate))
  if (!resolved) {
    throw new Error('MSYS2 bash was not found; set DSH_MSYS2_BASH to bash.exe')
  }
  return resolved
}

export function extractCompletion(text, marker) {
  const index = text.indexOf(marker)
  if (index < 0) return undefined
  const before = text.slice(0, index)
  const rest = text.slice(index + marker.length)
  const match = rest.match(/^:(\d+)/)
  return {
    output: before,
    exitCode: match ? Number(match[1]) : 0,
    consumed: index + marker.length + (match?.[0].length ?? 0),
  }
}

class SendOperation {
  constructor(session, marker) {
    this.session = session
    this.marker = marker
    this.output = ''
    this.settled = false
    this.resolve = undefined
    this.done = new Promise((resolve) => { this.resolve = resolve })
  }

  append(text) {
    if (!this.settled) this.output += text
  }

  finish(result) {
    if (this.settled) return
    this.settled = true
    this.resolve(result)
  }

  readOutput() {
    const delta = this.output
    this.output = ''
    return { delta, truncated: false }
  }

  cancel() {
    if (this.settled) return false
    this.session.proc.kill('SIGINT')
    return true
  }
}

export class StdioBashSession {
  constructor(proc, pathMap, config = {}) {
    this.proc = proc
    this.pathMap = pathMap
    this.config = config
    this.buffer = ''
    this.scrollback = ''
    this.active = undefined
    this.exited = false
    this.exitCode = null
    this.exitSignal = null
    this.waiters = []
    this.motd = ''
    this.processOutput = (chunk) => {
      const text = this.pathMap.rewriteOutput(chunk.toString().replaceAll('\r\n', '\n').replaceAll('\r', '\n'))
      this.buffer += text
      this.scrollback = `${this.scrollback}${text}`.slice(-this.config.maxScrollbackChars)
      if (this.active) this.active.append(text)
      this.flushWaiters()
    }
    proc.stdout.on('data', this.processOutput)
    proc.stderr.on('data', this.processOutput)
    proc.on('error', (error) => {
      this.exited = true
      this.exitCode = null
      this.exitSignal = null
      this.spawnError = error
      for (const waiter of this.waiters.splice(0)) waiter.resolve(undefined)
      if (this.active && !this.active.settled) {
        this.active.finish({
          viewport: this.active.output,
          waitReason: 'session_exit',
          sessionStatus: { kind: 'exited', exitCode: null, signal: null },
          truncated: false,
        })
        this.active = undefined
      }
    })
    proc.on('exit', (code, signal) => {
      this.exited = true
      this.exitCode = code
      this.exitSignal = signal
      for (const waiter of this.waiters.splice(0)) waiter.resolve(undefined)
      if (this.active && !this.active.settled) {
        this.active.finish({
          viewport: this.active.output,
          waitReason: 'session_exit',
          sessionStatus: { kind: 'exited', exitCode: code, signal },
          truncated: false,
        })
        this.active = undefined
      }
    })
  }

  flushWaiters() {
    for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.waiters[index]
      const completion = extractCompletion(this.buffer, waiter.marker)
      if (completion === undefined) continue
      this.buffer = this.buffer.slice(completion.consumed)
      this.waiters.splice(index, 1)
      waiter.resolve(completion)
    }
  }

  waitForMarker(marker, timeoutMs) {
    const completion = extractCompletion(this.buffer, marker)
    if (completion !== undefined) {
      this.buffer = this.buffer.slice(completion.consumed)
      return Promise.resolve(completion)
    }
    return new Promise((resolve) => {
      const waiter = { marker, resolve }
      this.waiters.push(waiter)
      const timer = setTimeout(() => {
        const position = this.waiters.indexOf(waiter)
        if (position >= 0) this.waiters.splice(position, 1)
        resolve(undefined)
      }, timeoutMs)
      const originalResolve = waiter.resolve
      waiter.resolve = (value) => {
        clearTimeout(timer)
        originalResolve(value)
      }
    })
  }

  async initialize(signal) {
    const marker = `__DSH_READY_${crypto.randomUUID().replaceAll('-', '')}__`
    const path = shellQuote('/usr/local/bin:/usr/bin:/bin')
    const workspace = shellQuote(this.pathMap.msysWorkspaceRoot)
    this.proc.stdin.write(`export PATH=${path}:"$PATH"; cd -- ${workspace}; printf '\\n${marker}\\n'\n`)
    const completion = await this.waitForMarker(marker, this.config.timeoutMs)
    signal?.throwIfAborted()
    if (!completion) throw new Error('MSYS2 bash did not become ready before timeout')
    this.motd = completion.output
  }

  startSend(request) {
    if (this.active) throw new Error('persistent bash already has an active send')
    const marker = `__DSH_DONE_${crypto.randomUUID().replaceAll('-', '')}__`
    const operation = new SendOperation(this, marker)
    this.active = operation
    const text = this.pathMap.rewriteCommand(request.text)
    const command = request.submit === false
      ? text
      : `{ ${text}\nstatus=$?; printf '\\n${marker}:%s\\n' "$status"; }`
    this.proc.stdin.write(`${command}\n`)
    if (request.submit === false) {
      setTimeout(() => {
        operation.finish({
          viewport: operation.output,
          waitReason: 'inferred_idle',
          sessionStatus: this.status(),
          truncated: false,
        })
        this.active = undefined
      }, this.config.idleMs)
      return operation
    }

    this.waitForMarker(marker, this.config.timeoutMs).then((completion) => {
      if (operation.settled) return
      if (!completion) {
        this.proc.kill()
        operation.finish({
          viewport: operation.output,
          waitReason: 'timeout',
          sessionStatus: this.status(),
          truncated: false,
        })
      } else {
        operation.finish({
          viewport: completion.output,
          waitReason: 'stdin_read',
          sessionStatus: this.status(),
          truncated: false,
        })
      }
      this.active = undefined
    })
    return operation
  }

  read({ offset = 0, count = 500 } = {}) {
    const lines = this.scrollback.split('\n')
    const totalLines = this.scrollback.length === 0 ? 0 : lines.length
    const end = Math.max(0, lines.length - offset)
    const start = Math.max(0, end - count)
    const text = lines.slice(start, end).join('\n')
    return { text, totalLines, lineBegin: offset, lineEnd: offset + (text.length === 0 ? 0 : text.split('\n').length), truncated: false }
  }

  status() {
    return this.exited ? { kind: 'exited', exitCode: this.exitCode, signal: this.exitSignal } : { kind: 'running' }
  }

  async signal(signal) {
    if (signal === 'SIGINT') this.proc.kill('SIGINT')
    else this.proc.kill(signal)
    return { delivered: true, targetPgid: this.proc.pid ?? 0 }
  }

  async close() {
    if (!this.exited) {
      this.proc.kill()
      await new Promise((resolve) => this.proc.once('exit', resolve))
    }
  }
}

export class WindowsMsys2Backend {
  type = 'shell'

  constructor(config = {}) {
    this.config = {
      // This backend owns a persistent stdin/stdout pipe, not a TTY.  An
      // interactive Bash adds prompts, command echo, and job-control noise to
      // tool results, so keep the process non-interactive while preserving its
      // shell state across requests.
      shellArgs: ['--noprofile', '--norc'],
      timeoutMs: 30000,
      idleMs: 100,
      maxScrollbackChars: 128000,
      ...config,
    }
  }

  async spawn(spec) {
    const workspaceRoot = spec.cwd ?? this.config.workspaceRoot ?? process.cwd()
    const pathMap = new WorkspacePathMap(workspaceRoot)
    const shellPath = resolveShellPath(this.config)
    const proc = spawn(shellPath, this.config.shellArgs, {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        TERM: 'dumb',
        PAGER: 'cat',
        GIT_PAGER: 'cat',
        DSH_SHELL: '1',
        DSH_WORKSPACE: '/workspace',
        DSH_REAL_WORKSPACE: pathMap.msysWorkspaceRoot,
        PS1: '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const session = new StdioBashSession(proc, pathMap, this.config)
    try {
      await session.initialize(spec.signal)
      return session
    } catch (error) {
      await session.close().catch(() => {})
      throw error
    }
  }
}

export function apply(ctx, config) {
  ctx.terminals.registerBackend(new WindowsMsys2Backend(config))
}
