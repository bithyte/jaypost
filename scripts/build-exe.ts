// Builds standalone binaries (Node SEA) for every release platform into dist-exe/.
// Needs Node 26: `vp env exec --node 26 npm run build:exe` (the local `vp` shadows the global one
// inside npm scripts, so the Node switch can't live in the script itself).
import { build } from 'vite-plus/pack'

const NODE_VERSION = '26.12.0'

if (Number(process.versions.node.split('.')[0]) < 26) {
  throw new Error(`build:exe needs Node 26, got ${process.versions.node}`)
}

// EXE_PLATFORMS=linux builds only that platform's targets (CI builds darwin on macOS to sign it)
const ALL_TARGETS = [
  { platform: 'linux', arch: 'x64', nodeVersion: NODE_VERSION },
  { platform: 'linux', arch: 'arm64', nodeVersion: NODE_VERSION },
  { platform: 'darwin', arch: 'x64', nodeVersion: NODE_VERSION },
  { platform: 'darwin', arch: 'arm64', nodeVersion: NODE_VERSION },
] as const
const platforms = process.env.EXE_PLATFORMS?.split(',')
const targets = ALL_TARGETS.filter(
  (target) => platforms === undefined || platforms.includes(target.platform),
)
if (targets.length === 0) {
  throw new Error(`EXE_PLATFORMS ${JSON.stringify(process.env.EXE_PLATFORMS)} matches no target`)
}

await build({
  config: false,
  entry: 'src/cli.ts',
  outDir: 'dist-exe',
  platform: 'node',
  format: 'esm',
  minify: true,
  // node-fetch (via grammy) recognizes the abort-controller polyfill's signal by
  // constructor.name === 'AbortSignal'; mangled class names make every Telegram call throw
  outputOptions: { keepNames: true },
  clean: true,
  // bundle everything, including grammy's transitive deps, so the binary needs no node_modules
  // zlib-sync stays external: @discordjs/ws imports it lazily and only for zlib-sync
  // compression, which we don't enable
  deps: { alwaysBundle: [/.*/], neverBundle: ['zlib-sync'], onlyBundle: false },
  // tr46 (via grammy, node-fetch, whatwg-url) requires the built-in punycode, which warns
  // DEP0040; the trailing slash resolves the userland package instead
  alias: { punycode: 'punycode/' },
  exe: {
    outDir: 'dist-exe',
    // node-fetch calls url.parse() on every request. Node only warns DEP0169 for code outside
    // node_modules, and bundled deps count as outside
    seaConfig: { execArgv: ['--disable-warning=DEP0169'] },
    targets,
  },
})
