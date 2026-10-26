import type { INodeProperties, INodePropertyOptions } from 'n8n-workflow';
import { locatorGroupValues, locatorProperty } from './locator.js';

export const FIELD_LOCATION = 'Where to find this value inside each item';

export const ATTRIBUTE_OPTIONS: INodePropertyOptions[] = [
  { name: 'Text', value: 'text', description: 'The visible text of the element' },
  { name: 'Link (Href)', value: 'href', description: 'The link address, as an absolute URL' },
  { name: 'Source (Src)', value: 'src', description: 'The image or media address, as an absolute URL' },
  { name: 'Title', value: 'title', description: 'The title attribute (tooltip text)' },
  { name: 'Alt Text', value: 'alt', description: 'The alt attribute of an image' },
  { name: 'ARIA Label', value: 'aria-label', description: 'The aria-label attribute' },
];

export const extractProperties: INodeProperties[] = [
  {
    displayName: 'Shape',
    name: 'shape',
    type: 'options',
    noDataExpression: true,
    default: 'table',
    options: [
      { name: 'Table', value: 'table', description: 'An HTML table: each body row becomes a row keyed by the column headers' },
      { name: 'List of Items', value: 'list', description: 'Repeated items such as cards or list entries: each item becomes a row' },
    ],
    description: 'What the data looks like on the page',
    displayOptions: { show: { operation: ['extract'] } },
  },
  locatorProperty({
    name: 'table',
    displayName: 'Table',
    description: 'The table to read. It must match exactly one table element. Headers come from the header row, else the first row.',
    required: true,
    show: { operation: ['extract'], shape: ['table'] },
  }),
  locatorProperty({
    name: 'item',
    displayName: 'Item',
    description: 'Matches every item in the list. Each match becomes one row.',
    required: true,
    show: { operation: ['extract'], shape: ['list'] },
  }),
  {
    displayName: 'Fields',
    name: 'fields',
    type: 'fixedCollection',
    typeOptions: { multipleValues: true },
    placeholder: 'Add Field',
    default: {},
    description: "The values to read from each item. Leave empty to get each item's text in a field named text.",
    displayOptions: { show: { operation: ['extract'], shape: ['list'] } },
    options: [
      {
        name: 'field',
        displayName: 'Field',
        values: [
          { displayName: 'Name', name: 'name', type: 'string', default: '', required: true, placeholder: 'price', description: 'The key of this value in each row' },
          ...locatorGroupValues(FIELD_LOCATION),
          {
            displayName: 'Attribute',
            name: 'attribute',
            type: 'options',
            default: 'text',
            options: ATTRIBUTE_OPTIONS,
            description: 'What to read from the element. Links and image sources come back as absolute URLs.',
          },
        ],
      },
    ],
  },
];
