#!/bin/zsh
# Copy the example skills into ~/.claude/skills, where the agent loads them from.
# A skill that already exists is NEVER overwritten (yours may be customised); pass --force to
# replace it. After copying, open each skill and fill in the TODO(owner) parts: your calendars,
# your Notion pages, your voice. `npm run doctor` warns until none are left.
set -eu
cd "$(dirname "$0")/.."
FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1
DEST="$HOME/.claude/skills"
mkdir -p "$DEST"
for dir in examples/skills/*/; do
  name="$(basename "$dir")"
  if [[ -e "$DEST/$name/SKILL.md" && $FORCE -eq 0 ]]; then
    echo "kept     $name (already installed; --force replaces it)"
  else
    mkdir -p "$DEST/$name"
    cp "$dir/SKILL.md" "$DEST/$name/SKILL.md"
    echo "installed $name"
  fi
done
echo
echo "Next: fill in the TODO(owner) parts, then run: npm run doctor"
