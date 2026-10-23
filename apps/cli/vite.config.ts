import { defineConfig } from 'vite-plus'

// Lint and format settings live in the root vite.config.ts
export default defineConfig({
  // Bundles the library (ESM + CJS) and the CLI (ESM only, it uses top-level await) into dist
  pack: [
    {
      entry: 'src/index.ts',
      format: ['esm', 'cjs'],
      dts: true,
      fixedExtension: false,
      logLevel: 'warn',
    },
    { entry: 'src/cli.ts', format: 'esm', dts: false, fixedExtension: false, logLevel: 'warn' },
  ],
})
