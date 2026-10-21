import type { OwnerCommand } from '../approval/index.ts'
import { COMMAND_OPTIONS } from './constants.ts'
import type { CommandDefinition } from './types.ts'

/** One slash command per owner command; those that take an argument get one optional string option. */
export function toCommandDefinitions(
  commands: readonly OwnerCommand[],
): readonly CommandDefinition[] {
  return commands.map((command) => {
    const option = COMMAND_OPTIONS[command.name]
    return option === undefined
      ? { name: command.name, description: command.description }
      : { name: command.name, description: command.description, option }
  })
}
