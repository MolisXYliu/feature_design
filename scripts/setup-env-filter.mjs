#!/usr/bin/env node

import { execFileSync } from "child_process"

function runGitConfig(...args) {
  execFileSync("git", ["config", ...args], { stdio: "inherit" })
}

function main() {
  runGitConfig("filter.envcrypt.clean", "node scripts/env-crypt.mjs clean")
  // Fallback to cat (passthrough) when the script isn't available yet,
  // e.g. during worktree creation where .env is checked out before the script.
  // The .env will stay as ciphertext; run `npm run env:decrypt:quick` afterwards.
  runGitConfig("filter.envcrypt.smudge", "node scripts/env-crypt.mjs smudge || cat")
  runGitConfig("filter.envcrypt.required", "true")
  process.stdout.write(
    "Configured git filter 'envcrypt'. Run 'git add --renormalize .env' once to store encrypted content in git.\n"
  )
}

main()
