import type { INodeProperties } from 'n8n-workflow';
import { locatorGroupValues, locatorProperty } from './locator.js';

const fillForm = { operation: ['fillForm'] };

export const SUBMIT_SCOPE = "Submits a form on the URL's site. Posts to other sites are blocked.";
export const PASSWORD_WARNING = 'Do not type passwords here.';

export const fillFormProperties: INodeProperties[] = [
  { displayName: SUBMIT_SCOPE, name: 'submitScope', type: 'notice', default: '', displayOptions: { show: fillForm } },
  { displayName: PASSWORD_WARNING, name: 'passwordWarning', type: 'notice', default: '', displayOptions: { show: fillForm } },
  {
    displayName: 'Fields',
    name: 'formFields',
    type: 'fixedCollection',
    typeOptions: { multipleValues: true },
    placeholder: 'Add Field',
    default: {},
    description: 'Text fields to fill in, in order (use Run Steps for selects and checkboxes). Each locator must match exactly one field.',
    displayOptions: { show: fillForm },
    options: [
      {
        name: 'field',
        displayName: 'Field',
        values: [
          ...locatorGroupValues(),
          {
            displayName: 'Value',
            name: 'value',
            type: 'string',
            default: '',
            description: 'What to type into the field, at most 10,000 characters. It is passed to the page as a value, never written into the steps. The debug trace records typed values.',
          },
        ],
      },
    ],
  },
  locatorProperty({
    name: 'submitButton',
    displayName: 'Submit Button',
    description: "The button that submits the form. Up to 3 posts to the URL's site (or Also Allow These Sites) are allowed while it is clicked.",
    required: true,
    show: fillForm,
  }),
];
