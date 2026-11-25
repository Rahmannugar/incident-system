import {spawnSync} from 'node:child_process';
import {paymentDatabaseUrl} from '../src/config.ts';

const result = spawnSync(process.execPath, ['node_modules/@pgtyped/cli/lib/index.js', '-c', 'apps/payment/pgtyped.config.json'], {
  stdio: 'inherit', env: {...process.env, DATABASE_URL: paymentDatabaseUrl()},
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
