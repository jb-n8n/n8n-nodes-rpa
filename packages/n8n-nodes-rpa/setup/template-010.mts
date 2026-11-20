// The template "RPA: 5 Import a bot" as RPA 0.1.0 shipped it (git show v0.1.0:packages/n8n-nodes-rpa/templates/5-import-a-bot.json):
// its nodes other than sticky notes, by name, type, version and parameters, and its connections. The setup command
// tells a form 0.1.0 made from one a person changed by this (template.mts madeBy010). test/setup.test.ts checks it
// against the tag when the repository has it. Never edited by hand.
export const TEMPLATE_010: { nodes: Record<string, any>[]; connections: Record<string, any> } = {
  "nodes": [
    {
      "name": "Import a bot",
      "type": "n8n-nodes-base.formTrigger",
      "typeVersion": 2.5,
      "parameters": {
        "authentication": "basicAuth",
        "formTitle": "Import a bot",
        "formDescription": "Upload a Chrome Recorder export (JSON), Playwright code (JavaScript or TypeScript) or a UiPath project (ZIP or XAML). The steps are replayed in a fresh browser and sent for approval. Nothing runs on a schedule until a person approves it.",
        "formFields": {
          "values": [
            {
              "fieldLabel": "Bot file",
              "fieldName": "bot",
              "fieldType": "file",
              "multipleFiles": false,
              "acceptFileTypes": ".json, .js, .ts, .zip, .xaml",
              "requiredField": true
            },
            {
              "fieldLabel": "Source",
              "fieldName": "source",
              "fieldType": "dropdown",
              "fieldOptions": {
                "values": [
                  {
                    "option": "Chrome Recorder"
                  },
                  {
                    "option": "Playwright code"
                  },
                  {
                    "option": "UiPath project"
                  }
                ]
              },
              "requiredField": true
            },
            {
              "fieldLabel": "Name for the steps",
              "fieldName": "name",
              "fieldType": "text",
              "placeholder": "line-item-export",
              "requiredField": true
            },
            {
              "fieldLabel": "File name pattern, if the bot downloads a file (regex)",
              "fieldName": "expectedFileName",
              "fieldType": "text",
              "placeholder": "^LINEITEMS_"
            },
            {
              "fieldLabel": "Required columns of that file (comma-separated)",
              "fieldName": "columns",
              "fieldType": "text",
              "placeholder": "Document, Amount"
            }
          ]
        },
        "options": {}
      }
    },
    {
      "name": "Import steps",
      "type": "n8n-nodes-rpa.playwright",
      "typeVersion": 1,
      "parameters": {
        "operation": "importSteps",
        "source": "={{ ({ 'Chrome Recorder': 'chrome', 'Playwright code': 'playwright', 'UiPath project': 'uipath' })[$json.source] ?? '' }}",
        "inputFrom": "binary",
        "binaryPropertyName": "bot",
        "stepsName": "={{ $json.name }}",
        "aiRepair": true,
        "expectedFile": {
          "file": {
            "namePattern": "={{ $json.expectedFileName ?? '' }}",
            "requiredColumns": "={{ $json.columns ?? '' }}"
          }
        },
        "options": {}
      }
    },
    {
      "name": "Chat model",
      "type": "@n8n/n8n-nodes-langchain.lmChatAnthropic",
      "typeVersion": 1.5,
      "parameters": {
        "model": {
          "__rl": true,
          "mode": "id",
          "value": "claude-sonnet-5-5"
        },
        "options": {}
      }
    },
    {
      "name": "Approve steps",
      "type": "n8n-nodes-base.executeWorkflow",
      "typeVersion": 1.2,
      "parameters": {
        "source": "database",
        "workflowId": {
          "__rl": true,
          "mode": "list",
          "value": "",
          "cachedResultName": "RPA: 3 Approve steps"
        },
        "mode": "each",
        "options": {
          "waitForSubWorkflow": false
        }
      }
    },
    {
      "name": "Workflow file?",
      "type": "n8n-nodes-base.if",
      "typeVersion": 2.2,
      "parameters": {
        "conditions": {
          "options": {
            "caseSensitive": true,
            "leftValue": "",
            "typeValidation": "strict",
            "version": 2
          },
          "conditions": [
            {
              "id": "3d6f1a20-7b4c-4e8a-9c11-0000000005b1",
              "leftValue": "={{ Boolean($json.workflowName) }}",
              "rightValue": "",
              "operator": {
                "type": "boolean",
                "operation": "true",
                "singleValue": true
              }
            }
          ],
          "combinator": "and"
        },
        "options": {}
      }
    },
    {
      "name": "Imported, with the workflow file",
      "type": "n8n-nodes-base.form",
      "typeVersion": 2.5,
      "parameters": {
        "operation": "completion",
        "respondWith": "returnBinary",
        "completionTitle": "Imported",
        "completionMessage": "=Imported: {{ $json.report.steps }} steps; {{ $json.report.items.filter(i => i.kind === 'untranslated').length }} not translated, {{ $json.report.items.filter(i => i.kind === 'secret').length }} removed as secrets.\n{{ $json.drafts.filter(d => d.adopted).length }} of {{ $json.drafts.length }} step lists passed the replay and are waiting for approval in RPA: 3 Approve steps.\nYour browser downloads {{ $binary.workflow.fileName }}: the rest of the bot as an n8n workflow. Open it in n8n with Import from file; stickies mark what was not translated.",
        "inputDataFieldName": "workflow",
        "limitWaitTime": true,
        "limitType": "afterTimeInterval",
        "resumeAmount": 1,
        "resumeUnit": "hours",
        "options": {}
      }
    },
    {
      "name": "Imported",
      "type": "n8n-nodes-base.form",
      "typeVersion": 2.5,
      "parameters": {
        "operation": "completion",
        "respondWith": "text",
        "completionTitle": "Imported",
        "completionMessage": "=Imported: {{ $json.report.steps }} steps; {{ $json.report.items.filter(i => i.kind === 'untranslated').length }} not translated, {{ $json.report.items.filter(i => i.kind === 'secret').length }} removed as secrets.\n{{ $json.drafts.filter(d => d.adopted).length }} of {{ $json.drafts.length }} step lists passed the replay and are waiting for approval in RPA: 3 Approve steps.\nThe full report, and the reason for any step list that could not be proved, is on the Data output of Import steps in this execution.",
        "limitWaitTime": true,
        "limitType": "afterTimeInterval",
        "resumeAmount": 1,
        "resumeUnit": "hours",
        "options": {}
      }
    },
    {
      "name": "Import failed",
      "type": "n8n-nodes-base.form",
      "typeVersion": 2.5,
      "parameters": {
        "operation": "completion",
        "respondWith": "text",
        "completionTitle": "Nothing to approve",
        "completionMessage": "={{ $json.error }}\nDetails, including the import report when there is one, are in the error output of Import steps in this execution.",
        "limitWaitTime": true,
        "limitType": "afterTimeInterval",
        "resumeAmount": 1,
        "resumeUnit": "hours",
        "options": {}
      }
    }
  ],
  "connections": {
    "Import a bot": {
      "main": [
        [
          {
            "node": "Import steps",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Chat model": {
      "ai_languageModel": [
        [
          {
            "node": "Import steps",
            "type": "ai_languageModel",
            "index": 0
          }
        ]
      ]
    },
    "Import steps": {
      "main": [
        [
          {
            "node": "Workflow file?",
            "type": "main",
            "index": 0
          }
        ],
        [
          {
            "node": "Approve steps",
            "type": "main",
            "index": 0
          }
        ],
        [
          {
            "node": "Import failed",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Workflow file?": {
      "main": [
        [
          {
            "node": "Imported, with the workflow file",
            "type": "main",
            "index": 0
          }
        ],
        [
          {
            "node": "Imported",
            "type": "main",
            "index": 0
          }
        ]
      ]
    }
  }
};
