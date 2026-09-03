# ─── Stage 1: builder ────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps

COPY . .

# VITE_API_BASE_URL is baked into the JS bundle at build time.
# In the container the nginx proxy handles /api/* → backend, so /api is correct.
ARG VITE_API_BASE_URL=/api
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}

RUN npm run build

# ─── Stage 2: runner ─────────────────────────────────────────────────────────
FROM nginx:1.27-alpine AS runner

# Remove default nginx config
RUN rm /etc/nginx/conf.d/default.conf

# Place our config as a template — nginx docker-entrypoint will run envsubst
# on files in /etc/nginx/templates/ at container start, substituting ${BACKEND_URL}
COPY nginx.conf /etc/nginx/templates/default.conf.template

# Copy compiled frontend assets
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80
