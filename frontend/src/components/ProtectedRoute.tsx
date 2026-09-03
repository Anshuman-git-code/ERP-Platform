import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { Role } from '../types';
import Layout from './Layout';

interface Props {
  children: React.ReactNode;
  roles?: Role[];
}

export default function ProtectedRoute({ children, roles }: Props) {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (roles && !roles.includes(user.role)) {
    return (
      <Layout>
        <div className="flex flex-col items-center justify-center h-64 text-center">
          <p className="text-2xl font-semibold text-gray-700">Access Denied</p>
          <p className="mt-2 text-gray-500">
            Your role ({user.role}) does not have permission for this page.
          </p>
        </div>
      </Layout>
    );
  }

  return <Layout>{children}</Layout>;
}
