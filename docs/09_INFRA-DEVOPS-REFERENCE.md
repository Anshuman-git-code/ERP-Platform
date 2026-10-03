Let me inspect every relevant file first before explaining anything.I have every file. Now the full explanation:

---

## Step 1 — All relevant files and exact reading order

**Files found:**

| Category | File |
|---|---|
| Docker | `backend/Dockerfile`, `frontend/Dockerfile`, `docker-compose.yml`, `backend/.dockerignore`, `frontend/.dockerignore`, `frontend/nginx.conf` |
| GitLab CI/CD | `.gitlab-ci.yml`, `.ci/update-task-def.py` |
| Terraform | `infra/terraform/provider.tf`, `variables.tf`, `networking.tf`, `compute.tf`, `database.tf`, `iam.tf`, `main.tf`, `monitoring.tf`, `outputs.tf` |

**Reading order:**

```
1. backend/Dockerfile           — understand what the backend image contains
2. frontend/Dockerfile          — understand what the frontend image contains
3. frontend/nginx.conf          — understand how frontend serves + proxies
4. docker-compose.yml           — understand local wiring of all 3 containers
5. .gitlab-ci.yml               — understand the full CI/CD pipeline
6. infra/terraform/provider.tf  — AWS provider setup
7. infra/terraform/variables.tf — all configurable values
8. infra/terraform/networking.tf — VPC, subnets, security groups
9. infra/terraform/database.tf  — RDS
10. infra/terraform/main.tf     — SSM secrets
11. infra/terraform/iam.tf      — all IAM roles and permissions
12. infra/terraform/compute.tf  — ECR, ECS, ALB (the core deployment)
13. infra/terraform/monitoring.tf — CloudWatch logs and alarms
14. infra/terraform/outputs.tf  — what Terraform prints after apply
```

---

## Step 3 — Docker

---

### FILE: `backend/Dockerfile`

**PURPOSE:** Builds the production Docker image for the Node.js API. Uses two stages — one to compile TypeScript, one to run it. The final image contains only production code, no dev tools.

---

```dockerfile
FROM node:20-alpine AS builder
```
**WHAT IT DOES:** Starts the first stage using the official Node.js 20 image built on Alpine Linux (a very small Linux distro, ~5MB base).  
**WHY:** Alpine keeps the image small. Node 20 matches the engine requirement in `package.json`.  
**CONNECTS TO:** Nothing yet — this is the starting base.  
**WHAT IF CHANGED:** Using `node:20` (Debian) instead would work but the final image would be ~200MB larger. Using node:18 would fail the engine guard in `package.json`.

---

```dockerfile
RUN apk add --no-cache openssl
```
**WHAT IT DOES:** Installs OpenSSL on the Alpine image.  
**WHY:** Prisma's query engine binary is compiled against OpenSSL. Without it, `prisma generate` and `prisma migrate deploy` throw a library not found error at runtime on Alpine. This is an Alpine-specific requirement — Debian images have it by default.  
**WHAT IF REMOVED:** Prisma crashes with: `Error: ENOENT: no such file or directory, open '.../libssl.so'`

---

```dockerfile
WORKDIR /app
```
**WHAT IT DOES:** Sets `/app` as the working directory for all subsequent commands.  
**WHY:** Without this, files would be placed in the root `/`, cluttering the filesystem and making paths unpredictable.  
**WHAT IF CHANGED:** Any path like `./dist` or `./prisma` would resolve differently.

---

```dockerfile
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps
```
**WHAT IT DOES:** Copies the dependency manifest files first, then installs ALL dependencies including dev dependencies (`typescript`, `ts-jest`, etc.).  
**WHY COPY PACKAGE.JSON FIRST (before source code):** Docker caches each layer. If you copy source code first, any code change invalidates the `npm ci` cache, forcing a full re-install on every build. By copying only `package.json` first, the expensive install layer is only re-run when dependencies actually change.  
**`--legacy-peer-deps`:** Suppresses peer dependency conflicts between packages. Needed here due to ESLint version incompatibilities.  
**WHY dev deps:** `tsc` (TypeScript compiler) and `prisma generate` are dev deps — needed to build.

---

```dockerfile
COPY tsconfig.json tsconfig.seed.json ./
COPY prisma ./prisma
COPY src ./src
```
**WHAT IT DOES:** Copies the source code into the image after dependencies are installed.  
**WHY THIS ORDER:** Once deps are cached (from the COPY package.json step above), changing source code only re-runs the layers from here downward — much faster than re-running `npm ci`.

---

```dockerfile
RUN npx prisma generate
```
**WHAT IT DOES:** Reads `prisma/schema.prisma` and generates the TypeScript Prisma Client into `node_modules/@prisma/client`.  
**WHY:** Without this, TypeScript compilation of any file that imports from `@prisma/client` fails — the types don't exist yet.  
**CONNECTS TO:** `backend/prisma/schema.prisma` — the schema defines what types get generated.

---

```dockerfile
RUN npm run build
```
**WHAT IT DOES:** Runs `tsc --project tsconfig.json` which compiles all TypeScript in `src/` into plain JavaScript in `dist/`.  
**WHY:** Node.js cannot run TypeScript directly in production. The compiled `dist/` folder is what the final container actually runs.  
**OUTPUT:** `dist/index.js`, `dist/app.js`, `dist/routes/*.js`, etc.

---

```dockerfile
FROM node:20-alpine AS runner
```
**WHAT IT DOES:** Starts a BRAND NEW, EMPTY stage — the final production image.  
**WHY A SECOND STAGE:** The builder stage has TypeScript, ts-jest, ESLint, all source `.ts` files, and ~500MB of dev dependencies. None of that belongs in production. The runner stage starts clean and only copies what's needed to RUN the app — not to BUILD it. This is called a multi-stage build.  
**RESULT:** Final image is ~165MB instead of ~500MB.

---

```dockerfile
RUN npm ci --only=production --legacy-peer-deps
```
**WHAT IT DOES:** Installs only production dependencies — no TypeScript, no Jest, no ESLint.  
**WHY:** Keeps the runtime image small and secure. Dev tools in production are unnecessary attack surface.

---

```dockerfile
COPY prisma ./prisma
RUN npx prisma generate
```
**WHAT IT DOES:** Copies the schema again and re-runs Prisma generation in the runner image.  
**WHY NOT COPY FROM BUILDER:** The Prisma query engine binary is compiled against the specific OpenSSL version of the image it runs on. The builder and runner are both Alpine, but copying a binary compiled in one Alpine layer might not match the exact OpenSSL version in the runner layer. Re-generating in the runner guarantees a correct binary.

---

