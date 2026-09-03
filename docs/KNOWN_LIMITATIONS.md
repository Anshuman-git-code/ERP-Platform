# Known Limitations

## In Scope (working as designed)

- All 5 mandatory PDF tests pass
- Concurrent reservation is safe (SELECT FOR UPDATE)
- Double-receipt is prevented by status guard
- Transfer and order lifecycle enforced correctly
- RBAC enforced on all endpoints

## Out of Scope / Known Gaps

### No JWT refresh
Tokens expire after 8h. On expiry the frontend redirects to login. A refresh token flow would require a separate endpoint and secure storage — out of scope for this case study.

### No rate limiting
No `express-rate-limit` middleware. Acceptable for a case study; production deployments should add it at the API gateway or application level.

### No frontend tests
The frontend has no Vitest/RTL test suite. All correctness testing is backend integration tests (74 tests).

### No user management UI
Users are created via seed or direct DB access. A `/api/users` CRUD endpoint and admin UI screen are not implemented.

### No stock reversal on transfer cancel
Cancelling a DISPATCHED transfer does not reverse the source stock deduction (cancellation is only permitted in REQUESTED state). A "recall" flow would be a future extension.

### No partial transfer receipt
The transfer receipt operation receives the full `quantity`. Partial receipt (e.g., receive 15 of 30) is not implemented. The live verification prompt explicitly calls this out as a potential extension.

### No damaged stock / damaged quantity field
The live verification prompt mentions a `damagedQty` field as a possible extension. The `InventoryTransaction` model with `reason` field and `OUT` type supports manual damage recording, but there is no dedicated `damagedQty` column on `Inventory`.

### Single ECS task per service
`desired_count = 1` in Terraform. Production would use 2+ tasks with ALB health check draining for zero-downtime deployments.

### Local Terraform state
The S3 backend block in `provider.tf` is commented out. Local state is not suitable for team use — uncomment and configure before production use.

### No HTTPS
ALB listener is HTTP only. Production requires an ACM certificate and HTTPS listener (port 443) with HTTP→HTTPS redirect.
