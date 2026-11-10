import { z } from 'zod'

/** Shape of install.json. */
export const installRecordSchema = z.object({
  target: z.enum(['systemd', 'compose', 'quadlet', 'launchd']),
  port: z.number(),
  version: z.string(),
  /** Absent in installs from 0.1.x, which are Telegram. */
  provider: z.string().optional(),
  cliPath: z.string().optional(),
  /** Which CLI the systemd or launchd service runs; absent means `npm`. */
  cliKind: z.enum(['npm', 'binary']).optional(),
  /** Absolute config.json path the systemd unit or launchd agent was installed with. */
  configFile: z.string().optional(),
  /** Present (true) when the service listens on all interfaces; absent means loopback. */
  exposed: z.boolean().optional(),
})
