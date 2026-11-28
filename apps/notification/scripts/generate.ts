import {spawnSync} from 'node:child_process';
import {notificationDatabaseUrl} from '../src/config.ts';

const result = spawnSync(process.execPath, ['node_modules/@pgtyped/cli/lib/index.js', '-c', 'apps/notification/pgtyped.config.json'], {
  stdio: 'inherit', env: {...process.env, DATABASE_URL: notificationDatabaseUrl()},
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
