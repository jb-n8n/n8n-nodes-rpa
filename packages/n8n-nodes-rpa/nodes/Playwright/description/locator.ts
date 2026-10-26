import type { IDisplayOptions, INodeProperties } from 'n8n-workflow';

/** Roles offered by Find By: Role and Name. Values are ARIA roles. */
export const ROLES = ['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'heading', 'row', 'cell', 'tab', 'menuitem'] as const;
const ROLE_NAMES: Record<(typeof ROLES)[number], string> = {
  button: 'Button', link: 'Link', textbox: 'Text Box', checkbox: 'Checkbox', radio: 'Radio', combobox: 'Combo Box',
  heading: 'Heading', row: 'Row', cell: 'Cell', tab: 'Tab', menuitem: 'Menu Item',
};

/** The locator inputs (Find By + one value input, or Role + Name, + Exact Match). Fresh copies on every call. */
function locatorInputs(): INodeProperties[] {
  return [
    {
      displayName: 'Find By',
      name: 'findBy',
      type: 'options',
      default: 'text',
      options: [
        { name: 'Visible Text', value: 'text', description: 'Text shown on the page. Matches part of the text, ignoring case.' },
        { name: 'Form Label', value: 'label', description: 'The label of a form field. Matches part of the label, ignoring case.' },
        { name: 'Role and Name', value: 'role', description: 'What the element is (button, link, …) and its accessible name' },
        { name: 'Test ID', value: 'testId', description: 'The data-testid attribute, as written' },
        { name: 'CSS Selector', value: 'css', description: "Advanced: a CSS selector, as written. Copy one from your browser's developer tools (Inspect, then Copy selector)." },
      ],
      description: 'How to find the element. It must match exactly one element.',
    },
    { displayName: 'Value', name: 'text', type: 'string', default: '', placeholder: 'Sign in', displayOptions: { show: { findBy: ['text'] } } },
    { displayName: 'Value', name: 'label', type: 'string', default: '', placeholder: 'Email address', displayOptions: { show: { findBy: ['label'] } } },
    {
      displayName: 'Role',
      name: 'role',
      type: 'options',
      default: 'button',
      options: ROLES.map((r) => ({ name: ROLE_NAMES[r], value: r })),
      displayOptions: { show: { findBy: ['role'] } },
    },
    { displayName: 'Name', name: 'roleName', type: 'string', default: '', placeholder: 'Submit', description: 'The accessible name, such as the button text', displayOptions: { show: { findBy: ['role'] } } },
    { displayName: 'Value', name: 'testId', type: 'string', default: '', placeholder: 'submit-button', displayOptions: { show: { findBy: ['testId'] } } },
    { displayName: 'Value', name: 'css', type: 'string', default: '', placeholder: 'table.results', displayOptions: { show: { findBy: ['css'] } } },
    {
      displayName: 'Exact Match',
      name: 'exact',
      type: 'boolean',
      default: false,
      description: 'Whether the whole text must match exactly (case-sensitive), instead of part of it ignoring case',
      displayOptions: { show: { findBy: ['text', 'label', 'role'] } },
    },
  ];
}

/**
 * The locator inputs on their own, for use inside another fixedCollection entry (Extract Data's Fields, Fill and Submit
 * Form's Fields), so the entry's value carries findBy/text/... next to its own keys. `findByDescription` replaces the
 * Find By description (for example "Where to find this value inside each item").
 */
export function locatorGroupValues(findByDescription?: string): INodeProperties[] {
  return locatorInputs().map((v) => (findByDescription !== undefined && v.name === 'findBy' ? { ...v, description: findByDescription } : v));
}

/**
 * One locator field: a fixedCollection with a single `locator` group (the inputs of locatorGroupValues), saved as
 * `{ locator: { findBy, text | label | role + roleName | testId | css, exact } }`. Values accept expressions.
 */
export function locatorProperty(o: { name: string; displayName: string; description: string; required?: boolean; show: Record<string, unknown> }): INodeProperties {
  return {
    displayName: o.displayName,
    name: o.name,
    type: 'fixedCollection',
    default: {},
    placeholder: `Set ${o.displayName}`,
    description: o.description,
    ...(o.required ? { required: true } : {}),
    displayOptions: { show: o.show as IDisplayOptions['show'] },
    options: [{ name: 'locator', displayName: 'Locator', values: locatorGroupValues() }],
  };
}
