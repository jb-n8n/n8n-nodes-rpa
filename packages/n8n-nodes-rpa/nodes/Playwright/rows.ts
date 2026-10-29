import type { SignedDesktopRow, SignedStepsRow } from 'n8n-rpa-engine';

export const STEPS_TABLE = 'playwright_steps';
export const RUN_TABLE = 'playwright_runs';

export type ColumnType = 'string' | 'number' | 'boolean';
export const STEPS_TABLE_COLUMNS: readonly { name: string; type: ColumnType }[] = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'number' },
  { name: 'steps', type: 'string' },
  { name: 'hash', type: 'string' },
  { name: 'signature', type: 'string' },
  { name: 'approvedBy', type: 'string' },
  { name: 'approvedAt', type: 'string' },
  { name: 'status', type: 'string' },
  { name: 'expiresAt', type: 'string' },
];
export const RUN_TABLE_COLUMNS: readonly { name: string; type: ColumnType }[] = [
  { name: 'name', type: 'string' },
  { name: 'lane', type: 'string' },
  { name: 'version', type: 'number' },
  { name: 'hash', type: 'string' },
  { name: 'confirmed', type: 'boolean' },
  { name: 'rowCount', type: 'number' },
  { name: 'durationMs', type: 'number' },
  { name: 'llmTokens', type: 'number' },
  { name: 'code', type: 'string' },
  { name: 'executionId', type: 'string' },
];

/** The record Sign Steps outputs, shaped as a row of the steps table (the approval template writes it by hash). */
export interface StepsRecord {
  name: string; version: number; steps: string; hash: string; signature: string; approvedBy: string; approvedAt: string; status: 'active' | 'rejected';
}

export function signedRecord(row: SignedStepsRow | SignedDesktopRow): StepsRecord {
  return {
    name: row.name, version: row.version, steps: JSON.stringify(row.steps), hash: row.hash, signature: row.signature,
    approvedBy: row.approvedBy, approvedAt: row.approvedAt, status: 'active',
  };
}

export function rejectedRecord(p: { name: string; version: number; hash: string }, approvedBy: string, at: Date): StepsRecord {
  return { name: p.name, version: p.version, steps: '', hash: p.hash, signature: '', approvedBy, approvedAt: at.toISOString(), status: 'rejected' };
}
