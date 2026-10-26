// Types for scripts/pack.mjs (used by test/package.test.ts).
export declare const RUNTIME_DEPENDENCIES: string[];
export declare function publishManifest(pkg: Record<string, unknown>): Record<string, unknown>;
export declare function manifestProblems(pkg: Record<string, unknown>, version?: string): string[];
export declare function pack(destination: string): string;
