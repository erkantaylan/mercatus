/**
 * `@mercatus/identity` -- how the Logto container is CONFIGURED, never how it is modified (CD2).
 * There is no `apps/identity`: identity is bought, and this package is the provisioning that
 * turns a freshly seeded instance into one this repo can sign in against.
 *
 * Two consumers, and the split between them matters:
 *
 *   src/bootstrap.ts   runs ONCE at AppHost A startup, beside Logto, on our own machine. It is
 *                      the only thing that may import `management-secret.js`, which reads a
 *                      schema we do not own.
 *   apps/platform      calls the Management API at RUNTIME, when an instance registers itself
 *                      and says where it lives (v2.0.0). It is handed the M2M credential as
 *                      configuration and reaches no database of Logto's.
 *
 * `readManagementSecret` is therefore NOT re-exported here.
 */
export {
  LogtoError,
  LogtoManagementClient,
  MANAGEMENT_API_APP_ID,
  MANAGEMENT_API_RESOURCE,
  type LogtoClientOptions,
} from './logto.js';
export {
  APPLICATION_NAMES,
  applicationSecret,
  installationApplicationName,
  deleteApplication,
  ensureInstallationClient,
  ensureOrganizationBySlug,
  findApplicationByName,
  findOrganizationIdBySlug,
  reconcileRedirectUris,
  type InstallationClient,
  type LogtoApplication,
} from './applications.js';
