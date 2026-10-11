#!/bin/bash
# hud-tmux-launch.sh — Option C launcher
#
# Splits the current tmux window and runs the HUD pane renderer
# in the top split. The Claude Code session stays in the bottom pane.
#
# Usage:
#   bash plugins/4ge/bin/hud-tmux-launch.sh [--theme NAME] [--state-dir PATH]
#
# Requirements: bash, tmux, node

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HUD_SCRIPT="${SCRIPT_DIR}/hud-tmux-pane.cjs"

# Quote one word for any POSIX shell: wrap it in single quotes and turn each
# embedded ' into '\''. tmux runs the pane command with its default shell,
# which may be sh (dash), so bash's printf %q ($'...' for control characters)
# is not safe here.
shell_quote() {
  local q="'\\''"
  printf "'%s'" "${1//\'/$q}"
}

# Forward every CLI arg (--theme, --state-dir, etc.) as its own quoted word.
# No "$*" flattening and nothing unquoted: a shell re-parses an argument only
# from this lossless single-quoted form. Keep every added word quoted.
PANE_ARGS="$(shell_quote "${HUD_SCRIPT}")"
for arg in "$@"; do
  PANE_ARGS+=" $(shell_quote "${arg}")"
done

# Verify tmux is running
if [ -z "${TMUX:-}" ]; then
  echo "Error: not inside a tmux session."
  echo ""
  echo "Start tmux first:"
  echo "  tmux new-session -s forge"
  echo ""
  echo "Or run the HUD pane directly:"
  printf '  node %s\n' "${PANE_ARGS}"
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
#
# tmux hands the one-string pane command to its default shell. The string
# holds only quoted words, and it always ends in a quote, so a trailing ';'
# in an argument can never read as a tmux command separator. This script's
# own bash (by absolute path, so the tmux server's PATH need not have one)
# runs the fixed wrapper (read -p is bash-only) and gets the words back as "$@".
PANE_WRAPPER='node "$@"; read -r -p "HUD exited. Press Enter to close pane."'
tmux split-window -v -b -l 60% "exec $(shell_quote "${BASH}") -c $(shell_quote "${PANE_WRAPPER}") hud-tmux-pane ${PANE_ARGS}"

echo "HUD pane launched. Use Ctrl+B then arrow keys to switch panes."
echo "Press 'q' in the HUD pane to close it."
