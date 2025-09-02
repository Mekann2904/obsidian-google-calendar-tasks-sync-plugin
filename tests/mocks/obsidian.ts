import { vi } from 'vitest';

export class Notice {
  message: string;
  timeout?: number;
  constructor(message: string, timeout?: number) {
    this.message = message;
    this.timeout = timeout;
  }
}

export type App = any;

// Mocked HTTP helper to avoid outbound requests during tests
export const requestUrl = vi.fn();

