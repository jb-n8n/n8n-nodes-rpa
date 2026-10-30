import type { INodeProperties } from 'n8n-workflow';
import { DEFAULT_FILE_TYPES, FILE_TYPES } from './download.js';
import { locatorProperty } from './locator.js';

/** Quick operations, in menu order. */
export const QUICK_OPERATIONS: string[] = [
  'screenshot',
  'getPage',
  'pdf',
  'extract',
  'fillForm',
  'download',
];
/** Every operation that opens a browser: all but Sign Steps ("all browser ops"), Import Steps included. */
export const BROWSER_OPERATIONS: string[] = [...QUICK_OPERATIONS, 'runSteps', 'importSteps'];
/** Every operation ("all operations": Max Items). */
export const ALL_OPERATIONS: string[] = [...BROWSER_OPERATIONS, 'signSteps'];

/** Options only quick operations have. */
export const QUICK_OPTIONS: INodeProperties[] = [
  {
    displayName: 'Wait Until',
    name: 'waitUntil',
    type: 'options',
    default: 'load',
    options: [
      { name: 'Load', value: 'load', description: 'The page, its styles and images have loaded' },
      { name: 'DOM Content Loaded', value: 'domcontentloaded', description: 'The HTML is parsed; images may still be loading' },
      { name: 'Network Idle', value: 'networkidle', description: 'No network requests for 500 ms. Can hang on pages that poll.' },
    ],
    description: 'When the page counts as opened',
    displayOptions: { show: { '/operation': QUICK_OPERATIONS } },
  },
  locatorProperty({
    name: 'waitFor',
    displayName: 'Wait for Element',
    description: 'An element to wait for (visible) before acting',
    show: { '/operation': QUICK_OPERATIONS },
  }),
  {
    displayName: 'Put Output in Field',
    name: 'screenshotProperty',
    type: 'string',
    default: 'screenshot',
    description: 'Name of the binary field that receives the PNG',
    displayOptions: { show: { '/operation': ['screenshot'] } },
  },
  {
    displayName: 'Print Background',
    name: 'printBackground',
    type: 'boolean',
    default: false,
    description: 'Whether to print background colours and images',
    displayOptions: { show: { '/operation': ['pdf'] } },
  },
  {
    displayName: 'Put Output in Field',
    name: 'pdfProperty',
    type: 'string',
    default: 'pdf',
    description: 'Name of the binary field that receives the PDF',
    displayOptions: { show: { '/operation': ['pdf'] } },
  },
  {
    displayName: 'Output',
    name: 'outputMode',
    type: 'options',
    default: 'rowPerItem',
    options: [
      { name: 'One Item per Row', value: 'rowPerItem', description: 'Each row becomes its own item, with the page facts under _meta' },
      { name: 'All Rows in One Item', value: 'allInOne', description: 'One item with a rows list, rowCount and confirmed' },
    ],
    description: 'How the rows come out of the node',
    displayOptions: { show: { '/operation': ['extract'] } },
  },
  locatorProperty({
    name: 'nextPage',
    displayName: 'Next Page',
    description: 'The link or button that opens the next page of results. Leave empty to read the first page only.',
    show: { '/operation': ['extract'] },
  }),
  {
    displayName: 'Max Pages',
    name: 'maxPages',
    type: 'number',
    default: 10,
    typeOptions: { minValue: 1, maxValue: 100 },
    description: 'The most pages to read when Next Page is set. If a next page is still there after this many, the run fails as incomplete.',
    displayOptions: { show: { '/operation': ['extract'] } },
  },
  {
    displayName: 'Allowed File Types',
    name: 'allowedFileTypes',
    type: 'multiOptions',
    default: DEFAULT_FILE_TYPES,
    options: FILE_TYPES.map((t) => ({ name: t.name, value: t.value })),
    description: 'The file types the download may be, checked by the file contents. Files are never unpacked: a ZIP stays one file.',
    displayOptions: { show: { '/operation': ['download'] } },
  },
  {
    displayName: 'Max File Size',
    name: 'maxFileSizeMb',
    type: 'number',
    default: 50,
    typeOptions: { minValue: 0.01, maxValue: 200, numberPrecision: 2 },
    description: 'In MB (1 MB = 1,048,576 bytes), at most 200. A larger file fails the run as incomplete.',
    displayOptions: { show: { '/operation': ['download'] } },
  },
  {
    displayName: 'Put Output in Field',
    name: 'fileProperty',
    type: 'string',
    default: 'file',
    description: 'Name of the binary field that receives the downloaded file',
    displayOptions: { show: { '/operation': ['download'] } },
  },
];

const only = (operations: string[]) => ({ show: { '/operation': operations } });
const withAiRepair = { show: { '/operation': ['runSteps'], '/aiRepair': [true] } };
const LITERAL = 'Must be set directly, not with an expression.';

