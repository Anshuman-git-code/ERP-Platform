import { apiClient } from './client';
import { DashboardStats, ApiResponse } from '../types';

export const dashboardApi = {
  getStats: () => apiClient.get<ApiResponse<DashboardStats>>('/dashboard'),
};
