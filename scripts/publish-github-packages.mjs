import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// GitHub Packages only accepts npm packages scoped to the repository owner, so the npm scope is
// rewritten on the way. Dependencies between mirrored packages become npm aliases that keep the
// original import specifiers resolvable.
const SOURCE_SCOPE = "@familis/";
const TARGET_SCOPE = `@${(process.env.GITHUB_REPOSITORY_OWNER ?? "familis-co").toLowerCase()}/`;
const REGISTRY = "https://npm.pkg.github.com";
const DEPENDENCY_FIELDS = [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
  "devDependencies",
];

const [directory, ...flags] = process.argv.slice(2);
if (!directory) {
  throw new Error(
    "Usage: node scripts/publish-github-packages.mjs <tarball-directory> [--dry-run]",
  );
}
const dryRun = flags.includes("--dry-run");

/**
 * Lists npm tarballs below a directory.
 *
 * @param {string} root - Directory to walk recursively
 * @returns {string[]} Absolute paths of every `.tgz` file found
 */
function tarballs(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return tarballs(path);
    return entry.isFile() && entry.name.endsWith(".tgz") ? [path] : [];
  });
}

/**
 * Maps a package name from the npm scope to the GitHub Packages scope.
 *
 * @param {string} name - Package name, scoped or not
 * @returns {string} The mirrored name, or the input when it is outside the npm scope
 */
function mirroredName(name) {
  return name.startsWith(SOURCE_SCOPE) ? TARGET_SCOPE + name.slice(SOURCE_SCOPE.length) : name;
}

/**
 * Rewrites a packed manifest so it can be published to GitHub Packages.
 *
 * @param {Record<string, any>} manifest - `package.json` extracted from an npm tarball
 * @returns {Record<string, any>} A copy with the mirrored name, aliased internal dependencies, and
 *   the GitHub registry as publish target
 */
function mirroredManifest(manifest) {
  const mirrored = { ...manifest, name: mirroredName(manifest.name) };
  for (const field of DEPENDENCY_FIELDS) {
    if (!manifest[field]) continue;
    mirrored[field] = Object.fromEntries(
      Object.entries(manifest[field]).map(([name, range]) => [
        name,
        name.startsWith(SOURCE_SCOPE) ? `npm:${mirroredName(name)}@${range}` : range,
      ]),
    );
  }
  mirrored.publishConfig = { registry: REGISTRY };
  return mirrored;
}

/**
 * Determines whether a version already exists on GitHub Packages.
 *
 * @param {string} name - Mirrored package name
 * @param {string} version - Exact version
 * @returns {boolean} `true` when the registry returns the version, `false` on any lookup failure
 */
function isPublished(name, version) {
  try {
    const output = execFileSync(
      "npm",
      ["view", `${name}@${version}`, "version", "--registry", REGISTRY],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return output.trim() === version;
  } catch {
    return false;
  }
}

/**
 * Picks the dist-tag for a version, mirroring the prerelease channel when there is one.
 *
 * @param {string} version - Semantic version
 * @returns {string} The first prerelease identifier, or `latest` for stable versions
 */
function distTag(version) {
  const prerelease = version.split("+")[0].split("-").slice(1).join("-");
  return prerelease ? prerelease.split(".")[0] : "latest";
}

const found = tarballs(resolve(directory));
if (found.length === 0) throw new Error(`No npm tarballs found in ${directory}.`);

for (const tarball of found) {
  const workspace = mkdtempSync(join(tmpdir(), "scribe-github-packages-"));
  try {
    execFileSync("tar", ["-xzf", tarball, "-C", workspace]);
    const packageDirectory = join(workspace, "package");
    const manifestPath = join(packageDirectory, "package.json");
    const manifest = mirroredManifest(JSON.parse(readFileSync(manifestPath, "utf8")));

    if (!dryRun && isPublished(manifest.name, manifest.version)) {
      console.log(`${manifest.name}@${manifest.version} is already on GitHub Packages, skipping.`);
      continue;
    }

    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    // The tarball already contains built output, so no lifecycle script needs to run.
    execFileSync(
      "npm",
      [
        "publish",
        packageDirectory,
        "--registry",
        REGISTRY,
        "--tag",
        distTag(manifest.version),
        "--ignore-scripts",
        ...(dryRun ? ["--dry-run"] : []),
      ],
      { stdio: "inherit" },
    );
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
}
