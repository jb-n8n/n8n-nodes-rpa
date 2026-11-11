import type { ICredentialType, Icon, INodeProperties } from 'n8n-workflow';

export class PlaywrightScriptSigningApi implements ICredentialType {
  name = 'playwrightScriptSigningApi';

  displayName = 'RPA Step Signing';

  icon: Icon = { light: 'file:rpa.svg', dark: 'file:rpa.svg' };

  documentationUrl = 'https://github.com/jb-n8n/n8n-nodes-rpa#the-self-healing-data-feed';

  properties: INodeProperties[] = [
    {
      displayName:
        'Sign Steps signs Repaired steps with this key, and Run Steps refuses steps whose signature does not match it. Use 32 or more random characters, for example a password your password manager generates.',
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
      hint: 'Let your password manager generate a password of 32 or more characters, and paste it here',
      description: 'At least 32 characters. Share it only with the owners of the workflows that run and approve the steps.',
    },
  ];
}
