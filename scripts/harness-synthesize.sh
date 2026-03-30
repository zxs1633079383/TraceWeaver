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
EVOLUTION_LOG="${HARNESS_DIR}/evolution-log.ndjson"
SESSION_ID="${SESSION_ID:-}"

# Counters
count_signals=0
count_new=0
count_bumped=0
count_entropy_drift=0
count_errors=0
count_prevented=0

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

  # Find next rule heading after signal_line
  local next_heading_line
  next_heading_line="$(tail -n "+$((signal_line + 1))" "${file}" | grep -n '^### \[' | head -1 | cut -d: -f1 || true)"

  local search_end
  if [[ -n "${next_heading_line}" ]]; then
    # next_heading_line is relative to (signal_line + 1), convert to absolute line count from signal_line
    search_end=$(( signal_line + next_heading_line ))
  else
    # No next heading found — search to end of file
    search_end=9999999
  fi

  # Only search within this rule's section
  local hit_line
  hit_line="$(sed -n "${signal_line},${search_end}p" "${file}" | grep -n '命中次数' | head -1 | cut -d: -f1 || true)"
  if [[ -z "${hit_line}" ]]; then
    return 0  # No hit count line found in this rule's section
  fi
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
- **阻止次数**: 0
- **效能**: 0
- **谱系**: session-${SESSION_ID} 自动采集
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
  local drift_file="$1"
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
    printf 'drift\n' >> "${drift_file}"
  fi
}

# ---------------------------------------------------------------------------
# Entropy check: examples/CLAUDE.md vs actual .ts file count in examples/src/
# ---------------------------------------------------------------------------

