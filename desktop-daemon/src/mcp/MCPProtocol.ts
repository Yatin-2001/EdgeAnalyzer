import { WebSocket } from 'ws';
import { OllamaBridge } from './OllamaBridge.js';

export class MCPProtocol {
    private ollama = OllamaBridge.getInstance();

    public async handleMessage(ws: WebSocket, rawMessage: string): Promise<void> {
        let req: any;
        try {
            req = JSON.parse(rawMessage);
        } catch {
            return;
        }

        const { id, method, params } = req;

        if (method === 'mcp.stream_chat') {
            const { model, messages } = params || {};
            if (!model || !messages) {
                ws.send(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Invalid params' } }));
                return;
            }

            try {
                await this.ollama.streamChat(model, messages, (chunk: string) => {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(
                            JSON.stringify({
                                jsonrpc: '2.0',
                                method: 'mcp.stream_chunk',
                                params: { id, chunk },
                            })
                        );
                    }
                });

                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(
                        JSON.stringify({
                            jsonrpc: '2.0',
                            id,
                            result: { status: 'completed' },
                        })
                    );
                }
            } catch (err: any) {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(
                        JSON.stringify({
                            jsonrpc: '2.0',
                            id,
                            error: { code: -32000, message: err.message || 'Inference failure' },
                        })
                    );
                }
            }
        }
    }
}