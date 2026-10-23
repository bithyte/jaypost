import { expect, test, vi } from 'vite-plus/test'
import { QUIET_COMMANDS, QuietService } from '../../src/quiet/index.ts'
import type { QuietPatch, QuietServiceOptions } from '../../src/quiet/index.ts'

const ZONE = 'Europe/Bucharest'
const NOW = new Date('2026-07-15T11:00:00Z') // Wed 14:00 local
const NIGHT = { startMinute: 1380, endMinute: 480 }
const SUFFIX = 'Approvals still ping. /unmute to undo.'

function createService(
  options: QuietServiceOptions = {},
  save = vi.fn<(patch: QuietPatch) => void>(),
) {
  const log = vi.fn<(line: string) => void>()
  const service = new QuietService(save, { timeZone: ZONE, now: () => NOW, log, ...options })
  return { service, save, log }
}

test('/mute 2h mutes until two hours from now and saves it', () => {
  const { service, save } = createService()
  expect(service.handleCommand('mute', '2h')).toBe(`Muted until 16:00 (${ZONE}). ${SUFFIX}`)
  expect(save.mock.calls).toEqual([[{ mutedUntil: '2026-07-15T13:00:00.000Z' }]])
  expect(service.isQuiet()).toBe(true)
  expect(service.quietUntil()).toEqual(new Date('2026-07-15T13:00:00Z'))
})

test('/mute with no argument mutes for one hour', () => {
  const { service } = createService()
  expect(service.handleCommand('mute', '')).toBe(`Muted until 15:00 (${ZONE}). ${SUFFIX}`)
  expect(service.quietUntil()).toEqual(new Date('2026-07-15T12:00:00Z'))
})

test('/mute again replaces the end time', () => {
  const { service } = createService()
  service.handleCommand('mute', '2h')
  service.handleCommand('mute', '30m')
  expect(service.quietUntil()).toEqual(new Date('2026-07-15T11:30:00Z'))
})

test('/mute past today shows the weekday', () => {
  const { service } = createService()
  expect(service.handleCommand('mute', '1d')).toBe(`Muted until Thu 14:00 (${ZONE}). ${SUFFIX}`)
})

test.each(['2', '8d', 'soon'])('/mute %j replies with usage and changes nothing', (argument) => {
  const { service, save } = createService()
  expect(service.handleCommand('mute', argument)).toBe(
    'Use /mute 30m, /mute 2h or /mute 1d (up to 7d).',
  )
  expect(save).not.toHaveBeenCalled()
  expect(service.isQuiet()).toBe(false)
})

test('/unmute clears the mute', () => {
  const { service, save } = createService()
  service.handleCommand('mute', '2h')
  save.mockClear()
  expect(service.handleCommand('unmute', '')).toBe('Unmuted.')
  expect(save.mock.calls).toEqual([[{ mutedUntil: null }]])
  expect(service.isQuiet()).toBe(false)
})

test('/unmute inside quiet hours says the window still applies', () => {
  const night = new Date('2026-07-15T20:30:00Z')
  const { service } = createService({
    quietHours: NIGHT,
    mutedUntil: new Date('2026-07-15T21:30:00Z'),
    now: () => night,
  })
  expect(service.handleCommand('unmute', '')).toBe(
    'Unmuted.\nQuiet hours 23:00-08:00 are on right now.',
  )
  expect(service.isQuiet()).toBe(true)
})

test('/quiet sets and saves the window', () => {
  const { service, save } = createService()
  expect(service.handleCommand('quiet', '23-8')).toBe(`Quiet hours set to 23:00-08:00 (${ZONE}).`)
  expect(save.mock.calls).toEqual([[{ quietHours: '23:00-08:00' }]])
})

test('/quiet set while inside the window adds quiet now', () => {
  const { service } = createService()
  expect(service.handleCommand('quiet', '13:00-15:00')).toBe(
    `Quiet hours set to 13:00-15:00 (${ZONE}).\nQuiet now.`,
  )
  expect(service.isQuiet()).toBe(true)
})

test.each(['off', 'OFF', ' Off '])('/quiet %j clears the window', (argument) => {
  const { service, save } = createService({ quietHours: NIGHT })
  expect(service.handleCommand('quiet', argument)).toBe('Quiet hours off.')
  expect(save.mock.calls).toEqual([[{ quietHours: null }]])
})

test.each(['25-8', '22-22', 'later'])(
  '/quiet %j replies with usage and changes nothing',
  (argument) => {
    const { service, save } = createService({ quietHours: NIGHT })
    expect(service.handleCommand('quiet', argument)).toBe('Use /quiet 23:00-08:00 or /quiet off.')
    expect(save).not.toHaveBeenCalled()
  },
)

test('/quiet alone shows the settings', () => {
  const first = createService({ quietHours: NIGHT })
  expect(first.service.handleCommand('quiet', '')).toBe(
    `Quiet hours: 23:00-08:00\nTime zone: ${ZONE}\nNot muted.\nNotifications ping right now.`,
  )
  const second = createService()
  second.service.handleCommand('mute', '2h')
  expect(second.service.handleCommand('quiet', '')).toBe(
    `Quiet hours: off\nTime zone: ${ZONE}\nMuted until 16:00.\nNotifications are silent right now.`,
  )
})

test('an expired mute from the config is not quiet', () => {
  const { service } = createService({ mutedUntil: new Date('2026-07-15T10:00:00Z') })
  expect(service.isQuiet()).toBe(false)
  expect(service.handleCommand('quiet', '')).toContain('\nNot muted.\n')
})

test('a failed save still applies the change and warns', () => {
  const save = vi.fn<(patch: QuietPatch) => void>(() => {
    throw new Error('EACCES: permission denied')
  })
  const { service, log } = createService({}, save)
  expect(service.handleCommand('mute', '2h')).toBe(
    `Muted until 16:00 (${ZONE}). ${SUFFIX}\nCouldn't save this; it resets on restart.`,
  )
  expect(service.isQuiet()).toBe(true)
  expect(log.mock.calls).toEqual([["couldn't save quiet settings: EACCES: permission denied"]])
})

test('unknown commands are left to someone else', () => {
  const { service, save } = createService()
  expect(service.handleCommand('pending', '')).toBeUndefined()
  expect(save).not.toHaveBeenCalled()
})

test.each(['Etc/Unknown', 'Invalid/Zone', ''])(
  'a bad time zone %j falls back to UTC and logs once',
  (zone) => {
    const log = vi.fn<(line: string) => void>()
    const service = new QuietService(vi.fn(), {
      timeZone: zone,
      now: () => NOW,
      log,
      quietHours: NIGHT,
    })
    expect(service.handleCommand('quiet', '')).toContain('Time zone: UTC')
    expect(service.isQuiet()).toBe(false)
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith(`invalid time zone ${JSON.stringify(zone)}, using UTC`)
  },
)

test('the quiet commands are listed for the menu', () =>
  expect(QUIET_COMMANDS.map(({ name }) => name)).toEqual(['mute', 'unmute', 'quiet']))
