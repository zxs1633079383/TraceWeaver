// packages/tw-cli/src/commands/daemon.ts
import { Command } from 'commander'
import { ensureDaemonRunning, isDaemonRunning, stopDaemon } from '../daemon-manager.js'

export function daemonCommand(program: Command): void {
  const cmd = program.command('daemon').description('Manage the TraceWeaver daemon')

  cmd.command('start').action(async () => {
    try {
      await ensureDaemonRunning()
      console.log('Daemon running.')
    } catch (e: any) {
      console.error(e.message ?? String(e))
      process.exit(1)
    }
  })

  cmd.command('stop').action(async () => {
    try {
      await stopDaemon()
      console.log('Daemon stopped.')
    } catch (e: any) {
      console.error(e.message ?? String(e))
      process.exit(1)
    }
  })

  cmd.command('status').action(async () => {
    const running = await isDaemonRunning()
    console.log(running ? 'Daemon: running' : 'Daemon: stopped')
  })
}
