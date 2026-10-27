import { findOwnerSetting, formatCode } from '@jaypost/core'
import type { Provider, SettingValue, SettingValues } from '@jaypost/core'
import { isPending } from '@jaypost/store'
import type { KeyDetails, KeyRecord, KeyTarget, NotFound, PairingRecord } from '@jaypost/store'
import type { AdminKey, AdminPairing, CreateKeyBody } from '@jaypost/protocol'
import type { AdminFailure, Parsed } from '../server/index.ts'

/** The 404 of an unknown id; ids aren't secret, so it names it. */
export function toNotFound(found: NotFound): AdminFailure {
  return { kind: 'notFound', error: `unknown ${found.what} ${JSON.stringify(found.id)}` }
}

export function toInvalid(error: string): AdminFailure {
  return { kind: 'invalid', error }
}

/**
 * A new bot's settings, each parsed by its provider setting. Refuses the owner setting, unknown
 * names and missing required settings. Errors name a setting by its description, never by a
 * name or value from `raw`. Never throws.
 */
export function parseBotSettings(
  provider: Provider,
  raw: Readonly<Record<string, SettingValue>>,
): Parsed<SettingValues> {
  const ownerSetting = findOwnerSetting(provider)
  if (ownerSetting !== undefined && Object.hasOwn(raw, ownerSetting.configKey)) {
    return { ok: false, error: 'settings may not set the owner' }
  }
  const allowed = provider.settings.filter((setting) => !setting.owner)
  const isKnown = (name: string): boolean => allowed.some((setting) => setting.configKey === name)
  if (!Object.keys(raw).every(isKnown)) {
    const names = allowed.map((setting) => setting.configKey).join(', ')
    return { ok: false, error: `settings may only hold ${names}` }
  }
  const values: Record<string, SettingValue> = {}
  for (const setting of allowed) {
    if (!Object.hasOwn(raw, setting.configKey)) {
      if (setting.required) {
        return { ok: false, error: `missing ${setting.description}` }
      }
      continue
    }
    const value = setting.parse(raw[setting.configKey])
    if (value === undefined) {
      return { ok: false, error: `invalid ${setting.description}` }
    }
    values[setting.configKey] = value
  }
  return { ok: true, value: values }
}

/** Which pairing a POST /admin/keys body points to; the schema made sure there's exactly one. */
export function toKeyTarget(body: CreateKeyBody): KeyTarget | undefined {
  if (body.bot !== undefined) {
    return { kind: 'newPairing', botId: body.bot }
  }
  if (body.pairing !== undefined) {
    return { kind: 'pairing', pairingId: body.pairing }
  }
  return body.sameAsKey === undefined ? undefined : { kind: 'sameAsKey', keyId: body.sameAsKey }
}

export function toKeyDetails(body: CreateKeyBody): KeyDetails {
  return {
    ...(body.label === undefined ? {} : { label: body.label }),
    ...(body.externalId === undefined ? {} : { externalId: body.externalId }),
  }
}

/** A pairing as the admin routes show it, with its keys' ids and its code while pending. */
export function toAdminPairing(pairing: PairingRecord, keys: readonly KeyRecord[]): AdminPairing {
  return {
    id: pairing.id,
    bot: pairing.botId,
    ...(pairing.person === undefined ? {} : { person: pairing.person }),
    state: pairing.person === undefined ? 'pending' : 'paired',
    ...(isPending(pairing) ? { code: formatCode(pairing.code) } : {}),
    keys: keys.filter((key) => key.pairingId === pairing.id).map((key) => key.id),
  }
}

/** A key as the admin routes show it; never its hash. */
export function toAdminKey(key: KeyRecord, botId: string): AdminKey {
  return {
    id: key.id,
    pairing: key.pairingId,
    bot: botId,
    ...(key.label === undefined ? {} : { label: key.label }),
    ...(key.externalId === undefined ? {} : { externalId: key.externalId }),
    createdAt: key.createdAt,
  }
}
