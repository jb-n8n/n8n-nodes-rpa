import type { ICredentialType, Icon, INodeProperties } from 'n8n-workflow';

export class RpaDesktopRunnerApi implements ICredentialType {
  name = 'rpaDesktopRunnerApi';

  displayName = 'RPA Desktop Runner';

  icon: Icon = { light: 'file:rpa.svg', dark: 'file:rpa.svg' };

  documentationUrl = 'https://github.com/jb-n8n/n8n-nodes-rpa#desktop-runs';

  properties: INodeProperties[] = [
    {
      displayName:
        'The desktop runner runs on the Windows machine whose apps desktop steps drive. It prints its address and its certificate fingerprint when it starts. Run Steps uses this credential for desktop steps (surface "desktop") only.',
      name: 'about',
      type: 'notice',
      default: '',
    },
    {
      displayName: 'Runner URL',
      name: 'url',
      type: 'string',
      required: true,
      default: '',
      placeholder: 'wss://runner.example.com:8765',
      description: 'The wss:// address of the desktop runner; port 8765 when none is given. Plain ws:// is refused.',
    },
    {
      displayName: 'Token',
      name: 'token',
      type: 'string',
      typeOptions: { password: true },
      required: true,
      default: '',
      description: "The runner's token. It is sent as a Bearer header, and only after the runner's certificate matched the fingerprint below.",
    },
    {
      displayName: 'Certificate Fingerprint',
      name: 'fingerprint',
      type: 'string',
      required: true,
      default: '',
      placeholder: '3A:7F:…:C2 (64 hexadecimal digits)',
      description: "The SHA-256 fingerprint of the runner's certificate, as the runner prints it at start. A runner presenting any other certificate is refused before anything is sent.",
    },
  ];
}
