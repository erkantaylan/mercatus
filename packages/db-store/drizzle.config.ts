/**
 * drizzle-kit reads this for both `generate` and `migrate`. The credentials are the OWNER's
 * (DATABASE_ADMIN_URL): migrations create and alter tables, which the runtime role must never be
 * able to do (BE2).
 */
import { defineConfig } from 'drizzle-kit';

const url = process.env['DATABASE_ADMIN_URL'];
if (!url) {
  // Fail here with the variable's name rather than three layers down with "connection refused".
  throw new Error('DATABASE_ADMIN_URL is not set. It must be the owner connection (§8.2).');
}

export default defineConfig({
  schema: './src/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: { url },
  strict: true,
  verbose: false,
});
