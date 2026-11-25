import { spawnSync } from 'node:child_process';
import { databaseUrl } from './database.ts';

// Pass the derived URL through the environment, never command-line arguments.
const result = spawnSync(process.execPath, [
  'node_modules/@pgtyped/cli/lib/index.js',
  '-c', 'scripts/database/pgtyped.config.json',
], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: databaseUrl() },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
