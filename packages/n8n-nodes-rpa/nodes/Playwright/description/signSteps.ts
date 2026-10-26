import type { INodeProperties } from 'n8n-workflow';

const signSteps = { show: { operation: ['signSteps'] } };

export const SIGN_INPUT_NOTICE = 'Signs the incoming item, which must be a Repaired steps item from Run Steps. Nothing else can be signed.';

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
];
