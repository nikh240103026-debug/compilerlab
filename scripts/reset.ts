import { createInterface } from 'node:readline/promises';
import { loadConfig } from '../apps/server/src/config';
import { backupDatabase, resetData } from '../apps/server/src/db/maintenance';
import { readEnv, ROOT } from './lib/env.mjs';

const config = loadConfig(readEnv(), ROOT);

if (!process.argv.includes('--yes')) {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`This deletes your settings and progress in ${config.dataDir}.`);
  console.log('A backup is saved first, and existing backups are kept.');
  const answer = await prompt.question('Type RESET to continue: ');
  prompt.close();
  if (answer.trim() !== 'RESET') {
    console.log('Nothing was changed.');
    process.exit(0);
  }
}

const backup = await backupDatabase(config.dataDir, config.dbDriver);
if (backup) console.log(`Backup saved to ${backup}`);

try {
  resetData(config.dataDir);
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'EBUSY' || code === 'EPERM') {
    console.error('The data files are in use. Stop CompilerLab, then run this again.');
    process.exit(1);
  }
  throw error;
}
console.log('All data was reset. A fresh database is created the next time the app starts.');
