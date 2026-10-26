import type { ICredentialType, Icon, INodeProperties } from 'n8n-workflow';

export class PlaywrightRedisApi implements ICredentialType {
  name = 'playwrightRedisApi';

  displayName = 'RPA Redis';

  icon: Icon = { light: 'file:rpa.svg', dark: 'file:rpa.svg' };

  documentationUrl = 'https://docs.n8n.io/integrations/community-nodes/';

  properties: INodeProperties[] = [
    {
      displayName: 'Host',
      name: 'host',
      type: 'string',
      default: 'localhost',
      description: 'The Redis server. In queue mode, the Redis that n8n queues jobs in works.',
    },
    { displayName: 'Port', name: 'port', type: 'number', default: 6379, description: 'The Redis port' },
    { displayName: 'Database Number', name: 'database', type: 'number', default: 0, description: 'The Redis database to keep the breaker and lock in' },
    { displayName: 'User', name: 'user', type: 'string', default: '', description: 'Leave empty when Redis has no user (ACL) set up' },
    {
      displayName: 'Password',
      name: 'password',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      description: 'Leave empty when Redis has no password',
    },
    { displayName: 'SSL', name: 'ssl', type: 'boolean', default: false, description: 'Whether to connect over TLS' },
    {
      displayName: 'Disable TLS Verification',
      name: 'disableTlsVerification',
      type: 'boolean',
      default: false,
      description: 'Whether to accept a certificate that cannot be verified (self-signed). Turn on only for a Redis you control.',
      displayOptions: { show: { ssl: [true] } },
    },
  ];
}
