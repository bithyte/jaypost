import type { SnippetId } from './types.ts'

/** Code shown on the page; each one must appear in the root README (see SnippetChecker). */
export const SNIPPETS: Readonly<Record<SnippetId, string>> = {
  npxInit: 'npx jaypost init',
  installScript: 'curl -fsSL https://unpkg.com/jaypost/install.sh | sh',
  installScriptPages: 'curl -fsSL https://bithyte.github.io/jaypost/install.sh | sh',
  pair: '/start ABCD-EFGH',
  mcpAdd: 'claude mcp add jaypost -- jaypost mcp',
  shellSend: "answer=$(jaypost send request 'Deploy?' -o Approve -d Decline --timeout 60)",
  curlRequest: `curl -s -X POST http://127.0.0.1:8787/request \\
  -H 'content-type: application/json' \\
  -H "authorization: Bearer $(cat ~/.config/jaypost/token)" \\
  -d '{"text":"Deploy?","options":["Approve","Decline"],"timeoutOption":"Decline","timeout":60}'`,
  nodeClient: `import { Client } from 'jaypost'

const client = new Client({ project: 'deploy' })
const { answer, timedOut } = await client.request({
  text: 'Deploy?',
  options: ['Approve', 'Decline'],
  timeoutOption: 'Decline',
  timeout: 60,
})
await client.notify({ text: 'backup finished' })`,
  hookSettings: `{
  "hooks": {
    "PermissionRequest": [
      {
        "hooks": [{ "type": "command", "command": "jaypost hook", "timeout": 360 }]
      }
    ],
    "Notification": [
      {
        "matcher": "idle_prompt|elicitation_dialog|agent_needs_input",
        "hooks": [{ "type": "command", "command": "jaypost hook" }]
      }
    ]
  }
}`,
}
