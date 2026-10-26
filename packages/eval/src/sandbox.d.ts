declare module 'n8n-rpa-sandbox/testing.js' {
  export interface SandboxPortal {
    url: string;
    host: string;
    port: number;
    setState(change: Record<string, unknown>): Record<string, unknown>;
    reset(): Record<string, unknown>;
    /** Loose: other tasks add switches and counters (locked, attacks, deletes). */
    state(): Record<string, unknown> & { locked?: unknown; attacks?: unknown; deletes?: number };
    close(): Promise<void>;
  }
  export const SANDBOX: {
    username: string; password: string; totpSecret: string; bulletins: string[];
    erp: {
      header: string; company: string; from: string; to: string; rowsInSeptember1000: number;
      emptyFrom: string; emptyTo: string; idPattern: string; webguiPath: string; fioriPath: string;
      readPosts(host: string): { host: string; path: string }[];
    };
  };
  export function startPortal(opts?: { sap?: 'light' | 'realistic' }): Promise<SandboxPortal>;
}
