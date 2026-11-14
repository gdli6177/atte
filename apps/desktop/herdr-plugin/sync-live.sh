#!/bin/sh
set -eu

cli=${ATTE_CLI_PATH:-${HOME}/.local/bin/atte}
if [ ! -x "$cli" ]; then
  printf '%s\n' \
    "Atte CLI is not available at $cli." \
    "Open Atte once, choose a workspace, then reopen this plugin." >&2
  exit 1
fi

# Plugin events run inside the Herdr server and must never inherit the current
# case scope from a concierge that happened to start that server.
unset ATTE_COORDINATOR ATTE_COORDINATOR_SCOPE_FILE
ATTE_HERDR_BINARY=${HERDR_BIN_PATH:-herdr}
export ATTE_HERDR_BINARY
exec "$cli" event herdr --json
