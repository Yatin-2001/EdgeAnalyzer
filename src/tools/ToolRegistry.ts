import { ToolExecutor, ToolDefinition } from './types';
import { CalculatorTool } from './builtin/calculator';
import { DeviceLocationTool } from './builtin/location';
import { WeatherTool } from './builtin/weather';
import { WebSearchTool } from './builtin/webSearch';

export class ToolRegistry {
    private static instance: ToolRegistry;
    private tools = new Map<string, ToolExecutor>();

    private constructor() {
        this.registerBuiltInTools();
    }

    public static getInstance(): ToolRegistry {
        if (!ToolRegistry.instance) {
            ToolRegistry.instance = new ToolRegistry();
        }
        return ToolRegistry.instance;
    }

    private registerBuiltInTools(): void {
        this.register(new CalculatorTool());
        this.register(new DeviceLocationTool());
        this.register(new WeatherTool());
        this.register(new WebSearchTool());
    }

    public register(tool: ToolExecutor): void {
        this.tools.set(tool.definition.name, tool);
    }

    public unregister(name: string): void {
        this.tools.delete(name);
    }

    public get(name: string): ToolExecutor | undefined {
        return this.tools.get(name);
    }

    public getAllDefinitions(): ToolDefinition[] {
        return Array.from(this.tools.values()).map((t) => t.definition);
    }
}