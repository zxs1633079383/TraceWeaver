// packages/tw-cli/src/commands/daemon.ts
import { Command } from 'commander'
import { ensureDaemonRunning, isDaemonRunning, stopDaemon } from '../daemon-manager.js'

export function daemonCommand(program: Command): void {
  const cmd = program.command('daemon').description('Manage the TraceWeaver daemon')

  cmd.command('start').action(async () => {
    await ensureDaemonRunning()
    console.log('Daemon running.')
  })

  cmd.command('stop').action(async () => {
    await stopDaemon()
    console.log('Daemon stopped.')
  })

  cmd.command('status').action(async () => {
    const running = await isDaemonRunning()
    console.log(running ? 'Daemon: running' : 'Daemon: stopped')
  })
}
