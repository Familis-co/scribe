import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";

const root = new URL("..", import.meta.url).pathname;
const packages = ["core", "pdfium", "tesseract"];
const archiveDirectory = join(root, ".packages-check");
const archives = {};

rmSync(archiveDirectory, { force: true, recursive: true });
mkdirSync(archiveDirectory, { recursive: true });

for (const name of packages) {
  const directory = join(root, "packages", name);
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));

  if (manifest.publishConfig?.access !== "public") {
    throw new Error(`${manifest.name}: publishConfig.access must be public`);
  }

  for (const target of ["dist/index.js", "dist/index.cjs", "dist/index.d.ts"]) {
    if (!existsSync(join(directory, target))) {
      throw new Error(`${manifest.name}: missing ${target}`);
    }
  }

  const output = execFileSync("pnpm", ["pack", "--pack-destination", archiveDirectory], {
    cwd: directory,
    encoding: "utf8",
  }).trim();
  const archiveName = output.split("\n").at(-1);
  if (!archiveName) throw new Error(`${manifest.name}: pnpm pack did not return an archive`);
  archives[manifest.name] = isAbsolute(archiveName)
    ? archiveName
    : join(archiveDirectory, archiveName);
}

const consumerDirectory = mkdtempSync(join(tmpdir(), "scribe-consumer-"));
try {
  writeFileSync(
    join(consumerDirectory, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: Object.fromEntries(
        Object.entries(archives).map(([name, archive]) => [name, `file:${archive}`]),
      ),
    }),
  );
  writeFileSync(
    join(consumerDirectory, "pnpm-workspace.yaml"),
    [
      "packages:",
      '  - "."',
      "overrides:",
      ...Object.entries(archives).map(
        ([name, archive]) => `  ${JSON.stringify(name)}: ${JSON.stringify(`file:${archive}`)}`,
      ),
      "allowBuilds:",
      "  sharp: true",
      "  tesseract.js: true",
      "",
    ].join("\n"),
  );
  execFileSync("pnpm", ["install", "--offline"], {
    cwd: consumerDirectory,
    stdio: "ignore",
  });

  const packagesToLoad = Object.keys(archives);
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `await Promise.all(${JSON.stringify(packagesToLoad)}.map((name) => import(name)))`,
    ],
    { cwd: consumerDirectory, stdio: "ignore" },
  );
  execFileSync(
    process.execPath,
    ["--eval", `${JSON.stringify(packagesToLoad)}.forEach((name) => require(name))`],
    { cwd: consumerDirectory, stdio: "ignore" },
  );

  const wasmPath = execFileSync(
    process.execPath,
    [
      "--eval",
      [
        "const { createRequire } = require('node:module')",
        "const adapterRequire = createRequire(require.resolve('@familis/scribe-pdfium/package.json'))",
        "process.stdout.write(adapterRequire.resolve('@embedpdf/pdfium/pdfium.wasm'))",
      ].join(";"),
    ],
    { cwd: consumerDirectory, encoding: "utf8" },
  );
  if (!existsSync(wasmPath)) {
    throw new Error("@embedpdf/pdfium did not publish its pdfium.wasm asset");
  }
} finally {
  rmSync(consumerDirectory, { force: true, recursive: true });
}

console.log("Packed ESM/CommonJS imports and the PDFium WASM asset are valid in isolation.");
