import { apiClient } from './client';
import { CustomerOrder, ApiResponse, PaginatedResponse } from '../types';

export const ordersApi = {
  list: (params?: { page?: number; limit?: number; status?: string }) =>
    apiClient.get<PaginatedResponse<CustomerOrder>>('/orders', { params }),

  get: (id: string) => apiClient.get<ApiResponse<CustomerOrder>>(`/orders/${id}`),

  create: (data: {
    customerName: string;
    customerPhone?: string;
    locationId: string;
    notes?: string;
    items: Array<{ inventoryId: string; quantity: number }>;
  }) => apiClient.post<ApiResponse<CustomerOrder>>('/orders', data),

  confirm: (id: string) =>
    apiClient.patch<ApiResponse<CustomerOrder>>(`/orders/${id}/confirm`),

  cancel: (id: string) =>
    apiClient.patch<ApiResponse<CustomerOrder>>(`/orders/${id}/cancel`),
};
