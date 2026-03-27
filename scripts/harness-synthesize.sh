#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

# Stop hook: cold experience synthesis + entropy management
# Reads hot signals from docs/harness/experience.ndjson for this session,
# deduplicates, compares against existing rules, and generates candidate rules.

# Always exit 0 — hook failures must not break CC session
trap 'exit 0' ERR

# ---------------------------------------------------------------------------
# Helpers (reused patterns from harness-collect.sh)
# ---------------------------------------------------------------------------

extract_json_string_field() {
  local json="$1"
  local field="$2"
  local rest="${json#*\"${field}\"}"
  [ "${rest}" = "${json}" ] && printf '' && return
  rest="${rest#*:}"
  rest="${rest#*\"}"
  printf '%s' "${rest%%\"*}"
}

# ---------------------------------------------------------------------------
# Globals
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
HARNESS_DIR="${PROJECT_ROOT}/docs/harness"
EXPERIENCE_FILE="${HARNESS_DIR}/experience.ndjson"
CANDIDATES_FILE="${HARNESS_DIR}/_candidates.md"
SESSION_ID="${SESSION_ID:-}"

# Counters
count_signals=0
count_new=0
count_bumped=0
count_entropy_drift=0

# ---------------------------------------------------------------------------
# Candidate ID management
# ---------------------------------------------------------------------------

next_candidate_id() {
  local max_id=0
  if [[ -f "${CANDIDATES_FILE}" ]]; then
    local id
    while IFS= read -r line; do
      id="$(printf '%s' "${line}" | grep -oE '\[C-[0-9]+\]' | grep -oE '[0-9]+' | head -1 || true)"
      if [[ -n "${id}" && "${id}" -gt "${max_id}" ]]; then
        max_id="${id}"
      fi
    done < "${CANDIDATES_FILE}"
  fi
  printf '%d' $(( max_id + 1 ))
}

# ---------------------------------------------------------------------------
# Rule file detection: signal type → file path
# ---------------------------------------------------------------------------

rule_file_for() {
  local sig_type="$1"
  local module="$2"
  local module_dir="${HARNESS_DIR}/${module}"

  case "${sig_type}" in
    decision)  printf '%s/decisions.md'   "${module_dir}" ;;
    error)     printf '%s/constraints.md' "${module_dir}" ;;
    pattern)   printf '%s/patterns.md'    "${module_dir}" ;;
    *)         printf '' ;;
  esac
}

# ---------------------------------------------------------------------------
# Check whether a signal already exists in a given file.
# Returns 0 (found) or 1 (not found).
# ---------------------------------------------------------------------------

signal_exists_in_file() {
  local file="$1"
  local signal="$2"
  [[ -f "${file}" ]] || return 1
  grep -qF "${signal}" "${file}" 2>/dev/null
}

# ---------------------------------------------------------------------------
# Bump hit count in a file immediately after the line containing the signal.
# Finds the nearest "- **命中次数**: N" after the signal line and increments N.
# ---------------------------------------------------------------------------

bump_hit_count_in_file() {
  local file="$1"
  local signal="$2"

  # Find line number of signal
  local signal_line
  signal_line="$(grep -nF "${signal}" "${file}" 2>/dev/null | head -1 | cut -d: -f1 || true)"
  [[ -z "${signal_line}" ]] && return 0

  # Find the hit-count line after the signal
  local hit_line
  hit_line="$(tail -n "+${signal_line}" "${file}" | grep -n '命中次数' | head -1 | cut -d: -f1 || true)"
  [[ -z "${hit_line}" ]] && return 0

  local abs_line=$(( signal_line + hit_line - 1 ))

  # Read current count
  local current_line
  current_line="$(sed -n "${abs_line}p" "${file}")"
  local current_n
  current_n="$(printf '%s' "${current_line}" | grep -oE '[0-9]+' | tail -1 || true)"
  [[ -z "${current_n}" ]] && return 0

  local new_n=$(( current_n + 1 ))

  # Replace in-place using sed
  sed -i.bak "${abs_line}s/命中次数\*\*: ${current_n}/命中次数**: ${new_n}/" "${file}" && rm -f "${file}.bak"
}

