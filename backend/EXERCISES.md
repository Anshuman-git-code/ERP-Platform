# Hands-On TypeScript Backend Exercises

These exercises are designed to be completed directly in this repository. They start simple and gradually increase in complexity. You can test your code locally using Docker or Node.js.

## Task 1: The Basics - A New GET Endpoint
**Goal:** Practice defining a route, returning JSON, and basic TypeScript typing.
* **Context:** The operations team wants a simple "ping" endpoint to check if the specific inventory service is alive, separate from the main app health check.
* **Your Job:**
  1. Open `backend/src/routes/inventory.ts`.
  2. Add a new `GET` route at `/ping`.
  3. It should return a JSON response: `{ "status": "ok", "service": "inventory", "timestamp": <current ISO date string> }`.
  4. Ensure you use the correct TypeScript types for the Express `Request` and `Response` objects.
* **Test it:** Run the server and hit `http://localhost:4000/api/inventory/ping`.

## Task 2: Database Query & Validation
**Goal:** Practice using Prisma to fetch data and Express Validator to check inputs.
* **Context:** The team needs a way to search for items by their category.
* **Your Job:**
  1. Open `backend/src/routes/inventory.ts` (or create a new `items.ts` route and link it in `app.ts`).
  2. Create a `GET` route like `/items/category/:categoryName`.
  3. Add validation to ensure `categoryName` is a string and not empty.
  4. Use Prisma (`prisma.item.findMany`) to find all items that match that category.
  5. Return the list of items as JSON. Handle the case where no items are found (return an empty array or a 404 message).

## Task 3: Modifying the Database Schema (Prisma)
**Goal:** Learn how to update the database schema and apply migrations.
* **Context:** Currently, the `Item` model only has a `sku`, `category`, and `unitPrice`. We want to add a `description` field.
* **Your Job:**
  1. Open `backend/prisma/schema.prisma`.
  2. Find the `Item` model.
  3. Add a new field: `description String?` (The `?` makes it optional so we don't break existing data).
  4. Run the Prisma migration command to apply this to the database (you will need to run the database via Docker first). *Hint: look at the `scripts` in `backend/package.json` for the exact command.*
  5. Update the codebase wherever an item is created to optionally accept a description.

## Task 4: Business Logic & Error Handling (Bug Fix / Feature)
**Goal:** Work with slightly more complex logic and error states.
* **Context:** Right now, in `backend/src/routes/locations.ts` (or similar), there might not be a way to "deactivate" a location. We don't want to delete it (to preserve history), but we want to mark it inactive.
* **Your Job:**
  1. Update the `Location` Prisma schema to include a boolean field `isActive` (default `true`). Run the migration.
  2. Create a new `PATCH /locations/:id/deactivate` endpoint.
  3. This endpoint must check if the location exists. If not, return a 404.
  4. It must check if there is any existing inventory at this location (`physicalQty > 0`). If there is, return a 400 Bad Request saying "Cannot deactivate location with active inventory."
  5. If it's empty, use Prisma to update `isActive` to `false`.

---

### How to get help
If you don't know where to start or get an error you don't understand, ask me! Provide the error message or the code you wrote, and I will help you debug it.