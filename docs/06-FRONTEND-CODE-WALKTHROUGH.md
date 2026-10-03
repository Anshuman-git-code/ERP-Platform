# Frontend Code Walkthrough

## Application Bootstrap

When you open the browser:

```
1. Browser loads index.html
2. <script src="/assets/index-*.js"> loads the React bundle (225KB gzipped)
3. main.tsx runs: ReactDOM.createRoot(document.getElementById('root')).render(<App />)
4. App.tsx renders: BrowserRouter → AuthProvider → Routes
5. AuthProvider's useEffect runs: reads localStorage for token+user
6. If token exists → user state is set → ProtectedRoute allows access
7. If no token → ProtectedRoute redirects to /login
```

---

## File: `src/main.tsx` — React Entry Point

```typescript
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

**Why `React.StrictMode`:** In development, StrictMode renders components twice to catch side effects. It has no effect in production. The `!` after `getElementById('root')` tells TypeScript "this element definitely exists" — it matches the `<div id="root"></div>` in `index.html`.

---

## File: `src/App.tsx` — Routing

**Three things happening here:**
1. `BrowserRouter` — uses the HTML5 History API for URL navigation (no page reloads)
2. `AuthProvider` — wraps everything so any component can call `useAuth()`
3. `Routes` + `Route` — maps URL paths to page components

```typescript
const Inventory  = React.lazy(() => import('./pages/Inventory'));
```
**Lazy loading:** The Inventory, WorkOrders, Transfers, and Orders page code is NOT included in the initial bundle. It's loaded on demand when the user first navigates to that route. This makes initial page load faster. `React.Suspense` shows a spinner while the chunk loads.

**Route structure:**
```
/           → redirect to /inventory
/login      → Login page (public, no auth guard)
/inventory  → ProtectedRoute → Inventory page
/work-orders→ ProtectedRoute → WorkOrders page
/transfers  → ProtectedRoute → Transfers page
/orders     → ProtectedRoute → Orders page
*           → redirect to /inventory
```

---

## File: `src/api/client.ts` — The API Bridge

This is the most important frontend file. Every single API call goes through this Axios instance.

```typescript
const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '/api';

