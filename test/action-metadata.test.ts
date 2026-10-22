import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { expect, test } from 'vite-plus/test'

type Action = {
  readonly name: string
  readonly description: string
  readonly branding: { readonly icon: string; readonly color: string }
  readonly inputs: Record<string, { readonly default?: string }>
  readonly outputs: Record<string, { readonly value: string }>
  readonly runs: {
    readonly using: string
    readonly steps: readonly {
      readonly id: string
      readonly run: string
      readonly env: Record<string, string>
    }[]
  }
}

function readAction(): Action {
  const source = readFileSync(join(import.meta.dirname, '..', 'action.yml'), 'utf8')
  return parse(source) as Action
}

test('every input reaches the script through env', () => {
  const action = readAction()
  const step = action.runs.steps[0]
  if (step === undefined) {
    throw new Error('action.yml has no step')
  }
  expect(action.runs.using).toBe('composite')
  expect(Object.keys(action.inputs)).toEqual([
    'command',
    'text',
    'options',
    'default',
    'timeout',
    'allow-text',
    'project',
    'format',
    'provider',
    'bot-token',
    'owner-id',
  ])
  expect(step.env).toEqual({
    INPUT_COMMAND: '${{ inputs.command }}',
    INPUT_TEXT: '${{ inputs.text }}',
    INPUT_OPTIONS: '${{ inputs.options }}',
    INPUT_DEFAULT: '${{ inputs.default }}',
    INPUT_TIMEOUT: '${{ inputs.timeout }}',
    INPUT_ALLOW_TEXT: '${{ inputs.allow-text }}',
    INPUT_PROJECT: '${{ inputs.project }}',
    INPUT_FORMAT: '${{ inputs.format }}',
    JAYPOST_MODE: 'direct',
    JAYPOST_PROVIDER: '${{ inputs.provider }}',
    JAYPOST_BOT_TOKEN: '${{ inputs.bot-token }}',
    JAYPOST_OWNER_ID: '${{ inputs.owner-id }}',
  })
  expect(step.run).not.toContain('${{')
  expect(action.outputs.answer?.value).toBe(`\${{ steps.${step.id}.outputs.answer }}`)
})

test('has what the marketplace needs', () => {
  const action = readAction()
  expect(action.name).toBe('jaypost approval')
  expect(action.description.length).toBeLessThanOrEqual(125)
  expect(action.branding).toEqual({ icon: 'message-circle', color: 'blue' })
  expect(action.inputs.command?.default).toBe('request')
})
