import { Bonjour } from 'bonjour-service';

export class DiscoveryService {
    private static instance: DiscoveryService;
    private bonjour: Bonjour | null = null;

    private constructor() {}

    public static getInstance(): DiscoveryService {
        if (!DiscoveryService.instance) {
            DiscoveryService.instance = new DiscoveryService();
        }
        return DiscoveryService.instance;
    }

    public start(port: number): void {
        if (this.bonjour) return;
        this.bonjour = new Bonjour();
        this.bonjour.publish({
            name: `EdgeAnalyzer-Desktop-${require('os').hostname()}`,
            type: 'edgeanalyzer-mcp',
            port,
            txt: {
                nodeType: 'thick_desktop',
                gpu: 'RTX 3060',
                protocols: 'ws,mcp',
            },
        });
        console.log(`[mDNS] Broadcasting _edgeanalyzer-mcp._tcp.local on port ${port}`);
    }

    public stop(): void {
        if (this.bonjour) {
            this.bonjour.unpublishAll(() => {
                this.bonjour?.destroy();
                this.bonjour = null;
            });
        }
    }
}