```dockerfile
COPY --from=builder /app/dist ./dist
```
**WHAT IT DOES:** Copies the compiled JavaScript output from the builder stage into the runner stage.  
**WHY `--from=builder`:** This is the multi-stage bridge. It reaches back into the builder stage (which no longer exists as a container — it was just used for building) and pulls out only what we need.

---

```dockerfile
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
RUN chown -R appuser:appgroup /app
USER appuser
```
**WHAT IT DOES:** Creates a non-root user and group, gives them ownership of `/app`, and switches to that user.  
**WHY:** By default Docker containers run as root. If the container is compromised, root inside the container has elevated privileges. Running as a non-root user limits the blast radius. This is a security best practice required in production environments.  
**WHAT IF REMOVED:** The container runs as root — a security vulnerability.

---

```dockerfile
EXPOSE 4000
```
**WHAT IT DOES:** Documents that the container listens on port 4000.  
**WHY:** This is metadata — it doesn't actually open any port. The real port mapping happens in `docker-compose.yml` (4002:4000) and the ECS task definition (`containerPort = 4000`).  
**CONNECTS TO:** `docker-compose.yml` ports `4002:4000` and `compute.tf` `containerPort = 4000`.

---

```dockerfile
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
```
**WHAT IT DOES:** When the container starts, it runs TWO commands in sequence:
1. `npx prisma migrate deploy` — applies any pending database migrations
2. `node dist/index.js` — starts the Express server

**WHY migrate deploy BEFORE starting the server:** If a new version of the app needs a new database column and the migration runs after the server starts, the server might serve requests that require the new column before it exists — causing crashes. Running it first guarantees the database is in the correct state before accepting traffic.  
**WHAT IF MIGRATION FAILS:** `sh -c` runs them in sequence with `&&` — if `migrate deploy` fails (e.g., database unreachable), the server never starts. The container exits with an error code, ECS marks the task as failed, and the health check never passes.  
**CONNECTS TO:** `prisma/migrations/` folder — the migrations that get applied; `backend/src/index.ts` — the file that gets run.

---

### FILE: `frontend/Dockerfile`

**PURPOSE:** Builds the production Docker image for the React frontend. Stage 1 compiles the React app with Vite. Stage 2 serves the compiled static files via nginx.

---

```dockerfile
FROM node:20-alpine AS builder
```
Same reasoning as backend — small Alpine image, Node 20 for Vite.

---

```dockerfile
ARG VITE_API_BASE_URL=/api
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
```
**WHAT IT DOES:** `ARG` declares a build-time argument (can be passed with `--build-arg`). `ENV` makes it available to the `RUN npm run build` command that follows.  
**WHY:** Vite bakes environment variables starting with `VITE_` into the compiled JavaScript bundle **at build time**. The frontend code does:
```typescript
const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '/api';
```
This means the URL `/api` is embedded directly in the compiled JS. There is no way to change it at runtime — it's hardcoded into the bundle.  
**WHY `/api` (not `http://localhost:4000`):** In the container, nginx proxies `/api/*` to the backend. The frontend just hits `/api/...` and nginx handles routing it to the right place.  
**CONNECTS TO:** `docker-compose.yml` build arg `VITE_API_BASE_URL: /api` and `frontend/src/api/client.ts`.

---

```dockerfile
RUN npm run build
```
**WHAT IT DOES:** Runs `tsc && vite build` which compiles TypeScript and bundles all React code into static files in `dist/`.  
**OUTPUT:** `dist/index.html`, `dist/assets/index-ChsQ3Cbf.js` (225KB), `dist/assets/index-Bu9KJvdU.css` (24KB), and lazy-loaded page chunks.

---

```dockerfile
FROM nginx:1.27-alpine AS runner
```
**WHAT IT DOES:** The runner stage uses nginx (a web server) — NOT Node.js.  
**WHY nginx, not Node:** The frontend is just static HTML/CSS/JS files after compilation. nginx is purpose-built for serving static files efficiently — it handles thousands of concurrent connections with minimal memory. There is no need for Node.js at runtime.

---

```dockerfile
RUN rm /etc/nginx/conf.d/default.conf
```
**WHAT IT DOES:** Removes nginx's default "Welcome to nginx" configuration.  
**WHY:** The default config would serve the wrong content and conflict with our custom config.

---

```dockerfile
COPY nginx.conf /etc/nginx/templates/default.conf.template
```
**WHAT IT DOES:** Places our custom nginx config as a **template** (not a direct config file).  
**WHY `templates/` and `.template` extension:** nginx's official Docker image has a built-in mechanism — at container startup it runs `envsubst` on every file in `/etc/nginx/templates/` and writes the result to `/etc/nginx/conf.d/`. This replaces `${BACKEND_URL}` in our nginx.conf with the actual value from the `BACKEND_URL` environment variable.  
**CONNECTS TO:** `docker-compose.yml` sets `BACKEND_URL: http://backend:4000` and `compute.tf` sets `BACKEND_URL: http://${aws_lb.main.dns_name}`.  
**WHAT IF REMOVED:** nginx starts with no config. The container crashes or serves nothing useful.

---

```dockerfile
COPY --from=builder /app/dist /usr/share/nginx/html
```
**WHAT IT DOES:** Copies the compiled React static files from the builder stage into nginx's serving directory.  
**WHY `/usr/share/nginx/html`:** This is nginx's default document root — where it looks for files to serve.

---

### FILE: `frontend/nginx.conf`

**PURPOSE:** nginx configuration that does three things: serves static React files, proxies API calls to the backend, and provides SPA fallback routing.

---

```nginx
listen 80;
```
**WHAT IT DOES:** nginx listens on port 80 inside the container.  
**CONNECTS TO:** `docker-compose.yml` port `3002:80` and ECS task definition `containerPort = 80`.

---

```nginx
add_header X-Frame-Options "SAMEORIGIN" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "no-referrer" always;
```
**WHAT IT DOES:** Security headers added to every response.  
- `X-Frame-Options SAMEORIGIN`: prevents the site being embedded in an iframe on another domain (clickjacking protection)
- `X-Content-Type-Options nosniff`: prevents browsers from guessing content type (MIME sniffing attack prevention)
- `Referrer-Policy no-referrer`: browser doesn't send the `Referer` header when navigating away

---

```nginx
location /api/ {
    proxy_pass ${BACKEND_URL}/api/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 30s;
}
```
**WHAT IT DOES:** Any request to `/api/*` is forwarded to the backend server.  
**`${BACKEND_URL}`:** Replaced by `envsubst` at container startup. In Docker Compose it becomes `http://backend:4000`. In AWS it becomes `http://ops-erp-alb-dev-330409874.ap-south-1.elb.amazonaws.com`.  
**`proxy_set_header X-Real-IP`:** Passes the real client IP to the backend so logs show actual user IPs, not nginx's IP.  
**WHY:** Without this proxy, the React app would try to call `http://localhost:4000/api/...` from the browser — which doesn't exist. nginx makes the backend accessible at the same origin as the frontend, avoiding CORS issues.  
**WHAT IF REMOVED:** All API calls from the frontend return 404.

