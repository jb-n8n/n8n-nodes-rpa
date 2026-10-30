// A small typed stand-in for n8n's execute context: only what the operations use (NodeContext).
import {
  NodeConnectionTypes, type ContextType, type ExecuteWorkflowData, type IExecuteWorkflowInfo, type IBinaryData, type ICredentialDataDecryptedObject, type IContextObject, type IDataObject, type INode,
  type INodeCredentials, type INodeExecutionData, type INodeParameters, type NodeTypeAndVersion,
} from 'n8n-workflow';
import type { NodeContext } from '../nodes/Playwright/context.js';

export interface HarnessOptions {
  params: Record<string, unknown> | ((itemIndex: number) => Record<string, unknown>);
  /**
   * The node's raw parameters as saved in the workflow, returned by getNode().parameters. Expressions are strings that
   * start with '='. Default: `params` (or every item's `params(i)` merged, item 0 on top), meaning no expressions.
   */
  rawParameters?: Record<string, unknown>;
  items?: INodeExecutionData[];
  /** Credential data by credential type. A type listed here is attached to the node (getNode().credentials). */
  credentials?: Record<string, ICredentialDataDecryptedObject>;
  /** Id of every attached credential without an entry in credentialIds. */
  credentialId?: string;
  /** Credential ids by credential type (only for types present in `credentials`). */
  credentialIds?: Record<string, string>;
  staticData?: IDataObject;
  /** What getInputConnectionData returns. Leave undefined for "no model sub-node connected". */
  model?: unknown;
  modelDisabled?: boolean;
  signal?: AbortSignal;
  continueOnFail?: boolean;
  nodeName?: string;
  /** What getBinaryMetadata returns as fileSize, by binary data id (filesystem-stored binaries carry an id, not the bytes). */
  binaryFileSizes?: Record<string, number>;
  /** Stands in for n8n's executeWorkflow (a sub-workflow run). Absent: calling it throws. */
  executeWorkflow?: (workflowInfo: IExecuteWorkflowInfo, inputData?: INodeExecutionData[]) => Promise<ExecuteWorkflowData>;
}
export interface Harness extends NodeContext {
  readonly modelRequests: number;
  readonly staticData: IDataObject;
  /** How many times getBinaryDataBuffer read a whole input binary. */
  readonly binaryReads: number;
}

const plainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** b laid over a, merging nested plain objects (so the result holds every path either has). */
function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = plainObject(out[k]) && plainObject(v) ? deepMerge(out[k], v) : v;
  return out;
}

/**
 * Raw parameters with no expressions: the resolved ones of every input item laid over each other, so every path an
 * item resolves exists in the saved node (as in n8n, where items differ only through expressions). An item whose getter
 * throws (tests of a failing parameter getter) adds nothing.
 */
function defaultRaw(params: HarnessOptions['params'], itemCount: number): Record<string, unknown> {
  if (typeof params !== 'function') return params;
  let raw: Record<string, unknown> = {};
  for (let i = itemCount - 1; i >= 0; i--) {
    try {
      raw = deepMerge(raw, params(i));
    } catch {
      // an item whose getter throws adds nothing
    }
  }
  return raw;
}

/** The value at a path, lodash-get style: anything that is not an object along the way (an expression string) ends the walk. */
function dig(value: unknown, parts: string[]): unknown {
  let v = value;
  for (const part of parts) v = typeof v === 'object' && v !== null ? (v as Record<string, unknown>)[part] : undefined;
  return v;
}

