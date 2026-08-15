#!/usr/bin/env node

import { appendFile, readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { DEFAULT_MANIFESTS } from '../preset/capabilities/manifests.mjs'
import { CapabilityRegistry } from '../preset/capabilities/registry.mjs'

const execFile = promisify((file, args, options, callback) => {
  const child = spawn(file, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.on('error', (error) => callback(error))
  child.on('close', (code) => callback(null, { code, stdout, stderr }))
})

function jsonOutput(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

async function logEvent(type, data) {
  const path = process.env.DSH_SESSION_EVENT_LOG
  if (!path) return
  await appendFile(path, `${JSON.stringify({ type, data, at: new Date().toISOString() })}\n`, 'utf8')
}

function parseInput(args) {
  const index = args.indexOf('--input-json')
  if (index < 0) return {}
  const value = args[index + 1]
  if (value === undefined) throw new Error('--input-json requires a JSON value')
  return JSON.parse(value)
}

async function gitReview(cwd) {
  const [branch, status, diff] = await Promise.all([
    execFile('git', ['branch', '--show-current'], { cwd }),
    execFile('git', ['status', '--short'], { cwd }),
    execFile('git', ['diff', '--stat'], { cwd }),
  ])
  return {
    branch: branch.stdout.trim(),
    changedFiles: status.stdout.split(/\r?\n/).filter(Boolean),
    diffStat: diff.stdout.trim(),
  }
}

async function ciInspect(cwd) {
  try {
    const packageJson = JSON.parse(await readFile(`${cwd}/package.json`, 'utf8'))
    return { scripts: packageJson.scripts ?? {}, package: packageJson.name ?? '' }
  } catch {
    return { scripts: {}, package: '' }
  }
}

async function externalProvider(capabilityId, input) {
  const command = process.env.DSH_CAPABILITY_PROVIDER
  if (!command) return { ok: false, status: 'unavailable', capabilityId, error: 'DSH_CAPABILITY_PROVIDER is not configured' }
  const args = process.env.DSH_CAPABILITY_PROVIDER_ARGS ? JSON.parse(process.env.DSH_CAPABILITY_PROVIDER_ARGS) : []
  const child = spawn(command, args, { cwd: process.env.DSH_CWD ?? process.cwd(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.stdin.end(JSON.stringify({ capabilityId, input }))
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', resolve)
  })
  let result
  try { result = JSON.parse(stdout) } catch { result = { output: stdout.trim() } }
  return { ok: code === 0, status: code === 0 ? 'completed' : 'failed', capabilityId, result, stderr: stderr.trim() }
}

function resolveCommand(args) {
  if (args[0] === 'capabilities' || args[0] === 'caps') return { kind: 'list' }
  if (args[0] === 'describe') return { kind: 'describe', id: args[1] }
  if (args[0] === 'call') args = args.slice(1)
  if (args.length === 0) return { kind: 'list' }
  if (args[0].includes('.')) return { kind: 'call', id: args[0], args: args.slice(1) }
  if (args[1] && !args[1].startsWith('-')) return { kind: 'call', id: `${args[0]}.${args[1]}`, args: args.slice(2) }
  return { kind: 'call', id: args[0], args: args.slice(1) }
}

async function main(argv) {
  const registry = new CapabilityRegistry(DEFAULT_MANIFESTS)
  const command = resolveCommand(argv)
  if (command.kind === 'list') return jsonOutput({ capabilities: registry.list() })
  if (command.kind === 'describe') {
    const entry = registry.get(command.id)
    if (!entry) throw new Error(`unknown capability: ${command.id}`)
    return jsonOutput(entry)
  }

  const entry = registry.get(command.id)
  if (!entry) throw new Error(`unknown capability: ${command.id}`)
  const input = parseInput(command.args)
  await logEvent('oh-my-dsh/capability-call', { capabilityId: entry.id, input })
  const cwd = process.env.DSH_CWD ?? process.cwd()
  let result
  if (entry.id === 'git.review') result = { ok: true, status: 'completed', capabilityId: entry.id, result: await gitReview(cwd) }
  else if (entry.id === 'ci.inspect') result = { ok: true, status: 'completed', capabilityId: entry.id, result: await ciInspect(cwd) }
  else result = await externalProvider(entry.id, input)
  await logEvent('oh-my-dsh/capability-result', result)
  jsonOutput(result)
  if (result.ok === false) process.exitCode = 1
}

main(process.argv.slice(2)).catch((error) => {
  jsonOutput({ ok: false, status: 'error', error: error instanceof Error ? error.message : String(error) })
  process.exitCode = 1
})
