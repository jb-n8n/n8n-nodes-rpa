// Types for scripts/build-templates.mjs (used by test/template-sources.test.ts).
export interface Workflow { nodes: { name: string; parameters: Record<string, unknown> }[] }
export interface Source { template: string; file: string; node: string; parameter: string; text: string }
export declare const TEMPLATES: string;
export declare const SOURCES: string;
export declare const LONG: number;
export declare function readSnippets(file?: string): Map<string, string>;
export declare function fold(text: string, pieces?: Map<string, string>): string;
export declare function readSource(file: string, pieces?: Map<string, string>): Omit<Source, 'template'>;
export declare function readSources(): Source[];
export declare function parameterAt(workflow: Workflow, node: string, parameter: string): unknown;
export declare function longParameters(workflow: Workflow): { node: string; parameter: string }[];
export declare function build(sources?: Source[]): { template: string; file: string; before: string; after: string }[];
