import { LANGUAGE_PATTERN } from './constants.ts'

const MARKUP_PATTERN = /[\\`*~#>]/g

const FENCE_RUN_PATTERN = /^ {0,3}(`+)/gm

/**
 * Backslash-escapes every character the markdown subset could treat as markup, so that
 * `format: "markdown"` shows `text` as typed. Never throws.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(MARKUP_PATTERN, '\\$&')
}

/**
 * Wraps `code` in a fenced block that shows it verbatim, with a fence longer than any backtick
 * run that starts a line of `code`. Throws a RangeError when `language` isn't a plain word.
 */
export function formatCodeBlock(code: string, language?: string): string {
  if (language !== undefined && !LANGUAGE_PATTERN.test(language)) {
    throw new RangeError(
      `language ${JSON.stringify(language)} must match ${LANGUAGE_PATTERN.source}`,
    )
  }
  const longestRun = [...code.matchAll(FENCE_RUN_PATTERN)].reduce(
    (longest, match) => Math.max(longest, match[1]?.length ?? 0),
    0,
  )
  const fence = '`'.repeat(Math.max(3, longestRun + 1))
  return `${fence}${language ?? ''}\n${code}\n${fence}`
}
