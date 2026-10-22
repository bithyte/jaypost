#!/usr/bin/env bash
# Runs `jaypost send` for the GitHub Action (action.yml): installs the release binary that matches
# this checkout's package.json version, builds the argv from the inputs and runs it in direct mode.
# Reads INPUT_COMMAND, INPUT_TEXT, INPUT_OPTIONS, INPUT_DEFAULT, INPUT_TIMEOUT, INPUT_ALLOW_TEXT,
# INPUT_PROJECT, INPUT_FORMAT, JAYPOST_BOT_TOKEN, JAYPOST_OWNER_ID (JAYPOST_MODE and
# JAYPOST_PROVIDER pass through) and the runner's GITHUB_* and RUNNER_* variables.
# Exits with the binary's status; 2 means a bad input.
set -euo pipefail

fail() {
  echo "jaypost action: $2" >&2
  exit "$1"
}

command_name="${INPUT_COMMAND:-}"
text="${INPUT_TEXT:-}"
options="${INPUT_OPTIONS:-}"
default_answer="${INPUT_DEFAULT:-}"
timeout_seconds="${INPUT_TIMEOUT:-}"
allow_text="${INPUT_ALLOW_TEXT:-}"

if [ "${RUNNER_OS:-}" = Windows ]; then
  fail 1 "Windows runners aren't supported; see the npx example in the jaypost README"
fi
case "$command_name" in
  request | notify) ;;
  *) fail 2 "input command must be request or notify, got \"$command_name\"" ;;
esac
if [ -z "$text" ]; then
  fail 2 "input text is empty"
fi
for pair in "bot-token:${JAYPOST_BOT_TOKEN:-}" "owner-id:${JAYPOST_OWNER_ID:-}"; do
  if [ -z "${pair#*:}" ]; then
    fail 2 "input ${pair%%:*} is empty; pass it from a secret (pull requests from forks don't get secrets)"
  fi
done
case "$allow_text" in
  '' | true | false) ;;
  *) fail 2 "input allow-text must be true or false, got \"$allow_text\"" ;;
esac
if [ "$command_name" = request ]; then
  if [ -z "$default_answer" ]; then
    fail 2 "input default is required for command request"
  fi
  if [ -z "$options" ] && [ "$allow_text" != true ]; then
    fail 2 "input options or allow-text: true is required for command request"
  fi
else
  if [ -n "$options" ]; then fail 2 "input options only applies to command request"; fi
  if [ -n "$default_answer" ]; then fail 2 "input default only applies to command request"; fi
  if [ -n "$timeout_seconds" ]; then fail 2 "input timeout only applies to command request"; fi
  if [ "$allow_text" = true ]; then fail 2 "input allow-text only applies to command request"; fi
fi

version=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$GITHUB_ACTION_PATH/package.json")
if [ -z "$version" ]; then
  fail 1 "can't read the version from package.json"
fi

install_dir="$RUNNER_TEMP/jaypost-$version"
if [ ! -x "$install_dir/jaypost" ]; then
  if ! JAYPOST_INSTALL_DIR="$install_dir" JAYPOST_NO_INIT=1 \
    JAYPOST_RELEASE_URL="${JAYPOST_RELEASE_URL:-https://github.com/bithyte/jaypost/releases/download/v$version}" \
    sh "$GITHUB_ACTION_PATH/install.sh"; then
    exit 1
  fi
fi

project="${INPUT_PROJECT:-${GITHUB_REPOSITORY#*/}}"
run_link="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"
args=(send "$command_name" "--project=$project")
if [ -n "${INPUT_FORMAT:-}" ]; then
  args+=("--format=$INPUT_FORMAT")
fi
while IFS= read -r line || [ -n "$line" ]; do
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  if [ -n "$line" ]; then
    args+=("--option=$line")
  fi
done <<<"$options"
if [ -n "$default_answer" ]; then
  args+=("--default=$default_answer")
fi
if [ -n "$timeout_seconds" ]; then
  args+=("--timeout=$timeout_seconds")
fi
if [ "$allow_text" = true ]; then
  args+=(--allow-text)
fi
args+=(-- "$text"$'\n\n'"Workflow run: $run_link")

# The runner signals the step's shell (action.yml execs this script into it), not the binary, so forward a cancel as SIGTERM: the binary then
# edits the question to the cancelled line. Background children of a non-interactive shell ignore SIGINT.
output_file=$(mktemp "$RUNNER_TEMP/jaypost-output.XXXXXX")
"$install_dir/jaypost" "${args[@]}" >"$output_file" &
child=$!
trap 'kill -TERM "$child" 2>/dev/null || true' INT TERM
set +e
wait "$child"
status=$?
# A trapped signal ends wait early with the child still unreaped (running or a zombie)
while [ "$status" -gt 128 ] && kill -0 "$child" 2>/dev/null; do
  wait "$child"
  status=$?
done
set -e
trap - INT TERM

answer=$(cat "$output_file")
rm -f "$output_file"
if [ -n "$answer" ]; then
  printf '%s\n' "$answer"
fi
delimiter="jaypost_$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
{
  printf '%s\n' "answer<<$delimiter" "$answer" "$delimiter"
} >>"$GITHUB_OUTPUT"
if [ "$status" -eq 3 ]; then
  echo "jaypost action: declined (the answer was the default, or the question timed out)" >&2
fi
exit "$status"
