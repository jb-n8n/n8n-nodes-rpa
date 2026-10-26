import type { ICredentialType, Icon, INodeProperties } from 'n8n-workflow';

export class PlaywrightBrowserApi implements ICredentialType {
  name = 'playwrightBrowserApi';

  displayName = 'RPA Browser';

  icon: Icon = { light: 'file:rpa.svg', dark: 'file:rpa.svg' };

  documentationUrl = 'https://docs.n8n.io/integrations/community-nodes/';

  properties: INodeProperties[] = [
    {
      displayName:
        'Where the Chromium browser runs. This package does not ship a browser: connect to a browser server (the compose stack runs one at ws://browser:3000/), a Chrome DevTools Protocol endpoint, or, for development, a Chromium installed next to n8n.',
      name: 'notice',
      type: 'notice',
      default: '',
    },
    {
      displayName: 'Mode',
      name: 'mode',
      type: 'options',
      default: 'playwright',
      options: [
        { name: 'Browser Server', value: 'playwright', description: 'A browser server container, or a hosted browser endpoint that speaks the Playwright protocol, such as Browserless' },
        { name: 'Chrome DevTools Protocol (CDP)', value: 'cdp', description: 'Browser vendors that only speak CDP; downloads are refused' },
        { name: 'Local Browser (Development Only)', value: 'local', description: "A Chromium installed next to n8n; it runs with n8n's network access and files" },
      ],
    },
    {
      displayName:
        'Start the reference server with: docker compose up -d browser (README: Where the browser runs). On the compose network it listens on ws://browser:3000/: turn on Private Network Endpoint and set the Token from BROWSER_TOKEN in .env.',
      name: 'playwrightNotice',
      type: 'notice',
      default: '',
      displayOptions: { show: { mode: ['playwright'] } },
    },
    {
      displayName: 'Use the wss:// (or https://) address your browser vendor gives you, and put its access key in Token.',
      name: 'cdpNotice',
      type: 'notice',
      default: '',
      displayOptions: { show: { mode: ['cdp'] } },
    },
    {
      displayName: "Install Chromium next to n8n: npx playwright install chromium. Development only: the browser runs with n8n's network access and files.",
      name: 'localNotice',
      type: 'notice',
      default: '',
      displayOptions: { show: { mode: ['local'] } },
    },
    {
      displayName: 'Endpoint URL',
      name: 'wsUrl',
      type: 'string',
      default: 'ws://browser:3000/',
      placeholder: 'wss://browser.example.com/',
      description:
        'The WebSocket address of the browser. Use wss:// (https:// for CDP), except for localhost, or for a private-network host with Private Network Endpoint on and a Token.',
      displayOptions: { show: { mode: ['playwright', 'cdp'] } },
    },
    {
      displayName: 'Token',
      name: 'token',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      hint: 'Never put the token in the URL',
      description: 'Sent as a Bearer header and removed from every message',
      displayOptions: { show: { mode: ['playwright', 'cdp'] } },
    },
    {
      displayName: 'Private Network Endpoint',
      name: 'privateNetwork',
      type: 'boolean',
      default: false,
      description: 'Whether the endpoint is on a private network, such as the compose network. Plain ws:// to a private address is allowed only with this on and a Token.',
      displayOptions: { show: { mode: ['playwright', 'cdp'] } },
    },
    {
      displayName: 'Headless',
      name: 'headless',
      type: 'boolean',
      default: true,
      description: 'Whether the local browser runs without a window',
      displayOptions: { show: { mode: ['local'] } },
    },
    {
      displayName: 'Slow Motion (ms)',
      name: 'slowMo',
      type: 'number',
      default: 0,
      typeOptions: { minValue: 0, maxValue: 2000 },
      description: 'Waits this long before each browser action, so a run can be followed in a live view or a demo. Keep 0 in production: it slows every run.',
    },
  ];
}
