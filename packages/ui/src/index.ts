/**
 * @mercatus/ui -- the design tokens (BUILD-PLAN §7.1). Plain CSS: no component library, no
 * Tailwind, no CSS-in-JS.
 *
 * There is no JavaScript here and there deliberately may not be: three front ends consume this
 * package (a Next.js server-rendered storefront, and two Vite SPAs), and a package that exports
 * React components has to agree with all three on a React version and a bundler. A stylesheet
 * agrees with everything.
 *
 *   import '@mercatus/ui/reset.css';
 *   import '@mercatus/ui/tokens.css';
 *
 * Components live in the app that renders them until two apps genuinely need the same one.
 */
export {};
