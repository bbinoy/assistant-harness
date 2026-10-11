---
name: mailbird-troubleshooting
description: Use ONLY when the `mailbird` MCP server is failing - `claude mcp list` shows it disconnected / unauthorized, tools error with connection or 401 errors, or setup needs redoing. Not needed for normal email work (see the `mailbird` skill).
---

# Fixing the Mailbird MCP connection

The owner's Mailbird Next app exposes a local MCP server (`mailbird`, registered
at **user scope**). Normal tool usage is covered by the `mailbird` skill
and the server's own `initialize` instructions. This file is only for when
the connection is broken.

## Why the config isn't a plain HTTP MCP entry

Mailbird's server is `https://127.0.0.1:<port>/mcp` with a self-signed TLS
cert. Claude Code's compiled CLI binary does not honor `NODE_EXTRA_CA_CERTS`
/ `SSL_CERT_FILE` for its own MCP HTTP transport (confirmed by testing -
plain Node scripts pick up the cert fine, the `claude` binary doesn't), and
getting macOS Keychain to trust a self-signed cert requires an interactive
GUI authorization prompt that isn't available in most Claude Code sessions.

The fix: register it as a **stdio** server that shells out to
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote), which bridges
stdio<->HTTP itself. `NODE_TLS_REJECT_UNAUTHORIZED=0` is set only in that
one child process's env, so it only weakens TLS for `mcp-remote`'s own
traffic (which only ever talks to `127.0.0.1:<port>`) - not for the main
`claude` process or its connection to Anthropic's API.

Registration command:

```
claude mcp add mailbird -s user -e NODE_TLS_REJECT_UNAUTHORIZED=0 -- \
  npx -y mcp-remote@latest https://127.0.0.1:<port>/mcp \
  --header "Authorization: Bearer <token>"
```

## Fixing a broken connection

`claude mcp list` shows `mailbird` as failed. Two distinct failure modes:

- **`UNABLE_TO_VERIFY_LEAF_SIGNATURE` / `CONNECTION_CLOSED` from mcp-remote
  crashing on OAuth discovery** - the stdio wrapper above is missing or the
  `-e NODE_TLS_REJECT_UNAUTHORIZED=0` env got dropped. Re-run the
  registration command above.
- **`401` / "Missing or invalid Authorization header"** (test directly with
  `curl -sk -i https://127.0.0.1:<port>/mcp -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'`
  to confirm) - **the token is stale.** Mailbird regenerates the bearer
  token every time the MCP server toggle is switched off/on. Ask the owner to
  open Mailbird -> Settings (bottom-left icon) -> **Wingman AI** tab,
  confirm the server shows "Running on https://127.0.0.1:<port>/mcp", click
  **Copy token**, and give you the fresh value. Then:

  ```
  claude mcp remove mailbird -s user
  claude mcp add mailbird -s user -e NODE_TLS_REJECT_UNAUTHORIZED=0 -- \
    npx -y mcp-remote@latest https://127.0.0.1:<port>/mcp \
    --header "Authorization: Bearer <fresh-token>"
  ```

  The port can also change between restarts - read it off the same Wingman
  AI tab rather than assuming it's still 52000.

After re-registering, start a **new** Claude Code session (or reconnect via
`/mcp`) - a session that was already running won't pick up the config
change on its own.
