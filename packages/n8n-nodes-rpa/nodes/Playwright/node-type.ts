// The RPA node's type id in saved workflows: the package name plus the node's name (a stored identifier, `playwright`).
// Generated workflows read it from here; test/import-workflow.test.ts pins it to package.json, so a package rename fails
// until this follows.
export const RPA_NODE_TYPE = 'n8n-nodes-rpa.playwright';
