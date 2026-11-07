# 09 — Security Architecture

> Security here is layered: identity (who you are), authorization (what you may do), secrets (what must not leak), network (what may talk to what), and container (what the process may do). Each layer is independent — a breach of one does not automatically grant the others.

---

## 1. Authentication

| Aspect | Implementation |
|---|---|
| Mechanism | JWT, HS256 (symmetric) via `jsonwebtoken` |
| Password storage | bcrypt hash, cost factor 10 (`bcryptjs`) |
| Token claims | `userId`, `email`, `role`, plus auto `iat`/`exp` |
| Expiry | `8h` (`JWT_EXPIRES_IN`) |
| Issuance | `POST /api/auth/login` after `bcrypt.compare` |
| Verification | `authenticate` middleware on every router; `jwt.verify(token, JWT_SECRET)` |
| Frontend storage | `localStorage` (`token`, `user`); Axios interceptor attaches `Authorization: Bearer` |

**Distinct failure messages:** `Token expired.` (re-login needed) vs `Invalid token.` (tampered/malformed) vs `Authentication token required.` (no header). Login returns the same 401 for wrong password, unknown email, and inactive user — no user enumeration.

**Production secret guard** (`index.ts`): if `NODE_ENV === 'production'` and `JWT_SECRET` is missing or equals the dev fallback `dev_secret_change_in_production`, the server logs an error and `process.exit(1)`. An insecure secret cannot run in prod.

**No refresh flow (known gap):** after 8h the token expires; the Axios 401 interceptor clears storage and redirects to `/login`. A refresh token flow is a documented improvement.

---

## 2. Authorization (RBAC)

`authorize(...roles)` is a higher-order middleware applied per handler after `authenticate`. It rejects any request whose `req.user.role` is not in the allowed set with 403.

### Role Matrix (verified from route definitions)

| Operation | ADMIN | OPERATIONS | SALES |
|---|:---:|:---:|:---:|
| Read all data (all GETs) | ✓ | ✓ | ✓ |
| Create locations | ✓ | — | — |
| Create / update items | ✓ | ✓ | — |
| Create inventory / adjust stock | ✓ | ✓ | — |
| Create work orders | ✓ | — | — |
| Advance work order status | ✓ | ✓ | — |
| Create transfers | ✓ | ✓ | — |
| Dispatch / receive transfers | ✓ | ✓ | — |
| Cancel transfers | ✓ | — | — |
| Create / confirm / cancel customer orders | ✓ | — | ✓ |
| Dashboard | ✓ | ✓ | ✓ |

The frontend mirrors this (nav filtered by role, `ProtectedRoute` role gate), but the backend is the authority — a `curl` from a SALES user to `POST /api/transfers` is rejected by the server regardless of the UI.

---

## 3. Secrets Management

| Secret | Dev/Compose | Production |
|---|---|---|
| `DATABASE_URL` | `.env` / compose env | SSM SecureString `/ops-erp/dev/database_url` |
| `JWT_SECRET` | `.env` / compose env | SSM SecureString `/ops-erp/dev/jwt_secret` |
| RDS password | (in connection string) | Used to compose the SSM value; never stored separately in tfvars plaintext |

Production injection: the ECS task definition `secrets` array references the SSM ARNs; ECS fetches and decrypts them at task start using the execution role's `ssm:GetParameters` + `kms:Decrypt` permissions. The values never appear in the task definition JSON, Terraform state, or CI logs. `lifecycle { ignore_changes = [value] }` keeps operator rotations from being reverted.

---

## 4. Network Security

```
Internet ──80──▶ ALB (public subnets) ──▶ { backend:4000, frontend:80 } (private subnets)
                                                  │
                                                  └─▶ RDS:5432 (private subnets, backend SG only)
```

- Only the ALB security group accepts traffic from `0.0.0.0/0`.
- Backend accepts 4000 only from the ALB SG; frontend accepts 80 only from the ALB SG.
- RDS accepts 5432 only from the backend SG — not the ALB, not the internet.
- ECS tasks have no public IP (`assign_public_ip = false`); they egress via the NAT Gateway for ECR pulls and SSM reads.
- `trust proxy = 1` is set on Express so it reads `X-Forwarded-*` correctly behind the ALB/nginx.

---

## 5. Container Security

- Backend image runs as a non-root user: `appuser`/`appgroup` created in the runner stage; `USER appuser` before `CMD`.
- Multi-stage builds drop the build toolchain and dev dependencies from the final image (runner installs `--only=production`).
- Frontend image is `nginx:1.27-alpine`; the default config is replaced; nginx adds security headers (`X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`).
- ECR scan-on-push flags known vulnerabilities in the image at push time.

---

## 6. Input Validation & Injection

- `express-validator` runs a declarative chain on every mutating route; `validate` returns 422 with the error array on any failure.
- Prisma parameterizes all queries — no string interpolation into SQL. The only raw SQL is `SELECT ... FOR UPDATE` via `$queryRaw`, which uses Prisma's tagged-template parameterization (the interpolated `${...}` values are bound parameters, not concatenated text).
- Body size is capped at 1MB (`express.json({ limit: '1mb' })`) to bound memory use.
- `CORS_ORIGIN` restricts the allowed origin (the ALB DNS in prod, `http://localhost:3000` in dev); credentials are allowed.

---

## 7. Error Handling (no information leak)

The error envelope is stable and deliberately does not echo internals:

```json
{ "success": false, "message": "Human-readable", "errors": [...], "details": {...}, "field": [...] }
```

- `AppError` carries a status code and a safe message; optional `details` carries business context (e.g., the insufficient-items list) — never stack traces.
- Prisma `P2002` → 409 with the constraint's target field; `P2025` → 404 generic "Record not found."
- Unexpected errors → 500 with only `"Internal server error"`; the stack trace goes to the winston logger, never to the client.

---

## 8. Audit Trail

Every stock movement writes an `InventoryTransaction` with the acting user (`createdById`), the type, quantity, reason, and (for system operations) a deterministic `referenceKey`. This makes who-did-what traceable after the fact — the security-relevant property for an operations system where stock movements are sensitive.

---

## 9. Known Gaps (see Production Improvements)

| Gap | Risk |
|---|---|
| ALB is HTTP only | Token in cleartext on the wire (no TLS) |
| No rate limiting | Brute-force / abuse unthrottled |
| No JWT refresh | Forced re-login; encourages long-lived reuse |
| Token in `localStorage` | Vulnerable to XSS exfiltration (no HttpOnly cookie) |
| No CI/CD secret rotation policy | Long-lived deploy keys |
| `DATABASE_URL` in SSM embeds the password | Rotation requires rewriting the parameter |

The single highest-impact fix is enabling HTTPS at the ALB with an ACM certificate and an HTTP→HTTPS redirect, because today the JWT travels in cleartext.


---

**Read next:** [10 — Transaction & Concurrency Workflow →](10-Transaction-Concurrency-Workflow.md)

[← Back to documentation index](README.md)
