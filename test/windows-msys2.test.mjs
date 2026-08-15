import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { extractCompletion, resolveShellPath, WindowsMsys2Backend } from '../preset/windows-msys2.mjs'

const localMsys2Bash = join(process.cwd(), 'msys64', 'usr', 'bin', 'bash.exe')
const realMsys2Bash = existsSync(localMsys2Bash)
  ? localMsys2Bash
  : process.env.DSH_MSYS2_BASH

test('stdio shell completion parsing tolerates marker fragments', () => {
  assert.deepEqual(extractCompletion('output\n__DSH_DONE_x__:7\n', '__DSH_DONE_x__'), {
    output: 'output\n',
    exitCode: 7,
    consumed: 23,
  })
  assert.equal(extractCompletion('still running', '__DSH_DONE_x__'), undefined)
})

test('shell discovery fails clearly when no configured executable exists', () => {
  assert.throws(() => resolveShellPath({ shellPath: 'Z:\\missing\\bash.exe' }), /DSH_MSYS2_BASH/)
})

test('real MSYS2 maps virtual workspace input and keeps core commands available', {
  skip: process.platform !== 'win32' || !realMsys2Bash,
}, async () => {
  const backend = new WindowsMsys2Backend({ shellPath: realMsys2Bash, timeoutMs: 10000 })
  const session = await backend.spawn({ cwd: process.cwd() })
  try {
    const result = await session.startSend({
      text: 'command -v ls; command -v cat; test -f /workspace/modeltest/README.md; cd /workspace/modeltest; pwd; sed -n "1p" README.md',
      submit: true,
    }).done
    assert.match(result.viewport, /\/usr\/bin\/ls/)
    assert.match(result.viewport, /\/usr\/bin\/cat/)
    assert.match(result.viewport, /\/workspace/)
    assert.match(result.viewport, /modeltest/)
    assert.doesNotMatch(result.viewport, /command not found|no job control|^>/m)
  } finally {
    await session.close()
  }
})
