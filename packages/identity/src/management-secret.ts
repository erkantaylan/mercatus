/**
 * The one database read in this repository that is not ours.
 *
 * `logto db seed` creates an M2M application `m-default` whose whole purpose is Management API
 * access, and its secret is random per seed and sits in `applications.secret` as plain text. That
 * single read is the entire chicken-and-egg of automating a fresh Logto instance; everything
 * after it is the Management API (lessons/08).
 *
 * It is in a module of its own so that importing the Management API CLIENT does not drag a
 * Postgres driver -- and a credential path into a schema we do not own (CD2) -- into every
 * consumer. The bootstrap task, which runs beside Logto on our own machine, is the ONLY thing
 * that may import this. `apps/platform` is handed the secret as configuration.
 */
import postgres from 'postgres';

import { LogtoError, MANAGEMENT_API_APP_ID } from './logto.js';

export async function readManagementSecret(databaseUrl: string): Promise<string> {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const rows = await sql<{ secret: string }[]>`
      select secret from applications where id = ${MANAGEMENT_API_APP_ID} limit 1
    `;
    const secret = rows[0]?.secret;
    if (!secret) {
      throw new LogtoError(
        `No "${MANAGEMENT_API_APP_ID}" application in this Logto database. Has "logto db seed" run?`,
      );
    }
    return secret;
  } finally {
    await sql.end({ timeout: 2 });
  }
}
