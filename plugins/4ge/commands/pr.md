---
description: "Verify, commit, push, and open a PR"
argument-hint: "<title>"
paths: ["**"]
---

# /pr

Full PR pipeline: verify, commit, push, create PR.

Parse $ARGUMENTS as the PR title. If no arguments, ask for a title.

Steps:
1. Follow the same steps as /ship
2. After successful push, create PR: `gh pr create --title "<title>"`
3. Ask for PR body content or generate from recent commits
4. Show the PR URL when done