---

```nginx
location /health {
    proxy_pass ${BACKEND_URL}/health;
}
```
**WHAT IT DOES:** The `/health` path is also proxied to the backend.  
**WHY:** The ALB health check for the frontend target group calls `/`. But when we want to check if the BACKEND is healthy through the frontend URL, we can call `/health`. The nginx container proxies it through.

---

```nginx
location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff2?)$ {
    expires 1y;
    add_header Cache-Control "public, immutable";
    try_files $uri =404;
}
```
**WHAT IT DOES:** For static asset files (JS bundles, CSS, images), sets a 1-year cache with "immutable" — the browser never re-requests these files once cached.  
**WHY `immutable`:** Vite generates filenames with content hashes like `index-ChsQ3Cbf.js`. When the content changes, the filename changes too — so there's never a stale cache problem. `immutable` tells the browser "don't even check if this file changed."

---

```nginx
location / {
    try_files $uri $uri/ /index.html;
}
```
**WHAT IT DOES:** The SPA fallback. For any URL that doesn't match a static file:
1. Try serving the exact file (`$uri`)
2. Try serving it as a directory (`$uri/`)
3. If neither exists, serve `index.html`

**WHY:** React Router handles routing in the browser. When someone navigates directly to `/inventory`, nginx has no file called `inventory`. Without the fallback, it would return 404. With the fallback, it returns `index.html` and React Router reads the URL and renders the Inventory page.  
**WHAT IF REMOVED:** Direct URL access to any route other than `/` returns 404.

---

### FILE: `docker-compose.yml`

**PURPOSE:** Defines three containers (postgres, backend, frontend) that work together locally. Wires them to each other via a private Docker network and maps ports to the host machine.

---

