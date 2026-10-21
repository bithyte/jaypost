import { expect, test } from 'vite-plus/test'
import { OWNER_COMMANDS } from '../../src/approval/index.ts'
import { toCommandDefinitions } from '../../src/discord/index.ts'
import { QUIET_COMMANDS } from '../../src/quiet/index.ts'

test('commands with an argument get one optional string option', () => {
  expect(toCommandDefinitions([...OWNER_COMMANDS, ...QUIET_COMMANDS])).toEqual([
    { name: 'pending', description: 'List open requests' },
    { name: 'cancel', description: 'Reject all open requests with their timeout answers' },
    {
      name: 'history',
      description: 'Show recent answers',
      option: { name: 'count', description: 'How many answers to show (1-20)' },
    },
    {
      name: 'mute',
      description: 'Silence notifications for a while (default 1h)',
      option: { name: 'duration', description: 'How long, like 30m, 2h or 1d' },
    },
    { name: 'unmute', description: 'End the mute early' },
    {
      name: 'quiet',
      description: 'Show or set quiet hours',
      option: { name: 'hours', description: 'Quiet hours like 22-7, or off' },
    },
  ])
})

test('no commands make no definitions', () => {
  expect(toCommandDefinitions([])).toEqual([])
})
