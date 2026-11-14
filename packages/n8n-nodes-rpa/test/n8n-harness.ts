import { Workflow, type INode, type INodeParameters, type INodeTypeDescription, type INodeTypes } from 'n8n-workflow';
import { Playwright } from '../nodes/Playwright/Playwright.node.js';

const d = new Playwright().description;

/** n8n's node types for a workflow of one node type: whatever type name or version is asked for gets this description. */
export const nodeTypes = (description: INodeTypeDescription): INodeTypes => {
  const type = { description };
  return { getByName: () => type, getByNameAndVersion: () => type, getKnownTypes: () => ({}) } as unknown as INodeTypes;
};
/** The node's parameters as a run sees them: n8n's Workflow constructor fills the defaults and strips what is not shown. */
export const runParameters = (node: INode, description = d): INodeParameters =>
  new Workflow({ nodes: [structuredClone(node)], connections: {}, nodeTypes: nodeTypes(description), active: false }).getNode(node.name)!.parameters;
