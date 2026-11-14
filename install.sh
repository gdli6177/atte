#!/usr/bin/env bash
# LEGACY: 0.2-era manual-contract skill installer. The current 0.6 app installs
# its CLI and the atte skill from Settings; this script and the ship-*
# skills are kept for historical reference and are not part of the 0.6 flow.
# One-command install for atte. No git clone and no sudo.
#   curl -fsSL https://raw.githubusercontent.com/gdli6177/atte/main/install.sh | bash
# Pin a tag:  curl -fsSL .../install.sh | bash -s -- --ref v0.1.0
# Tests can set ATTE_TARBALL to a local .tar.gz instead of downloading.
set -euo pipefail

REPO="gdli6177/atte"
DEFAULT_REF="main"
SKILLS=(
  ship-setup
  ship-watchdog
  ship-contract
  ship-dispatch
  ship-inbox
  ship-notify
  ship-e2e
)
SHIM_MARKER="atte-shim"

REF="${ATTE_REF:-$DEFAULT_REF}"
KIT_HOME="${ATTE_HOME:-$HOME/.atte}"
LEGACY_KIT_HOME="${CREWVANE_HOME:-$HOME/.crewvane}"
BIN_DIR="${ATTE_BIN_DIR:-$HOME/.local/bin}"
TARGETS=()
AGENTS=()
UNINSTALL=0

usage() {
  cat <<'EOF'
Install atte without cloning.

  curl -fsSL https://raw.githubusercontent.com/gdli6177/atte/main/install.sh | bash

Options:
  --ref <name>     Branch or tag to install (default: main, or ATTE_REF).
                   Slashes are allowed, as in feature/foo. The directory name
                   uses __ in place of /.
  --agent <name>   cursor, claude, codex, qoder, kiro, omp, agents, or all. Repeatable.
  --target <dir>   Copy skills into this directory instead of detecting agents.
  --uninstall      Remove the shim, the skill directories this installer
                   recorded, and the whole ~/.atte directory
                   (every ref and the current symlink).
  -h, --help       Show this help.

The installer never uses sudo and never edits a project repository.
Re-run the same command to upgrade. Windows: run it inside WSL.
EOF
}

die() {
  echo "error: $*" >&2
  exit 1
}

refuse_windows() {
  local name
  name="$(uname -s 2>/dev/null || echo unknown)"
  case "$name" in
    MINGW*|MSYS*|CYGWIN*)
      die "this installer does not run under Git Bash or MSYS. Install Ubuntu from the Microsoft Store and run the same command inside WSL."
      ;;
  esac
}

