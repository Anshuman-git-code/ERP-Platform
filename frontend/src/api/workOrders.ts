import { apiClient } from './client';
import { WorkOrder, ApiResponse, PaginatedResponse } from '../types';

export const workOrdersApi = {
  list: (params?: { page?: number; limit?: number; status?: string; locationId?: string }) =>
    apiClient.get<PaginatedResponse<WorkOrder>>('/work-orders', { params }),

  get: (id: string) => apiClient.get<ApiResponse<WorkOrder>>(`/work-orders/${id}`),

  create: (data: {
    locationId: string;
    itemId: string;
    requiredQty: number;
    assignedToId: string;
    notes?: string;
  }) => apiClient.post<ApiResponse<WorkOrder>>('/work-orders', data),

  updateStatus: (id: string, status: string) =>
    apiClient.patch<ApiResponse<WorkOrder>>(`/work-orders/${id}/status`, { status }),
};
