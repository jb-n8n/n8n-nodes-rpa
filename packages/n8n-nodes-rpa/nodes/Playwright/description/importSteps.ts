import type { INodeProperties } from 'n8n-workflow';
import { expectedFileProperty } from './runSteps.js';

const importSteps = { show: { operation: ['importSteps'] } };
// What does nothing for an RPA recording: its desktop steps are not replayed, so there is no site, no repair and no rows.
const importStepsNotRecording = { show: { operation: ['importSteps'] }, hide: { source: ['recording'] } };

export const IMPORT_NOTICE =
  'Imported steps make no form submissions or writes; Requests That Only Read still pass. Each step list runs once and is replayed in a fresh browser, so allow about twice Options → Max Seconds per step list. On sites with an authenticator code, the import needs either the TOTP Secret in the Site Login or Options → One-Time Code Workflow, and Max Seconds must leave room for up to a 30 s wait. What passes comes out on Repaired Steps for approval and Sign Steps. Desktop steps (from a UiPath project, a step document or an RPA recording) are not replayed: they go to approval as written.';

/** Import Steps: the source, how it arrives, the steps' name and what adoption needs to prove them. */
export const importStepsProperties: INodeProperties[] = [
  { displayName: IMPORT_NOTICE, name: 'importNotice', type: 'notice', default: '', displayOptions: importSteps },
  {
    displayName: 'Source',
    name: 'source',
    type: 'options',
    default: 'chrome',
    options: [
      { name: 'Chrome Recorder (JSON)', value: 'chrome', description: 'A recording exported from the Recorder panel of Chrome DevTools as JSON' },
      { name: 'Playwright Code (JavaScript or TypeScript)', value: 'playwright', description: 'Code from the codegen recorder, for JavaScript or TypeScript' },
      { name: 'UiPath Project (ZIP or XAML)', value: 'uipath', description: 'A UiPath project folder as a .zip, or one .xaml workflow' },
      {
        name: 'Step Document (JSON)',
        value: 'steps',
        description:
          'Steps you wrote, as Run Steps takes them: a browser step document or a desktop step set. This is how hand-written steps get approved and signed. Browser steps that submit a form, download through a form, type a secret or change a password are not run: they go to approval marked not replayed.',
      },
      {
        name: 'RPA Recording',
        value: 'recording',
        description:
          'A .rpa-recording.json file the RPA recorder saved on the Windows machine. Its desktop steps are not replayed: they go to approval as recorded.',
      },
    ],
    description: 'What the file holds',
    displayOptions: importSteps,
  },
  {
    displayName: 'Input From',
    name: 'inputFrom',
    type: 'options',
    default: 'binary',
    options: [
      { name: 'Binary File', value: 'binary', description: 'A file on the input item, for example from a Form Trigger upload' },
      { name: 'Text', value: 'text', description: 'The recording, code or step document pasted as text' },
    ],
    description: 'Where the recording, code or step document comes from',
    // A UiPath project and an RPA recording are always a file.
    displayOptions: { show: { operation: ['importSteps'] }, hide: { source: ['uipath', 'recording'] } },
  },
  {
    displayName: 'Input Binary Field',
    name: 'binaryPropertyName',
    type: 'string',
    default: 'data',
    hint: 'The name of the input binary field containing the file. At most 20 MiB.',
    description: 'The binary field of the input item that holds the file',
    displayOptions: { show: { operation: ['importSteps'] }, hide: { inputFrom: ['text'] } },
  },
  {
    displayName: 'Recording or Code',
    name: 'sourceText',
    type: 'string',
    typeOptions: { rows: 10 },
    default: '',
    description: 'The recording, code or step document as text: Chrome Recorder JSON, JavaScript or TypeScript code, or a step document as JSON',
    displayOptions: { show: { operation: ['importSteps'], inputFrom: ['text'] }, hide: { source: ['uipath', 'recording'] } },
  },
  {
    displayName: 'Name',
    name: 'stepsName',
    type: 'string',
    default: '',
    required: true,
    placeholder: 'line-item-export',
    description:
      'Names the imported steps. A UiPath project with several browser sequences gives one step list per sequence, named <name>-1, <name>-2 and so on. An RPA recording gives one desktop step list, named <name>-1.',
    displayOptions: importSteps,
  },
  {
    displayName: 'Start URL',
    name: 'startUrl',
    type: 'string',
    default: '',
    placeholder: 'https://example.com/account',
    description:
      "The site the imported steps may visit, and where they start. Leave empty to use the first page the recording opens. With a Site Login, it must be one of the credential's Sites the Browser May Open.",
    displayOptions: importStepsNotRecording,
  },
  {
    displayName: 'AI Repair',
    name: 'aiRepair',
    type: 'boolean',
    default: true,
    description:
      'Whether a connected chat model repairs the imported steps when the page no longer matches the recording. Without a model, or with this off, steps that no longer match fail with the step that drifted.',
    displayOptions: importStepsNotRecording,
  },
  {
    displayName: 'Goal',
    name: 'goal',
    type: 'string',
    typeOptions: { rows: 3 },
    default: '',
    placeholder: 'Download the line items of last month as CSV',
    description: 'What the steps are for, in plain words. The chat model uses it only when it repairs them. Empty means: do what the imported steps do.',
    displayOptions: { show: { operation: ['importSteps'], aiRepair: [true] }, hide: { source: ['recording'] } },
  },
  {
    displayName: 'ID Pattern (Regex)',
    name: 'idPattern',
    type: 'string',
    default: '',
    placeholder: 'INV-\\d{4}',
    description:
      'A regular expression that matches the ID every record has, such as INV-\\d{4} for INV-0417. Required when the imported steps read rows: the replay checks the rows by it. Leave empty for steps that download a file.',
    hint: 'Not sure? Paste one real ID into regex101.com and describe its shape: digits \\d, letters [A-Z], repeats {4}.',
    displayOptions: importStepsNotRecording,
  },
  expectedFileProperty(
    // A step document's download steps carry their own checks; a recording's Save dialog gives its expectFile step.
    { show: { operation: ['importSteps'] }, hide: { source: ['steps', 'recording'] } },
    'Set it when the steps download a file: the click that exports becomes a download step with these checks, and the replay must download a file that passes them.',
  ),
];
