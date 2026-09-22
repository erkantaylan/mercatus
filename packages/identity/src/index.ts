/**
 * `@mercatus/identity` -- how the Logto container is CONFIGURED, never how it is modified (CD2).
 * There is no `apps/identity`: identity is bought, and this package is the provisioning that
 * turns a freshly seeded instance into one this repo can sign in against.
 */
export {
  LogtoError,
  LogtoManagementClient,
  MANAGEMENT_API_APP_ID,
  MANAGEMENT_API_RESOURCE,
  readManagementSecret,
  type LogtoClientOptions,
} from './logto.js';
