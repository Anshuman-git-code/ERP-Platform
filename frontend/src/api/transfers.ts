import { apiClient } from './client';
import { StockTransfer, ApiResponse, PaginatedResponse } from '../types';

export const transfersApi = {
  list: (params?: { page?: number; limit?: number; status?: string }) =>
    apiClient.get<PaginatedResponse<StockTransfer>>('/transfers', { params }),

  get: (id: string) => apiClient.get<ApiResponse<StockTransfer>>(`/transfers/${id}`),

  create: (data: {
    sourceLocationId: string;
    destLocationId: string;
    itemId: string;
    quantity: number;
    notes?: string;
  }) => apiClient.post<ApiResponse<StockTransfer>>('/transfers', data),

  dispatch: (id: string) =>
    apiClient.patch<ApiResponse<StockTransfer>>(`/transfers/${id}/dispatch`),

  receive: (id: string) =>
    apiClient.patch<ApiResponse<StockTransfer>>(`/transfers/${id}/receive`),

  cancel: (id: string) =>
    apiClient.patch<ApiResponse<StockTransfer>>(`/transfers/${id}/cancel`),
};
