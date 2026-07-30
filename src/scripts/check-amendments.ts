import { NETWORK_URL, REQUIRED_AMENDMENTS } from '../config';
import { checkAmendments, DERIVATION_CONTROL, derivationIsSound, enabledAmendments } from '../ledger/amendments';
import { withClient } from '../ledger/client';
import { heading, fail, ok, info, warn } from './console';

/**
 * GATE 0 — are the amendments this project depends on actually enabled, right now?
 *
 * Documentation goes stale. This asks the network.
 */
async function main(): Promise<void> {
  await withClient(async (client) => {
    heading('GATE 0 — amendment check');
    info(`Network: ${NETWORK_URL}`);

    const serverInfo = await client.request({ command: 'server_info' });
    const server = serverInfo.result.info;
    info(`rippled ${server.build_version} · ledger ${server.validated_ledger?.seq} · state ${server.server_state}`);

    const enabled = await enabledAmendments(client);
    info(`${enabled.length} amendments enabled on this network.`);

    // Prove the id derivation is right before trusting any result from it.
    if (derivationIsSound()) {
      ok(`Amendment-id derivation verified: SHA-512Half("${DERIVATION_CONTROL.name}") matches its published id.`);
    } else {
      fail(
        `Amendment-id derivation is BROKEN — SHA-512Half("${DERIVATION_CONTROL.name}") did not produce ` +
          `${DERIVATION_CONTROL.expectedId}. Every result below is meaningless until this is fixed.`,
      );
      process.exitCode = 1;
      return;
    }

    const statuses = await checkAmendments(client, REQUIRED_AMENDMENTS);
    console.log('');
    for (const status of statuses) {
      const line = `${status.name.padEnd(20)} ${status.id}`;
      if (status.enabled) ok(`${line}  ENABLED`);
      else fail(`${line}  NOT ENABLED`);
    }
    console.log('');

    const missing = statuses.filter((s) => !s.enabled);
    if (missing.length > 0) {
      fail(`GATE 0 FAILED. Not in the enabled list: ${missing.map((m) => m.name).join(', ')}.`);
      warn(
        'One caveat before acting on this: a network whose genesis ledger already had an amendment\n' +
          '    active can omit it from the Amendments ledger entry entirely — Devnet does this for\n' +
          '    MultiSign. So absence here is suggestive, not conclusive. The conclusive test is\n' +
          '    functional: run `npm run lifecycle` and see whether VaultCreate is accepted.',
      );
      info(
        'XLS-65 and XLS-66 are Devnet-only. Confirm the network URL first. Do not try to run a\n' +
          '    local rippled to work around this.',
      );
      process.exitCode = 1;
      return;
    }

    ok('GATE 0 PASSED — SingleAssetVault and LendingProtocol are both enabled.');
    info('Record this result, with today\'s date, in docs/verified.md.');
  });
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
