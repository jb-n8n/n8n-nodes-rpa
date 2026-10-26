import type { INodeProperties } from 'n8n-workflow';
import { locatorProperty } from './locator.js';

export const screenshotProperties: INodeProperties[] = [
  {
    displayName: 'Capture',
    name: 'capture',
    type: 'options',
    default: 'fullPage',
    options: [
      { name: 'Full Page', value: 'fullPage', description: 'The whole page, up to 16,384 px tall' },
      { name: 'Viewport', value: 'viewport', description: 'Only what fits in the browser window (Options → Viewport)' },
      { name: 'One Element', value: 'element', description: 'One element, found with a locator' },
    ],
    description: 'What to capture as a PNG',
    displayOptions: { show: { operation: ['screenshot'] } },
  },
  locatorProperty({
    name: 'element',
    displayName: 'Element',
    description: 'The element to capture. It must match exactly one element.',
    required: true,
    show: { operation: ['screenshot'], capture: ['element'] },
  }),
];
