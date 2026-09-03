import { apiClient } from './client';
import { Item, ApiResponse, PaginatedResponse } from '../types';

export const itemsApi = {
  list: (params?: { page?: number; limit?: number; search?: string }) =>
    apiClient.get<PaginatedResponse<Item>>('/items', { params }),
  get: (id: string) => apiClient.get<ApiResponse<Item>>(`/items/${id}`),
  create: (data: { name: string; sku: string; category?: string; unitPrice: number }) =>
    apiClient.post<ApiResponse<Item>>('/items', data),
  update: (id: string, data: { name?: string; category?: string; unitPrice?: number }) =>
    apiClient.put<ApiResponse<Item>>(`/items/${id}`, data),
};
