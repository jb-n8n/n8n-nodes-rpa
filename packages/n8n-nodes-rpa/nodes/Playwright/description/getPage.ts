import type { INodeProperties } from 'n8n-workflow';

export const getPageProperties: INodeProperties[] = [
  {
    displayName: 'Return',
    name: 'pageContent',
    type: 'options',
    default: 'text',
    options: [
      { name: 'Text', value: 'text', description: 'The visible text of the page' },
      { name: 'HTML', value: 'html', description: 'The page HTML after it loaded' },
      { name: 'Title and URL Only', value: 'titleUrl', description: 'Only the title, the final URL and the HTTP status' },
    ],
    description: 'What to return. Text and HTML stop at 5 MB; a longer page comes back cut, with truncated: true.',
    displayOptions: { show: { operation: ['getPage'] } },
  },
];