/** The ID Pattern description text. */
export const ID_PATTERN_OPTION: INodeProperties = {
  displayName: 'ID Pattern (Regex)',
  name: 'idPattern',
  type: 'string',
  default: '',
  placeholder: 'INV-\\d{4}',
  description:
    'Optional. A regular expression that matches the ID every record has, such as INV-\\d{4} for INV-0417. When set, the node keeps only rows whose ID matches, and removes duplicates by ID. To check the count against a total the page states, set Stated Total Pattern. Leave empty to return everything found. Required for AI repair.',
  hint: 'Not sure? Paste one real ID into regex101.com and describe its shape: digits \\d, letters [A-Z], repeats {4}.',
  displayOptions: only(['extract', 'runSteps']),
};

/** The Options entries in display order. Each entry lists the operations it applies to. */
export const OPTION_ENTRIES: INodeProperties[] = [
  ...QUICK_OPTIONS,
  {
    displayName: 'Timeout (Seconds)',
    name: 'timeout',
    type: 'number',
    default: 30,
    typeOptions: { minValue: 1, maxValue: 300 },
    description: 'How long each step may wait for its page or element',
    displayOptions: only(BROWSER_OPERATIONS),
  },
  {
    displayName: 'Max Seconds',
    name: 'maxSeconds',
    type: 'number',
    default: 180,
    typeOptions: { minValue: 10, maxValue: 300 },
    description: 'One deadline for the whole run, AI repair and proof included',
    displayOptions: only(BROWSER_OPERATIONS.filter((op) => op !== 'importSteps')),
  },
  // The same option for Import Steps, with its own help (n8n shows the entry whose displayOptions match).
  {
    displayName: 'Max Seconds',
    name: 'maxSeconds',
    type: 'number',
    default: 180,
    typeOptions: { minValue: 10, maxValue: 300 },
    description:
      'One deadline for each run, AI repair and proof included. Each imported step list runs once and is then replayed in a fresh browser, so it can take about twice this. On sites with an authenticator code, Max Seconds must leave room for up to a 30 s wait.',
    displayOptions: only(['importSteps']),
  },
  {
    displayName: 'Viewport',
    name: 'viewport',
    type: 'fixedCollection',
    default: { size: { width: 1280, height: 800 } },
    description: 'Browser window size in pixels',
    options: [
      {
        name: 'size',
        displayName: 'Size',
        values: [
          { displayName: 'Width', name: 'width', type: 'number', default: 1280, typeOptions: { minValue: 320, maxValue: 3840 } },
          { displayName: 'Height', name: 'height', type: 'number', default: 800, typeOptions: { minValue: 240, maxValue: 2160 } },
        ],
      },
    ],
    displayOptions: only(BROWSER_OPERATIONS),
  },
  {
    displayName: 'Also Allow These Sites',
    name: 'allowedHosts',
    type: 'string',
    default: '',
    placeholder: 'cdn.example.com, images.example.com',
    description:
      'Extra sites the browser may open or load files from, separated by commas. Exact hosts only, no wildcards. Leave empty when a Site Login is attached: the credential sets the allowed sites.',
    displayOptions: only(BROWSER_OPERATIONS),
  },
  {
    displayName: 'Allow Private Network',
    name: 'allowPrivateNetwork',
    type: 'boolean',
    default: false,
    noDataExpression: true,
    description: `Whether the allowed sites may be on a private network address, such as 10.x, 192.168.x or localhost. ${LITERAL}`,
    displayOptions: only(BROWSER_OPERATIONS),
  },
  ID_PATTERN_OPTION,
  {
    displayName: 'Stated Total Pattern (Regex)',
    name: 'totalPattern',
    type: 'string',
    default: '',
    placeholder: '(\\d+) results',
    description: 'A regular expression whose first group is the total the page states, such as (\\d+) results. The row count must equal it; confirmed is true only then.',
    displayOptions: only(['extract', 'runSteps']),
  },
  {
    displayName: 'Required Fields',
    name: 'requiredFields',
    type: 'string',
    default: '',
    placeholder: 'title, date',
    description: 'Comma-separated row fields that must not be empty. A row missing one fails the run.',
    displayOptions: { show: { '/operation': ['extract', 'runSteps'] }, hide: { '/shape': ['table'] } },
  },
  {
    displayName: 'Text That Means No Results (Regex)',
    name: 'emptyPattern',
    type: 'string',
    default: '',
    placeholder: 'No results found',
    description: 'Lets a run with no rows succeed, but only when the page shows text matching this (case-insensitive). Leave empty to treat zero rows as a failure.',
    displayOptions: only(['extract', 'runSteps']),
  },
  {
    displayName: 'Variables',
    name: 'variables',
    type: 'fixedCollection',
    typeOptions: { multipleValues: true },
    default: {},
    placeholder: 'Add Variable',
    description: 'Values the steps may type into fields, used as {{var.name}} inside the steps (never secrets)',
    hint: 'Not n8n expressions; {{var.name}} is replaced inside steps.',
    options: [
      {
        name: 'values',
        displayName: 'Variable',
        values: [
          { displayName: 'Name', name: 'name', type: 'string', default: '', placeholder: 'from' },
          { displayName: 'Value', name: 'value', type: 'string', default: '' },
        ],
      },
    ],
    displayOptions: only(['runSteps', 'importSteps']),
  },
  {
    displayName: 'Name',
    name: 'name',
    type: 'string',
    default: '',
    placeholder: 'invoices-example',
    description: 'Names the step list. Required for a first run (empty steps with AI Repair on). With signed steps, it must equal the signed name.',
    displayOptions: only(['runSteps']),
  },
  {
    displayName: 'Expected Version',
    name: 'expectedVersion',
    type: 'string',
    default: '',
    placeholder: '3',
    description: 'With signed steps, the signed version must equal this whole number. Map it from the newest active row, so an edited version column fails.',
    displayOptions: only(['runSteps']),
  },
  {
    displayName: 'Allow Unsigned Writes',
    name: 'allowUnsignedWrites',
    type: 'boolean',
    default: false,
    noDataExpression: true,
    description: `Whether unsigned steps may sign in, submit a form or download through a form. ${LITERAL}`,
    displayOptions: only(['runSteps']),
  },
  {
    displayName: 'Deliver Unconfirmed Rows',
    name: 'deliverUnconfirmed',
    type: 'boolean',
    default: false,
    noDataExpression: true,
    description: `Whether rows read during AI repair go to Data even when the proof in a fresh browser did not pass. ${LITERAL}`,
    displayOptions: withAiRepair,
  },
  {
    displayName: 'Max Agent Actions',
    name: 'maxActions',
    type: 'number',
    default: 40,
    typeOptions: { minValue: 1, maxValue: 200 },
    description: 'Most browser actions the chat model may take while repairing',
    displayOptions: withAiRepair,
  },
  {
    displayName: 'Max LLM Tokens',
    name: 'maxTokens',
    type: 'number',
    default: 200000,
    typeOptions: { minValue: 1000, maxValue: 1000000 },
    description: 'Most chat model tokens one run may use',
    displayOptions: withAiRepair,
  },
  {
    displayName: 'One-Time Code Workflow',
    name: 'codeWorkflowId',
    type: 'string',
    default: '',
    placeholder: 'e.g. 4nQkZp2r8XyT1bLm',
    description:
      'ID of the workflow that supplies the sign-in code when the steps\' sign-in takes its code from a workflow ("source": "workflow"). It starts with an Execute Workflow Trigger, receives requestedAt and must return exactly one item with a code field of 6 to 10 digits.',
    displayOptions: only(['runSteps']),
  },
  {
    displayName: 'Code Timeout (Seconds)',
    name: 'codeTimeout',
    type: 'number',
    default: 120,
    typeOptions: { minValue: 1, maxValue: 300 },
    description: 'How long the sign-in waits for the One-Time Code Workflow. Max Seconds still bounds the whole run.',
    displayOptions: only(['runSteps']),
  },
  {
    displayName: 'Login Breaker Reset Key',
    name: 'breakerResetKey',
    type: 'string',
    default: '',
    noDataExpression: true,
    description:
      "Only used with a Site Login. A failed login stops all further logins with that credential. After fixing the account, change this value (for example to today's date) to allow the next login. Type the value, not an expression: it is the same for every item, and a login that fails stays blocked for the rest of the execution.",
    displayOptions: only(['runSteps', 'importSteps']),
  },
  {
    displayName: 'Debug Trace',
    name: 'saveTrace',
    type: 'options',
    default: 'onFailure',
    options: [
      { name: 'On Failure', value: 'onFailure' },
      { name: 'Always', value: 'always' },
      { name: 'Never', value: 'never' },
    ],
    description: 'When to attach a scrubbed browser trace as binary "trace"',
    displayOptions: only(BROWSER_OPERATIONS),
  },
  {
    displayName: 'Max Items',
    name: 'maxItems',
    type: 'number',
    default: 100,
    typeOptions: { minValue: 1 },
    description: 'More input items than this fail the execution before any run',
    displayOptions: only(ALL_OPERATIONS),
  },
];

export const optionsProperty: INodeProperties = {
  displayName: 'Options',
  name: 'options',
  type: 'collection',
  placeholder: 'Add Option',
  default: {},
  options: OPTION_ENTRIES,
  displayOptions: { show: { operation: ALL_OPERATIONS } },
};
