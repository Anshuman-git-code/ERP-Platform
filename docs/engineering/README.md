# Engineering Documentation — Mini Operations ERP

> This folder is the engineering reference for the Mini Operations ERP project. Each document answers one question about the system end to end, from business requirements to production operations. The documents are numbered in the order a reader should follow: requirements first, then decisions, then architecture, then the data and flows that realise it, then the infrastructure that runs it, then the failure and operational concerns, and finally the reflective and explanatory material.

The project documented here is a production-oriented Operations ERP covering the flow:

> **Inventory → Work Order → Stock Check → Internal Transfer / Shortage → Customer Reservation**

It is a containerized monolith (Express + Prisma + PostgreSQL) deployed on AWS ECS Fargate behind an ALB, with RDS PostgreSQL, SSM-managed secrets, and GitLab CI/CD.

---

## Document Index

| # | Document | What it answers |
|---|---|---|
| 01 | [Business Requirements](01-Business-Requirements.md) | Why the system exists, who uses it, what it must do, and the constraints it operates within |
| 02 | [Engineering Thinking](02-Engineering-Thinking.md) | The engineering reasoning and mental models behind the design |
| 03 | [Architecture Decision Records](03-Architecture-Decision-Records.md) | The significant technical decisions, the alternatives considered, and the trade-offs accepted |
| 04 | [System Architecture](04-System-Architecture.md) | The logical and physical architecture, component responsibilities, and trust boundaries |
| 05 | [Business Flows](05-Business-Flows.md) | Each user-facing flow from business, technical, AWS, and failure perspectives |
| 06 | [Data Modeling](06-Data-Modeling.md) | The Prisma schema, entities, relationships, indexes, and access patterns |
| 07 | [AWS Service Decisions](07-AWS-Service-Decisions.md) | Why each AWS service was chosen for this workload |
| 08 | [Infrastructure as Code](08-Infrastructure-as-Code.md) | How Terraform provisions the entire AWS footprint |
| 09 | [Security Architecture](09-Security-Architecture.md) | Authentication, authorization, secrets, network, and container security |
| 10 | [Transaction & Concurrency Workflow](10-Transaction-Concurrency-Workflow.md) | The defining workflow: atomic stock reservation, transfer state machine, and row locking |
| 11 | [Failure Scenarios](11-Failure-Scenarios.md) | What can go wrong, how the system behaves, and what is left unguarded |
| 12 | [Observability](12-Observability.md) | Logging, health checks, metrics, alarms, and what is not yet observed |
| 13 | [Production Improvements](13-Production-Improvements.md) | The roadmap from case-study quality to production quality |
| 14 | [Lessons Learned](14-Lessons-Learned.md) | Reflections on the build: what worked, what surprised, and what to repeat |
| 15 | [Interview Guide](15-Interview-Guide.md) | Questions and answers an interviewer might ask about this system |
| 16 | [API and DB Design](16-API-and-DB-Design.md) | The endpoint catalogue and the database design that backs it |
| 17 | [System Design Overview](17-System-Design-Overview.md) | A condensed high-level walkthrough for a reader in a hurry |
| 18 | [Requirements to Architecture](18-Requirements-to-Architecture.md) | How each requirement traces to an architectural element |
| 19 | [Complete Build Journal](19-Complete-Build-Journal.md) | The phase-by-phase story of how the system was built |
| 20 | [Complete Request Flow](20-Complete-Request-Flow.md) | A single request traced end to end through every layer |

---

## How to Read This Documentation

If you are new to the project, read in order 01 → 20. If you want a quick orientation, read [17 — System Design Overview](17-System-Design-Overview.md). If you want to understand the concurrency design (the most important engineering decision in the project), read [10 — Transaction & Concurrency Workflow](10-Transaction-Concurrency-Workflow.md). If you are preparing for an interview on this system, read [15 — Interview Guide](15-Interview-Guide.md).

## Relationship to the Existing `docs/` Folder

This `engineering/` folder is a deep, teaching-oriented reference. The existing top-level `docs/` files (`ARCHITECTURE.md`, `DECISIONS.md`, `API.md`, `DEPLOYMENT.md`, `E2E_VERIFICATION.md`, `KNOWN_LIMITATIONS.md`, `complete-project-guide.md`) are concise operational references. Where they overlap, this folder expands on the same facts with the reasoning and the "why" behind them.

> **Note on naming:** The project's codebase and README call it **Mini Operations ERP** (resources are prefixed `ops-erp`). These documents use that name. The "Grievance Sphere" label is not present in the codebase and is not used here.
