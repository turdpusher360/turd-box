---
description: "Bootstrap or update a Claude Code environment"
argument-hint: "setup | update | status"
paths: ["plugins/4ge/**", "lib/**", "components/**", ".claude/**"]
---

# /blueprint

Parse $ARGUMENTS:

| Pattern | Action |
|---------|--------|
| `setup` | Check if `lib/hook-installer.cjs` exists in the project root. If not, report: "Blueprint installers not found in this project. The Blueprint `lib/` installer scripts are not bundled with the marketplace plugin; this subcommand only runs in a project that already has the `lib/` and `components/` directories at its root. Skipping setup — every other 4ge command works without Blueprint." If found: ask the user for project_name, tech_stack, tier (minimal/recommended/full), and setup_mode. Validate against `components/configs/.blueprint-config.json.schema`. Write answers to `.blueprint-config.json`. Then run each installer in order: `node -e "require('./lib/hook-installer.cjs')"`, `node -e "require('./lib/agent-installer.cjs')"`, `node -e "require('./lib/skill-installer.cjs')"`, `node -e "require('./lib/rule-installer.cjs')"`. |
| `update` | Re-run Blueprint installation using existing `.blueprint-config.json`. Check `lib/hook-installer.cjs` exists first (report same message as setup if missing). Read the config, then run each installer in order (same as setup). If `.blueprint-config.json` does not exist, report "No config found — run `/blueprint setup` first." |
| `status` | Read `.blueprint-manifest.json` and display installation health: version, file count, installed date. If missing, report "No Blueprint installation found." |
| (empty) | Show available subcommands: setup, update, status. |
