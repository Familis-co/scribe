import type { TextToken } from "./types.js";

/**
 * Computes the Levenshtein distance between two strings.
 *
 * @param left - First string
 * @param right - Second string
 * @returns Minimum number of single-character insertions, deletions, or substitutions
 */
export function editDistance(left: string, right: string): number {
  if (left === right) return 0;
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1]! + 1,
        previous[rightIndex]! + 1,
        previous[rightIndex - 1]! + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length]!;
}

/**
 * Reduces a label to the characters compared by fuzzy matching.
 *
 * @remarks
 * The text is NFKD-normalized and stripped of combining marks, then of every character that is not
 * a letter or a digit, so `Dossier N°:` becomes `dossiern`.
 *
 * @param text - Label or token text
 * @param caseSensitive - Whether letter case is preserved
 * @returns The comparison key, empty when the text has no letter or digit
 */
export function fuzzyKey(text: string, caseSensitive: boolean): string {
  const key = text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
  return caseSensitive ? key : key.toLocaleLowerCase();
}

/**
 * Scores how close two comparison keys are.
 *
 * @param left - First key from {@link fuzzyKey}
 * @param right - Second key from {@link fuzzyKey}
 * @returns `1 − levenshtein / max(length)`, from `0` for unrelated keys to `1` for equal ones
 */
export function similarity(left: string, right: string): number {
  const length = Math.max(left.length, right.length);
  return length === 0 ? 1 : 1 - editDistance(left, right) / length;
}

/** The run of consecutive tokens that best matches a label. */
export interface FuzzyWindow {
  /** Index of the run's first token. */
  readonly start: number;
  /** Index just past the run's last token. */
  readonly end: number;
  /** Similarity between the label and the run's text. */
  readonly score: number;
  /** Space-joined text of the run. */
  readonly text: string;
}

/**
 * Finds the run of consecutive tokens that best matches a label.
 *
 * @remarks
 * Every run of 1 to `maxTokens` tokens that starts and ends on a token with a letter or digit is
 * scored, so a stray `:` or `|` never widens a run. The highest score wins and ties go to the
 * leftmost run, then to the shorter one.
 *
 * @param tokens - Tokens of one line, left to right
 * @param key - Label comparison key from {@link fuzzyKey}, which must not be empty
 * @param threshold - Minimum similarity between `0` and `1`
 * @param caseSensitive - Whether letter case is preserved
 * @param maxTokens - Longest run tried
 * @param usable - Optional predicate excluding token indices from every run
 * @returns The best run at or above the threshold, or `undefined` when none reaches it
 */
export function bestWindow(
  tokens: readonly TextToken[],
  key: string,
  threshold: number,
  caseSensitive: boolean,
  maxTokens: number,
  usable: (index: number) => boolean = () => true,
): FuzzyWindow | undefined {
  const keys = tokens.map((token) => fuzzyKey(token.text, caseSensitive));
  let best: FuzzyWindow | undefined;
  for (let start = 0; start < tokens.length; start += 1) {
    if (keys[start] === "") continue;
    let candidate = "";
    for (let end = start + 1; end <= Math.min(tokens.length, start + maxTokens); end += 1) {
      if (!usable(end - 1)) break;
      if (keys[end - 1] === "") continue;
      candidate += keys[end - 1]!;
      const score = similarity(key, candidate);
      if (score >= threshold && (!best || score > best.score)) {
        const text = tokens
          .slice(start, end)
          .map((token) => token.text)
          .join(" ");
        best = { start, end, score, text };
      }
    }
  }
  return best;
}
