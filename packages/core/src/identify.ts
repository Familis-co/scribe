import { visualLines } from "./lines.js";
import type { IdentifyContext, ProfileIdentify } from "./profile.js";
import type { TextToken } from "./types.js";

/**
 * Builds the identification context from each page's native tokens.
 *
 * @param pages - Native tokens of every page, in page order
 * @returns Page texts with tokens joined by spaces and visual lines by newlines, and their join
 */
export function identifyContext(pages: readonly (readonly TextToken[])[]): IdentifyContext {
  const texts = pages.map((tokens) =>
    visualLines(tokens)
      .map((line) => line.map((token) => token.text).join(" "))
      .join("\n"),
  );
  return { text: texts.join("\n"), pages: texts, pageCount: pages.length };
}

/**
 * Checks a document against a profile's identification rules.
 *
 * @param identify - Identification rules of the profile
 * @param context - Native text of the document
 * @returns A description of every text rule that failed, or of the failed predicate, empty when the
 * document matches
 */
export async function unmatchedRules(
  identify: ProfileIdentify,
  context: IdentifyContext,
): Promise<readonly string[]> {
  const caseSensitive = identify.caseSensitive ?? false;
  const haystack = caseSensitive ? context.text : context.text.toLocaleLowerCase();
  const failures = (identify.text ?? []).flatMap((search) => {
    const found =
      typeof search === "string"
        ? haystack.includes(caseSensitive ? search : search.toLocaleLowerCase())
        : new RegExp(search.source, search.flags.replaceAll("g", "")).test(context.text);
    return found
      ? []
      : [`${typeof search === "string" ? JSON.stringify(search) : String(search)} was not found`];
  });
  // The predicate may be costly, and may rely on the text rules, so it only runs once they pass.
  if (failures.length === 0 && identify.test && !(await identify.test(context))) {
    failures.push("the test predicate failed");
  }
  return failures;
}
