import { defineConfig } from 'vite-plus'

export default defineConfig({
  lint: {
    rules: {
      curly: 'error',
    },
  },
  fmt: {
    ignorePatterns: ['docs/**', 'pnpm-lock.yaml'],
    semi: false,
    singleQuote: true,
    printWidth: 100,
  },
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
