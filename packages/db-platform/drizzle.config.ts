/** Owner credentials: migrations create and alter tables (BE2). */
import { defineConfig } from 'drizzle-kit';

const url = process.env['DATABASE_ADMIN_URL'];
if (!url) {
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
