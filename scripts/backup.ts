import { loadConfig } from '../apps/server/src/config';
import { backupDatabase } from '../apps/server/src/db/maintenance';
import { readEnv, ROOT } from './lib/env.mjs';

const config = loadConfig(readEnv(), ROOT);
const target = await backupDatabase(config.dataDir, config.dbDriver);
console.log(target ? `Backup saved to ${target}` : 'There is no data to back up yet.');