# ---------------------------------------------------------------------------
# Append a new candidate rule to _candidates.md
# ---------------------------------------------------------------------------

append_candidate() {
  local cid="$1"
  local signal="$2"
  local sig_type="$3"
  local module="$4"
  local context="$5"
  local today
  today="$(date -u +"%Y-%m-%d")"

  cat >> "${CANDIDATES_FILE}" <<EOF

### [C-${cid}] ${signal}
- **类型**: ${sig_type}
- **目标模块**: ${module}
- **置信度**: candidate
- **来源**: session-${SESSION_ID}, ${today}
- **命中次数**: 1
- **触发条件**: ${context}
- **规则**: （待提炼）
- **原因**: 自动采集自 session ${SESSION_ID}
EOF
}

# ---------------------------------------------------------------------------
# Count confirmed rules (lines matching ^### \[R- across all rule files)
# ---------------------------------------------------------------------------

count_confirmed_rules() {
  local total=0
  local count
  for f in "${HARNESS_DIR}"/*/decisions.md \
            "${HARNESS_DIR}"/*/constraints.md \
            "${HARNESS_DIR}"/*/patterns.md; do
    [[ -f "${f}" ]] || continue
    count="$(grep -cE '^\#\#\# \[R-' "${f}" 2>/dev/null || true)"
    total=$(( total + count ))
  done
  printf '%d' "${total}"
}

# ---------------------------------------------------------------------------
# Count candidate rules in _candidates.md
# ---------------------------------------------------------------------------

count_candidate_rules() {
  local count=0
  if [[ -f "${CANDIDATES_FILE}" ]]; then
    count="$(grep -cE '^\#\#\# \[C-[0-9]+\]' "${CANDIDATES_FILE}" 2>/dev/null || true)"
  fi
  printf '%d' "${count}"
}

# ---------------------------------------------------------------------------
# Entropy check: packages/tw-daemon/CLAUDE.md vs actual test count
# ---------------------------------------------------------------------------

entropy_check_daemon_tests() {
  local claude_file="${PROJECT_ROOT}/packages/tw-daemon/CLAUDE.md"
  [[ -f "${claude_file}" ]] || return 0

  # Extract first number adjacent to "passing|passed|tests" pattern
  local declared
  declared="$(grep -oE '[0-9]+ (passing|passed|tests)' "${claude_file}" | grep -oE '^[0-9]+' | head -1 || true)"
  [[ -z "${declared}" ]] && return 0  # no recognizable number, skip

  # Run tests in subshell with 60s timeout; ignore failure
  local actual
  actual="$(
    (
      cd "${PROJECT_ROOT}"
      timeout 60 npm test --workspace=packages/tw-daemon 2>&1 || true
    ) | grep -oE '[0-9]+ (passing|passed)' | grep -oE '^[0-9]+' | head -1 || true
  )"

  if [[ -z "${actual}" ]]; then
    # Test run failed or no match — treat as unknown, do not increment drift
    return 0
  fi

  if [[ "${declared}" != "${actual}" ]]; then
    printf '  ⚠️  tw-daemon/CLAUDE.md: 声明 %s 个测试，实际 %s 个\n' "${declared}" "${actual}"
    count_entropy_drift=$(( count_entropy_drift + 1 ))
  fi
}

# ---------------------------------------------------------------------------
# Entropy check: examples/CLAUDE.md vs actual .ts file count in examples/src/
# ---------------------------------------------------------------------------

entropy_check_examples() {
  local claude_file="${PROJECT_ROOT}/examples/CLAUDE.md"
  [[ -f "${claude_file}" ]] || return 0

  # Extract first number adjacent to "个示例|examples" pattern
  local declared
  declared="$(grep -oE '[0-9]+ (个示例|examples)' "${claude_file}" | grep -oE '^[0-9]+' | head -1 || true)"
  [[ -z "${declared}" ]] && return 0  # no recognizable number, skip

  # Count actual .ts files in examples/src/
  local actual=0
  if [[ -d "${PROJECT_ROOT}/examples/src" ]]; then
    actual="$(find "${PROJECT_ROOT}/examples/src" -maxdepth 1 -name '*.ts' | wc -l | tr -d ' ')"
  fi

  if [[ "${declared}" != "${actual}" ]]; then
    printf '  ⚠️  examples/CLAUDE.md: 声明 %s 个示例，实际 %s 个\n' "${declared}" "${actual}"
    count_entropy_drift=$(( count_entropy_drift + 1 ))
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  # Guard: experience file must exist
  if [[ ! -f "${EXPERIENCE_FILE}" ]]; then
    printf '📭 experience.ndjson not found, skipping synthesis\n'
    return 0
  fi

  # Guard: SESSION_ID must be set
  if [[ -z "${SESSION_ID}" ]]; then
    printf '⚠️  SESSION_ID not set, skipping synthesis\n'
    return 0
  fi

  # ---- Step 1: Extract this session's signals ----
  local signals=()
  while IFS= read -r line; do
    [[ -z "${line}" ]] && continue
    local sid
    sid="$(extract_json_string_field "${line}" "session_id")"
    [[ "${sid}" != "${SESSION_ID}" ]] && continue
    signals+=("${line}")
  done < "${EXPERIENCE_FILE}"

  count_signals="${#signals[@]}"

  # ---- Step 2: Process each signal ----
  # Deduplicate within this batch using a newline-delimited string (bash 3 compat)
  local seen_keys=""

  local next_id
  next_id="$(next_candidate_id)"

  local i
  for (( i=0; i<${#signals[@]}; i++ )); do
    local line="${signals[$i]}"
    local sig_type module signal context

    sig_type="$(extract_json_string_field "${line}" "type")"
    module="$(extract_json_string_field "${line}" "module")"
    signal="$(extract_json_string_field "${line}" "signal")"
    context="$(extract_json_string_field "${line}" "context")"

    # Skip empty signals
    [[ -z "${signal}" ]] && continue

    # Deduplicate within session batch (bash 3 compatible)
    local dedup_key="${module}::${signal}"
    if printf '%s\n' "${seen_keys}" | grep -qF "${dedup_key}" 2>/dev/null; then
      continue
    fi
    seen_keys="${seen_keys}
${dedup_key}"

    # Determine rule file
    local rule_file=""
    rule_file="$(rule_file_for "${sig_type}" "${module}")"

    # Check if signal exists in module rule file
    if [[ -n "${rule_file}" ]] && signal_exists_in_file "${rule_file}" "${signal}"; then
      bump_hit_count_in_file "${rule_file}" "${signal}"
      count_bumped=$(( count_bumped + 1 ))
      continue
    fi

    # Check if signal exists in _candidates.md
    if signal_exists_in_file "${CANDIDATES_FILE}" "${signal}"; then
      bump_hit_count_in_file "${CANDIDATES_FILE}" "${signal}"
      count_bumped=$(( count_bumped + 1 ))
      continue
    fi

    # New signal → append as candidate
    append_candidate "${next_id}" "${signal}" "${sig_type}" "${module}" "${context}"
    next_id=$(( next_id + 1 ))
    count_new=$(( count_new + 1 ))
  done

  # ---- Step 3: Entropy checks ----
  local entropy_output=""
  entropy_output="$(entropy_check_daemon_tests 2>&1 || true)"
  [[ -n "${entropy_output}" ]] && printf '%s\n' "${entropy_output}"

  local entropy_output2=""
  entropy_output2="$(entropy_check_examples 2>&1 || true)"
  [[ -n "${entropy_output2}" ]] && printf '%s\n' "${entropy_output2}"

  # ---- Step 4: Summary ----
  local confirmed_count candidate_count
  confirmed_count="$(count_confirmed_rules)"
  candidate_count="$(count_candidate_rules)"

  printf '\n'
  printf '🔧 Harness 熵管理摘要\n'
  printf '├─ 📥 本次采集: %d 条热信号\n'  "${count_signals}"
  printf '├─ 📋 新增候选: %d 条\n'        "${count_new}"
  printf '├─ ⬆️  升级规则: %d 条\n'       "${count_bumped}"
  printf '├─ ⚠️  熵偏差: %d 处\n'         "${count_entropy_drift}"
  printf '├─ 📊 确认规则: %d 条\n'        "${confirmed_count}"
  printf '└─ 📝 候选规则: %d 条\n'        "${candidate_count}"
}

main
exit 0
