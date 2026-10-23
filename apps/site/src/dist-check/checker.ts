import type { DistPage, DistProblem } from './types.ts'

const URL_ATTRIBUTE_PATTERN = /\b(?:href|src|content)="([^"]*)"/g
const EM_DASH = '—'

/** Finds base-path slips and em-dashes in built pages. Never throws. */
export class DistChecker {
  private constructor() {}

  public static findProblems(pages: readonly DistPage[], base: string): readonly DistProblem[] {
    return pages.flatMap((page) => DistChecker.findPageProblems(page, base))
  }

  private static findPageProblems(page: DistPage, base: string): readonly DistProblem[] {
    const urlProblems = [
      ...new Set([...page.html.matchAll(URL_ATTRIBUTE_PATTERN)].map((match) => match[1] ?? '')),
    ]
      .filter((value) => value.startsWith('/') && !value.startsWith('//'))
      .filter((value) => value !== base && !value.startsWith(`${base}/`))
      .map((value) => `url "${value}" is outside base "${base}"`)
    const dashProblems = page.html.includes(EM_DASH) ? ['em-dash in page text'] : []
    return [...urlProblems, ...dashProblems].map((problem) => ({ path: page.path, problem }))
  }
}
