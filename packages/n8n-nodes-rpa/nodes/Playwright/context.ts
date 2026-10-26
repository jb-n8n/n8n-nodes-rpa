import type {
  AINodeConnectionType, ContextType, IBinaryData, IContextObject, ICredentialDataDecryptedObject, IDataObject, INode, INodeExecutionData,
  NodeConnectionType, NodeTypeAndVersion,
} from 'n8n-workflow';

/**
 * The part of n8n's IExecuteFunctions the Run and Approve operations use. IExecuteFunctions is assignable to it
 * (checked in test/node.test.ts), so the node passes `this`, and tests pass a small typed stub.
 */
export interface NodeContext {
  getInputData(): INodeExecutionData[];
  getNodeParameter(parameterName: string, itemIndex: number, fallbackValue?: unknown): unknown;
  getCredentials(type: string, itemIndex?: number): Promise<ICredentialDataDecryptedObject>;
  getNode(): INode;
  getWorkflowStaticData(type: string): IDataObject;
  /** n8n's per-execution context data ('flow': shared by every node of this execution). Never persisted across executions. */
  getContext(type: ContextType): IContextObject;
  getInputConnectionData(connectionType: AINodeConnectionType, itemIndex: number): Promise<unknown>;
  getParentNodes(nodeName: string, options?: { connectionType?: NodeConnectionType; depth?: number }): NodeTypeAndVersion[];
  getExecutionCancelSignal(): AbortSignal | undefined;
  continueOnFail(): boolean;
  getExecutionId(): string;
  helpers: {
    prepareBinaryData(binaryData: Buffer, filePath?: string, mimeType?: string): Promise<IBinaryData>;
    /** The input item's binary under the property name, or n8n's error when it has none. */
    assertBinaryData(itemIndex: number, propertyName: string): IBinaryData;
    /** The whole input binary (read from the binary data store when it lives there). */
    getBinaryDataBuffer(itemIndex: number, propertyName: string): Promise<Buffer>;
    /** A stored binary's size, without reading it. */
    getBinaryMetadata(binaryDataId: string): Promise<{ fileName?: string; mimeType?: string; fileSize: number }>;
  };
}
