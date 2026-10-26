import type { INodeProperties } from 'n8n-workflow';
import { locatorProperty } from './locator.js';

/**
 * The file types Download File offers. Values are the engine's MIME constants, written out here because the
 * description must not load the engine; test/quick-download.test.ts pins them to MIME and DEFAULT_MIME.
 */
export const FILE_TYPES: readonly { name: string; value: string }[] = [
  { name: 'CSV', value: 'text/csv' },
  { name: 'Plain Text', value: 'text/plain' },
  { name: 'PDF', value: 'application/pdf' },
  { name: 'XLSX', value: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  { name: 'JSON', value: 'application/json' },
  { name: 'ZIP', value: 'application/zip' },
  { name: 'PNG', value: 'image/png' },
  { name: 'JPEG', value: 'image/jpeg' },
  { name: 'DOCX', value: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
];
export const DEFAULT_FILE_TYPES: string[] = FILE_TYPES.slice(0, 4).map((t) => t.value);

export const downloadProperties: INodeProperties[] = [
  locatorProperty({
    name: 'downloadTrigger',
    displayName: 'Download Link or Button',
    description: 'The link or button that starts the download. Clicking it must start a GET download; a download that needs a form post is a Run Steps job.',
    required: true,
    show: { operation: ['download'] },
  }),
];
