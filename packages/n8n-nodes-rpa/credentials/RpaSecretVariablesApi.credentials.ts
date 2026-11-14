import type { ICredentialType, Icon, INodeProperties } from 'n8n-workflow';

export class RpaSecretVariablesApi implements ICredentialType {
  name = 'rpaSecretVariablesApi';

  displayName = 'RPA Secret Variables';

  icon: Icon = { light: 'file:rpa.svg', dark: 'file:rpa.svg' };

  documentationUrl = 'https://github.com/jb-n8n/n8n-nodes-rpa/blob/main/docs/reference/security.md#secret-variables';

  properties: INodeProperties[] = [
    {
      displayName:
        'Passwords and other secrets the steps use as {{var.name}}. Run Steps adds them to the run variables and masks every value in its outputs, errors, traces and screenshots and in what the chat model sees. Only signed steps type one: a browser fill with secret: true, or a desktop fill of exactly {{var.name}}; any other use of a value is refused. Each value must be at least 4 characters. Give a name here or in Options → Variables, not in both.',
      name: 'about',
      type: 'notice',
      default: '',
    },
    {
      displayName: 'Variables',
      name: 'variables',
      type: 'fixedCollection',
      typeOptions: { multipleValues: true },
      default: {},
      placeholder: 'Add Secret Variable',
      options: [
        {
          name: 'values',
          displayName: 'Variable',
          values: [
            {
              displayName: 'Name',
              name: 'name',
              type: 'string',
              default: '',
              placeholder: 'password',
              description: 'The name the steps use, as in {{var.password}}: letters, digits and _',
            },
            {
              displayName: 'Value',
              name: 'value',
              type: 'string',
              typeOptions: { password: true },
              default: '',
              description: 'The secret itself, at least 4 characters',
            },
          ],
        },
      ],
    },
    {
      displayName: 'May Be Typed Into',
      name: 'mayBeTypedInto',
      type: 'string',
      typeOptions: { rows: 3 },
      default: '',
      noDataExpression: true,
      placeholder: 'ErpDemo.exe\nerp.example.com',
      description:
        "Where these values may be typed, one per line: an app's program file name for desktop steps (ErpDemo.exe), or a site's exact host for browser steps (erp.example.com). A desktop run of an app not listed is refused before the app starts, and a browser step is refused before it types a value on a site not listed. Empty means the values may be typed into any app or site the signed steps use.",
    },
  ];
}
