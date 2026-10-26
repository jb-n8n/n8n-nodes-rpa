import type { INodeProperties, INodePropertyOptions } from 'n8n-workflow';
import { getPageProperties } from './getPage.js';
import { importStepsProperties } from './importSteps.js';
import { downloadProperties } from './download.js';
import { extractProperties } from './extract.js';
import { fillFormProperties } from './fillForm.js';
import { optionsProperty, QUICK_OPERATIONS } from './options.js';
import { pdfProperties } from './pdf.js';
import { runStepsProperties } from './runSteps.js';
import { screenshotProperties } from './screenshot.js';
import { signStepsProperties } from './signSteps.js';

/** Quick operations, in menu order; merge order = menu order. */
export const QUICK_OPERATION_OPTIONS: INodePropertyOptions[] = [
  { name: 'Screenshot', value: 'screenshot', action: 'Take a screenshot of a page', description: 'Open a page and capture it as a PNG image' },
  { name: 'Get Page', value: 'getPage', action: 'Get the text, HTML or title of a page', description: 'Open a page and return its text, HTML or title' },
  { name: 'Save as PDF', value: 'pdf', action: 'Save a page as PDF', description: 'Open a page and print it to a PDF file' },
  { name: 'Extract Data', value: 'extract', action: 'Extract a table or list from a page', description: 'Read a table or a repeated list on a page into rows' },
  { name: 'Fill and Submit Form', value: 'fillForm', action: 'Fill in and submit a form', description: 'Fill in the fields of a form on a page and submit it' },
  { name: 'Download File', value: 'download', action: 'Download a file from a page', description: 'Click a link or button and return the file it downloads' },
];

export const URL_HINT = 'Only this site is visited. Other sites are blocked. Add more under Options → Also Allow These Sites.';

/** The URL field every quick operation has. */
export const URL_PROPERTY: INodeProperties = {
  displayName: 'URL',
  name: 'url',
  type: 'string',
  default: '',
  required: true,
  placeholder: 'https://example.com/pricing',
  hint: URL_HINT,
  description: 'The page to open (http or https)',
  displayOptions: { show: { operation: QUICK_OPERATIONS } },
};

/** Fields of the quick operations, after the URL. */
export const QUICK_PROPERTIES: INodeProperties[] = [
  ...screenshotProperties,
  ...getPageProperties,
  ...pdfProperties,
  ...extractProperties,
  ...fillFormProperties,
  ...downloadProperties,
];

/**
 * Operations in menu order: the quick operations first (QUICK_OPERATION_OPTIONS), then the expert operations, Import
 * Steps last.
 * The order is logical on purpose. @n8n/eslint-plugin-community-nodes 0.35.0 has no option-sorting rule, so there is
 * nothing to disable here.
 */
export const OPERATION_OPTIONS: INodePropertyOptions[] = [
  ...QUICK_OPERATION_OPTIONS,
  {
    name: 'Run Steps',
    value: 'runSteps',
    action: 'Run a list of browser steps',
    description: 'Advanced: run a JSON step list, signed or typed here, with optional AI repair when the page changes',
  },
  {
    name: 'Sign Steps',
    value: 'signSteps',
    action: 'Sign a repaired step list',
    description: 'Advanced: sign a Repaired steps item from Run Steps after a person approved it, or record a rejection',
  },
  {
    name: 'Import Steps',
    value: 'importSteps',
    action: 'Import steps from a recording, code or a UiPath bot',
    description: 'Advanced: turn a Chrome Recorder export, Playwright code or a UiPath project into steps for approval',
  },
];

export const OPERATIONS: INodeProperties = {
  displayName: 'Operation',
  name: 'operation',
  type: 'options',
  noDataExpression: true,
  default: 'screenshot',
  options: OPERATION_OPTIONS,
};

const SUBTITLE_NAMES = Object.fromEntries(OPERATION_OPTIONS.map((o) => [String(o.value), o.name]));
export const SUBTITLE = `={{ (${JSON.stringify(SUBTITLE_NAMES)})[$parameter["operation"]] }}`;

export const properties: INodeProperties[] = [OPERATIONS, URL_PROPERTY, ...QUICK_PROPERTIES, ...runStepsProperties, ...signStepsProperties, ...importStepsProperties, optionsProperty];
