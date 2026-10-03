// ============================================================
// FILE: backend/jest.config.ts
// CONSTRUCTION ORDER: #8
// HOW: Created manually as a TypeScript file (not jest.config.js).
//      Using .ts for the config file lets TypeScript type-check it,
//      so you get autocomplete and type errors in your editor when
//      configuring Jest.
// WHY NOW: Created before writing any test files because:
//   1. Jest needs to know how to find and process .ts test files
//   2. Without the ts-jest preset, Jest cannot understand TypeScript
//   3. Without moduleNameMapper, the @/* path alias used in source files
//      would cause imports to fail inside tests
// ============================================================

// Import Jest's Config type for TypeScript autocomplete on the config object.
// `import type` means this import is erased at runtime — it's purely for
// TypeScript's benefit during editing and type-checking.
import type { Config } from 'jest';

// Define the configuration object with the Config type applied.
// This gives TypeScript the ability to catch typos like "testEnvironemnt" immediately.
const config: Config = {

  // "preset": "ts-jest" — tells Jest to use ts-jest as the transformer.
  // ts-jest intercepts Jest's module loading and compiles .ts files on-the-fly
  // using TypeScript. Without this, Jest would see TypeScript syntax and throw:
  //   SyntaxError: Cannot use import statement in a module
  preset: 'ts-jest',

  // "testEnvironment": "node" — runs tests in a Node.js environment, not jsdom.
  // jsdom simulates a browser DOM and is the default for React projects.
  // We don't need a DOM — our tests make HTTP calls to an Express server.
  testEnvironment: 'node',

  // "rootDir": "." — the base directory Jest uses to resolve all other paths.
  // "." means the backend/ folder (where this config file lives).
  rootDir: '.',

  // "testMatch" — the glob pattern Jest uses to FIND test files.
  // **/src/__tests__/**/*.test.ts means: any .test.ts file anywhere inside
  // src/__tests__/. Jest will ignore files that don't match this pattern,
  // so adding a helper file to __tests__/ without .test.ts extension is safe.
  testMatch: ['**/src/__tests__/**/*.test.ts'],

  // "moduleNameMapper" — maps import path aliases to real file system paths.
  // The source code uses `import { something } from '@/types'` (configured in tsconfig.json paths).
  // Jest doesn't read tsconfig.json for module resolution, so it needs its own mapping.
  // '^@/(.*)$' matches any import starting with @/ and the (.*)$ captures the rest.
  // '<rootDir>/src/$1' replaces it with the actual path (e.g., '@/types' → 'src/types').
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },

  // "collectCoverageFrom" — which files to measure coverage for when
  // running `npm run test:coverage`. Defines the "denominator" of coverage.
  collectCoverageFrom: [
    // Include all TypeScript files in src/
    'src/**/*.ts',
    // Exclude the entry point — index.ts starts the server, which isn't testable in unit tests
    '!src/index.ts',
    // Exclude test files themselves — measuring coverage of your tests is nonsensical
    '!src/__tests__/**',
    // Exclude generated TypeScript declaration files
    '!src/**/*.d.ts',
  ],

  // "coverageDirectory" — where to write the coverage report HTML and XML files.
  // .gitignore excludes backend/coverage/ from version control.
  // CI uploads it as an artifact for GitLab's coverage badge.
  coverageDirectory: 'coverage',

  // "verbose": true — print every individual test name as it runs.
  // Without this, Jest only prints the file names and final pass/fail.
  // Verbose mode shows: ✓ returns 200 on valid login (45ms)
  verbose: true,

  // "testTimeout": 30000 — each individual test has 30 seconds to complete.
  // The default is 5 seconds. We increase this because:
  //   1. Tests make real HTTP requests to Express
  //   2. Express makes real database queries to PostgreSQL
  //   3. Some tests (concurrency test in orders.test.ts) use Promise.all
  //      to fire multiple simultaneous requests and wait for both to resolve
  // On a slow CI machine, 5 seconds is not enough.
  testTimeout: 30000,
};

// Export the config as the default export.
// Jest reads this file and uses whatever is exported as the configuration.
export default config;
