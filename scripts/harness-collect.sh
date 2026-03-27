#!/usr/bin/env bash
set -euo pipefail

# PostToolUse hook: capture hot signals from CC tool calls
# Appends structured NDJSON to docs/harness/experience.ndjson

# Always exit 0 — hook failures must not break CC session
trap 'exit 0' ERR

main() {
  local tool_name="${TOOL_NAME:-}"
  local tool_input="${TOOL_INPUT:-}"
  local tool_output="${TOOL_OUTPUT:-}"
  local exit_code="${EXIT_CODE:-}"
  local session_id="${SESSION_ID:-}"

  # Determine project root from script location
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local project_root
  project_root="$(cd "${script_dir}/.." && pwd)"

  local outfile="${project_root}/docs/harness/experience.ndjson"
  mkdir -p "$(dirname "${outfile}")"

  local signal_type=""
  local module=""
  local signal=""
  local context=""
  local resolution=""

  case "${tool_name}" in
    Bash)
      if [[ -n "${exit_code}" && "${exit_code}" != "0" ]]; then
        signal_type="error"
        signal="${tool_input}"
        context="exit_code=${exit_code}"
        resolution="${tool_output}"
        module="$(detect_module "${tool_input}")"
      elif [[ "${tool_input}" == *"npm test"* || "${tool_input}" == *"vitest"* ]]; then
        signal_type="pattern"
        signal="${tool_input}"
        # Extract test count from output (e.g. "Tests: 5 passed" or "x passed")
        local test_count=""
        test_count="$(printf '%s' "${tool_output}" | grep -oE '[0-9]+ passed' | head -1 || true)"
        context="tests=${test_count:-unknown}"
        resolution=""
        module="$(detect_module "${tool_input}")"
      else
        return 0
      fi
      ;;
    Edit|Write)
      local file_path=""
      file_path="$(extract_file_path "${tool_input}")"
      if [[ -z "${file_path}" ]]; then
        return 0
      fi

      if [[ "${file_path}" == *"CLAUDE.md"* ]]; then
        signal_type="decision"
        module="$(detect_module "${file_path}")"
        if [[ -z "${module}" ]]; then
          module="root"
        fi
        signal="${tool_name} ${file_path}"
        context="config_change"
        resolution=""
      elif [[ "${file_path}" == */src/* && "${file_path}" != *.test.* ]]; then
        signal_type="decision"
        module="$(detect_module "${file_path}")"
        if [[ -z "${module}" ]]; then
          return 0
        fi
        signal="${tool_name} ${file_path}"
        context="src_change"
        resolution=""
      else
        return 0
      fi
      ;;
    *)
      return 0
      ;;
  esac

  # Truncate fields
  signal="$(truncate_str "${signal}" 200)"
  context="$(truncate_str "${context}" 200)"
  resolution="$(truncate_str "${resolution}" 300)"

  # Escape double quotes for JSON
  signal="$(escape_json "${signal}")"
  context="$(escape_json "${context}")"
  resolution="$(escape_json "${resolution}")"
  session_id="$(escape_json "${session_id}")"
  module="$(escape_json "${module}")"

  local ts
  ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  printf '{"ts":"%s","session_id":"%s","type":"%s","module":"%s","signal":"%s","context":"%s","resolution":"%s"}\n' \
    "${ts}" "${session_id}" "${signal_type}" "${module}" "${signal}" "${context}" "${resolution}" \
    >> "${outfile}"
}

extract_file_path() {
  local input="$1"
  # Extract file_path value from JSON string using bash pattern matching
  local rest="${input#*\"file_path\"}"
  if [[ "${rest}" == "${input}" ]]; then
    printf ''
    return 0
  fi
  rest="${rest#*:}"
  rest="${rest#*\"}"
  local val="${rest%%\"*}"
  printf '%s' "${val}"
}

detect_module() {
  local path="$1"
  if [[ "${path}" == *tw-daemon* || "${path}" == *packages/tw-daemon* ]]; then
    printf 'daemon'
  elif [[ "${path}" == *tw-cli* || "${path}" == *packages/tw-cli* ]]; then
    printf 'cli'
  elif [[ "${path}" == *tw-types* || "${path}" == *packages/tw-types* ]]; then
    printf 'types'
  elif [[ "${path}" == *examples* ]]; then
    printf 'examples'
  else
    printf ''
  fi
}

truncate_str() {
  local str="$1"
  local max="$2"
  if [[ ${#str} -gt ${max} ]]; then
    printf '%s' "${str:0:${max}}"
  else
    printf '%s' "${str}"
  fi
}

escape_json() {
  local str="$1"
  # Strip non-printable control chars (U+0000-U+001F) except \n \r \t
  str="$(printf '%s' "${str}" | tr -d '\000-\010\013\014\016-\037')"
  # Escape backslashes first, then double quotes
  str="${str//\\/\\\\}"
  str="${str//\"/\\\"}"
  # Normalize line endings and tabs
  str="${str//$'\n'/\\n}"
  str="${str//$'\r'/\\r}"
  str="${str//$'\t'/\\t}"
  printf '%s' "${str}"
}

main
exit 0
