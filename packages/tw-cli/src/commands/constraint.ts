import { Command } from 'commander';
import { sendIpc } from '../ipc-client.js';
import { ensureDaemon } from '../daemon-manager.js';
import type { ConstraintHarnessResult } from '@traceweaver/types';

export function constraintCommand(): Command {
  const cmd = new Command('constraint').description(
    'Evaluate and query constraint checks'
  );

  cmd
    .command('evaluate <entity_id>')
    .description('Evaluate constraints for an entity')
    .option('--json', 'Output raw JSON')
    .action(async (entityId: string, opts: { json?: boolean }) => {
      await ensureDaemon();
      const res = await sendIpc<ConstraintHarnessResult>({
        method: 'constraint.evaluate',
        params: { entity_id: entityId },
      });

      if (!res.ok) {
        console.error(`Error: ${(res as { ok: false; error: { message: string } }).error.message}`);
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
        return;
      }

      const d = res.data;
      const icon =
        d.result === 'pass' ? '✅' : d.result === 'fail' ? '❌' : '⏭️';
      console.log(`${icon} ${d.entity_id}: ${d.result} (${d.duration_ms}ms)`);

      for (const ref of d.refs_checked) {
        const refIcon =
          ref.result === 'pass' ? '  ✓' : ref.result === 'fail' ? '  ✗' : '  -';
        console.log(`${refIcon} ${ref.ref}: ${ref.result}`);
        if (ref.note) console.log(`    ${ref.note}`);
      }

      if (d.error) {
        console.log(`\n⚠ Error: ${d.error}`);
      }
    });

  cmd
    .command('history <entity_id>')
    .description('Show constraint evaluation history')
    .option('--json', 'Output raw JSON')
    .option('--limit <n>', 'Max results', '10')
    .action(async (entityId: string, opts: { json?: boolean; limit: string }) => {
      await ensureDaemon();
      const res = await sendIpc<any[]>({
        method: 'constraint.history',
        params: { entity_id: entityId, limit: parseInt(opts.limit, 10) },
      });

      if (!res.ok) {
        console.error(`Error: ${(res as { ok: false; error: { message: string } }).error.message}`);
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
        return;
      }

      if (res.data.length === 0) {
        console.log('No constraint evaluations found.');
        return;
      }

      for (const event of res.data) {
        const attrs = event.attributes ?? {};
        const icon =
          attrs.result === 'pass' ? '✅' :
          attrs.result === 'fail' ? '❌' : '⏭️';
        console.log(`${icon} ${event.ts} — ${attrs.result} (${attrs.duration_ms}ms)`);
      }
    });

  cmd
    .command('show <entity_id>')
    .description('Show latest constraint evaluation detail')
    .option('--json', 'Output raw JSON')
    .action(async (entityId: string, opts: { json?: boolean }) => {
      await ensureDaemon();
      const res = await sendIpc<any[]>({
        method: 'constraint.history',
        params: { entity_id: entityId, limit: 1 },
      });

      if (!res.ok) {
        console.error(`Error: ${(res as { ok: false; error: { message: string } }).error.message}`);
        process.exit(1);
      }

      if (res.data.length === 0) {
        console.log('No constraint evaluations found.');
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify(res.data[0], null, 2));
        return;
      }

      const event = res.data[0];
      const attrs = event.attributes ?? {};
      console.log(`Entity:   ${event.entity_id}`);
      console.log(`Result:   ${attrs.result}`);
      console.log(`Time:     ${event.ts}`);
      console.log(`Duration: ${attrs.duration_ms}ms`);
      console.log(`Span:     ${attrs.span_id ?? 'n/a'}`);

      if (attrs.refs_checked) {
        console.log('\nRefs checked:');
        for (const ref of attrs.refs_checked) {
          console.log(`  ${ref.result === 'pass' ? '✓' : ref.result === 'fail' ? '✗' : '-'} ${ref.ref}`);
          if (ref.note) console.log(`    ${ref.note}`);
        }
      }

      if (attrs.error) {
        console.log(`\n⚠ Error: ${attrs.error}`);
      }
    });

  return cmd;
}
