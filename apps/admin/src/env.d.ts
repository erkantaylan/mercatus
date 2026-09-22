/// <reference types="vite/client" />

/**
 * §8.2 calls this variable `PLATFORM_URL`. Vite only exposes variables prefixed `VITE_` to the
 * browser, so the console reads `VITE_PLATFORM_URL` -- the same treatment `VITE_STORE_API_URL`
 * already gets in that table. Declared here so a typo is a typecheck failure rather than
 * `undefined` at the first request.
 */
interface ImportMetaEnv {
  readonly VITE_PLATFORM_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
