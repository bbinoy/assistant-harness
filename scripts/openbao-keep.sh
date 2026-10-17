#!/bin/zsh
# Entry point for the OpenBao keeper job (launchd/openbao-keeper.plist.template): unseal from the Keychain if sealed, renew the tokens.
# launchd starts with a minimal PATH; install-launchd.sh records where `node` lives.
cd "$(dirname "$0")/.." || exit 1
export PATH="$(cat .node-path 2>/dev/null):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
exec node --conditions=workspace-source scripts/openbao.ts keep --quiet
