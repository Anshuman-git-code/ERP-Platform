import { apiClient } from './client';
import { User } from '../types';

export const authApi = {
  login: (email: string, password: string) =>
    apiClient.post<{ success: boolean; token: string; user: User }>('/auth/login', {
      email,
      password,
    }),

  me: () => apiClient.get<{ success: boolean; user: User }>('/auth/me'),
};