/** One harness is one execution: getContext (n8n's per-execution context data) starts empty and lives as long as the harness. */
export function harness(o: HarnessOptions): Harness {
  const fallbackId = o.credentialId ?? 'cred-1';
  const credentials: INodeCredentials = {};
  for (const type of Object.keys(o.credentials ?? {})) credentials[type] = { id: o.credentialIds?.[type] ?? fallbackId, name: `${type} credential` };
  const raw = o.rawParameters ?? defaultRaw(o.params, Math.max(1, o.items?.length ?? 1));
  const node: INode = {
    id: 'node-1', name: o.nodeName ?? 'RPA', type: 'n8n-nodes-rpa.playwright', typeVersion: 1, position: [0, 0],
    parameters: raw as INodeParameters, credentials,
  };
  const staticData = o.staticData ?? {};
  const contextData: Record<string, IContextObject> = {};
  let modelRequests = 0;
  let binaryReads = 0;
  /** As n8n's assertBinaryData: the item's binary under the property name, or n8n's error. */
  const binaryOf = (itemIndex: number, propertyName: string): IBinaryData => {
    const b = (o.items ?? [{ json: {} }])[itemIndex]?.binary?.[propertyName];
    if (!b) throw new Error(`This operation expects the node's input data to contain a binary file '${propertyName}', but none was found [item ${itemIndex}]`);
    return b;
  };
  return {
    get modelRequests() {
      return modelRequests;
    },
    get binaryReads() {
      return binaryReads;
    },
    staticData,
    getInputData: () => o.items ?? [{ json: {} }],
    /**
     * As n8n 2.41's _getNodeParameter: the RAW value at the dotted path (lodash get on node.parameters, so a path under
     * an expression string such as `options: '={{…}}'` finds nothing and gives the fallback), then its resolved value.
     * A missing value without a fallback throws, as n8n does.
     */
    getNodeParameter(name: string, itemIndex: number, fallbackValue?: unknown): unknown {
      const parts = name.split('.');
      if (dig(raw, parts) === undefined) {
        if (fallbackValue === undefined) throw new Error(`Could not get parameter "${name}"`);
        return fallbackValue;
      }
      const v = dig(typeof o.params === 'function' ? o.params(itemIndex) : o.params, parts);
      return v === undefined ? fallbackValue : v;
    },
    async getCredentials(type: string): Promise<ICredentialDataDecryptedObject> {
      const data = o.credentials?.[type];
      if (!data) throw new Error(`Node "${node.name}" does not have any credentials of type "${type}" set`);
      return data;
    },
    getNode: () => node,
    getWorkflowStaticData(type: string): IDataObject {
      if (type !== 'global') throw new Error('the RPA node only uses global static data');
      return staticData;
    },
    getContext(type: ContextType): IContextObject {
      const key = type === 'flow' ? 'flow' : `node:${node.name}`;
      return (contextData[key] ??= {});
    },
    async getInputConnectionData(): Promise<unknown> {
      modelRequests++;
      return o.model;
    },
    getParentNodes(_nodeName: string, options?: { connectionType?: string }): NodeTypeAndVersion[] {
      if (o.model === undefined || options?.connectionType !== NodeConnectionTypes.AiLanguageModel) return [];
      return [{ name: 'Chat model', type: 'test.chatModel', typeVersion: 1, disabled: o.modelDisabled ?? false }];
    },
    getExecutionCancelSignal: () => o.signal,
    continueOnFail: () => o.continueOnFail ?? false,
    getExecutionId: () => 'exec-1',
    async executeWorkflow(workflowInfo: IExecuteWorkflowInfo, inputData?: INodeExecutionData[]): Promise<ExecuteWorkflowData> {
      if (!o.executeWorkflow) throw new Error('executeWorkflow is not set up in this test');
      return o.executeWorkflow(workflowInfo, inputData);
    },
    helpers: {
      async prepareBinaryData(binaryData: Buffer, filePath?: string, mimeType?: string): Promise<IBinaryData> {
        return { data: binaryData.toString('base64'), mimeType: mimeType ?? 'application/octet-stream', ...(filePath ? { fileName: filePath } : {}), bytes: binaryData.length };
      },
      assertBinaryData(itemIndex: number, propertyName: string): IBinaryData {
        return binaryOf(itemIndex, propertyName);
      },
      async getBinaryDataBuffer(itemIndex: number, propertyName: string): Promise<Buffer> {
        binaryReads++;
        return Buffer.from(binaryOf(itemIndex, propertyName).data, 'base64');
      },
      async getBinaryMetadata(binaryDataId: string): Promise<{ fileName?: string; mimeType?: string; fileSize: number }> {
        const fileSize = o.binaryFileSizes?.[binaryDataId];
        if (fileSize === undefined) throw new Error(`no binary data with id ${binaryDataId}`);
        return { fileSize };
      },
    },
  };
}
