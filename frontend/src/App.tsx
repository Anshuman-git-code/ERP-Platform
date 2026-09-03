import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import ProtectedRoute from './components/ProtectedRoute';
import Login from './pages/Login';

// Placeholder pages — will be implemented in Phase 6
const Inventory    = React.lazy(() => import('./pages/Inventory'));
const WorkOrders   = React.lazy(() => import('./pages/WorkOrders'));
const Transfers    = React.lazy(() => import('./pages/Transfers'));
const Orders       = React.lazy(() => import('./pages/Orders'));

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <React.Suspense
          fallback={
            <div className="min-h-screen flex items-center justify-center">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" />
            </div>
          }
        >
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/" element={<Navigate to="/inventory" replace />} />

            <Route
              path="/inventory"
              element={
                <ProtectedRoute>
                  <Inventory />
                </ProtectedRoute>
              }
            />

            <Route
              path="/work-orders"
              element={
                <ProtectedRoute>
                  <WorkOrders />
                </ProtectedRoute>
              }
            />

            <Route
              path="/transfers"
              element={
                <ProtectedRoute>
                  <Transfers />
                </ProtectedRoute>
              }
            />

            <Route
              path="/orders"
              element={
                <ProtectedRoute>
                  <Orders />
                </ProtectedRoute>
              }
            />

            {/* Fallback */}
            <Route path="*" element={<Navigate to="/inventory" replace />} />
          </Routes>
        </React.Suspense>
      </AuthProvider>
    </BrowserRouter>
  );
}
