import type { INodeProperties } from 'n8n-workflow';

export const pdfProperties: INodeProperties[] = [
  {
    displayName: 'Paper',
    name: 'paper',
    type: 'options',
    default: 'A4',
    options: [
      { name: 'A4', value: 'A4', description: '210 × 297 mm' },
      { name: 'Letter', value: 'Letter', description: '8.5 × 11 in' },
    ],
    description: 'Paper size of the PDF. Saving as PDF needs headless Chromium.',
    displayOptions: { show: { operation: ['pdf'] } },
  },
];
