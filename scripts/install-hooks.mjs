import { execFileSync } from "node:child_process";

try {
  execFileSync("git", ["rev-parse", "--git-dir"], { stdio: "ignore" });
} catch {
  console.log("Skipping Lefthook installation because this directory is not a Git repository.");
  process.exit(0);
}

execFileSync("lefthook", ["install"], { stdio: "inherit" });
