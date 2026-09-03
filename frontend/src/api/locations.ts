import { apiClient } from './client';
import { Location, ApiResponse } from '../types';

export const locationsApi = {
  list: () => apiClient.get<ApiResponse<Location[]>>('/locations'),
  get: (id: string) => apiClient.get<ApiResponse<Location>>(`/locations/${id}`),
  create: (data: { name: string; address?: string }) =>
    apiClient.post<ApiResponse<Location>>('/locations', data),
};
