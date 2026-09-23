import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { defineConfig } from "tsup";

const OUT_DIR = "dist";

// Matches relative specifiers in `from "./x.js"`, `import "./x.js"` and `import("./x.js")`.
const RELATIVE_JS_SPECIFIER = /((?:from|import)\s*\(?\s*)(["'])(\.{1,2}\/[^"']+)\.js\2/gu;

/**
 * Lists the ESM declaration files emitted by `tsc`.
 *
 * @param directory - Directory to walk recursively
 * @returns Paths of every `.d.ts` file found
 */
function declarationFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return declarationFiles(path);
    return entry.isFile() && entry.name.endsWith(".d.ts") ? [path] : [];
  });
}

/**
 * Derives a CommonJS declaration graph from the ESM one.
 *
 * @remarks
 * The packages are `"type": "module"`, so TypeScript reads every `.d.ts` as ESM. A `require`
 * consumer needs `.d.cts` files instead, and their relative imports must point at other `.d.cts`
 * files so the whole graph stays CommonJS. tsup's own `dts` option cannot produce them because its
 * bundled rollup-plugin-dts does not support TypeScript 7.
 *
 * @param directory - Build output directory containing the `tsc` declarations
 */
function emitCommonJsDeclarations(directory: string): void {
  for (const file of declarationFiles(directory)) {
    const target = file.replace(/\.d\.ts$/u, ".d.cts");
    const source = readFileSync(file, "utf8")
      .replace(RELATIVE_JS_SPECIFIER, "$1$2$3.cjs$2")
      .replace(/^(\/\/# sourceMappingURL=.+)\.d\.ts\.map$/mu, "$1.d.cts.map");
    writeFileSync(target, source);

    const map: Record<string, unknown> = JSON.parse(readFileSync(`${file}.map`, "utf8"));
    writeFileSync(`${target}.map`, JSON.stringify({ ...map, file: basename(target) }));
  }
}

/**
 * Builds the shared tsup configuration of a published package.
 *
 * @remarks
 * tsup bundles the ESM and CommonJS JavaScript. Declarations come from `tsc` with the package's
 * `tsconfig.build.json`, then get a CommonJS twin, once the JavaScript build succeeds.
 *
 * @param entry - Source entry points, one per public subpath
 * @returns The tsup configuration
 */
export function definePackageConfig(entry: string[]) {
  return defineConfig({
    entry,
    format: ["esm", "cjs"],
    platform: "node",
    target: "node22",
    outDir: OUT_DIR,
    sourcemap: true,
    clean: true,
    async onSuccess() {
      execFileSync("tsc", ["-p", "tsconfig.build.json"], { stdio: "inherit" });
      emitCommonJsDeclarations(OUT_DIR);
    },
  });
}
