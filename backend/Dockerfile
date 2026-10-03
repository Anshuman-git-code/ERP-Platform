# ============================================================
# FILE: backend/Dockerfile
# CONSTRUCTION ORDER: #34
# HOW: touch backend/Dockerfile (no extension — Dockerfile has no extension by convention)
# WHY NOW: Written after ALL application code compiles and tests pass.
#          The Dockerfile packages everything we built into a portable image.
#          You can't write a Dockerfile until you know exactly what needs to be built.
# WHAT A DOCKERFILE IS:
#   A recipe for building a Docker image.
#   Each instruction (FROM, RUN, COPY, etc.) creates a new "layer" in the image.
#   Layers are cached — if a layer's input hasn't changed, Docker reuses it.
#   The final image is a stack of all layers.
# MULTI-STAGE BUILD PATTERN:
#   This Dockerfile has TWO stages: `builder` and `runner`.
#   STAGE 1 (builder): Has ALL tools (TypeScript, devDependencies, Prisma CLI).
#                      Compiles TypeScript → JavaScript into dist/.
#   STAGE 2 (runner):  Only has production dependencies and compiled JavaScript.
#                      Doesn't contain TypeScript source, devDependencies, or build tools.
#   BENEFIT: The final image is much smaller (~200MB vs ~600MB).
#            Smaller images pull faster, use less storage, and have a smaller attack surface.
# ============================================================

# ── STAGE 1: builder ──────────────────────────────────────────────────────────
# FROM image AS name — sets the base image for this stage.
# node:20-alpine — Node.js 20 on Alpine Linux.
#   Alpine is a minimal Linux distribution (~5MB vs ~900MB for Ubuntu).
#   It has everything needed to run Node.js but nothing unnecessary.
# AS builder — names this stage so Stage 2 can copy from it.
FROM node:20-alpine AS builder

# openssl is required by Prisma's query engine binary.
# Alpine doesn't include it by default.
# --no-cache: don't cache the Alpine package index (keeps image smaller).
RUN apk add --no-cache openssl

# Set the working directory inside the container.
# All subsequent COPY and RUN instructions operate relative to /app.
# Creates /app if it doesn't exist.
WORKDIR /app

# ── CRITICAL LAYER CACHING TRICK ─────────────────────────────────────────────
# Copy ONLY package.json and package-lock.json FIRST, then run npm ci.
# WHY: Docker rebuilds a layer only when its inputs change.
#   If we copied all source code first, any source file change would
#   invalidate the npm ci layer, forcing a full npm install on every build.
#   By copying only package files first:
#     - Source code changes → only app layers rebuild (fast)
#     - package.json changes → npm ci layer AND app layers rebuild (necessary)
COPY package.json package-lock.json ./

# npm ci (clean install) — installs EXACTLY what's in package-lock.json.
# Unlike npm install, it never modifies package-lock.json.
# --legacy-peer-deps: some packages have minor peer dependency conflicts;
# this flag installs them anyway without failing.
RUN npm ci --legacy-peer-deps

# Copy the TypeScript config files needed for compilation.
COPY tsconfig.json tsconfig.seed.json ./

# Copy the Prisma schema — needed for `prisma generate` below.
COPY prisma ./prisma

# Copy all TypeScript source code.
COPY src ./src

# Generate the Prisma client TypeScript types.
# MUST run before `npm run build` because TypeScript needs @prisma/client types.
# Running prisma generate creates node_modules/@prisma/client with full type definitions.
RUN npx prisma generate

# Compile TypeScript → JavaScript.
# Reads tsconfig.json (rootDir: ./src, outDir: ./dist).
# Output goes to /app/dist/
RUN npm run build

# ── STAGE 2: runner ───────────────────────────────────────────────────────────
# Start a FRESH image — none of Stage 1's layers carry over.
# The final image will only contain what we explicitly COPY from Stage 1.
FROM node:20-alpine AS runner

# Same openssl requirement for Prisma's query engine in the production image.
RUN apk add --no-cache openssl

WORKDIR /app

# Copy ONLY package files, then install ONLY production dependencies.
COPY package.json package-lock.json ./
# --only=production: skips ALL devDependencies (typescript, ts-node, jest, etc.)
# This reduces node_modules from ~450MB to ~120MB.
RUN npm ci --only=production --legacy-peer-deps

# Copy Prisma schema files — needed to run `prisma generate` and `prisma migrate deploy`.
COPY prisma ./prisma
# Run prisma generate again in the runner stage.
# We can't copy node_modules/@prisma/client from Stage 1 because it's generated
# for the builder stage's environment. The runner stage needs its own copy.
RUN npx prisma generate

# ── COPY COMPILED OUTPUT FROM STAGE 1 ────────────────────────────────────────
# COPY --from=builder /source/path /dest/path
# --from=builder: copies from Stage 1's filesystem, not the current stage.
# We only copy dist/ — the compiled JavaScript.
# We do NOT copy:
#   - src/ (TypeScript source — not needed at runtime)
#   - node_modules/ from Stage 1 (has devDependencies — we installed fresh above)
#   - tsconfig.json (TypeScript config — not needed at runtime)
COPY --from=builder /app/dist ./dist

# ── Security: run as non-root user ────────────────────────────────────────────
# By default, Node.js containers run as root.
# If an attacker exploits the app, running as root gives them full container access.
# Running as a non-privileged user limits the blast radius.
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
# Give ownership of /app to appuser (so the app can write logs, temp files, etc.)
RUN chown -R appuser:appgroup /app
# Switch to the non-root user for all subsequent operations (including CMD).
USER appuser

# Expose port 4000 — documents that the container listens on this port.
# This does NOT publish the port to the host; docker-compose.yml does that with `ports:`.
EXPOSE 4000

# CMD — the default command to run when the container starts.
# Uses sh -c "command1 && command2" to run two commands sequentially:
#
# 1. `npx prisma migrate deploy` — applies any pending database migrations.
#    Uses `deploy` (not `dev`) — applies existing files without creating new ones.
#    Safe for automated environments. Runs BEFORE the server starts.
#    WHY HERE: Ensures schema is up to date before accepting traffic.
#    The ECS task execution role has no direct DB access, but the app container does.
#
# 2. `node dist/index.js` — starts the Express server.
#    Runs the compiled JavaScript (no TypeScript compilation at runtime).
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
