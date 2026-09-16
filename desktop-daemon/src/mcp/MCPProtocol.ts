import { WebSocket } from 'ws';
import { OllamaBridge } from './OllamaBridge.js';

export interface JSONRPCRequest {
    jsonrpc: '2.0';
    id: string | number;
    method: string;
    params?: any;
}

export class MCPProtocol {
    private ollama = OllamaBridge.getInstance();

    public async handleMessage(ws: WebSocket, raw: string): Promise<void> {
        let message: JSONRPCRequest;
        try {
            message = JSON.parse(raw);
        } catch {
            this.sendError(ws, null, -32700, 'Parse error');
            return;
        }

        const { id, method, params } = message;

        switch (method) {
            case 'mcp.list_models': {
                const models = await this.ollama.listModels();
                ws.send(JSON.stringify({ jsonrpc: '2.0', id, result: { models } }));
                break;
            }

            case 'mcp.stream_chat': {
                const { model, messages } = params || {};
                if (!model || !messages) {
                    this.sendError(ws, id, -32602, 'Invalid params: model and messages required');
                    return;
                }

                try {
                    await this.ollama.streamChat(model, messages, (tokenChunk: string) => {
                        ws.send(
                            JSON.stringify({
                                jsonrpc: '2.0',
                                method: 'mcp.stream_chunk',
                                params: { id, chunk: tokenChunk },
                            })
                        );
                    });
                    ws.send(
                        JSON.stringify({
                            jsonrpc: '2.0',
                            id,
                            result: { status: 'completed' },
                        })
                    );
                } catch (err: any) {
                    this.sendError(ws, id, -32000, err.message || 'Ollama Execution Error');
                }
                break;
            }

            case 'mcp.stream_vision': {
                const { model, imageBase64, prompt } = params || {};
                if (!model || !imageBase64) {
                    this.sendError(ws, id, -32602, 'Invalid params: model and imageBase64 required');
                    return;
                }

                const messages = [
                    {
                        role: 'user',
                        content: prompt || 'Analyze this image.',
                        images: [imageBase64.replace(/^data:image\/[a-z]+;base64,/, '')],
                    },
                ];

                try {
                    await this.ollama.streamChat(model, messages, (tokenChunk: string) => {
                        ws.send(
                            JSON.stringify({
                                jsonrpc: '2.0',
                                method: 'mcp.stream_chunk',
                                params: { id, chunk: tokenChunk },
                            })
                        );
                    });
                    ws.send(JSON.stringify({ jsonrpc: '2.0', id, result: { status: 'completed' } }));
                } catch (err: any) {
                    this.sendError(ws, id, -32000, err.message || 'Vision Execution Error');
                }
                break;
            }

            default:
                this.sendError(ws, id, -32601, `Method not found: ${method}`);
                break;
        }
    }

    private sendError(ws: WebSocket, id: string | number | null, code: number, message: string): void {
        ws.send(
            JSON.stringify({
                jsonrpc: '2.0',
                id,
                error: { code, message },
            })
        );
    }
}