export const apiClient = axios.create({
  baseURL: BASE_URL,
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
});
```

In development, `VITE_API_BASE_URL` is not set, so it defaults to `/api`. Vite's dev server proxies `/api/*` to `http://localhost:4000`. In production (Docker/AWS), nginx proxies `/api/*` to the backend container.

**Request interceptor:**
```typescript
apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});
```
Every API call automatically gets the JWT header. The component calling the API doesn't need to know about tokens — it just calls `inventoryApi.list()` and the header is added transparently.

**Response interceptor:**
```typescript
apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);
```
If any API call returns 401 (token expired or invalid), the user is immediately logged out and redirected. This handles session expiry transparently — the user doesn't stay on a broken page.

---

## File: `src/contexts/AuthContext.tsx` — Auth State

**Why this file exists:** Multiple components need to know who is logged in. Instead of passing `user` and `token` as props through every component tree, React Context makes it globally available.

**The state:**
```typescript
const [user, setUser] = useState<User | null>(null);
const [token, setToken] = useState<string | null>(localStorage.getItem('token'));
const [isLoading, setIsLoading] = useState(true);
```
`isLoading: true` initially prevents a flash of the redirect to `/login` while the app checks localStorage.

**The `useEffect` (runs once on mount):**
```typescript
useEffect(() => {
  const storedToken = localStorage.getItem('token');
  const storedUser = localStorage.getItem('user');
  if (storedToken && storedUser) {
    setUser(JSON.parse(storedUser));
    setToken(storedToken);
  }
  setIsLoading(false);
}, []);
```
When the page refreshes, React state is lost. This effect re-hydrates the user from localStorage. Once it finishes, `isLoading` becomes false and ProtectedRoute makes its decision.

**`login()`:**
```typescript
const login = async (email: string, password: string) => {
  const { data } = await authApi.login(email, password);
  localStorage.setItem('token', data.token);
  localStorage.setItem('user', JSON.stringify(data.user));
  setToken(data.token);
  setUser(data.user);
};
```
Stores token AND user in localStorage (for page refresh persistence) AND in React state (for immediate UI update).

**`logout()`:**
```typescript
const logout = () => {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  setToken(null);
  setUser(null);
};
```
Clearing state triggers React re-render → ProtectedRoute sees `user=null` → redirects to `/login`.

---

## File: `src/components/ProtectedRoute.tsx` — Route Guard

```typescript
export default function ProtectedRoute({ children, roles }: Props) {
  const { user, isLoading } = useAuth();

  if (isLoading) return <spinner />;        // Still checking localStorage
  if (!user) return <Navigate to="/login" />;  // Not logged in
  if (roles && !roles.includes(user.role)) {   // Wrong role
    return <Layout><AccessDenied /></Layout>;
  }
  return <Layout>{children}</Layout>;        // All good
}
```

Three guard layers:
1. **Loading** — prevents redirect flash while checking localStorage
2. **Authentication** — no user → login
3. **Authorization** — wrong role → access denied page (not a redirect, so user knows why)

In `App.tsx`, all route `ProtectedRoute` elements wrap the page in `Layout` automatically. This is why every protected page has the sidebar — it's provided by `ProtectedRoute` → `Layout`.

---

## File: `src/components/Layout.tsx` — The Shell

**Role-filtered navigation:**
```typescript
const navItems = [
  { label: 'Inventory',       to: '/inventory',   roles: ['ADMIN', 'OPERATIONS', 'SALES'] },
  { label: 'Work Orders',     to: '/work-orders', roles: ['ADMIN', 'OPERATIONS', 'SALES'] },
  { label: 'Transfers',       to: '/transfers',   roles: ['ADMIN', 'OPERATIONS', 'SALES'] },
  { label: 'Customer Orders', to: '/orders',      roles: ['ADMIN', 'OPERATIONS', 'SALES'] },
];

const visibleItems = navItems.filter((item) =>
  user ? item.roles.includes(user.role) : false
);
```

In this application all four screens are accessible to all roles (but with different action buttons per page). The filtering here allows future role-restricted navigation without changing routing.

**Role badge colors:**
```typescript
const roleBadgeColor = {
  ADMIN: 'bg-purple-100 text-purple-800',
  OPERATIONS: 'bg-blue-100 text-blue-800',
  SALES: 'bg-green-100 text-green-800',
};
```
Provides immediate visual feedback on which role is active.

---

## Screen Walkthroughs

### Screen 1: Login (`/login`)

```
User types email + password
  ↓
handleSubmit()
  ↓
login(email, password)   [from AuthContext]
  ↓
authApi.login(email, password)
  ↓
POST /api/auth/login
  ↓
Backend: bcrypt.compare + jwt.sign
  ↓
Response: { token, user }
  ↓
localStorage.setItem('token', token)
localStorage.setItem('user', JSON.stringify(user))
  ↓
setUser(user) → React re-renders
  ↓
navigate('/inventory')   [React Router]
  ↓
ProtectedRoute sees user → renders Inventory page
```

### Screen 2: Inventory (`/inventory`)

```
Page mounts → useEffect runs
  ↓
inventoryApi.list()
  ↓
GET /api/inventory
  ↓
Backend: prisma.inventory.findMany + withAvailable()
  ↓
Response: { data: [...], meta: {...} }
  ↓
setRecords(res.data.data)
  ↓
Table renders with physicalQty, reservedQty, availableQty
  
User clicks "Adjust"
  ↓
setAdjustTarget(record) → modal opens
  ↓
User selects IN/OUT, enters quantity
  ↓
inventoryApi.adjust(record.id, { transactionType, quantity, reason })
  ↓
PATCH /api/inventory/:id/adjust
  ↓
Backend: SELECT FOR UPDATE + UPDATE physicalQty
  ↓
Response: updated inventory with new availableQty
  ↓
load() called → table refreshes with new values
```

### Screen 3: Work Orders (`/work-orders`)

```
Page mounts → workOrdersApi.list()
  ↓
GET /api/work-orders
  ↓
Backend: fetches work orders + for each calls getInventoryAvailability()
         shortageQty = max(requiredQty - availableQty, 0)
  ↓
Response includes shortageQty for each WO
  ↓
Red badge "-15" shown when shortage > 0
Green "OK" badge when enough stock

User clicks "→ IN PROGRESS"
  ↓
workOrdersApi.updateStatus(wo.id, 'IN_PROGRESS')
  ↓
PATCH /api/work-orders/:id/status
  ↓
Backend: transition check (ASSIGNED → IN_PROGRESS only)
         UPDATE status + startedAt = now()
  ↓
Response: updated work order
  ↓
load() called → table refreshes
```

### Screen 4: Transfers (`/transfers`)

```
Page mounts → transfersApi.list()
  ↓
GET /api/transfers
  ↓
Table shows REQUESTED transfers with "Dispatch Cancel" buttons
Table shows DISPATCHED transfers with "Receive" button only

User clicks "Dispatch"
  ↓
transfersApi.dispatch(transfer.id)
  ↓
PATCH /api/transfers/:id/dispatch
  ↓
Backend: prisma.$transaction → SELECT FOR UPDATE on source inventory
         Check available, decrement source physicalQty
         Create InventoryTransaction (OUT)
         Update status = DISPATCHED
  ↓
Source inventory row shows reduced quantity immediately
Destination inventory UNCHANGED (proven by test)
"Dispatch" button disappears; "Receive" button appears

User clicks "Receive"
  ↓
transfersApi.receive(transfer.id)
  ↓
PATCH /api/transfers/:id/receive
  ↓
Backend: SELECT FOR UPDATE on transfer row
         status check (must be DISPATCHED)
         UPSERT dest inventory
         Increment dest physicalQty
         Create InventoryTransaction (IN)
         Update status = RECEIVED
  ↓
Destination inventory row now shows increased quantity
Transfer status shows RECEIVED badge
```

### Screen 5: Customer Orders (`/orders`)

```
Page mounts → ordersApi.list()
  ↓
GET /api/orders
  ↓
Table shows PENDING orders with "Confirm Cancel" buttons
Table shows CONFIRMED orders with "Cancel" button only

User clicks "New Order" → modal opens
  ↓
User selects location → inventoryApi.list({ locationId }) called
Dropdown shows: "Steel Rod 10mm — Available: 5"
  ↓
User fills form and clicks "Create Order"
  ↓
ordersApi.create({ customerName, locationId, items: [{inventoryId, quantity}] })
  ↓
POST /api/orders
  ↓
Backend: creates PENDING order (NO stock reserved yet)
  ↓
Table shows new order with PENDING status

User clicks "Confirm"
  ↓
ordersApi.confirm(orderId)
  ↓
PATCH /api/orders/:id/confirm
  ↓
Backend: BEGIN TRANSACTION
         SELECT ... FOR UPDATE (row lock)
         available = physicalQty - reservedQty
         if available < requested → 422 ROLLBACK
         UPDATE reservedQty += quantity
         UPDATE status = CONFIRMED
         COMMIT
  ↓
If success: table shows CONFIRMED badge, stock is reserved
If failure: alert shows "Insufficient stock — available: X, requested: Y"
```
