/** Checks that page snippets still appear in the README or docs. Never throws. */
export class SnippetChecker {
  private constructor() {}

  /** Ids of snippets not found in the docs text (whitespace-insensitive), in key order. */
  public static findMissing(
    docs: string,
    snippets: Readonly<Record<string, string>>,
  ): readonly string[] {
    const normalizedDocs = SnippetChecker.normalize(docs)
    return Object.entries(snippets)
      .filter(([, snippet]) => !normalizedDocs.includes(SnippetChecker.normalize(snippet)))
      .map(([id]) => id)
  }

  private static normalize(text: string): string {
    return text.replace(/\s+/g, ' ').trim()
  }
}
