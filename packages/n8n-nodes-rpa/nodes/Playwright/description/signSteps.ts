import type { INodeProperties } from 'n8n-workflow';

const signSteps = { show: { operation: ['signSteps'] } };

export const SIGN_INPUT_NOTICE = 'Signs the incoming item, which must be a Repaired steps item from Run Steps or Import Steps. Nothing else can be signed.';

export const signStepsProperties: INodeProperties[] = [
  { displayName: SIGN_INPUT_NOTICE, name: 'signInputNotice', type: 'notice', default: '', displayOptions: signSteps },
  {
    displayName: 'Approved',
    name: 'approved',
    type: 'boolean',
    default: false,
    hint: 'Off records a rejection',
    description: 'Whether the approver accepted the repaired steps. Map it from the approval answer, for example {{ $json.data.approved }}.',
    displayOptions: signSteps,
  },
  {
    displayName: 'Approver',
    name: 'approverFrom',
    type: 'options',
    default: 'approvedBy',
    options: [
      { name: 'Approved By', value: 'approvedBy', description: 'The address in Approved By, or the one address on the allowlist when it is empty' },
      {
        name: 'Who Signed In to n8n on the Approval Form',
        value: 'formSignIn',
        description: 'The n8n user who submitted the form page named in Approval Form Page. Its form must use n8n User Auth.',
      },
    ],
    description: 'Where the approver comes from. Either way, the approver must be on the Approver Allowlist.',
    displayOptions: signSteps,
  },
  {
    displayName: 'Approval Form Page',
    name: 'approvalFormPage',
    type: 'string',
    default: 'Review and approve',
    noDataExpression: true,
    description:
      'With Approver set to who signed in to n8n: the name of the form page where the approver decides. The email of the n8n user who submitted that page is recorded as the approver. Must be set directly, not with an expression.',
    displayOptions: signSteps,
  },
  {
    displayName: 'Approved By',
    name: 'approverId',
    type: 'string',
    default: '',
    placeholder: 'ops-lead@example.com',
    description:
      'Who decided: an address on the Approver Allowlist. Leave it empty when the allowlist holds one address: that address is recorded. With more than one, it is required. Not used when Approver is who signed in to n8n.',
    displayOptions: signSteps,
  },
  {
    displayName: 'Approver Allowlist',
    name: 'approverAllowlist',
    type: 'string',
    default: '',
    required: true,
    noDataExpression: true,
    placeholder: 'ops-lead@example.com, owner@example.com',
    description: 'Comma-separated approvers who may approve or reject repaired steps. Must be set directly, not with an expression.',
    displayOptions: signSteps,
  },
  {
    displayName: 'Write Steps',
    name: 'writeSteps',
    type: 'string',
    default: '',
    placeholder: '7, 9',
    hint: 'Desktop steps only. Leave empty when no step saves, posts or submits.',
    description:
      'Desktop steps only: the numbers of the steps that save, post or submit, as the approver declared them (the change list numbers every step; the safety flags list the candidates). Listed steps are signed as writes, so the desktop runner lets them act on the write controls and gated keys of its policy. The runner refuses a write only on those: leaving a step unlisted does not stop it from saving unless its control is in the runner policy. Map it from the approval answer. Browser steps refuse a value here.',
    displayOptions: signSteps,
  },
  {
    // Shown with every other field: a field hidden by an expression's value would be dropped when n8n saves the node.
    displayName: 'Check Only',
    name: 'checkOnly',
    type: 'boolean',
    default: false,
    hint: 'On signs and records nothing',
    description:
      "Whether to only report what this node signs for: the name of its RPA Site Login, and whether the signature of an approved version on the input item (an active row of the steps table) verifies with this node's RPA Step Signing key and Site Login. RPA: 5 Import a bot does this before its review page.",
    displayOptions: signSteps,
  },
];
