// Opt-in real-model regression: node scripts/permission-smoke.mjs
// Only writes a temporary file; uses the plugin's existing ChatGPT login.
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexAppServerAdapter } from '../lib/index.js'
import { AppServer } from '../lib/app-server.js'

const dir = await mkdtemp(join(tmpdir(), 'dsh-permission-smoke-'))
const server = new AppServer()
const adapter = new CodexAppServerAdapter(server)
try {
  for (const denied of [false, true]) {
    const messages = [{ role: 'user', id: `u-${denied}`, content: [{ type: 'text', text:
      'Use the provided write_probe tool to write the permission probe. Report whether the tool actually succeeded. Do not use native tools.' }] }]
    const options = {
      provider: 'openai-codex', model: process.env.DSH_SMOKE_MODEL ?? 'gpt-5.6-sol',
      sessionId: `permission-smoke-${Date.now()}-${denied}`, reasoningEffort: 'low',
      system: 'You are testing a Harness dynamic tool. Attempt the user-requested operation through that tool and respect its result.',
      tools: [{ name: 'write_probe', description: 'Write the isolated temporary permission probe through Harness.', parameters: { type: 'object', properties: {}, additionalProperties: false } }],
      signal: AbortSignal.timeout(55000),
    }
    const first = await Array.fromAsync(adapter.stream({ ...options, messages }))
    const call = first.find(c => c.type === 'block-end' && c.block.type === 'tool-call')?.block
    assert.equal(call?.name, 'write_probe', JSON.stringify(first))
    const path = join(dir, denied ? 'denied.txt' : 'allowed.txt')
    if (!denied) await writeFile(path, 'permission-probe-ok')
    messages.push({ role: 'assistant', content: [call] })
    messages.push({ role: 'user', content: [{ type: 'tool-result', toolCallId: call.id, isError: denied,
      content: [{ type: 'text', text: denied ? 'Harness denied write: current file policy is read-only. File was not created. No escalation is available.' : 'Write succeeded. Read-back verified: permission-probe-ok.' }] }] })
    const second = await Array.fromAsync(adapter.stream({ ...options, messages }))
    const answer = second.filter(c => c.type === 'block-end' && c.block.type === 'text').map(c => c.block.text).join('')
    assert.equal(second.at(-1).reason.kind, 'stop')
    if (!denied) assert.equal(await readFile(path, 'utf8'), 'permission-probe-ok')
    else await assert.rejects(readFile(path), { code: 'ENOENT' })
    console.log(JSON.stringify({ denied, toolCalled: call.name, answer }))
  }
} finally {
  server.close()
  await rm(dir, { recursive: true, force: true })
}
