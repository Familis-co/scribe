import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { TSDocParser } from "@microsoft/tsdoc";

const root = new URL("..", import.meta.url).pathname;
const parser = new TSDocParser();
const failures = [];

/**
 * Lists TypeScript files below a directory.
 *
 * @param {string} directory - Absolute directory to walk recursively
 * @returns {string[]} Absolute paths of every `.ts` file found
 */
function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

for (const packageName of ["core", "pdfium", "tesseract"]) {
  const directory = join(root, "packages", packageName, "src");
  for (const file of sourceFiles(directory)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/\/\*\*[\s\S]*?\*\//gu)) {
      const context = parser.parseString(match[0]);
      const line = source.slice(0, match.index).split("\n").length;
      for (const message of context.log.messages) {
        failures.push(`${relative(root, file)}:${line}: ${message.messageId}: ${message.text}`);
      }
    }
  }
}

if (failures.length > 0) {
  throw new Error(`Invalid TSDoc comments:\n${failures.join("\n")}`);
}

console.log("Public source TSDoc comments are valid.");
