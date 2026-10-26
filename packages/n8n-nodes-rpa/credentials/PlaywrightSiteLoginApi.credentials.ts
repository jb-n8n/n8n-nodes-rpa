import type { ICredentialType, Icon, INodeProperties } from 'n8n-workflow';

export class PlaywrightSiteLoginApi implements ICredentialType {
  name = 'playwrightSiteLoginApi';

  displayName = 'RPA Site Login';

  icon: Icon = { light: 'file:rpa.svg', dark: 'file:rpa.svg' };

  documentationUrl = 'https://docs.n8n.io/integrations/community-nodes/';

  properties: INodeProperties[] = [
    {
      displayName:
        'What the browser signs in with, and the only sites it may open, load files from or post to. Anything outside these lists is blocked and the run fails as policy_violation. Used by Run Steps and Sign Steps only.',
      name: 'notice',
      type: 'notice',
      default: '',
    },
    {
      displayName: 'Login Page URL',
      name: 'loginUrl',
      type: 'string',
      default: '',
      required: true,
      placeholder: 'https://example.com/login',
      description: 'Where every run with this credential starts. Its site is always allowed.',
    },
    { displayName: 'Username', name: 'username', type: 'string', default: '', required: true, description: 'The account the browser signs in as' },
    {
      displayName: 'Password',
      name: 'password',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      required: true,
      description: 'Typed only on the Pages Where the Password May Be Typed; never shown to the chat model',
    },
    {
      displayName: 'TOTP Secret',
      name: 'totpSecret',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      description: 'Base32 seed of the authenticator app, if the site asks for one-time codes. It never enters the browser.',
    },
    {
      displayName: 'Sites the Browser May Open',
      name: 'navHosts',
      type: 'string',
      typeOptions: { rows: 3 },
      default: '',
      placeholder: 'example.com',
      description: "Exact hosts, one per line. Empty means the login page's site only. Add every host the site redirects to.",
    },
    {
      displayName: 'Sites It May Load Files From',
      name: 'subresourceHosts',
      type: 'string',
      typeOptions: { rows: 3 },
      default: '',
      placeholder: 'cdn.example.com',
      description: 'Hosts the site loads scripts, styles or images from, one per line. Empty means only the sites above.',
    },
    {
      displayName: 'Sites Allowed in Embedded Frames',
      name: 'frameHosts',
      type: 'string',
      typeOptions: { rows: 2 },
      default: '',
      placeholder: 'www.recaptcha.net',
      description: 'Hosts embedded frames (for example a CAPTCHA widget) may load, one per line. Never opened as pages.',
    },
    {
      displayName: 'Pages Where the Password May Be Typed',
      name: 'login',
      type: 'string',
      typeOptions: { rows: 2 },
      default: '',
      placeholder: 'example.com/login',
      description: 'As host/path, one per line. Empty means the login page.',
    },
    {
      displayName: 'Forms It May Submit',
      name: 'allowedSubmits',
      type: 'string',
      typeOptions: { rows: 2 },
      default: '',
      placeholder: 'POST example.com/reports/export',
      description: 'Form submissions the steps may make, as METHOD host/path, one per line. Everything else stays read-only.',
    },
    {
      displayName: 'Requests That Only Read',
      name: 'readPosts',
      type: 'string',
      typeOptions: { rows: 2 },
      default: '',
      placeholder: 'POST example.com/sap/opu/odata/sap/ZLINEITEMS_SRV/$batch',
      description:
        'POST requests the site makes to read data (some sites, such as SAP, post on every screen), as POST host/path, one per line. * matches letters, digits and _ . ( ) = ~ - (and %3D) within one part of the path, never / ; or another % code, so write the rest exactly (for example ZSRV;v=0002). Listed requests pass in every run, repairs included, without any check of what they send, and are listed in the approval evidence. On SAP the same endpoints also save data: sign in with an SAP user that can only display, and name the exact service, not *. Forms that change data belong in Forms It May Submit.',
    },
  ];
}
