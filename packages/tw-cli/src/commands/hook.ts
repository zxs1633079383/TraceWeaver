import { Command } from 'commander'
import { join } from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { IpcClient } from '../ipc-client.js'
import { getSocketPath } from '../daemon-manager.js'

const SESSION_FILE = join(process.cwd(), '.traceweaver', '.tw-session')

async function readEntityId(): Promise<string | undefined> {
  if (process.env.TW_ENTITY_ID) return process.env.TW_ENTITY_ID
  try {
    const content = await readFile(SESSION_FILE, 'utf8')
    return content.trim() || undefined
  } catch {
    return undefined
  }
}

async function writeSessionFile(entityId: string): Promise<void> {
  await mkdir(join(process.cwd(), '.traceweaver'), { recursive: true })
  await writeFile(SESSION_FILE, entityId, 'utf8')
}

async function sendSilent(method: string, params: Record<string, unknown>): Promise<boolean> {
  try {
    const client = new IpcClient(getSocketPath(), 2000)
    const res = await client.send({ method, params })
    return res.ok === true
  } catch {
    return false
  }
}

function classifyErrorSource(tool: string, cmd?: string): string {
  if (tool !== 'Bash') return 'tool'
  if (!cmd) return 'command'
  if (/\b(npm run build|tsc|esbuild)\b/.test(cmd)) return 'build'
  if (/\b(npm test|vitest|jest|mocha)\b/.test(cmd)) return 'test'
  if (/\b(node|ts-node|tsx)\b/.test(cmd)) return 'runtime'
  return 'command'
}

export function hookCommand(): Command {
  const cmd = new Command('hook')
  cmd.description('CC Hook integration commands (auto-invoked by Claude Code hooks)')

  cmd.command('session-start')
    .description('Create anonymous session entity (called by SessionStart hook)')
    .action(async () => {
      try {
        const sessionId = `session-${randomUUID().slice(0, 8)}`
        const ok = await sendSilent('register', { entity_type: 'task', id: sessionId })
        if (ok) {
          await writeSessionFile(sessionId)
          await sendSilent('emit_event', {
            entity_id: sessionId,
            event: 'session.started',
            attributes: { anonymous: true },
          })
        }
      } catch {
        // Silent — never block Claude Code
      }
    })

  cmd.command('pre-tool')
    .description('Record tool invocation (called by PreToolUse hook)')
    .requiredOption('--tool <name>', 'Tool name')
    .action(async (opts: { tool: string }) => {
      try {
        const entityId = await readEntityId()
        if (!entityId) return
        await sendSilent('emit_event', {
          entity_id: entityId,
          event: 'tool.invoked',
          attributes: { tool: opts.tool },
        })
      } catch {
        // Silent
      }
    })

  cmd.command('post-tool')
    .description('Record tool result (called by PostToolUse hook)')
    .requiredOption('--tool <name>', 'Tool name')
    .option('--exit-code <code>', 'Exit code', '0')
    .option('--stderr <text>', 'Stderr output')
    .option('--cmd <command>', 'Original command (for Bash source classification)')
    .action(async (opts: { tool: string; exitCode: string; stderr?: string; cmd?: string }) => {
      try {
        const entityId = await readEntityId()
        if (!entityId) return
        const exitCode = parseInt(opts.exitCode, 10)

        if (exitCode === 0) {
          await sendSilent('emit_event', {
            entity_id: entityId,
            event: 'tool.completed',
            attributes: { tool: opts.tool },
          })
        } else {
          const source = classifyErrorSource(opts.tool, opts.cmd)
          const message = (opts.stderr ?? '').slice(0, 500)
          await sendSilent('emit_event', {
            entity_id: entityId,
            event: 'error.captured',
            attributes: { source, tool: opts.tool, exit_code: exitCode, message },
          })
        }
      } catch {
        // Silent
      }
    })

  cmd.command('stop')
    .description('End session (called by Stop hook)')
    .action(async () => {
      try {
        const entityId = await readEntityId()
        if (!entityId) return
        await sendSilent('emit_event', {
          entity_id: entityId,
          event: 'session.ended',
        })
      } catch {
        // Silent
      }
    })

  cmd.command('rebind')
    .description('Rebind session to a formal entity')
    .requiredOption('--entity-id <id>', 'New entity id to bind to')
    .action(async (opts: { entityId: string }) => {
      try {
        const oldEntityId = await readEntityId()
        if (!oldEntityId) {
          console.error('[tw] No active session to rebind')
          return
        }
        const ok = await sendSilent('session_rebind', {
          old_entity_id: oldEntityId,
          new_entity_id: opts.entityId,
        })
        if (ok) {
          await writeSessionFile(opts.entityId)
        }
      } catch {
        // Silent
      }
    })

  return cmd
}
