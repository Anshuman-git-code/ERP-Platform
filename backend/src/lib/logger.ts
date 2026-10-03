// ============================================================
// FILE: backend/src/lib/logger.ts
// CONSTRUCTION ORDER: #12 — First file inside src/
// HOW: Created by first making the folder structure:
//        mkdir -p src/lib src/middleware src/routes src/types src/__tests__
//      Then: touch src/lib/logger.ts
// WHY NOW: Written before any other src/ file because:
//   1. It has ZERO dependencies on other project files (only imports winston)
//   2. src/middleware/errorHandler.ts imports it
//   3. src/lib/prisma.ts doesn't need it, but everything else does
//   4. Best practice: set up logging infrastructure first so every file
//      you write after this can immediately use structured logging
// ============================================================

// Import the winston logging library.
// winston provides: log levels, multiple output formats, multiple transports.
// A "transport" is a destination for log output (console, file, HTTP endpoint, etc.)
import winston from 'winston';

// Destructure the format helpers from winston.format.
// These are functions that create format transformers — they are composed
// together using combine() to build a formatting pipeline.
//
// combine  — chains multiple format transformers together
// timestamp — adds a `timestamp` field to each log entry
// json      — serializes the log entry as JSON (machine-readable, for production)
// colorize  — adds ANSI color codes to the output (for human reading in terminal)
// simple    — outputs a simplified human-readable string
const { combine, timestamp, json, colorize, simple } = winston.format;

// Determine the environment ONCE at module load time.
// TypeScript infers this as `boolean` from the comparison result.
// Used to choose between two different logging formats below.
const isProduction = process.env.NODE_ENV === 'production';

// Create and export the singleton logger instance.
// All files import THIS instance — there is one logger for the whole application.
// `export const` makes it a named export: import { logger } from '../lib/logger'
export const logger = winston.createLogger({

  // "level" — the minimum severity to log. Messages below this level are ignored.
  // Priority order (lowest to highest): debug < info < warn < error
  //
  // process.env.LOG_LEVEL ?? ... — if LOG_LEVEL is set in .env, use it.
  // Otherwise default to 'info' in production (less verbose) or 'debug' in dev.
  // setup.ts sets LOG_LEVEL='error' before running tests to suppress all log noise.
  level: process.env.LOG_LEVEL ?? (isProduction ? 'info' : 'debug'),

  // "format" — how log messages are formatted before output.
  // The ternary chooses between two different format pipelines:
  format: isProduction
    // PRODUCTION FORMAT: structured JSON
    // Each log entry is a single JSON object on one line.
    // Example: {"level":"info","message":"Server listening on port 4000","timestamp":"2026-09-26T10:00:00.000Z"}
    // Why JSON in production?
    //   AWS CloudWatch Logs can parse and filter structured JSON.
    //   You can query: `fields message | filter level = "error"` in CloudWatch Insights.
    //   Human-readable format would be parseable but not directly queryable.
    ? combine(timestamp(), json())

    // DEVELOPMENT FORMAT: colorized human-readable output
    // Example: 10:00:00 info: Server listening on port 4000
    // colorize() adds ANSI codes: info = green, warn = yellow, error = red
    // timestamp({ format: 'HH:mm:ss' }) shows only time (not full ISO date)
    //   — cleaner to read during development
    // simple() uses the format: `${level}: ${message} ${JSON.stringify(meta)}`
    : combine(colorize(), timestamp({ format: 'HH:mm:ss' }), simple()),

  // "transports" — where to send the log output.
  // We use only Console here. In production, ECS captures stdout/stderr
  // and sends it to CloudWatch Logs via the awslogs driver (configured in compute.tf).
  // Adding a file transport is unnecessary when running in a container.
  transports: [new winston.transports.Console()],
});