```yaml
services:
  postgres:
    image: postgres:15-alpine
    container_name: ops_erp_postgres
    environment:
      POSTGRES_DB: ops_erp
      POSTGRES_USER: ops_user
      POSTGRES_PASSWORD: devpassword123
```
**WHAT IT DOES:** Pulls the official PostgreSQL 15 image (no build needed — it's pre-built). Creates a database named `ops_erp` with user `ops_user`.  
**CONNECTS TO:** `backend` environment variable `DATABASE_URL: postgresql://ops_user:devpassword123@postgres:5432/ops_erp`.  
**WHY `postgres` as hostname:** Docker Compose puts all services on the same internal network. The service name `postgres` is automatically the hostname other containers use to connect.

---

```yaml
    ports:
      - '5444:5432'
```
**WHAT IT DOES:** Maps host port 5444 to container port 5432.  
**FORMAT:** `HOST_PORT:CONTAINER_PORT`. PostgreSQL always listens on 5432 inside the container. 5444 is exposed to your laptop so you can connect with a DB tool.  
**WHY 5444 (not 5432):** Port 5432 was already occupied by the Case Study 1 container on this machine.

---

```yaml
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U ops_user -d ops_erp']
      interval: 5s
      timeout: 5s
      retries: 10
```
**WHAT IT DOES:** Every 5 seconds, Docker runs `pg_isready` inside the postgres container. If it succeeds, the container is marked "healthy."  
**CONNECTS TO:** `backend.depends_on.postgres.condition: service_healthy` — the backend only starts AFTER postgres is healthy.  
**WHY:** PostgreSQL takes a few seconds to initialize. Without the health check, the backend might try to connect before PostgreSQL is ready, fail, and exit.

---

```yaml
  backend:
    build:
      context: ./backend
      dockerfile: Dockerfile
    depends_on:
      postgres:
        condition: service_healthy
```
**WHAT IT DOES:** Builds the backend image from `./backend/Dockerfile`. Won't start until postgres reports healthy.  
**`context: ./backend`:** Docker looks for files relative to this path. So `COPY package.json ./` in the Dockerfile copies from `./backend/package.json`.

---

```yaml
    environment:
      NODE_ENV: production
      PORT: 4000
      DATABASE_URL: postgresql://ops_user:devpassword123@postgres:5432/ops_erp?schema=public
      JWT_SECRET: compose_dev_secret_change_before_production_use_64chars
      JWT_EXPIRES_IN: 8h
      CORS_ORIGIN: http://localhost:3002
      LOG_LEVEL: info
```
**WHAT EACH DOES:**
- `NODE_ENV: production` — tells the app and Prisma to use production logging, disables query logging
- `PORT: 4000` — which port Express listens on
- `DATABASE_URL` — uses `postgres` (the Docker service name) as the hostname, port 5432 (internal container port, NOT 5444 which is the host mapping)
- `JWT_SECRET` — the secret used to sign and verify JWTs. Long enough to be secure locally
- `CORS_ORIGIN: http://localhost:3002` — backend only accepts requests from this origin. Port 3002 is where the frontend is on the host
- `LOG_LEVEL: info` — suppress debug-level logs in compose

---

```yaml
    ports:
      - '4002:4000'
```
**HOST:CONTAINER.** Exposes the API at `localhost:4002` on your machine.

---

```yaml
    healthcheck:
      test: ['CMD-SHELL', 'wget -qO- http://localhost:4000/health || exit 1']
      interval: 15s
      timeout: 10s
      retries: 5
      start_period: 45s
```
**WHAT IT DOES:** Hits `/health` every 15 seconds. Backend needs `start_period: 45s` because `prisma migrate deploy` can take up to 30 seconds on first run.  
**CONNECTS TO:** `frontend.depends_on.backend.condition: service_healthy` — frontend waits for backend to be healthy.

---

```yaml
  frontend:
    build:
      context: ./frontend
      args:
        VITE_API_BASE_URL: /api
    environment:
      BACKEND_URL: http://backend:4000
```
**`VITE_API_BASE_URL: /api`** — build argument passed into the Dockerfile, baked into the compiled JS bundle.  
**`BACKEND_URL: http://backend:4000`** — runtime environment variable. nginx's `envsubst` replaces `${BACKEND_URL}` in `nginx.conf` with this value when the container starts. `backend` is the Docker service name — resolvable within the Docker network.

---

## Step 4 — GitLab CI/CD

---

### FILE: `.gitlab-ci.yml`

**PURPOSE:** Automates testing, building, packaging, and deploying the application. Five stages run in order. Every stage must pass before the next begins.

---

```yaml
stages:
  - validate
  - test
  - build
  - package
  - deploy
```
**WHAT IT DOES:** Declares five ordered stages. Jobs within the same stage run in parallel. No job in `test` starts until ALL jobs in `validate` pass.  
**WHAT IF A STAGE FAILS:** Everything after it is skipped. A failed `validate` means `test`, `build`, `package`, and `deploy` never run.

---

```yaml
variables:
  NODE_VERSION: "20"
  AWS_REGION: ap-south-1
  ECR_REGISTRY: "690081480550.dkr.ecr.ap-south-1.amazonaws.com"
  ECR_REPO_BACKEND: "ops-erp-backend-dev"
  ECR_REPO_FRONTEND: "ops-erp-frontend-dev"
  ECS_CLUSTER: "ops-erp-cluster-dev"
  ECS_SERVICE_BACKEND: "ops-erp-backend-dev"
  ECS_SERVICE_FRONTEND: "ops-erp-frontend-dev"
```
**WHAT IT DOES:** Pipeline-wide variables available in every job.  
**WHY hardcoded (not GitLab CI variables):** These are not secrets — they're just AWS resource names. Hardcoding avoids each developer needing to configure them. Only `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` are kept as masked GitLab variables.

---

### Stage 1: validate

```yaml
backend:lint:
  stage: validate
  image: node:20-alpine
  cache:
    key: backend-node-$CI_COMMIT_REF_SLUG
    paths: [backend/node_modules/]
  before_script:
    - cd backend && npm ci --legacy-peer-deps
  script:
    - npm run lint
```
**WHAT IT DOES:** Runs ESLint against all `src/**/*.ts` files. Fails if any error or warning.  
**`image: node:20-alpine`:** Each GitLab job runs in a fresh Docker container. This pulls `node:20-alpine` as the environment.  
**`cache`:** GitLab caches `node_modules/` between jobs using a key based on branch name. This avoids re-running `npm ci` (which takes 30-60s) for every job on the same branch.  
**`CI_COMMIT_REF_SLUG`:** GitLab built-in variable. The current branch name, URL-safe (e.g., `main`, `feature-123`).  
**`before_script`:** Runs before the main `script` block. Here it installs dependencies.  
**WHY:** Catches code style errors before running tests. Fast feedback.

---

### Stage 2: test

```yaml
backend:test:
  stage: test
  image: node:20-alpine
  services:
    - name: postgres:15-alpine
      alias: postgres
      variables:
        POSTGRES_DB: ops_erp_test
        POSTGRES_USER: ops_user
        POSTGRES_PASSWORD: devpassword123
```
**`services:`** — GitLab CI spins up a separate `postgres:15-alpine` container alongside the job container. They share a network. The `alias: postgres` means the job container can reach the database at hostname `postgres`.  
**This is real PostgreSQL** — not a mock. The 74 integration tests run against an actual database.

```yaml
  variables:
    TEST_DATABASE_URL: postgresql://ops_user:devpassword123@postgres:5432/ops_erp_test?schema=public
    JWT_SECRET: ci_test_secret_not_for_production_abcdef1234567890
```
**WHAT IT DOES:** These override environment variables for this job only. `TEST_DATABASE_URL` is read by `src/__tests__/setup.ts` to point tests at the CI postgres, not the dev database.

```yaml
  before_script:
    - apk add --no-cache openssl
    - cd backend
    - npm ci --legacy-peer-deps
    - npx prisma generate
    - DATABASE_URL=$TEST_DATABASE_URL npx prisma migrate deploy
```
**Line by line:**
1. Install OpenSSL (required by Prisma on Alpine)
2. Change into backend directory
3. Install all dependencies
4. Generate Prisma client types
5. `DATABASE_URL=$TEST_DATABASE_URL npx prisma migrate deploy` — applies all migrations to the fresh CI postgres database, creating all 9 tables

```yaml
  script:
    - npm test
```
**WHAT IT DOES:** Runs all 74 Jest tests. If any fail, this job fails and the pipeline stops.

```yaml
  artifacts:
    reports:
      coverage_report:
        coverage_format: cobertura
        path: backend/coverage/cobertura-coverage.xml
    paths: [backend/coverage/]
    expire_in: 7 days
```
**WHAT IT DOES:** After tests pass, saves the coverage report as an artifact. GitLab shows this coverage percentage in merge requests. Artifacts expire after 7 days to save storage.

---

### Stage 3: build

```yaml
backend:build:
  before_script:
    - apk add --no-cache openssl
    - cd backend
    - npm ci --legacy-peer-deps
    - npx prisma generate
  script:
    - npm run build
  artifacts:
    paths: [backend/dist/]
    expire_in: 1 day
```
**WHAT IT DOES:** Compiles TypeScript → JavaScript. Saves the `dist/` folder as an artifact for 1 day.  
**WHY save as artifact:** The `deploy` stage needs `dist/`. Without saving it, each stage would need to recompile.

---

### Stage 4: package

```yaml
.docker_package: &docker_package
  stage: package
  image: docker:24-dind
  services: [docker:24-dind]
  before_script:
    - docker login -u $CI_REGISTRY_USER -p $CI_REGISTRY_PASSWORD $CI_REGISTRY
  rules:
    - if: $CI_COMMIT_BRANCH == "main" || $CI_COMMIT_BRANCH == "develop"
```
**`image: docker:24-dind`:** DinD = Docker-in-Docker. This job itself runs inside Docker but needs to RUN Docker commands (docker build, docker push). `docker:24-dind` provides a Docker daemon inside the job container.  
**`services: [docker:24-dind]`:** Starts the Docker daemon as a side container.  
**`$CI_REGISTRY_USER`, `$CI_REGISTRY_PASSWORD`, `$CI_REGISTRY`:** GitLab built-in variables. These are credentials for the GitLab Container Registry (free with every GitLab project). `docker login` authenticates against it.  
**`rules:`** — only runs on `main` or `develop` branches. Feature branches don't build Docker images.

```yaml
package:backend:
  <<: *docker_package
  script:
    - |
      docker build -t $CI_REGISTRY_IMAGE/backend:$CI_COMMIT_SHORT_SHA \
                   -t $CI_REGISTRY_IMAGE/backend:latest \
                   ./backend
      docker push $CI_REGISTRY_IMAGE/backend:$CI_COMMIT_SHORT_SHA
      docker push $CI_REGISTRY_IMAGE/backend:latest
```
**`$CI_REGISTRY_IMAGE`:** GitLab built-in. Points to the project's container registry, e.g., `registry.gitlab.com/Anshuman-git-code/erp-platform`.  
**`$CI_COMMIT_SHORT_SHA`:** The first 8 characters of the git commit hash (e.g., `989f045a`). Used as an image tag so you can trace exactly which code version is in which image.  
**TWO TAGS:** `:$CI_COMMIT_SHORT_SHA` for traceability; `:latest` for convenience (always points to the most recent main build).  
**WHAT THIS PRODUCES:** A Docker image pushed to `registry.gitlab.com/Anshuman-git-code/erp-platform/backend:989f045a` and `:latest`.

---

### Stage 5: deploy

```yaml
.deploy_before: &deploy_before
  - apk add --no-cache curl python3 py3-pip
  - pip3 install awscli --quiet --break-system-packages
  - CRANE_VER=$(curl -sf https://api.github.com/repos/google/go-containerregistry/releases/latest | grep '"tag_name"' | cut -d'"' -f4)
  - curl -sL "https://github.com/google/go-containerregistry/releases/download/${CRANE_VER}/go-containerregistry_Linux_x86_64.tar.gz" | tar -xz crane
  - chmod +x crane && mv crane /usr/local/bin/crane
  - crane auth login $CI_REGISTRY -u $CI_REGISTRY_USER -p $CI_REGISTRY_PASSWORD
  - crane auth login $ECR_REGISTRY -u AWS -p "$(aws ecr get-login-password --region $AWS_REGION)"
```
**WHAT THIS BLOCK DOES (line by line):**
1. Install curl, python3, pip on alpine
2. Install AWS CLI via pip
3. Find the latest version of `crane` (a tool for copying Docker images between registries without needing a Docker daemon)
4. Download and extract the `crane` binary
5. Make it executable, move to PATH
6. Authenticate crane to GitLab Container Registry
7. `aws ecr get-login-password` — calls AWS to get a temporary ECR password (valid 12 hours). Pipe to `crane auth login` to authenticate to ECR.

**WHY `crane` instead of `docker pull/push`:** The `amazon/aws-cli` image (used in deploy) doesn't have Docker. Previous attempts failed with `docker: command not found`. `crane` is a single binary that copies images between registries without needing a Docker daemon.

```yaml
deploy:backend:
  script:
    - crane copy $CI_REGISTRY_IMAGE/backend:$CI_COMMIT_SHORT_SHA $ECR_REGISTRY/$ECR_REPO_BACKEND:$CI_COMMIT_SHORT_SHA
    - crane tag $ECR_REGISTRY/$ECR_REPO_BACKEND:$CI_COMMIT_SHORT_SHA latest
    - NEW_IMAGE="$ECR_REGISTRY/$ECR_REPO_BACKEND:$CI_COMMIT_SHORT_SHA"
    - aws ecs describe-task-definition --task-definition $ECS_SERVICE_BACKEND --region $AWS_REGION --query taskDefinition --output json | python3 .ci/update-task-def.py backend "$NEW_IMAGE" > new-task-def.json
    - NEW_ARN=$(aws ecs register-task-definition --region $AWS_REGION --cli-input-json file://new-task-def.json --query taskDefinition.taskDefinitionArn --output text)
    - aws ecs update-service --cluster $ECS_CLUSTER --service $ECS_SERVICE_BACKEND --task-definition "$NEW_ARN" --region $AWS_REGION
    - aws ecs wait services-stable --cluster $ECS_CLUSTER --services $ECS_SERVICE_BACKEND --region $AWS_REGION
```
**Line by line:**
1. Copy image from GitLab Registry → ECR (no Docker daemon needed)
2. Tag the ECR image as `:latest`
3. Set variable with the full ECR image URI
4. Fetch current ECS task definition JSON, pipe to `update-task-def.py` which updates the `image` field, write result to file
5. Register the updated task definition with AWS — this creates a new revision (e.g., `ops-erp-backend-dev:3`)
6. Tell ECS service to use the new task definition — triggers a rolling deployment
7. Wait until ECS reports the service is stable (old tasks stopped, new tasks running and healthy)

```yaml
  rules:
    - if: $CI_COMMIT_BRANCH == "main"
      when: manual
```
**`when: manual`:** The deploy jobs have a play button in GitLab UI. They don't run automatically — a human must click to deploy. This prevents accidental production deployments.

---

## Step 5 — Terraform

---

### FILE: `provider.tf`

```hcl
terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.55"
    }
  }
}
```
**WHAT IT DOES:** Declares which version of Terraform and the AWS provider plugin this configuration requires.  
**`~> 5.55`:** "Compatible with 5.55" — allows patch updates (5.55.x) but not major or minor version jumps. Pins the provider to prevent breaking changes from unexpected updates.  
**WHAT IF REMOVED:** `terraform init` fetches the latest AWS provider version which might have breaking changes.

```hcl
provider "aws" {
  region = var.aws_region
  default_tags {
    tags = {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}
```
**`region = var.aws_region`:** All AWS resources go to `ap-south-1` (Mumbai) unless overridden.  
**`default_tags`:** Every single AWS resource Terraform creates automatically gets these three tags. Useful for cost tracking (filter all `ops-erp` costs), identifying resources (don't accidentally delete something), and compliance.

---

### FILE: `variables.tf`

This file defines all the inputs to the Terraform configuration. Key ones:

```hcl
variable "db_password" {
  sensitive   = true
}
variable "jwt_secret" {
  sensitive   = true
}
```
**`sensitive = true`:** Terraform never prints these values in logs or plan output. You provide them via `terraform.tfvars` (gitignored) or `TF_VAR_db_password` environment variables.

```hcl
variable "backend_image" {
  default = "PLACEHOLDER_BACKEND_IMAGE"
}
```
**WHY a placeholder:** Terraform creates infrastructure first (including ECR repos). Once ECR exists, images are built and pushed. Then Terraform is run again with the real image URI. If Terraform tried to deploy ECS with the placeholder, ECS would fail to pull the image — but the infrastructure (VPC, ALB, RDS) would still be created correctly.

---

### FILE: `networking.tf`

This file creates the entire network foundation.

```hcl
resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr        # 10.1.0.0/16
  enable_dns_hostnames = true
  enable_dns_support   = true
}
```
**WHAT:** A private network in AWS with IP range `10.1.0.0/16` (65,536 addresses).  
**WHY:** All our AWS resources live inside this VPC. Nothing inside is accessible from the internet unless explicitly allowed. `enable_dns_hostnames = true` allows RDS to have a hostname like `ops-erp-db-dev.xxxx.ap-south-1.rds.amazonaws.com` instead of just an IP.

```hcl
resource "aws_subnet" "public" {
  count                   = 2
  cidr_block              = var.public_subnet_cidrs[count.index]  # 10.1.1.0/24, 10.1.2.0/24
  availability_zone       = var.availability_zones[count.index]   # ap-south-1a, ap-south-1b
  map_public_ip_on_launch = true
}
```
**WHAT:** Two public subnets, one per availability zone (AZ). `count = 2` creates two identical resources with `count.index = 0` and `1`.  
**WHY TWO:** The ALB requires at least two subnets in different AZs for high availability.  
**`map_public_ip_on_launch = true`:** Resources launched in public subnets get a public IP automatically. The ALB needs this to be reachable from the internet.

```hcl
resource "aws_subnet" "private" {
  count      = 2
  cidr_block = var.private_subnet_cidrs[count.index]  # 10.1.10.0/24, 10.1.11.0/24
}
```
**WHAT:** Two private subnets. No public IPs assigned.  
**WHY:** ECS tasks (backend, frontend) and RDS live here. They should never be directly accessible from the internet — only through the ALB.

```hcl
resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
}
```
**WHAT:** A gateway that connects the VPC to the internet.  
**WHY:** Without an IGW, nothing in the VPC can reach the internet or be reached from it. The ALB in the public subnet uses this to receive incoming traffic.  
**WHAT IF REMOVED:** ALB becomes unreachable. Nobody can access the application.

```hcl
resource "aws_eip" "nat" {
  domain = "vpc"
}
resource "aws_nat_gateway" "main" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id
}
```
**WHAT:** A NAT Gateway with an Elastic IP (static public IP), placed in the first public subnet.  
**WHY:** ECS tasks in private subnets need outbound internet access (to pull Docker images from ECR, call AWS APIs). They can't have public IPs. NAT allows outbound-only internet access — traffic goes out but nothing can reach them directly from the internet.  
**WHAT IF REMOVED:** ECS tasks can't pull images from ECR → containers fail to start.

```hcl
resource "aws_route_table" "public" {
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
}
```
**WHAT:** Route table for public subnets. Any traffic destined for `0.0.0.0/0` (all internet IPs) goes through the Internet Gateway.

```hcl
resource "aws_route_table" "private" {
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main.id
  }
}
```
**WHAT:** Route table for private subnets. Outbound internet traffic goes through NAT Gateway (not IGW directly — that would require a public IP).

**Security Groups — the firewall rules:**

```hcl
resource "aws_security_group" "alb" {
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]   # ← anyone on the internet
  }
  egress { all traffic → allowed }
}
```
**ALB SG:** The internet can reach the ALB on port 80. ALB can talk to anything outbound (needed to forward to backend/frontend).

```hcl
resource "aws_security_group" "backend" {
  ingress {
    from_port       = 4000
    to_port         = 4000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]  # ← only from ALB
  }
}
```
**Backend SG:** Only the ALB can reach the backend on port 4000. Direct internet access to the backend is blocked. If you try `curl http://backend-task-ip:4000/`, it's rejected by this rule.

```hcl
resource "aws_security_group" "rds" {
  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.backend.id]  # ← only from backend
  }
}
```
**RDS SG:** Only the backend ECS task can reach PostgreSQL on port 5432. Not the frontend, not the internet, not anyone else.

---

### FILE: `database.tf`

```hcl
resource "aws_db_subnet_group" "main" {
  subnet_ids = aws_subnet.private[*].id
}
```
**WHAT:** Groups both private subnets so RDS can be placed in either. Required by AWS before creating an RDS instance.

```hcl
resource "aws_db_instance" "postgres" {
  engine                 = "postgres"
  engine_version         = "15"
  instance_class         = var.db_instance_class   # db.t3.micro
  db_name                = var.db_name             # ops_erp
  username               = var.db_username         # ops_user
  password               = var.db_password         # from terraform.tfvars (sensitive)
  storage_encrypted      = true
  publicly_accessible    = false
  skip_final_snapshot    = true
  backup_retention_period = 0
}
```
**`instance_class = db.t3.micro`:** The smallest (and cheapest) RDS instance — 1 vCPU, 1GB RAM. Sufficient for development and low-traffic production.  
**`storage_encrypted = true`:** Data at rest is encrypted. Required for security best practices.  
**`publicly_accessible = false`:** No public IP. Only reachable within the VPC — specifically only from the backend SG.  
**`skip_final_snapshot = true`:** When you destroy this RDS, don't create a backup snapshot. For development — in production this should be `false`.  
**`backup_retention_period = 0`:** No automated daily backups. Again, development setting.

---

### FILE: `main.tf` — SSM SecureString Parameters

```hcl
resource "aws_ssm_parameter" "database_url" {
  name  = "/${var.project_name}/${var.environment}/database_url"
  type  = "SecureString"
  value = "postgresql://${var.db_username}:${var.db_password}@${aws_db_instance.postgres.endpoint}/${var.db_name}?schema=public"

  lifecycle {
    ignore_changes = [value]
  }
}
```
**WHAT:** Creates a parameter at path `/ops-erp/dev/database_url` in AWS Systems Manager Parameter Store. Type `SecureString` means it's encrypted using AWS KMS.  
**WHY NOT ENV VAR IN TASK DEFINITION:** If you put secrets directly in ECS task definition environment variables, they appear in the AWS console and in CloudTrail logs in plaintext. SSM SecureString is encrypted — the value is never visible in logs.  
**`${aws_db_instance.postgres.endpoint}`:** Terraform automatically substitutes the RDS endpoint from the database it created (e.g., `ops-erp-db-dev.cf46ak6qa9xh.ap-south-1.rds.amazonaws.com:5432`).  
**`lifecycle { ignore_changes = [value] }`:** After Terraform creates this parameter, if someone manually rotates the database password through the console, Terraform won't overwrite it on the next `terraform apply`. Without this, Terraform would reset the secret to the original value.  
**CONNECTS TO:** `iam.tf` — the ECS execution role gets permission to read this ARN; `compute.tf` — the backend task definition references this ARN in its `secrets` array.

---

### FILE: `iam.tf`

**Two separate IAM roles. They serve completely different purposes:**

**Role 1: `ecs_task_execution`** — used by ECS itself (the control plane), not your application.

```hcl
resource "aws_iam_role" "ecs_task_execution" {
  assume_role_policy = data.aws_iam_policy_document.ecs_assume_role.json
}
resource "aws_iam_role_policy_attachment" "ecs_exec_managed" {
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}
```
**WHAT `AmazonECSTaskExecutionRolePolicy` allows:**
- Pull Docker images from ECR
- Write logs to CloudWatch
- Retrieve secrets from SSM

**WHY ECS needs this:** When ECS starts a task, it needs to pull the container image from ECR and inject secrets. It uses this role to do so — before your application code even starts.

```hcl
resource "aws_iam_role_policy" "ssm_read" {
  policy = jsonencode({
    Statement = [{
      Effect = "Allow"
      Action = ["ssm:GetParameters", "ssm:GetParameter"]
      Resource = [
        aws_ssm_parameter.database_url.arn,
        aws_ssm_parameter.jwt_secret.arn,
      ]
    }, {
      Effect = "Allow"
      Action = ["kms:Decrypt"]
      Resource = "*"
    }]
  })
}
```
**WHAT:** Allows the execution role to read specifically the `database_url` and `jwt_secret` parameters — nothing else.  
**WHY so specific:** Least privilege principle. If this role were ever compromised, it can only read these two specific parameters, not any other SSM secrets in the account.  
**`kms:Decrypt`:** SSM SecureString is encrypted with KMS. Reading it requires decryption permission.

**Role 2: `ecs_task`** — used by your application code while it runs.

```hcl
resource "aws_iam_role_policy" "cloudwatch_logs" {
  policy = jsonencode({
    Statement = [{
      Action = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource = "${aws_cloudwatch_log_group.app.arn}:*"
    }]
  })
}
```
**WHAT:** Allows the running application to write logs to the specific CloudWatch log group `/ecs/ops-erp-dev`.  
**WHY separate from execution role:** Execution role is for ECS to SET UP the task. Task role is for the APPLICATION to use AWS services while running. They have different permissions because they do different things.

**The CI/CD Deploy User:**

```hcl
resource "aws_iam_user" "ci_deploy" {
  name = "${var.project_name}-ci-deploy-${var.environment}"
}
resource "aws_iam_user_policy" "ci_deploy" {
  policy = jsonencode({
    Statement = [
      { Action = ["ecr:*"], Resource = "*" },
      { Action = ["ecs:UpdateService", "ecs:DescribeServices"], Resource = "*" },
      { Action = ["iam:PassRole"], Resource = [
          aws_iam_role.ecs_task_execution.arn,
          aws_iam_role.ecs_task.arn
      ]}
    ]
  })
}
```
**WHAT:** An IAM user specifically for GitLab CI. Its access key ID and secret go into GitLab CI/CD variables.  
**WHY a dedicated user:** If you used your personal root credentials in CI/CD, a leak would compromise your entire AWS account. This user can only push to ECR, update ECS services, and pass the two IAM roles. Nothing else.  
**`iam:PassRole`:** When updating an ECS task definition, you tell ECS which IAM roles to assign to the task. AWS requires that the person/service doing this has `iam:PassRole` permission for those roles — otherwise anyone could escalate privileges by assigning a powerful role to their task.

---

### FILE: `compute.tf` — The Core Deployment

**ECR Repositories:**

```hcl
resource "aws_ecr_repository" "backend" {
  name                 = "ops-erp-backend-dev"
  image_tag_mutability = "MUTABLE"
  image_scanning_configuration { scan_on_push = true }
}
```
**WHAT:** A Docker image registry (like DockerHub but private, in your AWS account) for the backend image.  
**`image_tag_mutability = "MUTABLE"`:** The `:latest` tag can be overwritten on each push. If `IMMUTABLE`, you couldn't push a new `:latest` over the old one.  
**`scan_on_push = true`:** AWS automatically scans every pushed image for known CVEs (security vulnerabilities).

**ALB and Target Groups:**

```hcl
resource "aws_lb" "main" {
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id
}
```
**WHAT:** An internet-facing Application Load Balancer in both public subnets.  
**`internal = false`:** Has a public IP/DNS. Receives traffic from the internet.  
**`subnets = aws_subnet.public[*].id`:** Both public subnets — the ALB spans both AZs for high availability.

```hcl
resource "aws_lb_listener" "http" {
  port     = 80
  protocol = "HTTP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.frontend.arn
  }
}
resource "aws_lb_listener_rule" "api" {
  priority = 10
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.backend.arn
  }
  condition {
    path_pattern {
      values = ["/api/*", "/health"]
    }
  }
}
```
**WHAT:** The ALB's routing rules. The listener checks incoming requests:
- If path matches `/api/*` or `/health` → route to backend target group (priority 10, checked first)
- Everything else → route to frontend target group (default action)

**WHY `priority = 10`:** Rules are evaluated in priority order (lower = higher priority). Rule 10 is checked before the default. If you had a rule for `/api/internal` at priority 5, it would match before rule 10.

**ECS Task Definitions:**

```hcl
resource "aws_ecs_task_definition" "backend" {
  family                   = "ops-erp-backend-dev"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256    # 0.25 vCPU
  memory                   = 512    # 512 MB
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn
```
**`FARGATE`:** Serverless containers — AWS manages the underlying EC2 instances. You only specify CPU/memory and pay per second.  
**`awsvpc`:** Each task gets its own network interface and IP address within the VPC.  
**`cpu = 256`:** AWS Fargate CPU is in "units" where 1024 = 1 vCPU. 256 = 0.25 vCPU. Sufficient for a low-traffic API.

```hcl
  container_definitions = jsonencode([{
    secrets = [
      { name = "DATABASE_URL", valueFrom = aws_ssm_parameter.database_url.arn },
      { name = "JWT_SECRET",   valueFrom = aws_ssm_parameter.jwt_secret.arn },
    ]
```
**WHAT:** When ECS starts this task, it reads these two SSM parameters and injects them as environment variables `DATABASE_URL` and `JWT_SECRET` into the container.  
**WHY `valueFrom` (not `value`):** `valueFrom` tells ECS to FETCH the value from SSM at task startup. The actual secret never appears in the task definition JSON — only the SSM parameter path.

```hcl
    healthCheck = {
      command     = ["CMD-SHELL", "wget -qO- http://localhost:4000/health || exit 1"]
      interval    = 30
      startPeriod = 60
    }
```
**WHAT:** Container-level health check. ECS checks if the container is healthy by running this command every 30 seconds. `startPeriod = 60` — ECS doesn't count failures for the first 60 seconds (gives the app time to run `prisma migrate deploy` and start).

```hcl
resource "aws_ecs_service" "backend" {
  desired_count  = 1
  launch_type    = "FARGATE"
  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.backend.id]
    assign_public_ip = false
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.backend.arn
    container_name   = "backend"
    container_port   = 4000
  }
  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }
}
```
**`desired_count = 1`:** Run exactly 1 instance of this container.  
**`subnets = private`:** Task runs in private subnets — no direct internet access.  
**`assign_public_ip = false`:** No public IP. Only reachable through ALB.  
**`load_balancer`:** Registers this task with the backend target group. When the task starts and its health check passes, the ALB starts sending traffic to it.  
**`lifecycle { ignore_changes = [task_definition, desired_count] }`:** Critical. Without this, every `terraform apply` would reset the task definition back to whatever version Terraform knows about. But CI/CD updates the task definition directly via `aws ecs register-task-definition`. `ignore_changes` tells Terraform: "don't try to manage these — CI/CD handles them."

---

### FILE: `monitoring.tf`

```hcl
resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/ops-erp-dev"
  retention_in_days = var.environment == "prod" ? 30 : 7
}
```
**WHAT:** A CloudWatch log group where ALL container logs go.  
**WHY:** ECS containers don't store logs persistently. CloudWatch is the durable log store. The backend task definition's `logConfiguration` points here.  
**`retention_in_days`:** Non-prod logs deleted after 7 days (cost saving). Prod logs kept 30 days.

```hcl
resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  metric_name         = "HTTPCode_ELB_5XX_Count"
  threshold           = 10
  evaluation_periods  = 2
  period              = 60
}
```
**WHAT:** Alarm triggers if the ALB returns more than 10 server errors (5xx) per minute for 2 consecutive minutes.  
**WHY:** 5xx errors mean something is broken on the backend. This alarm catches sustained failures.  
**NOTE:** The alarm is created but no `alarm_actions` (SNS, email) are configured — you'd need to add those to actually receive notifications.

---

### FILE: `outputs.tf`

```hcl
output "alb_dns_name" {
  value = aws_lb.main.dns_name
}
```
**WHAT:** After `terraform apply`, prints the ALB's public DNS name. This is the URL you open in your browser: `http://ops-erp-alb-dev-330409874.ap-south-1.elb.amazonaws.com`.  
**CONNECTS TO:** You take this value and put it in `terraform.tfvars` as `cors_origin`, then run `terraform apply` again so the backend knows which origin to allow.

---

## Step 6 — End-to-End Deployment Trace

```
Developer pushes code to main branch on GitLab
          |
          | File: .gitlab-ci.yml
          ↓
STAGE: validate (backend:lint, backend:typecheck, frontend:lint, frontend:typecheck)
  All run in node:20-alpine containers
  Uses cached node_modules from previous runs
  npm run lint → eslint src/**/*.ts → must pass with 0 warnings
          |
          ↓ (only if all validate jobs pass)
STAGE: test (backend:test)
  Spins up postgres:15-alpine as a service container
  Runs: prisma migrate deploy (creates all 9 tables in the CI test DB)
  Runs: npm test (74 tests against real PostgreSQL)
  Saves coverage report as artifact
          |
          ↓ (only if test passes)
STAGE: build (backend:build, frontend:build)
  Runs tsc → dist/        (backend TypeScript compiled to JS)
  Runs vite build → dist/ (React compiled to static HTML/CSS/JS)
  Both saved as artifacts
          |
          ↓ (only if on main or develop branch)
STAGE: package (package:backend, package:frontend)
  Uses docker:24-dind image
  Runs docker build ./backend → creates image with compiled app
  Tags: registry.gitlab.com/.../backend:989f045a and :latest
  Runs docker push → image stored in GitLab Container Registry
  Same for frontend
          |
          ↓ (MANUAL — human clicks play button in GitLab)
STAGE: deploy (deploy:backend, deploy:frontend)
  Uses alpine:3.19 image
  Installs: awscli (pip), crane (binary)
  crane copy: GitLab Registry → ECR
    from: registry.gitlab.com/.../backend:989f045a
    to:   690081480550.dkr.ecr.ap-south-1.amazonaws.com/ops-erp-backend-dev:989f045a
  aws ecs describe-task-definition: fetches current task def JSON
  python3 .ci/update-task-def.py: updates the image field to the new ECR URI
  aws ecs register-task-definition: creates new revision (e.g., :3)
  aws ecs update-service: tells ECS service to use the new task definition
  aws ecs wait services-stable: blocks until new task is running and healthy
          |
          ↓
AWS ECS FARGATE (ap-south-1)
  ECS control plane sees: "service wants task definition :3"
  Uses execution_role (ecs_task_execution) to:
    → Pull image: 690081480550.dkr.ecr.ap-south-1.amazonaws.com/ops-erp-backend-dev:989f045a
    → Fetch secrets from SSM:
        /ops-erp/dev/database_url → DATABASE_URL env var
        /ops-erp/dev/jwt_secret   → JWT_SECRET env var
  Starts new container in private subnet (10.1.10.x or 10.1.11.x)
  Container runs CMD: prisma migrate deploy && node dist/index.js
          |
          ↓
DATABASE (RDS PostgreSQL 15 in private subnet)
  Container connects using DATABASE_URL from SSM
  prisma migrate deploy applies any new migration files
  node dist/index.js starts Express on port 4000
  /health endpoint starts responding 200
          |
          ↓
ALB TARGET GROUP (ops-erp-be-tg-dev)
  ALB sends health check: GET /health every 30s
  After 2 healthy responses: task is marked healthy, receives traffic
  Old task (running previous version) is drained and stopped
          |
          ↓
ALB LISTENER RULE
  /api/* → backend target group (this task)
  /*     → frontend target group
          |
          ↓
INTERNET → USER'S BROWSER
  User opens: http://ops-erp-alb-dev-330409874.ap-south-1.elb.amazonaws.com
  ALB receives HTTP GET /
  Default rule → frontend target group
  Frontend container (nginx) serves index.html
  React app loads, calls /api/auth/login
  ALB rule matches /api/* → backend target group
  Backend processes request, queries RDS, returns JWT
```

---

## Files to read before the interview (checklist)

```
□ backend/Dockerfile          — understand multi-stage, openssl, CMD migration+start
□ frontend/Dockerfile         — understand vite build arg, nginx runner stage
□ frontend/nginx.conf         — understand proxy_pass, SPA fallback, envsubst
□ docker-compose.yml          — understand service names, depends_on, BACKEND_URL
□ .gitlab-ci.yml              — understand 5 stages, services postgres, crane deploy
□ infra/terraform/networking.tf — understand VPC, public/private subnets, SGs
□ infra/terraform/compute.tf  — understand ALB routing rules, task definition secrets, lifecycle
□ infra/terraform/iam.tf      — understand 2 ECS roles + ci_deploy user
□ infra/terraform/main.tf     — understand SSM SecureString + ignore_changes
```

The three questions you're most likely to be asked:

1. **"How does the frontend reach the backend?"** → nginx proxy_pass, BACKEND_URL envsubst, ALB listener rule
2. **"How are secrets managed?"** → SSM SecureString, `secrets` array in task definition, execution role SSM read permission
3. **"How does a new deployment roll out?"** → crane copy to ECR, register-task-definition new revision, update-service, wait services-stable