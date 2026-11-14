#!/bin/sh
set -eu

cli=${CREWVANE_CLI_PATH:-${HOME}/.local/bin/crewvane}
if [ ! -x "$cli" ]; then
  printf '%s\n' \
    "Atte CLI is not available at $cli." \
    "Open Atte once, choose a workspace, then reopen this panel." >&2
  exit 1
fi

exec "$cli" "$@"
