import assert from 'node:assert/strict'
import test from 'node:test'

import { WorkspacePathMap, toMsysPath } from '../preset/shell/path-map.mjs'

test('Windows paths map to MSYS paths and virtual workspace output', () => {
  const map = new WorkspacePathMap('F:\\oh-my-dsh')
  assert.equal(toMsysPath('F:\\oh-my-dsh\\docs'), '/f/oh-my-dsh/docs')
  assert.equal(map.toVirtualPath('F:\\oh-my-dsh\\docs\\plan.md'), '/workspace/docs/plan.md')
  assert.equal(map.toVirtualPath('/f/oh-my-dsh/docs/plan.md'), '/workspace/docs/plan.md')
  assert.equal(map.toShellPath('/workspace/docs/plan.md'), '/f/oh-my-dsh/docs/plan.md')
  assert.equal(map.rewriteCommand('cd /workspace && cat "/workspace/docs/plan.md"'), 'cd /f/oh-my-dsh && cat "/f/oh-my-dsh/docs/plan.md"')
  assert.equal(map.rewriteOutput('cwd=F:\\oh-my-dsh\\docs and /f/oh-my-dsh/docs'), 'cwd=/workspace/docs and /workspace/docs')
})
