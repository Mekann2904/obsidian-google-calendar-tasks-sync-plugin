export class Notice {
  message: string;
  timeout?: number;
  constructor(message: string, timeout?: number) {
    this.message = message;
    this.timeout = timeout;
  }
}

export type App = any;


