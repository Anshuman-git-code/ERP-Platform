import { apiClient } from './client';
import { Inventory, ApiResponse, PaginatedResponse } from '../types';

export const inventoryApi = {
  list: (params?: { page?: number; limit?: number; locationId?: string; itemId?: string }) =>
    apiClient.get<PaginatedResponse<Inventory>>('/inventory', { params }),

  get: (id: string) => apiClient.get<ApiResponse<Inventory>>(`/inventory/${id}`),

  create: (data: {
    itemId: string;
    locationId: string;
    physicalQty: number;
    batchNumber?: string;
  }) => apiClient.post<ApiResponse<Inventory>>('/inventory', data),

  adjust: (
    id: string,
    data: {
      transactionType: 'IN' | 'OUT';
      quantity: number;
      reason?: string;
      referenceKey?: string;
    }
  ) => apiClient.patch<ApiResponse<Inventory>>(`/inventory/${id}/adjust`, data),
};
