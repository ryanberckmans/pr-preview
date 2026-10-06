// The publish job's step when a pull request closes: deletes its preview,
// with all its deployments, from Cloudflare. It needs no build output and no
// Wrangler, just pr-preview's own API client.
import { UserError, clean, errorMessage, isMain, log, main, patterns, readEnv, redact, setOutputs } from './lib/common.mjs';
import { CloudflareApiError, createCloudflare, explainCloudflareError } from './lib/cloudflare.mjs';

export function readCleanupInputs(env) {
  const worker = readEnv(env, 'PLAN_WORKER');
  const alias = readEnv(env, 'PLAN_ALIAS');
  if (!patterns.workerName.test(worker)) throw new UserError('The plan step reported an invalid Worker name.');
  if (!patterns.alias.test(alias)) throw new UserError('The plan step reported an invalid preview name.');
  return { token: readEnv(env, 'CLOUDFLARE_API_TOKEN'), accountId: readEnv(env, 'CLOUDFLARE_ACCOUNT_ID'), worker, alias };
}

// Returns { status: 'removed' } or, when there was nothing to delete, { status: 'absent' }.
export async function cleanup(inputs, { fetch = globalThis.fetch, sleep } = {}) {
  const cf = createCloudflare({ token: inputs.token, accountId: inputs.accountId, fetch, sleep });
  try {
    return { status: (await cf.deletePreview(inputs.worker, inputs.alias)) ? 'removed' : 'absent' };
  } catch (error) {
    throw explainCloudflareError(error, `deleting the preview ${inputs.alias}`);
  }
}

if (isMain(import.meta.url)) {
  await main(async () => {
    try {
      const inputs = readCleanupInputs(process.env);
      const outputs = await cleanup(inputs);
      setOutputs(outputs);
      log.info(outputs.status === 'removed' ? `Deleted the preview ${inputs.alias} of ${inputs.worker}.` : `${inputs.worker} has no preview named ${inputs.alias}.`);
    } catch (error) {
      const message = error instanceof UserError || error instanceof CloudflareApiError ? error.message : `Unexpected error: ${errorMessage(error)}`;
      const secrets = [process.env.CLOUDFLARE_API_TOKEN, process.env.CLOUDFLARE_ACCOUNT_ID].map((value) => value?.trim());
      setOutputs({ status: 'error', message: clean(redact(message, secrets), 600) });
      throw error;
    }
  });
}
