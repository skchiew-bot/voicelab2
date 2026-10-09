import { loadConfig } from './config.js';
import { createPool, withActor } from './db.js';
import { migrate } from './migrate.js';
import { createUser } from './store/tenants.js';

const [cmd, ...args] = process.argv.slice(2);
const config = loadConfig();
const pool = createPool(config.DATABASE_URL);

try {
  if (cmd === 'migrate') {
    const applied = await migrate(pool);
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
  } else if (cmd === 'bootstrap') {
    // Creates the first internal admin. The token is shown once and only its hash is stored.
    const email = args[0];
    if (!email) throw new Error('Usage: npm run bootstrap -- <admin-email>');
    await migrate(pool);
    const user = await withActor(pool, { kind: 'internal' }, (c) =>
      createUser(c, null, { tenantId: null, email, role: 'internal_admin' }));
    console.log(`Admin created: ${user.email}\nAPI token (save it now, it is not shown again):\n${user.token}`);
  } else {
    console.log('Commands: migrate | bootstrap <admin-email>');
    process.exitCode = 1;
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
