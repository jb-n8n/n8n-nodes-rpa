// Types for setup/n8n-api.mjs (used by setup/setup.mts).
export interface Redactor {
  add(secret: string | undefined): void;
  redact(text: unknown): string;
}
export declare function createRedactor(): Redactor;
export declare function isLoopback(hostname: string): boolean;
export declare function parseN8nUrl(value: string | undefined, flag: string): { problem: string } | { problem?: undefined; origin: string; base: string; plaintext: boolean };
export declare const MIN_BROWSER_TOKEN_LENGTH: number;
export declare function parseBrowserUrl(value: string | undefined, flag: string, what?: string): { problem: string } | { problem?: undefined; href: string };
export declare function browserCredentialData(href: string, token: string): { mode: string; wsUrl: string; token: string; privateNetwork: boolean };

export interface ApiResponse {
  status: number;
  json: any;
  text: string;
}
export interface Client {
  api(method: string, path: string, body?: unknown): Promise<ApiResponse>;
  reason(r: ApiResponse): string;
  listAll(path: string, filter?: Record<string, string>): Promise<{ ok: true; items: any[] } | { ok: false; response: ApiResponse }>;
}
export declare function createClient(options: { base: string; apiKey: string; redact: (text: unknown) => string }): Client;
export declare function findCredential<T extends { name?: unknown; type?: unknown }>(
  items: T[], name: string, type: string, inProject?: (c: T) => boolean,
): { existing?: T; conflict?: T };
