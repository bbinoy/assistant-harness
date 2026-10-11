#!/bin/zsh
# Stop the agent and remove its launchd job. Your .env and state/ are left untouched.
set -eu
cd "$(dirname "$0")/.."
[[ -f .env ]] && { set -a; source .env; set +a; }
LABEL="${LAUNCHD_LABEL:-com.$USER.number-one}"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "Removed $LABEL"
