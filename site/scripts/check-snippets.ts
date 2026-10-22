import { readdir, readFile } from 'node:fs/promises'
import { SNIPPETS, SnippetChecker } from '../src/snippets/index.ts'

const ROOT_URL = new URL('../../', import.meta.url)

/** Usage: node scripts/check-snippets.ts */
class CheckSnippetsCli {
  private constructor() {}

  public static async run(): Promise<number> {
    try {
      const docs = await CheckSnippetsCli.readDocs()
      const missing = SnippetChecker.findMissing(docs, SNIPPETS)
      for (const id of missing) {
        process.stderr.write(
          `check-snippets: snippet "${id}" not found in README.md or docs/*.md\n`,
        )
      }
      return missing.length === 0 ? 0 : 1
    } catch (error) {
      process.stderr.write(
        `check-snippets: ${error instanceof Error ? error.message : String(error)}\n`,
      )
      return 1
    }
  }

  private static async readDocs(): Promise<string> {
    const docsUrl = new URL('docs/', ROOT_URL)
    const names = (await readdir(docsUrl)).filter((name) => name.endsWith('.md')).toSorted()
    const urls = [new URL('README.md', ROOT_URL), ...names.map((name) => new URL(name, docsUrl))]
    const texts = await Promise.all(urls.map((url) => readFile(url, 'utf8')))
    return texts.join('\n')
  }
}

process.exitCode = await CheckSnippetsCli.run()
