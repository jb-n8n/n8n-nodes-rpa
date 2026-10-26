import type { INodeProperties } from 'n8n-workflow';

const runSteps = { show: { operation: ['runSteps'] } };

export const UNSIGNED_NOTICE = 'Unsigned steps run as written. Only turn this off for steps you typed here.';
export const STEPS_PLACEHOLDER = JSON.stringify(
  [
    { intent: 'Open the price list', goto: 'https://example.com/pricing' },
    { intent: 'Read the price table', extractTable: { table: { css: 'table.results' } } },
    { intent: 'Take a screenshot', screenshot: { capture: 'viewport' } },
  ],
  null,
  2,
);

/** The file types Expected File offers: display name and the key into the engine's MIME table. */
const FILE_TYPES: [string, string][] = [['CSV', 'csv'], ['Excel (XLSX)', 'xlsx'], ['PDF', 'pdf'], ['Text', 'text'], ['JSON', 'json'], ['ZIP', 'zip']];

/**
 * Expected File (First Version): the file a first version must download. Run Steps (with AI Repair) and Import Steps
 * show it; both read it with operations/runSteps.ts expectedDownload.
 */
export function expectedFileProperty(displayOptions: INodeProperties['displayOptions'], description: string): INodeProperties {
  return {
    displayName: 'Expected File (First Version)',
    name: 'expectedFile',
    type: 'fixedCollection',
    default: {},
    description,
    displayOptions,
    options: [
      {
        displayName: 'Expected File',
        name: 'file',
        values: [
          {
            displayName: 'File Type',
            name: 'fileType',
            type: 'multiOptions',
            default: [],
            description: 'The kinds of file the download may be. Empty means the default list.',
            options: FILE_TYPES.map(([name, value]) => ({ name, value })),
          },
          {
            displayName: 'File Name Pattern (Regex)',
            name: 'namePattern',
            type: 'string',
            default: '',
            placeholder: '^LINEITEMS_',
            description: 'A regular expression the downloaded file name must match',
          },
          { displayName: 'Minimum Size (Bytes)', name: 'minBytes', type: 'number', default: 0, description: 'The smallest the file may be. 0 means no minimum.' },
          {
            displayName: 'Required Columns',
            name: 'requiredColumns',
            type: 'string',
            default: '',
            placeholder: 'Document, Amount',
            description: 'Comma-separated column headings the file must have (CSV and Excel)',
          },
          { displayName: 'Minimum Rows', name: 'minRows', type: 'number', default: 0, description: 'The fewest data rows the file may have. 0 means no minimum.' },
        ],
      },
    ],
  };
}

export const runStepsProperties: INodeProperties[] = [
  {
    displayName: 'Steps (JSON)',
    name: 'steps',
    type: 'json',
    default: '',
    placeholder: STEPS_PLACEHOLDER,
    description:
      'A step document { name?, version?, startUrl?, steps: [...] } or a bare array of steps, as JSON text or an object. Map it from an item with an expression, for example {{ $json.steps }}. Empty means a first run, which needs AI Repair.',
    hint: 'Verbs and JSON shape: README → Run Steps reference',
    displayOptions: runSteps,
  },
  {
    displayName: 'Start URL',
    name: 'startUrl',
    type: 'string',
    default: '',
    placeholder: 'https://example.com/account',
    description:
      "The site this run may visit, and where it starts when the steps do not say. Required without a Site Login; with one, it must be one of the credential's Sites the Browser May Open.",
    displayOptions: runSteps,
  },
  {
    displayName: 'Require Signed Steps',
    name: 'requireSignedSteps',
    type: 'boolean',
    default: true,
    noDataExpression: true,
    description: 'Whether the steps must carry a valid Signature and Approved By from Sign Steps. Must be set directly, not with an expression.',
    displayOptions: runSteps,
  },
  {
    displayName: UNSIGNED_NOTICE,
    name: 'unsignedNotice',
    type: 'notice',
    default: '',
    displayOptions: { show: { operation: ['runSteps'], requireSignedSteps: [false] } },
  },
  {
    displayName: 'Signature',
    name: 'signature',
    type: 'string',
    default: '',
    description: 'The signature Sign Steps recorded, for example {{ $json.signature }}. A non-empty signature is always checked, even with Require Signed Steps off.',
    displayOptions: runSteps,
  },
  {
    displayName: 'Approved By',
    name: 'approvedBy',
    type: 'string',
    default: '',
    description: 'Who approved the steps, as Sign Steps recorded it, for example {{ $json.approvedBy }}',
    displayOptions: runSteps,
  },
  {
    displayName: 'AI Repair',
    name: 'aiRepair',
    type: 'boolean',
    default: false,
    description:
      'Whether a connected chat model repairs the run when the page no longer matches the steps. Repaired steps come out on the Repaired Steps output and never run until Sign Steps signs them.',
    displayOptions: runSteps,
  },
  {
    displayName: 'Goal',
    name: 'goal',
    type: 'string',
    typeOptions: { rows: 3 },
    default: '',
    placeholder: 'Read every invoice in the list. Invoice IDs look like INV-0417.',
    description: 'What the data is, in plain words. The chat model uses it when it repairs the steps or builds the first version.',
    displayOptions: { show: { operation: ['runSteps'], aiRepair: [true] } },
  },
  expectedFileProperty(
    { show: { operation: ['runSteps'], aiRepair: [true] } },
    'Used when AI repair builds the first version of steps that download a file. Steps that already exist carry their own checks on the download step (check).',
  ),
];