entropy_check_examples() {
  local drift_file="$1"
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
    printf 'drift\n' >> "${drift_file}"
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

  # NOTE: We load signals into an array and iterate with a for-loop intentionally.
  # Using `echo "$signals" | while read` would process in a subshell, silently
  # discarding all counter increments (count_new_candidates, count_upgraded, next_id).
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

    # Track error signals for effectiveness calculation
    if [[ "${sig_type}" == "error" ]]; then
      count_errors=$(( count_errors + 1 ))
    fi

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
  local DRIFT_FILE
  DRIFT_FILE="$(mktemp)"
  entropy_check_daemon_tests "${DRIFT_FILE}"
  entropy_check_examples "${DRIFT_FILE}"
  count_entropy_drift="$(wc -l < "${DRIFT_FILE}" | tr -d ' ')"
  rm -f "${DRIFT_FILE}"

  # ---- Step 4: Evolution Log ----
  local rules_changed=""
  if [[ ${count_bumped} -gt 0 ]]; then
    rules_changed="${count_bumped} rules hit+1"
  fi
  if [[ ${count_new} -gt 0 ]]; then
    [[ -n "${rules_changed}" ]] && rules_changed="${rules_changed}, "
    rules_changed="${rules_changed}${count_new} new candidates"
  fi

  # Generate next_focus based on gaps and signals
  local next_focus=""

  # Check coverage gaps: which modules have few rules
  for mod in daemon cli types examples; do
    local mod_rule_count=0
    for rf in "${HARNESS_DIR}/${mod}"/decisions.md \
              "${HARNESS_DIR}/${mod}"/constraints.md \
              "${HARNESS_DIR}/${mod}"/patterns.md; do
      [[ -f "${rf}" ]] || continue
      local c
      c="$(grep -cE '^\#\#\# \[R-' "${rf}" 2>/dev/null || true)"
      mod_rule_count=$(( mod_rule_count + c ))
    done
    if [[ ${mod_rule_count} -lt 2 ]]; then
      [[ -n "${next_focus}" ]] && next_focus="${next_focus}, "
      next_focus="${next_focus}${mod} module has only ${mod_rule_count} rules — observe for patterns"
    fi
  done

  # Check near-upgrade candidates (hit count >= 2)
  if [[ -f "${CANDIDATES_FILE}" ]]; then
    local near_upgrade
    near_upgrade="$(grep -B1 '命中次数.*[2-9]' "${CANDIDATES_FILE}" 2>/dev/null | grep -oE '\[C-[0-9]+\]' || true)"
    if [[ -n "${near_upgrade}" ]]; then
      [[ -n "${next_focus}" ]] && next_focus="${next_focus}, "
      next_focus="${next_focus}${near_upgrade} near upgrade threshold"
    fi
  fi

  # Check entropy drift
  if [[ ${count_entropy_drift} -gt 0 ]]; then
    [[ -n "${next_focus}" ]] && next_focus="${next_focus}, "
    next_focus="${next_focus}${count_entropy_drift} entropy drifts need attention"
  fi

  [[ -z "${next_focus}" ]] && next_focus="no specific focus — continue normal development"

  # Count iteration number
  local iteration=1
  if [[ -f "${EVOLUTION_LOG}" ]]; then
    local existing_count
    existing_count="$(wc -l < "${EVOLUTION_LOG}" | tr -d ' ')"
    iteration=$(( existing_count + 1 ))
  fi

  # Escape for JSON
  local esc_rules_changed esc_next_focus
  esc_rules_changed="$(printf '%s' "${rules_changed}" | sed 's/"/\\"/g')"
  esc_next_focus="$(printf '%s' "${next_focus}" | sed 's/"/\\"/g')"

  local ts
  ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  # Write evolution-log entry
  printf '{"ts":"%s","session_id":"%s","iteration":%d,"signals":%d,"errors":%d,"rules_changed":"%s","next_focus":"%s"}\n' \
    "${ts}" "${SESSION_ID}" "${iteration}" "${count_signals}" "${count_errors}" \
    "${esc_rules_changed}" "${esc_next_focus}" \
    >> "${EVOLUTION_LOG}"

  # ---- Step 5: Summary ----
  local confirmed_count candidate_count
  confirmed_count="$(count_confirmed_rules)"
  candidate_count="$(count_candidate_rules)"

  printf '\n'
  printf '🔧 Harness 熵管理摘要\n'
  printf '├─ 📥 本次采集: %d 条热信号 (%d errors)\n' "${count_signals}" "${count_errors}"
  printf '├─ 📋 新增候选: %d 条\n'        "${count_new}"
  printf '├─ ⬆️  升级规则: %d 条\n'       "${count_bumped}"
  printf '├─ ⚠️  熵偏差: %d 处\n'         "${count_entropy_drift}"
  printf '├─ 📊 确认规则: %d 条\n'        "${confirmed_count}"
  printf '├─ 📝 候选规则: %d 条\n'        "${candidate_count}"
  printf '├─ 📓 演进日志: 第 %d 轮\n'    "${iteration}"
  printf '└─ 🎯 下轮关注: %s\n'          "${next_focus}"

  # ---- Step 6: Emit evolution event to daemon (span + EventLog) ----
  # Reads TW_ENTITY_ID or .traceweaver/.tw-session for current session entity
  local entity_id="${TW_ENTITY_ID:-}"
  if [[ -z "${entity_id}" ]]; then
    local session_file="${PROJECT_ROOT}/.traceweaver/.tw-session"
    if [[ -f "${session_file}" ]]; then
      entity_id="$(cat "${session_file}" 2>/dev/null | tr -d '[:space:]')"
    fi
  fi

  if [[ -n "${entity_id}" ]]; then
    local socket_path="${PROJECT_ROOT}/.traceweaver/tw.sock"
    if [[ -S "${socket_path}" ]]; then
      # tw hook uses IPC sendSilent — we call the CLI directly
      local tw_bin="${PROJECT_ROOT}/packages/tw-cli/dist/index.js"
      if [[ -f "${tw_bin}" ]]; then
        # Emit harness.evolution event → span event in Jaeger + EventLog
        node "${tw_bin}" emit-event --entity-id "${entity_id}" \
          --event "harness.evolution" \
          --attr "iteration=${iteration}" \
          --attr "signals=${count_signals}" \
          --attr "errors=${count_errors}" \
          --attr "new_candidates=${count_new}" \
          --attr "rules_bumped=${count_bumped}" \
          --attr "entropy_drift=${count_entropy_drift}" \
          --attr "confirmed_rules=${confirmed_count}" \
          --attr "candidate_rules=${candidate_count}" \
          --attr "next_focus=${next_focus}" \
          --attr "rules_changed=${rules_changed}" \
          2>/dev/null || true

        # Also emit next_focus as a separate decision event for visibility
        if [[ "${next_focus}" != "no specific focus"* ]]; then
          node "${tw_bin}" emit-event --entity-id "${entity_id}" \
            --event "harness.next_focus" \
            --attr "focus=${next_focus}" \
            --attr "iteration=${iteration}" \
            2>/dev/null || true
        fi

        printf '  📡 已写入 daemon span: harness.evolution (entity=%s)\n' "${entity_id}"
      fi
    fi
  fi
}

main
exit 0
