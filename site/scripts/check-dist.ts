import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DistChecker } from '../src/dist-check/index.ts'
import type { DistPage } from '../src/dist-check/index.ts'

const DIST_DIRECTORY = fileURLToPath(new URL('../dist', import.meta.url))
const BASE = '/jaypost'

/** Usage: node scripts/check-dist.ts */
class CheckDistCli {
  private constructor() {}

  public static async run(): Promise<number> {
    try {
      const files = (await readdir(DIST_DIRECTORY, { recursive: true })).filter((file) =>
        file.endsWith('.html'),
      )
      const pages: DistPage[] = []
      for (const file of files) {
        pages.push({
          path: relative(DIST_DIRECTORY, join(DIST_DIRECTORY, file)),
          html: await readFile(join(DIST_DIRECTORY, file), 'utf8'),
        })
      }
      const problems = DistChecker.findProblems(pages, BASE)
      for (const { path, problem } of problems) {
        process.stderr.write(`check-dist: ${path}: ${problem}\n`)
      }
      return problems.length === 0 ? 0 : 1
    } catch (error) {
      process.stderr.write(
        `check-dist: ${error instanceof Error ? error.message : String(error)}\n`,
      )
      return 1
    }
  }
}

process.exitCode = await CheckDistCli.run()
