#!/bin/bash
# hud-tmux-launch.sh — Option C launcher
#
# Splits the current tmux window and runs the HUD pane renderer
# in the top split. The Claude Code session stays in the bottom pane.
#
# Usage:
#   bash plugins/4ge/bin/hud-tmux-launch.sh [--theme NAME]
#
# Requirements: tmux, node

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HUD_SCRIPT="${SCRIPT_DIR}/hud-tmux-pane.cjs"

# Forward any CLI args (--theme, --state-dir, etc.)
ARGS="$*"

# Verify tmux is running
if [ -z "${TMUX:-}" ]; then
  echo "Error: not inside a tmux session."
  echo ""
  echo "Start tmux first:"
  echo "  tmux new-session -s forge"
  echo ""
  echo "Or run the HUD pane directly:"
  echo "  node ${HUD_SCRIPT} ${ARGS}"
  exit 1
fi

# Verify node is available
if ! command -v node &>/dev/null; then
  echo "Error: node not found on PATH."
  exit 1
fi

# Verify the HUD script exists
if [ ! -f "${HUD_SCRIPT}" ]; then
  echo "Error: HUD script not found at ${HUD_SCRIPT}"
  exit 1
fi

# Split window: HUD in top pane (60% height), current pane pushed to bottom
# -v = vertical split (top/bottom)
# -b = new pane goes above (before) current
# -l 60% = new pane gets 60% of height
tmux split-window -v -b -l 60% "node '${HUD_SCRIPT}' ${ARGS}; read -p 'HUD exited. Press Enter to close pane.'"

echo "HUD pane launched. Use Ctrl+B then arrow keys to switch panes."
echo "Press 'q' in the HUD pane to close it."
