import { readFile } from 'node:fs/promises'
import { SNIPPETS, SnippetChecker } from '../src/snippets/index.ts'

/** Usage: node scripts/check-snippets.ts */
class CheckSnippetsCli {
  private constructor() {}

  public static async run(): Promise<number> {
    try {
      const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8')
      const missing = SnippetChecker.findMissing(readme, SNIPPETS)
      for (const id of missing) {
        process.stderr.write(`check-snippets: snippet "${id}" not found in README.md\n`)
      }
      return missing.length === 0 ? 0 : 1
    } catch (error) {
      process.stderr.write(
        `check-snippets: ${error instanceof Error ? error.message : String(error)}\n`,
      )
      return 1
    }
  }
}

process.exitCode = await CheckSnippetsCli.run()
