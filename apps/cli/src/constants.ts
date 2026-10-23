import packageJson from '../package.json' with { type: 'json' }

/** Version of the published jaypost package, read when the module loads; the workspace packages are private. */
export const VERSION: string = packageJson.version
