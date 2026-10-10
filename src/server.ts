import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { migrate } from './migrate.js';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
const applied = await migrate(pool);
if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);

const app = buildApp(pool, config);
await app.listen({ port: config.PORT, host: '0.0.0.0' });
console.log(`Voice Lab listening on :${config.PORT}`);
if (config.SCHEDULER === 'on') app.scheduler.start();
else console.log('Scheduled jobs are off on this server (SCHEDULER=off).');
