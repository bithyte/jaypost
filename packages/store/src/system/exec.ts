import { spawn } from 'node:child_process'
import type { Exec } from './types.ts'

/** Thrown by `realExec` when the binary doesn't exist. */
export class MissingCommandError extends Error {
  readonly command: string
  constructor(command: string) {
    super(`command ${JSON.stringify(command)} not found`)
    this.name = 'MissingCommandError'
    this.command = command
  }
}

/** Never rejects on a non-zero exit; rejects only when the binary doesn't exist. */
export const realExec: Exec = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      stdio: options.inherit && !options.onOutput ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    // A string decoder holds back a multi-byte character split across chunks until it's whole.
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
      options.onOutput?.(chunk)
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
      options.onOutput?.(chunk)
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        reject(new MissingCommandError(command))
      } else {
        reject(error)
      }
    })
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })
