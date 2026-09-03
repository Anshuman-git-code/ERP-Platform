/**
 * Global test setup — loaded first by jest via testMatch order.
 * Overrides env vars so all tests run against the dedicated test DB
 * and use a known JWT secret.
 */

// Point at the test database — never the development DB
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://erp_user:devpassword123@localhost:5432/ops_erp_test?schema=public';

// Deterministic JWT secret for tests
process.env.JWT_SECRET = 'test_secret_do_not_use_in_production_abcdef1234567890';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error'; // suppress log noise during tests
