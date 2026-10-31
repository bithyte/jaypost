import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { Exec, ExecOptions } from '@jaypost/store'
import { parseContainerAdminKey } from './admin-key.ts'
import { DOCKERIGNORE, PACKAGE_NAME } from './constants.ts'
import { readContainerSecrets, readEnvApiToken, removeEnvKey, writeEnvFile } from './envfile.ts'
import { requireRecordOwner } from './state.ts'
import { formatComposeYaml, formatDockerfile, formatEnvFile } from './templates.ts'
import type { InstallRecord, Secrets, Target, TargetDeps } from './types.ts'

async function tryExec(exec: Exec, command: string, args: readonly string[]) {
  try {
    return await exec(command, args)
  } catch {
    return undefined
  }
}

/**
 * Docker Compose target; writes its files under the compose directory and drives `docker compose`.
 */
export function createComposeTarget(deps: TargetDeps): Target {
  const { exec, paths, providers } = deps
  const file = join(paths.composeDirectory, 'compose.yaml')
  const envPath = join(paths.composeDirectory, '.env')
  const compose = (args: readonly string[], options?: ExecOptions) =>
    exec('docker', ['compose', '-f', file, ...args], options)
  /** The bot service's image ID, or empty when there's none or compose can't tell. */
  async function readImageId(): Promise<string> {
    const result = await tryExec(exec, 'docker', ['compose', '-f', file, 'images', '-q', 'bot'])
    return result === undefined || result.code !== 0 ? '' : result.stdout.trim()
  }
  const target: Target = {
    name: 'compose',
    async available() {
      const version = await tryExec(exec, 'docker', ['compose', 'version'])
      if (version === undefined) {
        return { ok: false, reason: 'docker not installed' }
      }
      if (version.code !== 0) {
        return { ok: false, reason: 'docker compose v2 not available' }
      }
      const info = await tryExec(exec, 'docker', ['info'])
      if (info === undefined || info.code !== 0) {
        return { ok: false, reason: "can't talk to docker (not in the docker group?)" }
      }
      return { ok: true }
    },
    async install(options): Promise<InstallRecord> {
      mkdirSync(paths.composeDirectory, { recursive: true })
      if (options.tarball !== undefined) {
        const destination = join(paths.composeDirectory, basename(options.tarball))
        if (resolve(options.tarball) !== resolve(destination)) {
          copyFileSync(options.tarball, destination)
        }
      }
      // Keep the credentials out of the build context.
      writeFileSync(join(paths.composeDirectory, '.dockerignore'), DOCKERIGNORE)
      writeFileSync(
        join(paths.composeDirectory, 'Dockerfile'),
        formatDockerfile({
          version: options.version,
          ...(options.tarball ? { tarball: options.tarball } : {}),
        }),
      )
      writeFileSync(file, formatComposeYaml(options.port, options.exposed ?? false))
      writeEnvFile(
        envPath,
        formatEnvFile({
          provider: options.provider,
          port: options.port,
          settings: options.settings,
          auth: options.auth,
          ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
        }),
      )
      const result = await compose(
        ['up', '-d', '--build'],
        options.output === undefined ? { inherit: true } : { onOutput: options.output },
      )
      if (result.code !== 0) {
        throw new Error(`docker compose up failed (exit ${result.code})`)
      }
      return {
        target: 'compose',
        provider: options.provider.name,
        port: options.port,
        version: options.version,
        ...(options.exposed ? { exposed: true } : {}),
      }
    },
    async upgrade(options, previous): Promise<InstallRecord> {
      const oldImageId = await readImageId()
      // `up -d --build` recreates the container when the image changed.
      const record = await target.install({ ...options, exposed: previous.exposed ?? false })
      if (oldImageId === '' || oldImageId === (await readImageId())) {
        return record
      }
      const result = await tryExec(exec, 'docker', ['image', 'rm', oldImageId])
      if (result === undefined || result.code !== 0) {
        const reason = result?.stderr.trim() || (result ? `exit ${result.code}` : 'docker failed')
        options.print(`Couldn't remove the old image ${oldImageId}: ${reason}`)
      }
      return record
    },
    async readSecrets(): Promise<Secrets> {
      return readContainerSecrets(envPath, providers, () =>
        compose(['run', '--rm', '--no-deps', 'bot', PACKAGE_NAME, 'owner', 'get']),
      )
    },
    async remove(_record, purge) {
      const result = await compose(purge ? ['down', '-v'] : ['down'])
      if (result.code !== 0) {
        throw new Error(`docker compose down failed: ${result.stderr.trim()}`)
      }
      if (purge) {
        rmSync(paths.composeDirectory, { recursive: true, force: true })
      }
    },
    async restart() {
      const result = await compose(['up', '-d', '--force-recreate'])
      if (result.code !== 0) {
        throw new Error(`docker compose up failed (exit ${result.code})`)
      }
    },
    async start() {
      const result = await compose(['start'])
      if (result.code !== 0) {
        throw new Error(`docker compose start failed (exit ${result.code})`)
      }
    },
    async stop() {
      const result = await compose(['stop'])
      if (result.code !== 0) {
        throw new Error(`docker compose stop failed (exit ${result.code})`)
      }
    },
    async readApiToken() {
      return readEnvApiToken(envPath)
    },
    async forgetSeedOwner(record) {
      removeEnvKey(envPath, requireRecordOwner(providers, record).envVar)
    },
    async clearOwner(record) {
      await target.forgetSeedOwner(record)
      const result = await compose([
        'run',
        '--rm',
        '--no-deps',
        'bot',
        PACKAGE_NAME,
        'owner',
        'clear',
      ])
      if (result.code !== 0) {
        throw new Error(`couldn't clear the owner in the container: ${result.stderr.trim()}`)
      }
    },
    async readAuditLog() {
      const result = await compose([
        'run',
        '--rm',
        '--no-deps',
        '-T',
        'bot',
        PACKAGE_NAME,
        'audit',
        'dump',
      ])
      if (result.code !== 0) {
        throw new Error(`couldn't read the log from the container: ${result.stderr.trim()}`)
      }
      return result.stdout
    },
    async readAdminKey() {
      const result = await compose([
        'run',
        '--rm',
        '--no-deps',
        '-T',
        'bot',
        PACKAGE_NAME,
        'admin-key',
        'show',
      ])
      if (result.code !== 0) {
        throw new Error(`couldn't read the admin key from the container: ${result.stderr.trim()}`)
      }
      return parseContainerAdminKey(result.stdout)
    },
    async isRunning() {
      const result = await compose(['ps', '--status', 'running', '-q', 'bot'])
      return result.code === 0 && result.stdout.trim() !== ''
    },
    logsHint() {
      return `docker compose -f ${file} logs -f`
    },
  }
  return target
}
