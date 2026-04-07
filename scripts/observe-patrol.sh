#!/bin/bash
# 可观测性巡检 - 通过 claude CLI 执行
# 用法:
#   手动: ./observe-patrol.sh
#   crontab: 17 * * * * /Users/mac28/workspace/java/cses/scripts/observe-patrol.sh

SCRIPT_DIR="/Users/mac28/workspace/frontend/TraceWeaver/scripts"
PROMPT_FILE="${SCRIPT_DIR}/observe-patrol.md"
LOG_FILE="/tmp/observe-patrol-$(date +%Y%m%d).log"

echo "=== Observability Patrol $(date) ===" >> "$LOG_FILE"

# 用 claude CLI 的 -p 模式执行（非交互，读 prompt 文件）
claude -p "$(cat "$PROMPT_FILE")" \
  --allowedTools "Bash,Read,Write,Edit,Grep,Glob" \
  2>&1 | tee -a "$LOG_FILE"

echo "=== Done $(date) ===" >> "$LOG_FILE"
