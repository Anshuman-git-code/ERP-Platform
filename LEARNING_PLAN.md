# TypeScript & Backend Development Learning Plan

Welcome to your structured path to becoming a market-ready Backend Developer with a focus on TypeScript, Node.js, and Prisma! Since you already have some background in Python, Java, and DSA, you will pick up the syntax quickly. This plan is designed to be fast-paced, hands-on, and directly tied to this ERP codebase.

## How to use this plan
As your AI mentor, I am here to guide you. Your workflow will be:
1. **Read & Explore:** Review the specific concepts and files mentioned in each phase.
2. **Execute:** Pick a task from `backend/EXERCISES.md`.
3. **Review:** Once you complete a task, you can ask me to review your code.
4. **Stuck?** Ask me questions anytime! You can ask "How does this Prisma query work?" or "Why am I getting this TypeScript error?"

---

## Phase 1: The Foundations (TypeScript + Express)
**Goal:** Understand how JavaScript becomes TypeScript and how a basic web server works.

* **Concept 1: Types and Interfaces**
  * *What it is:* Unlike Python or JS, TypeScript forces you to define the "shape" of your data.
  * *Where to look:* Open `backend/src/types/index.d.ts` (if it exists) or look at how types are imported in routes. Notice how `req.body` is typed.
* **Concept 2: Express Server Setup**
  * *What it is:* Express is the framework handling HTTP requests (GET, POST).
  * *Where to look:* Open `backend/src/app.ts` and `backend/src/index.ts`. See how middlewares (like CORS and JSON parsing) are applied.
* **Concept 3: Middleware**
  * *What it is:* Functions that run *before* the final route handler (e.g., checking if a user is logged in).
  * *Where to look:* Explore `backend/src/middleware/auth.ts`. Notice how it checks for a JWT token before allowing the request to proceed.

## Phase 2: Database Layer (PostgreSQL + Prisma)
**Goal:** Understand how the backend talks to the database.

* **Concept 1: The Prisma Schema**
  * *What it is:* Prisma is an ORM. It translates TypeScript into SQL queries. The schema defines your database tables.
  * *Where to look:* Open `backend/prisma/schema.prisma`. Read through the `model` definitions (e.g., `User`, `Location`, `Item`). Notice the relationships (like `@relation`).
* **Concept 2: Querying the Database**
  * *What it is:* Using Prisma Client in your code to CRUD (Create, Read, Update, Delete) data.
  * *Where to look:* Open `backend/src/routes/inventory.ts` or `backend/src/routes/users.ts`. Look for code like `prisma.inventory.findMany(...)` or `prisma.user.create(...)`.

## Phase 3: Business Logic & Routing
**Goal:** Understand how data flows from the client, through validation, to the database, and back.

* **Concept 1: Routing**
  * *Where to look:* Open `backend/src/routes/`. Notice how `router.get('/', ...)` or `router.post('/', ...)` map specific URLs to logic.
* **Concept 2: Validation**
  * *What it is:* Never trust client data. We validate it before saving it.
  * *Where to look:* Look at how `express-validator` is used in the routes (e.g., `body('email').isEmail()`).

## Phase 4: Advanced Concepts (Concurrency & Cloud/DevOps)
**Goal:** Prepare for real-world backend engineering and DevOps integration.

* **Concept 1: Transactions & Locks**
  * *What it is:* Ensuring data integrity when multiple users buy the last item at the exact same time.
  * *Where to look:* Look for `$transaction` and raw queries with `FOR UPDATE` in `backend/src/routes/orders.ts`.
* **Concept 2: Docker & CI/CD**
  * *What it is:* Running the app reliably anywhere.
  * *Where to look:* Review `Dockerfile`, `docker-compose.yml`, and `.gitlab-ci.yml` in the root. Since you know DevOps, focus on how the Node.js app is built and tested in these pipelines.

---

## Next Steps
Head over to `backend/EXERCISES.md`. Start with **Task 1**. Try to implement it yourself in this codebase. If you get stuck or when you are finished, message me!
