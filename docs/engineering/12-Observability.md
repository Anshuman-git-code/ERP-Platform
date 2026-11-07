# 12 — Observability

> Observability for this system is intentionally light: structured logs, a health endpoint, and two alarms. This document records what is observed today, what each signal tells you, and — honestly — what is not observed.

---

## 1. Logging

The backend uses **Winston**. The format switches on `NODE_ENV`:

| Environment | Format | Why |
|---|---|---|
| Production | `combine(timestamp(), json())` | Queryable in CloudWatch Logs Insights (`filter level = "error"`) |
| Development | `combine(colorize(), timestamp({format:'HH:mm:ss'}), simple())` | Human-readable in the terminal |
| Test | `LOG_LEVEL=error` (set in `setup.ts`) | Suppresses noise during test runs |

Level is `process.env.LOG_LEVEL` or a sensible default (`info` in prod, `debug` in dev). Prisma logs `query/error/warn` in development and only `error` in production.

**Request logging** is Morgan in `combined` format, piped through Winston (`morgan`'s stream writes to `logger.info`). Every request produces one structured log line in prod.

**Error logging** happens in `errorHandler`: unexpected errors are logged with `message` and `stack` before the 500 envelope is returned. Expected `AppError`s are not logged (they are normal control flow) — they just produce their response.

The frontend has no logging beyond the browser console; the nginx container logs access logs to CloudWatch via the `awslogs` driver.

---

## 2. Health Endpoint

`GET /health` is deliberately unauthenticated — Docker, the ALB target group, and external monitors call it.

```json
// healthy
{
  "status": "ok",
  "timestamp": "2026-09-04T...",
  "uptime": 1982,
  "version": "1.0.0",
  "environment": "production",
  "database": { "status": "ok", "latencyMs": 1 }
}

// degraded
{
  "status": "degraded",
  "timestamp": "...",
  "uptime": 12,
  "version": "1.0.0",
  "environment": "production",
  "database": { "status": "unreachable" }
}
```

It runs `SELECT 1` (the cheapest possible DB probe) and returns 200 when the DB is reachable, 503 when it is not. The ALB uses this for target-group health: a degraded task is marked unhealthy and removed from rotation. Two layers use it:

- **ECS task-level** healthCheck (`wget -qO- http://localhost:4000/health`) — restarts a sick container.
- **ALB target-group** health check (`/health`, 30s interval, 2 healthy / 3 unhealthy) — stops sending traffic to a sick task.

---

## 3. CloudWatch

| Resource | What it captures |
|---|---|
| Log group `/ecs/ops-erp-dev` | Both tasks' stdout via `awslogs` (app logs + nginx access logs) |
| Alarm `alb_5xx > 10/min` | The backend is erroring or down |
| Alarm `rds_cpu > 80%` (10 min) | The `db.t3.micro` is the bottleneck |

ECS Container Insights is enabled on the cluster, giving per-service CPU/memory utilisation, task count, and ALB request counts without extra instrumentation.

---

## 4. What the Logs Let You Answer

With prod JSON logs in CloudWatch Insights, you can answer:

- "Show me all 422 reservation failures and their `insufficientItems`" — filter on the error message / status.
- "Show me all 5xx in the last hour" — `filter level = "error"`.
- "How long has the task been up?" — `uptime` in any `/health` log line.
- "Did a transfer get received twice?" — the second receive logs a 400; the audit `InventoryTransaction` with `referenceKey = receive-<id>` appears exactly once.

---

## 5. What Is Not Observed (honest gaps)

| Gap | Impact |
|---|---|
| No application metrics (reservation latency, confirm success rate, transfer throughput) | Only logs/alarms exist; no time-series of business behaviour |
| No distributed tracing | One request = one service, so tracing is low-value today; would matter with multiple services |
| No CloudWatch dashboard | Alarms exist, but no single visual panel |
| No frontend error reporting | No Sentry/Coralogix; client errors are only in the user's console |
| No alert on backend 4xx rate | A spike in 422s (e.g., a bad deploy causing mass reservation failures) would not alarm |
| No alert on RDS connections / storage | A connection leak or disk fill would not alarm |
| No log-based alerting | Only metric alarms; a repeating error string does not raise an alert |
| No audit log export | `InventoryTransaction` rows are queryable but not shipped to a SIEM |

---

## 6. The Minimum Viable Improvement Set

If only three things were added for production observability:

1. **HTTPS + an error-tracking sink** (so the JWT and any client errors are not in cleartext, and JS errors are captured).
2. **A CloudWatch dashboard** with: ALB request count, backend p95 latency, 4xx/5xx rates, RDS CPU/connections, ECS task count. This turns the two existing alarms into a picture.
3. **A backend 4xx-rate alarm** (e.g., 422 count > N in 5 min) to catch a bad deploy that breaks reservation for everyone before users report it.


---

**Read next:** [13 — Production Improvements →](13-Production-Improvements.md)

[← Back to documentation index](README.md)
