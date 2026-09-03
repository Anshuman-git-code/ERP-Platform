# ─── Stage 1: builder ────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

# openssl is required by Prisma's query engine on Alpine
RUN apk add --no-cache openssl

WORKDIR /app

# Install all deps (including devDeps — needed for tsc + prisma generate)
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps

# Copy source
COPY tsconfig.json tsconfig.seed.json ./
COPY prisma ./prisma
COPY src ./src

# Generate Prisma client types
RUN npx prisma generate

# Compile TypeScript → dist/
RUN npm run build

# ─── Stage 2: runner ─────────────────────────────────────────────────────────
FROM node:20-alpine AS runner

RUN apk add --no-cache openssl

WORKDIR /app

# Production deps only
COPY package.json package-lock.json ./
RUN npm ci --only=production --legacy-peer-deps

# Prisma schema + migrations (needed for migrate deploy at startup)
COPY prisma ./prisma

# Re-generate Prisma client against the Alpine/OpenSSL version in this image
RUN npx prisma generate

# Compiled output from builder
COPY --from=builder /app/dist ./dist

# Non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
RUN chown -R appuser:appgroup /app
USER appuser

EXPOSE 4000

# Run migration then start the server
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
