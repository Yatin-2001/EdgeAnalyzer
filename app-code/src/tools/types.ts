export interface ToolProperty {
    type: 'string' | 'number' | 'boolean' | 'object' | 'array';
    description: string;
    enum?: string[];
}

export interface ToolDefinition {
    name: string;
    description: string;
    parameters: {
        type: 'object';
        properties: Record<string, ToolProperty>;
        required: string[];
    };
}

export interface OpenAIToolDefinition {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: {
            type: 'object';
            properties: Record<string, ToolProperty>;
            required: string[];
        };
    };
}

export interface OpenAIToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
}

export interface ToolResult {
    success: boolean;
    data?: any;
    error?: string;
    executionTimeMs: number;
}

export interface ToolExecutor {
    definition: ToolDefinition;
    execute(args: Record<string, any>): Promise<ToolResult>;
}

export interface ToolCallPayload {
    tool: string;
    parameters: Record<string, any>;
}