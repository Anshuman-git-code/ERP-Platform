import React, { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

interface NavItem {
  label: string;
  to: string;
  roles: string[];
}

const navItems: NavItem[] = [
  { label: 'Inventory',         to: '/inventory',  roles: ['ADMIN', 'OPERATIONS', 'SALES'] },
  { label: 'Work Orders',       to: '/work-orders', roles: ['ADMIN', 'OPERATIONS', 'SALES'] },
  { label: 'Transfers',         to: '/transfers',  roles: ['ADMIN', 'OPERATIONS', 'SALES'] },
  { label: 'Customer Orders',   to: '/orders',     roles: ['ADMIN', 'OPERATIONS', 'SALES'] },
];

export default function Layout({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const visibleItems = navItems.filter((item) =>
    user ? item.roles.includes(user.role) : false
  );

  const roleBadgeColor: Record<string, string> = {
    ADMIN: 'bg-purple-100 text-purple-800',
    OPERATIONS: 'bg-blue-100 text-blue-800',
    SALES: 'bg-green-100 text-green-800',
  };

  return (
    <div className="min-h-screen bg-gray-50 flex">
      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-64 bg-white border-r border-gray-200 transform transition-transform duration-200 ease-in-out
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'} lg:relative lg:translate-x-0 lg:flex lg:flex-col`}
      >
        {/* Logo */}
        <div className="flex items-center justify-between h-16 px-6 border-b border-gray-200 flex-shrink-0">
          <span className="text-lg font-bold text-brand-700">Ops ERP</span>
          <button
            className="lg:hidden text-gray-500 hover:text-gray-700"
            onClick={() => setSidebarOpen(false)}
          >
            ✕
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-4 py-4 space-y-1 overflow-y-auto">
          {visibleItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={() => setSidebarOpen(false)}
              className={({ isActive }) =>
                `flex items-center px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-brand-50 text-brand-700'
                    : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        {/* User info */}
        {user && (
          <div className="p-4 border-t border-gray-200 flex-shrink-0">
            <div className="flex items-center justify-between">
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">{user.name}</p>
                <span
                  className={`inline-block mt-0.5 px-2 py-0.5 rounded-full text-xs font-medium ${
                    roleBadgeColor[user.role] ?? 'bg-gray-100 text-gray-700'
                  }`}
                >
                  {user.role}
                </span>
              </div>
              <button
                onClick={handleLogout}
                className="ml-3 text-xs text-gray-500 hover:text-red-600 transition-colors"
              >
                Sign out
              </button>
            </div>
          </div>
        )}
      </aside>

      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black bg-opacity-50 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar (mobile) */}
        <header className="h-16 bg-white border-b border-gray-200 flex items-center px-4 lg:hidden flex-shrink-0">
          <button
            onClick={() => setSidebarOpen(true)}
            className="text-gray-500 hover:text-gray-700 mr-4"
          >
            ☰
          </button>
          <span className="font-bold text-brand-700">Ops ERP</span>
        </header>

        <main className="flex-1 p-6 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
