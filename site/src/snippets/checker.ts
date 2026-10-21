/** Checks that page snippets still appear in the README. Never throws. */
export class SnippetChecker {
  private constructor() {}

  /** Ids of snippets not found in the readme (whitespace-insensitive), in key order. */
  public static findMissing(
    readme: string,
    snippets: Readonly<Record<string, string>>,
  ): readonly string[] {
    const normalizedReadme = SnippetChecker.normalize(readme)
    return Object.entries(snippets)
      .filter(([, snippet]) => !normalizedReadme.includes(SnippetChecker.normalize(snippet)))
      .map(([id]) => id)
  }

  private static normalize(text: string): string {
    return text.replace(/\s+/g, ' ').trim()
  }
}
