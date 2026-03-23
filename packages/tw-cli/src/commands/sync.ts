// packages/tw-cli/src/commands/sync.ts
import { Command } from 'commander'
import { isDaemonRunning } from '../daemon-manager.js'

export function syncCommand(program: Command): void {
  program
    .command('sync')
    .description('Flush in-memory state to disk (used by Stop hook)')
    .action(async () => {
      // Phase 1: all writes are synchronous (WAL + YAML written on each command),
      // so there is no in-flight buffer to flush. This command is a no-op placeholder
      // that will gain real behavior in Phase 2 when the async write queue is introduced.
      if (!(await isDaemonRunning())) {
        process.exit(0)
      }
      // Daemon is running — nothing to flush in Phase 1, exit cleanly
      process.exit(0)
    })
}
