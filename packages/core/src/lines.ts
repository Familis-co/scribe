import type { TextToken } from "./types.js";

/**
 * Vertical center of a token.
 *
 * @param token - Token to measure
 * @returns The normalized vertical center
 */
export const centerY = (token: TextToken): number => token.box.y + token.box.height / 2;

/**
 * Groups tokens into visual lines from their geometry alone.
 *
 * @remarks
 * `lineIndex` is ignored: native and OCR line indices come from different numbering schemes, and a
 * PDF text layer may put the cells of one table row on separate lines. A token joins the current
 * line when its vertical center lies above the line's bottom edge.
 *
 * @param tokens - Tokens of one page from any source
 * @returns Lines from top to bottom, each ordered from left to right
 */
export function visualLines(tokens: readonly TextToken[]): readonly (readonly TextToken[])[] {
  const lines: Array<{ bottom: number; tokens: TextToken[] }> = [];
  for (const token of tokens.toSorted((left, right) => centerY(left) - centerY(right))) {
    const line = lines.at(-1);
    if (line && centerY(token) <= line.bottom) {
      line.tokens.push(token);
      line.bottom = Math.max(line.bottom, token.box.y + token.box.height);
    } else {
      lines.push({ bottom: token.box.y + token.box.height, tokens: [token] });
    }
  }
  return lines.map((line) => line.tokens.toSorted((left, right) => left.box.x - right.box.x));
}
