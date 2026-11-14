import type { INodeProperties } from 'n8n-workflow';
import { RUNS_ON_DEFAULT, RUNS_ON_DEFAULT_V2, RUNS_ON_NAMES, RUNS_ON_OPERATIONS, SHARE_ACROSS_WORKERS, type RunsOn } from '../config.js';

const runSteps = { show: { operation: ['runSteps'] } };
/** displayOptions keys for a field that differs between the node's versions (n8n reads @version from the node's typeVersion). */
export const VERSION_1 = { '@version': [1] };
export const VERSION_2_ON = { '@version': [{ _cnd: { gte: 2 } }] };

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

/**
 * Runs On (Run Steps and Import Steps): which credential slots the node shows, and on Run Steps A Windows desktop app
 * also hides Start URL, which only browser steps read. The default shows everything, so a node saved before this field
 * keeps every credential and value it holds. Typed, never an expression: n8n reads it to decide which credentials to keep.
 * It only ever hides (n8n drops a hidden field's value), and only what a desktop run never reads.
 */
export const RUNS_ON_PROPERTY: INodeProperties = {
  displayName: 'Runs On',
  name: 'runsOn',
  type: 'options',
  noDataExpression: true,
  default: RUNS_ON_DEFAULT,
  options: (['browserAndDesktop', 'browser', 'desktop'] as RunsOn[]).map((value) => ({ name: RUNS_ON_NAMES[value], value })),
  description: 'This only chooses which credentials and fields the node asks for, and the steps themselves decide where they run',
  hint: 'Choosing A browser or A Windows desktop app removes a credential whose slot it hides',
  displayOptions: { show: { operation: [...RUNS_ON_OPERATIONS], ...VERSION_1 } },
};

/** Runs On in version 2: the same field, starting at A browser, so a new node shows the browser's slots only. */
export const RUNS_ON_PROPERTY_V2: INodeProperties = {
  ...RUNS_ON_PROPERTY,
  default: RUNS_ON_DEFAULT_V2,
  displayOptions: { show: { operation: [...RUNS_ON_OPERATIONS], ...VERSION_2_ON } },
};

/**
 * Version 2 only (Run Steps and Import Steps): whether the RPA Redis slot shows. Typed, never an expression: n8n reads it
 * to decide which credentials to keep. Off (the default) the node runs as a version 1 node without RPA Redis
 * (guard-store.ts redisAttached). A Windows desktop app hides it, as it hides RPA Redis.
 */
export const SHARE_ACROSS_WORKERS_PROPERTY: INodeProperties = {
  displayName: 'Share Login Breaker Across Workers (RPA Redis)',
  name: SHARE_ACROSS_WORKERS,
  type: 'boolean',
  default: false,
  noDataExpression: true,
  description:
    'Whether the login breaker and the run lock are kept in Redis, so that every n8n worker shares them. Turn it on when n8n runs in queue mode and the node has a Site Login, then attach an RPA Redis credential.',
  displayOptions: { show: { operation: [...RUNS_ON_OPERATIONS], ...VERSION_2_ON }, hide: { runsOn: ['desktop'] } },
};

/**
 * The same switch in version 1: never shown, always on, so a version 1 node shows and keeps RPA Redis as it always did.
 * Without it n8n would read version 2's default (off) when it works out which credentials a version 1 node keeps
 * (getActiveCredentialTypes fills in the defaults of fields that are not shown, except for a name used twice).
 */
export const SHARE_ACROSS_WORKERS_V1_PROPERTY: INodeProperties = {
  displayName: SHARE_ACROSS_WORKERS_PROPERTY.displayName,
  name: SHARE_ACROSS_WORKERS,
  type: 'hidden',
  default: true,
  displayOptions: { show: { operation: [...RUNS_ON_OPERATIONS], ...VERSION_1 } },
};

/**
 * Signature and Approved By, as each version shows them: on the Parameters tab in version 1, on the node's Settings tab in
 * version 2 (isNodeSetting). Names and stored values are the same in both: n8n keeps a Settings tab field in the node's
 * parameters, and the run reads it as before.
 */
function signedFields(): INodeProperties[] {
  const fields: INodeProperties[] = [
    {
      displayName: 'Signature',
      name: 'signature',
      type: 'string',
      default: '',
      description: 'The signature Sign Steps recorded, for example {{ $json.signature }}. A non-empty signature is always checked, even with Require Signed Steps off.',
    },
    {
      displayName: 'Approved By',
      name: 'approvedBy',
      type: 'string',
      default: '',
      description: 'Who approved the steps, as Sign Steps recorded it, for example {{ $json.approvedBy }}',
    },
  ];
  return [
    ...fields.map((f) => ({ ...f, displayOptions: { show: { ...runSteps.show, ...VERSION_1 } } })),
    ...fields.map((f) => ({ ...f, isNodeSetting: true, displayOptions: { show: { ...runSteps.show, ...VERSION_2_ON } } })),
  ];
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
    hint: 'Verbs and JSON shape: docs/reference/steps.md in the repository',
    displayOptions: runSteps,
  },
  {
    displayName: 'Start URL',
    name: 'startUrl',
    type: 'string',
    default: '',
    placeholder: 'https://example.com/account',
    description:
      "Browser steps only: where the run starts when the steps do not say, and the site it may visit. Required without a Site Login; with one, it must be one of the credential's Sites the Browser May Open.",
    // A desktop run never reads it (runDesktopSteps.ts), so hiding it, and n8n dropping its value, changes no run.
    displayOptions: { ...runSteps, hide: { runsOn: ['desktop'] } },
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
  ...signedFields(),
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
