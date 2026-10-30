import { expect, test } from 'vite-plus/test'
import { decodeInvite, encodeInvite } from '../../src/book/index.ts'

const KEY = `jpk_${'a'.repeat(43)}`
const INVITE = { url: 'https://bots.example/', key: KEY }

function encodePayload(payload: unknown): string {
  return `jpi_${Buffer.from(JSON.stringify(payload)).toString('base64url')}`
}

test('decodeInvite reads what encodeInvite wrote', () => {
  expect(decodeInvite(encodeInvite(INVITE))).toEqual(INVITE)
})

test('decodeInvite accepts surrounding whitespace and a pasted "jaypost bots join " prefix', () => {
  const invite = encodeInvite(INVITE)
  expect(decodeInvite(`  ${invite}\n`)).toEqual(INVITE)
  expect(decodeInvite(`jaypost bots join ${invite}`)).toEqual(INVITE)
})

test('decodeInvite rejects a truncated invite, another prefix, v 2, a bad url and a bad key', () => {
  const invite = encodeInvite(INVITE)
  for (const raw of [
    invite.slice(0, -10),
    invite.replace('jpi_', 'jpx_'),
    encodePayload({ v: 2, ...INVITE }),
    encodePayload({ v: 1, url: 'ftp://bots.example/', key: KEY }),
    encodePayload({ v: 1, url: INVITE.url, key: 'short' }),
    '',
  ]) {
    expect(decodeInvite(raw)).toBeUndefined()
  }
})
