/** Small, stable capability catalog. Providers own the actual enterprise work. */
export const DEFAULT_MANIFESTS = [
  {
    id: 'git.review',
    summary: 'Inspect the current repository status and diff facts.',
    use: 'dshx git review --format json',
    output: 'JSON containing branch, changed files, and diff summary.',
  },
  {
    id: 'ci.inspect',
    summary: 'Inspect configured checks and their latest local status.',
    use: 'dshx ci inspect --format json',
    output: 'JSON containing check names and available status facts.',
  },
  {
    id: 'task.ledger',
    summary: 'Read or update the durable task ledger through the host seam.',
    use: 'dshx task ledger --format json',
    output: 'JSON containing task state and ledger facts.',
  },
  {
    id: 'subagent.spawn',
    summary: 'Delegate a bounded subtask to a host-managed worker.',
    use: 'dshx subagent spawn --format json',
    output: 'JSON containing the created worker and its result handle.',
  },
  {
    id: 'workflow.run',
    summary: 'Run a host-managed workflow with explicit input.',
    use: 'dshx workflow run --format json',
    output: 'JSON containing workflow status and output facts.',
  },
  {
    id: 'mcp.call',
    summary: 'Call an approved MCP capability through the host seam.',
    use: 'dshx mcp call --format json',
    output: 'JSON containing the MCP result.',
  },
  {
    id: 'artifact.publish',
    summary: 'Publish a validated artifact through the host provider.',
    use: 'dshx artifact publish --format json',
    output: 'JSON containing the publication result and artifact reference.',
  },
]