valid_ref() {
  local ref="$1" name
  [[ -n "$ref" ]] || return 1
  [[ "$ref" =~ ^[A-Za-z0-9._/-]+$ ]] || return 1
  [[ "$ref" != *..* ]] || return 1
  [[ "$ref" != /* && "$ref" != */ && "$ref" != *//* ]] || return 1
  name="${ref//\//__}"
  [[ -n "$name" && "$name" != "current" && "$name" != "manifest" && "$name" != .* ]] || return 1
  return 0
}

ref_dir_name() {
  printf '%s\n' "${1//\//__}"
}

urlencode() {
  local s="$1" out="" i c hex
  for ((i = 0; i < ${#s}; i++)); do
    c="${s:i:1}"
    case "$c" in
      [A-Za-z0-9._~-]) out+="$c" ;;
      *)
        printf -v hex '%%%02X' "'$c"
        out+="$hex"
        ;;
    esac
  done
  printf '%s\n' "$out"
}

codeload_url() {
  printf 'https://codeload.github.com/%s/tar.gz/%s\n' "$REPO" "$(urlencode "$1")"
}

require_node() {
  if ! command -v node >/dev/null 2>&1; then
    die "Node.js 20 or newer is required, and 'node' was not found on PATH. Install it from https://nodejs.org/ and run this again."
  fi
  if ! command -v npm >/dev/null 2>&1; then
    die "npm was not found. It ships with Node.js 20 or newer. Install Node.js and run this again."
  fi
  local major
  if ! major="$(node -p 'process.versions.node.split(".")[0]')"; then
    die "could not read the Node.js version. atte needs Node.js 20 or newer."
  fi
  if [[ ! "$major" =~ ^[0-9]+$ ]] || [[ "$major" -lt 20 ]]; then
    die "Node.js $(node -v 2>/dev/null || echo "$major") is too old. atte needs Node.js 20 or newer."
  fi
}

is_skill_name() {
  local name="$1"
  local skill
  for skill in "${SKILLS[@]}"; do
    [[ "$skill" == "$name" ]] && return 0
  done
  return 1
}

safe_skill_path() {
  local path="$1"
  local base parent
  [[ "$path" == /* ]] || return 1
  case "$path" in
    *"/.."*|*"../"*) return 1 ;;
  esac
  base="$(basename "$path")"
  is_skill_name "$base" || return 1
  parent="$(dirname "$path")"
  [[ "$parent" != "/" && "$parent" != "$HOME" && "$path" != "$HOME" ]] || return 1
  [[ -d "$path" ]] || return 1
  return 0
}

agent_skills_dir() {
  case "$1" in
    cursor) printf '%s\n' "$HOME/.cursor/skills" ;;
    claude) printf '%s\n' "$HOME/.claude/skills" ;;
    qoder) printf '%s\n' "$HOME/.qoder/skills" ;;
    kiro) printf '%s\n' "$HOME/.kiro/skills" ;;
    omp) printf '%s\n' "$HOME/.omp/agent/skills" ;;
    agents) printf '%s\n' "$HOME/.agents/skills" ;;
    codex) printf '%s\n' "$HOME/.codex/skills" ;;
    *) return 1 ;;
  esac
}

abs_dir() {
  mkdir -p "$1"
  (cd "$1" && pwd)
}

detect_targets() {
  local home_dir name dir found=0
  for name in cursor claude codex qoder kiro omp agents; do
    home_dir="$HOME/.$name"
    if [[ -d "$home_dir" || -d "$home_dir/skills" ]]; then
      dir="$(abs_dir "$(agent_skills_dir "$name")")"
      TARGETS+=("$dir")
      found=1
    fi
  done
  if [[ "$found" -eq 0 ]]; then
    dir="$(abs_dir "$HOME/.cursor/skills")"
    TARGETS+=("$dir")
    echo "No Cursor, Claude, or Codex home was found. Skills will be copied to $dir." >&2
  fi
}

resolve_targets() {
  local agent dir
  if [[ ${#AGENTS[@]} -eq 0 && ${#TARGETS[@]} -eq 0 ]]; then
    detect_targets
    return
  fi
  local requested=()
  local existing=()
  if [[ ${#TARGETS[@]} -gt 0 ]]; then
    existing=("${TARGETS[@]}")
    TARGETS=()
    for dir in "${existing[@]}"; do
      [[ -n "$dir" ]] || die "--target needs a directory"
      TARGETS+=("$(abs_dir "$dir")")
    done
  fi
  for agent in "${AGENTS[@]}"; do
    if [[ "$agent" == "all" ]]; then
      requested+=(cursor claude codex qoder kiro omp agents)
    else
      agent_skills_dir "$agent" >/dev/null || die "--agent must be cursor, claude, codex, qoder, kiro, omp, agents, or all"
      requested+=("$agent")
    fi
  done
  for agent in "${requested[@]}"; do
    TARGETS+=("$(abs_dir "$(agent_skills_dir "$agent")")")
  done
}

copy_skills() {
  local kit="$1"
  local target name
  INSTALLED_SKILLS=()
  for target in "${TARGETS[@]}"; do
    mkdir -p "$target"
    for name in "${SKILLS[@]}"; do
      [[ -d "$kit/skills/$name" ]] || die "kit is missing skills/$name"
      rm -rf "$target/$name"
      cp -R "$kit/skills/$name" "$target/$name"
      INSTALLED_SKILLS+=("$target/$name")
    done
  done
}

verify_shim_target() {
  local shim="$BIN_DIR/atte"
  [[ -e "$shim" || -L "$shim" ]] || return 0
  [[ -f "$shim" && ! -L "$shim" ]] || die "refused to replace unowned CLI entry: $shim"
  [[ "$(head -n 2 "$shim" 2>/dev/null)" == $'#!/bin/sh\n# atte-shim' ]] &&
    grep -q -E '^exec .+/cli/bin/atte\.js "\$@"$' "$shim" ||
    die "refused to replace unowned CLI entry: $shim"
}

write_shim() {
  local bin_js="$1"
  verify_shim_target
  mkdir -p "$BIN_DIR"
  SHIM_PATH="$BIN_DIR/atte"
  local temporary
  temporary="$(mktemp "$BIN_DIR/.atte-shim.XXXXXX")"
  {
    printf '%s\n' "#!/bin/sh"
    printf '%s\n' "# $SHIM_MARKER"
    printf 'exec %q "$@"\n' "$bin_js"
  } >"$temporary"
  chmod 755 "$temporary"
  mv -f "$temporary" "$SHIM_PATH"
}

write_manifest() {
  local kit="$1"
  local line
  MANIFEST="$KIT_HOME/manifest"
  {
    printf '%s\n' "# atte-manifest"
    printf 'ref=%s\n' "$REF"
    printf 'dir=%s\n' "$(ref_dir_name "$REF")"
    printf 'kit=%s\n' "$kit"
    printf 'shim=%s\n' "$SHIM_PATH"
    for line in "${INSTALLED_SKILLS[@]}"; do
      printf 'skill=%s\n' "$line"
    done
  } >"$MANIFEST"
}

remove_kit_dir() {
  local kit="$1" base
  [[ -n "$kit" ]] || return 0
  case "$kit" in
    "$KIT_HOME"/*) ;;
    *)
      echo "warning: refused to delete $kit" >&2
      return 0
      ;;
  esac
  case "$kit" in
    *"/.."*|*"../"*)
      echo "warning: refused to delete $kit" >&2
      return 0
      ;;
  esac
  base="$(basename "$kit")"
  [[ "$base" != "current" && "$base" != "manifest" && "$kit" != "$KIT_HOME" ]] || return 0
  if [[ -L "$kit" ]]; then
    echo "warning: refused to delete symlink $kit" >&2
    return 0
  fi
  if [[ -d "$kit" ]]; then
    rm -rf "$kit"
    echo "removed previous kit $kit"
  fi
}

migrate_legacy_home() {
  [[ "$KIT_HOME" != "$LEGACY_KIT_HOME" ]] || return 0
  [[ ! -e "$KIT_HOME" && -d "$LEGACY_KIT_HOME" && ! -L "$LEGACY_KIT_HOME" ]] || return 0
  if node - "$LEGACY_KIT_HOME" "$KIT_HOME" <<'NODE'
const { cp, lstat, mkdir, readFile, readlink, readdir, rename, rm, writeFile } = require("node:fs/promises");
const { createHash, randomUUID } = require("node:crypto");
const { dirname, join } = require("node:path");

async function filesUnder(root, prefix = "") {
  const files = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) files.push({ path, type: "symlink" });
    else if (entry.isDirectory()) files.push(...await filesUnder(root, path));
    else if (entry.isFile()) files.push({ path, type: "file" });
    else throw new Error(`only regular files can be migrated: ${path}`);
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

(async () => {
  const [legacy, current] = process.argv.slice(2);
  const temporary = join(dirname(current), `.atte-migration-${process.pid}-${randomUUID()}`);
  try {
    await mkdir(dirname(current), { recursive: true });
    await cp(legacy, temporary, {
      recursive: true, force: false, errorOnExist: true, dereference: false, verbatimSymlinks: true,
    });
    const expected = await filesUnder(legacy), actual = await filesUnder(temporary);
    if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error("file list mismatch");
    for (const { path, type } of expected) {
      if (type === "symlink") {
        if (await readlink(join(legacy, path)) !== await readlink(join(temporary, path)))
          throw new Error(`symbolic link mismatch: ${path}`);
        continue;
      }
      const [before, after] = await Promise.all([readFile(join(legacy, path)), readFile(join(temporary, path))]);
      if (createHash("sha256").update(before).digest("hex") !== createHash("sha256").update(after).digest("hex"))
        throw new Error(`digest mismatch: ${path}`);
    }
    await writeFile(join(temporary, ".atte-migration.json"), `${JSON.stringify({
      version: 1, source: legacy, migratedAt: new Date().toISOString(), verified: true,
    }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, current);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
NODE
  then
    echo "migrated $LEGACY_KIT_HOME to $KIT_HOME; the original remains in place"
  else
    echo "warning: could not migrate $LEGACY_KIT_HOME; continuing to use the old directory" >&2
    KIT_HOME="$LEGACY_KIT_HOME"
  fi
}

remove_legacy_shim() {
  local shim="$BIN_DIR/crewvane"
  [[ -f "$shim" && ! -L "$shim" ]] || return 0
  if [[ "$(head -n 2 "$shim" 2>/dev/null)" == $'#!/bin/sh\n# crewvane-shim' ]] &&
    grep -q -E '^exec .+/cli/bin/crewvane\.js "\$@"$' "$shim"; then
    rm -f "$shim"
    echo "removed old managed shim $shim"
  else
    echo "warning: left $shim in place because it is not a verified old Atte/Crewvane shim" >&2
  fi
}

remove_recorded_kits() {
  local keep="$1" manifest="$KIT_HOME/manifest" line kit
  [[ -f "$manifest" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      kit=*)
        kit="${line#kit=}"
        if [[ "$kit" != "$keep" ]]; then
          remove_kit_dir "$kit"
        fi
        ;;
    esac
  done <"$manifest"
}

link_current() {
  local dest="$1" link="$KIT_HOME/current" name
  name="$(basename "$dest")"
  if [[ -e "$link" && ! -L "$link" ]]; then
    die "$link exists and is not a symlink"
  fi
  ln -sfn "$name" "$link"
}

kit_home_is_ours() {
  [[ "$KIT_HOME" == /* ]] || return 1
  [[ "$KIT_HOME" != "/" && "$KIT_HOME" != "$HOME" && "$KIT_HOME" != "$HOME/" ]] || return 1
  case "$KIT_HOME" in
    *"/.."*|*"../"*) return 1 ;;
  esac
  [[ -d "$KIT_HOME" ]] || return 1
  if [[ "$(basename "$KIT_HOME")" == ".atte" ]]; then
    return 0
  fi
  [[ -f "$KIT_HOME/manifest" ]] && grep -q -F "atte-manifest" "$KIT_HOME/manifest"
}

on_path() {
  case ":$PATH:" in
    *":$BIN_DIR:"*) return 0 ;;
    *) return 1 ;;
  esac
}

unique_targets() {
  local dir seen=""
  local next=()
  for dir in "${TARGETS[@]}"; do
    case " $seen " in
      *" $dir "*) ;;
      *)
        next+=("$dir")
        seen="$seen $dir"
        ;;
    esac
  done
  TARGETS=("${next[@]}")
}

TMP_DIR=""
STAGE_DIR=""
cleanup_install() {
  if [[ -n "$TMP_DIR" ]]; then
    rm -rf "$TMP_DIR"
  fi
  if [[ -n "$STAGE_DIR" && -d "$STAGE_DIR" ]]; then
    rm -rf "$STAGE_DIR"
  fi
}

install_kit() {
  valid_ref "$REF" || die "ref must be a branch or tag (for example main, v0.1.0, or feature/foo)"
  verify_shim_target
  require_node
  migrate_legacy_home
  command -v tar >/dev/null 2>&1 || die "tar is required"
  trap cleanup_install EXIT
  local extract src dest
  TMP_DIR="$(mktemp -d)"
  extract="$TMP_DIR/extract"
  mkdir -p "$extract"
  if [[ -n "${ATTE_TARBALL:-}" ]]; then
    [[ -f "$ATTE_TARBALL" ]] || die "ATTE_TARBALL is not a file: $ATTE_TARBALL"
    echo "Installing atte from $ATTE_TARBALL ($REF)"
    tar -xzf "$ATTE_TARBALL" -C "$extract"
  else
    command -v curl >/dev/null 2>&1 || die "curl is required"
    local url
    url="$(codeload_url "$REF")"
    echo "Downloading atte ($REF)"
    curl -fsSL "$url" | tar -xz -C "$extract"
  fi

  src=""
  if [[ -d "$extract/skills" && -f "$extract/cli/package.json" ]]; then
    src="$extract"
  else
    local candidate
    for candidate in "$extract"/*; do
      if [[ -d "$candidate/skills" && -f "$candidate/cli/package.json" ]]; then
        src="$candidate"
        break
      fi
    done
  fi
  [[ -n "$src" ]] || die "downloaded archive does not look like atte"

  resolve_targets
  [[ ${#TARGETS[@]} -gt 0 ]] || die "no skill directory to install into"
  unique_targets

  local ref_dir
  ref_dir="$(ref_dir_name "$REF")"
  dest="$KIT_HOME/$ref_dir"
  STAGE_DIR="$KIT_HOME/.staging-$ref_dir"
  mkdir -p "$KIT_HOME"
  rm -rf "$STAGE_DIR"
  mkdir -p "$STAGE_DIR"
  cp -a "$src"/. "$STAGE_DIR"/
  rm -rf "$STAGE_DIR/node_modules" "$STAGE_DIR/cli/node_modules"
  echo "Installing the atte CLI (Node $(node -v))"
  (
    cd "$STAGE_DIR" &&
      npm install --omit=dev --no-update-notifier --no-fund --no-audit --silent </dev/null
  ) || die "npm install failed"
  chmod 755 "$STAGE_DIR/cli/bin/atte.js"
  rm -rf "$dest"
  mv "$STAGE_DIR" "$dest"
  STAGE_DIR=""
  rm -rf "$TMP_DIR"
  TMP_DIR=""

  remove_recorded_kits "$dest"
  link_current "$dest"
  write_shim "$KIT_HOME/current/cli/bin/atte.js"
  remove_legacy_shim
  copy_skills "$KIT_HOME/current"
  write_manifest "$dest"

  if ! on_path; then
    echo "warning: $BIN_DIR is not on PATH. Add this to your shell profile:" >&2
    echo "  export PATH=\"\$HOME/.local/bin:\$PATH\"" >&2
  fi

  echo
  echo "atte installed"
  echo "  ref:     $REF"
  echo "  kit:     $dest"
  echo "  current: $KIT_HOME/current"
  echo "  shim:    $SHIM_PATH"
  local target
  for target in "${TARGETS[@]}"; do
    echo "  skills: $target"
  done
  echo
  echo "Next: open your project and tell the captain /ship-setup"
}

remove_shim() {
  local shim="$1"
  [[ -f "$shim" ]] || return 0
  if grep -q -F "$SHIM_MARKER" "$shim"; then
    rm -f "$shim"
    echo "removed shim $shim"
  else
    echo "warning: left $shim in place because it was not installed by atte" >&2
  fi
}

remove_skill() {
  local path="$1"
  if safe_skill_path "$path"; then
    rm -rf "$path"
    echo "removed skill $path"
    return 0
  fi
  echo "warning: skipped $path (not a skill this installer is allowed to delete)" >&2
  return 0
}

uninstall_kit() {
  local manifest="$KIT_HOME/manifest"
  local shim="$BIN_DIR/atte"
  local skills=()
  local line skill
  if [[ -f "$manifest" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      case "$line" in
        shim=*) shim="${line#shim=}" ;;
        skill=*) skills+=("${line#skill=}") ;;
      esac
    done <"$manifest"
  else
    echo "No install manifest found. Removing the shim (if it is ours) and $KIT_HOME." >&2
  fi
  if [[ ${#skills[@]} -gt 0 ]]; then
    for skill in "${skills[@]}"; do
      remove_skill "$skill"
    done
  fi
  remove_shim "$shim"
  if kit_home_is_ours; then
    rm -rf "$KIT_HOME"
    echo "removed $KIT_HOME"
  elif [[ -e "$KIT_HOME" ]]; then
    echo "warning: refused to delete $KIT_HOME" >&2
  fi
  echo
  echo "atte removed"
  echo
  echo "Next: nothing remains on PATH from this installer. Project repositories were not modified."
}

EXPLICIT_REF=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref)
      [[ $# -ge 2 ]] || die "--ref needs a name"
      REF="$2"
      EXPLICIT_REF=1
      shift 2
      ;;
    --target)
      [[ $# -ge 2 ]] || die "--target needs a directory"
      TARGETS+=("$2")
      shift 2
      ;;
    --agent)
      [[ $# -ge 2 ]] || die "--agent needs cursor, claude, codex, qoder, kiro, omp, agents, or all"
      AGENTS+=("$2")
      shift 2
      ;;
    --uninstall)
      UNINSTALL=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1 (try --help)"
      ;;
  esac
done

refuse_windows
export UNINSTALL_EXPLICIT_REF="$EXPLICIT_REF"

if [[ "$UNINSTALL" -eq 1 ]]; then
  uninstall_kit
else
  install_kit
fi
