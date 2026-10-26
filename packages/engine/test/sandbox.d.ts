declare module 'n8n-rpa-sandbox/testing.js' {
  export interface SandboxPortal {
    url: string;
    host: string;
    port: number;
    setState(change: Record<string, unknown>): Record<string, unknown>;
    reset(): Record<string, unknown>;
    state(): Record<string, unknown> & { logins: number; deletes: number; widgetPosts: number };
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
  export function startPortal(opts?: { sap?: 'light' | 'realistic'; sapLogin?: 'sap' | 'sso' | 'sso2' }): Promise<SandboxPortal>;
}
declare module 'n8n-rpa-sandbox/server.js' {
  export const server: import('node:http').Server;
}
declare module 'n8n-rpa-sandbox/xlsx.js' {
  export function crc32(bytes: Uint8Array): number;
  export function zipStored(files: { name: string; data: Uint8Array }[]): Uint8Array;
  export function xlsxBytes(rows: (string | number)[][], sheetName?: string): Uint8Array;
  export const XLSX_MIME: string;
}
declare module 'n8n-rpa-gate' {
  export const MIN_TOKEN_LENGTH: number;
  export interface GateStats {
    active: number; capacity: number; draining: boolean; sessionsTotal: number;
    refused: { capacity: number; draining: number; unauthorized: number; forbidden: number; bad_request: number };
  }
  export function createGate(opts: { token: string; upstreamHost?: string; upstreamPort: number; upstreamPath: string; maxSessions?: number }):
    import('node:http').Server & { stats(): GateStats; drain(timeoutMs: number): Promise<'idle' | 'timeout'> };
}
