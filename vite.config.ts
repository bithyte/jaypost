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
})
