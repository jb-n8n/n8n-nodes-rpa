import { describe, expect, it } from 'vitest';
import type { SignedStepsRow } from 'n8n-rpa-engine';
import { rejectedRecord, RUN_TABLE, RUN_TABLE_COLUMNS, signedRecord, STEPS_TABLE, STEPS_TABLE_COLUMNS } from '../nodes/Playwright/rows.js';

describe('Data Table rows', () => {
  it('names the two tables and their columns in documented order', () => {
    expect(STEPS_TABLE).toBe('playwright_steps');
    expect(RUN_TABLE).toBe('playwright_runs');
    expect(STEPS_TABLE_COLUMNS.map((c) => `${c.name}:${c.type}`)).toEqual([
      'name:string', 'version:number', 'steps:string', 'hash:string', 'signature:string', 'approvedBy:string', 'approvedAt:string', 'status:string', 'expiresAt:string',
    ]);
    expect(RUN_TABLE_COLUMNS.map((c) => `${c.name}:${c.type}`)).toEqual([
      'name:string', 'lane:string', 'version:number', 'hash:string', 'confirmed:boolean', 'rowCount:number', 'durationMs:number', 'llmTokens:number', 'code:string', 'executionId:string',
    ]);
  });
  it('a signed row becomes an active record with the steps as JSON text', () => {
    const row: SignedStepsRow = {
      name: 'feed', version: 2, steps: { name: 'feed', version: 2, startUrl: 'https://example.com/', steps: [] }, hash: 'h', signature: 's',
      approvedBy: 'a@example.com', approvedAt: '2026-10-06T00:00:00.000Z', status: 'active',
    };
    expect(signedRecord(row)).toEqual({
      name: 'feed', version: 2, steps: JSON.stringify(row.steps), hash: 'h', signature: 's', approvedBy: 'a@example.com', approvedAt: '2026-10-06T00:00:00.000Z', status: 'active',
    });
  });
  it('a rejection has empty steps and signature', () => {
    expect(rejectedRecord({ name: 'feed', version: 3, hash: 'h3' }, 'a@example.com', new Date('2026-10-06T12:00:00Z'))).toEqual({
      name: 'feed', version: 3, steps: '', hash: 'h3', signature: '', approvedBy: 'a@example.com', approvedAt: '2026-10-06T12:00:00.000Z', status: 'rejected',
    });
  });
});
