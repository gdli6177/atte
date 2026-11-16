#!/bin/sh
set -eu

cli=${ATTE_CLI_PATH:-${HOME}/.local/bin/atte}
if [ ! -x "$cli" ]; then
  printf '%s\n' \
    "Atte CLI is not available at $cli." \
    "Open Atte once, choose a workspace, then reopen this plugin." >&2
  exit 1
fi

printf '\n\033[38;5;111m要处理什么？\033[0m\n'
printf '%s' '> '
IFS= read -r text || exit 130
if [ -z "$text" ]; then
  printf '%s\n' "没有输入，事项没有创建。"
  exit 1
fi

# Plugin commands run inside the Herdr server and must never inherit the
# current case scope from a concierge that happened to start that server.
unset ATTE_COORDINATOR ATTE_COORDINATOR_SCOPE_FILE
exec "$cli" ask "$text"
