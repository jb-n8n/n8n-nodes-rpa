import type { ICredentialType, Icon, INodeProperties } from 'n8n-workflow';

export class PlaywrightScriptSigningApi implements ICredentialType {
  name = 'playwrightScriptSigningApi';

  displayName = 'RPA Step Signing';

  icon: Icon = { light: 'file:rpa.svg', dark: 'file:rpa.svg' };

  documentationUrl = 'https://docs.n8n.io/integrations/community-nodes/';

  properties: INodeProperties[] = [
    {
      displayName:
        'Sign Steps signs Repaired steps with this key, and Run Steps refuses steps whose signature does not match it. Use 32+ random characters, e.g. the output of `openssl rand -hex 32`.',
      name: 'notice',
      type: 'notice',
      default: '',
    },
    {
      displayName: 'Signing Key',
      name: 'secretKey',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      required: true,
      hint: 'Generate one: openssl rand -hex 32',
      description: 'At least 32 characters. Share it only with the owners of the workflows that run and approve the steps.',
    },
  ];
}
