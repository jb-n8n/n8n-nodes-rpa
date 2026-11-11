import type { ICredentialType, Icon, INodeProperties } from 'n8n-workflow';

export class RpaDesktopRunnerApi implements ICredentialType {
  name = 'rpaDesktopRunnerApi';

  displayName = 'RPA Desktop Runner';

  icon: Icon = { light: 'file:rpa.svg', dark: 'file:rpa.svg' };

  documentationUrl = 'https://github.com/jb-n8n/n8n-nodes-rpa/blob/main/docs/install/windows.md#6-connect-n8n';

  properties: INodeProperties[] = [
    {
      displayName:
        'The desktop runner runs on the Windows machine whose apps desktop steps drive. Paste the Connection Line the installer prints for the runner when it finishes; on that machine, as an administrator, & "C:\\Program Files\\RPA Runner\\rpa.cmd" connection -ShowTokens prints it again, and the three values below for a credential that uses them (Windows guide, section 6). Run Steps uses this credential for desktop steps (surface "desktop") only.',
      name: 'about',
      type: 'notice',
      default: '',
    },
    // The line holds the token (the rule reads only the field's name).
    // eslint-disable-next-line @n8n/community-nodes/credential-unnecessary-password
    {
      displayName: 'Connection Line',
      name: 'connectionLine',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      noDataExpression: true,
      placeholder: 'rpa-runner://<address>:8765/rpa/v1#token=…&fingerprint=…',
      description:
        'The one line the Windows installer prints for the runner. It holds the address, the token and the certificate fingerprint: keep it as secret as the token. When it is filled, the three fields below are not used.',
    },
    {
      displayName: 'Runner URL',
      name: 'url',
      type: 'string',
      default: '',
      placeholder: 'wss://runner.example.com:8765',
      description: 'Without a Connection Line: the wss:// address of the desktop runner; port 8765 when none is given. Plain ws:// is refused.',
    },
    {
      displayName: 'Token',
      name: 'token',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      description: "The runner's token. It is sent as a Bearer header, and only after the runner's certificate matched the fingerprint below.",
    },
    {
      displayName: 'Certificate Fingerprint',
      name: 'fingerprint',
      type: 'string',
      default: '',
      placeholder: '3A:7F:…:C2 (64 hexadecimal digits)',
      description: "The SHA-256 fingerprint of the runner's certificate, as rpa connection prints it (the Runner fingerprint line). A runner presenting any other certificate is refused before anything is sent.",
    },
  ];
}
