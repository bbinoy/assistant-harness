#!/bin/zsh
# Install (or reinstall) the launchd job that keeps the agent running.
# Run from the repo: npm run install:launchd
set -eu
cd "$(dirname "$0")/.."
[[ -f .env ]] || { echo "Create .env first (copy .env.example)."; exit 1; }
set -a; source .env; set +a
LABEL="${LAUNCHD_LABEL:-com.$USER.assistant-harness}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
command -v node >/dev/null || { echo "node not found on PATH"; exit 1; }
command -v signal-cli >/dev/null || echo "warning: signal-cli not found on PATH (brew install signal-cli)"
dirname "$(command -v node)" > .node-path
mkdir -p state && chmod 700 state
: > state/launchd-stderr.log && chmod 600 state/launchd-stderr.log   # launchd would create it world-readable
sed -e "s#__LABEL__#$LABEL#g" -e "s#__DIR__#$PWD#g" launchd/agent.plist.template > "$PLIST"
plutil -lint "$PLIST" >/dev/null
# bootout returns before the old job is fully gone; bootstrapping too early fails with
# "Input/output error". Wait until it is really unloaded, then retry the bootstrap.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
for i in 1 2 3 4 5 6 7 8 9 10; do
  launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break
  sleep 1
done
for i in 1 2 3 4 5; do
  launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null && break
  [[ $i -eq 5 ]] && { echo "launchctl bootstrap failed; try: launchctl bootstrap gui/$(id -u) $PLIST"; exit 1; }
  sleep 2
done
echo "Installed and started $LABEL"
echo "Log:    $PWD/state/agent.log"
echo "Check:  npm run doctor"
