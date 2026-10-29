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
    displayName: 'Approved By',
    name: 'approverId',
    type: 'string',
    default: '',
    required: true,
    placeholder: 'ops-lead@example.com',
    description: 'Who decided. Use the address the approval request was sent to.',
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
];
