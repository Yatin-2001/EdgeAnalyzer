import * as Location from 'expo-location';
import { ToolExecutor, ToolDefinition, ToolResult } from '../types';

export class DeviceLocationTool implements ToolExecutor {
    public definition: ToolDefinition = {
        name: 'device_location',
        description: 'Retrieves current device GPS coordinates, city, region, and country.',
        parameters: {
            type: 'object',
            properties: {},
            required: [],
        },
    };

    public async execute(): Promise<ToolResult> {
        const start = performance.now();
        try {
            const { status } = await Location.requestForegroundPermissionsAsync();
            if (status !== 'granted') {
                throw new Error('Device location permission was denied by user.');
            }

            const position = await Location.getCurrentPositionAsync({
                accuracy: Location.Accuracy.Balanced,
            });

            let address = 'Current Device Location';
            try {
                const reverse = await Location.reverseGeocodeAsync({
                    latitude: position.coords.latitude,
                    longitude: position.coords.longitude,
                });

                if (reverse.length > 0) {
                    const r = reverse[0];
                    address = [r.name, r.city || r.subregion, r.region, r.country]
                        .filter(Boolean)
                        .join(', ');
                }
            } catch {
                // Keep default address if reverse geocoding fails
            }

            return {
                success: true,
                data: {
                    address,
                    latitude: parseFloat(position.coords.latitude.toFixed(4)),
                    longitude: parseFloat(position.coords.longitude.toFixed(4)),
                },
                executionTimeMs: Math.round(performance.now() - start),
            };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
                executionTimeMs: Math.round(performance.now() - start),
            };
        }
    }
}