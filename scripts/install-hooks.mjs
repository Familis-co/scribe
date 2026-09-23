import { execFileSync } from "node:child_process";

// Lefthook itself only reads LEFTHOOK=0 when a hook fires, so honour it here to keep CI from
// installing hooks it will never run.
if (process.env.LEFTHOOK === "0" || process.env.LEFTHOOK === "false") {
  console.log("Skipping Lefthook installation because LEFTHOOK is disabled.");
  process.exit(0);
}

try {
  execFileSync("git", ["rev-parse", "--git-dir"], { stdio: "ignore" });
} catch {
  console.log("Skipping Lefthook installation because this directory is not a Git repository.");
  process.exit(0);
}

execFileSync("lefthook", ["install"], { stdio: "inherit" });
