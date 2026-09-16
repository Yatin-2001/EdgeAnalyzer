import * as Location from 'expo-location';
import { ToolExecutor, ToolDefinition, ToolResult } from '../types';
import { WebSearchTool } from './webSearch';

interface GeocodingResult {
    name: string;
    latitude: number;
    longitude: number;
    country?: string;
    admin1?: string;
}

export class WeatherTool implements ToolExecutor {
    public definition: ToolDefinition = {
        name: 'weather',
        description: 'Fetches live real-time weather and temperature for any city name (e.g. "Delhi", "London", "Tokyo") or "current_location" for device GPS location.',
        parameters: {
            type: 'object',
            properties: {
                location: {
                    type: 'string',
                    description: 'City name (e.g. "Delhi", "New York") or "current_location" for device location.',
                },
            },
            required: ['location'],
        },
    };

    public async execute(args: { location?: string }): Promise<ToolResult> {
        const start = performance.now();
        try {
            const locInput = (args.location || '').trim().toLowerCase();
            const isCurrentLocation =
                !locInput ||
                locInput.includes('current') ||
                locInput.includes('my location') ||
                locInput.includes('here') ||
                locInput.includes('device');

            let latitude: number;
            let longitude: number;
            let placeName: string;

            if (isCurrentLocation) {
                // Request live GPS and trigger permission popup
                const { status } = await Location.requestForegroundPermissionsAsync();
                if (status !== 'granted') {
                    throw new Error('Device location permission was denied.');
                }

                const position = await Location.getCurrentPositionAsync({
                    accuracy: Location.Accuracy.Balanced,
                });

                latitude = position.coords.latitude;
                longitude = position.coords.longitude;
                placeName = 'Your Current Location';

                try {
                    const reverse = await Location.reverseGeocodeAsync({ latitude, longitude });
                    if (reverse.length > 0) {
                        const r = reverse[0];
                        placeName = [r.city || r.subregion, r.region, r.country]
                            .filter(Boolean)
                            .join(', ');
                    }
                } catch {
                    // Non-critical fallback
                }
            } else {
                // Geocode city name to coordinates
                const cleanCity = args.location!.replace(/weather|in|for|today|current/gi, '').trim();
                const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
                    cleanCity
                )}&count=1&language=en&format=json`;

                const geoRes = await fetch(geoUrl);
                const geoData = await geoRes.json();
                const firstMatch: GeocodingResult | undefined = geoData.results?.[0];

                if (!firstMatch) {
                    // Fall back to live web search if city geocoding fails
                    const webSearch = new WebSearchTool();
                    return await webSearch.execute({
                        query: `${args.location} current weather temperature today`
                    });
                }

                latitude = firstMatch.latitude;
                longitude = firstMatch.longitude;
                placeName = [firstMatch.name, firstMatch.admin1, firstMatch.country]
                    .filter(Boolean)
                    .join(', ');
            }

            // Fetch live conditions from Open-Meteo Forecast API
            const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m`;
            const weatherRes = await fetch(weatherUrl);

            if (!weatherRes.ok) {
                throw new Error(`Open-Meteo error: ${weatherRes.status}`);
            }

            const weatherData = await weatherRes.json();
            const current = weatherData.current;
            const tempC = current.temperature_2m;
            const tempF = parseFloat(((tempC * 9) / 5 + 32).toFixed(1));

            return {
                success: true,
                data: {
                    location: placeName,
                    temperature_celsius: `${tempC}°C`,
                    temperature_fahrenheit: `${tempF}°F`,
                    feels_like: `${current.apparent_temperature}°C`,
                    humidity: `${current.relative_humidity_2m}%`,
                    wind_speed: `${current.wind_speed_10m} km/h`,
                    condition: this.mapWeatherCode(current.weather_code),
                },
                executionTimeMs: Math.round(performance.now() - start),
            };
        } catch (error) {
            // Automatic fallback to web search on any network/geocoding error
            try {
                const webSearch = new WebSearchTool();
                return await webSearch.execute({
                    query: `${args.location || 'current'} weather temperature today`
                });
            } catch {
                return {
                    success: false,
                    error: error instanceof Error ? error.message : String(error),
                    executionTimeMs: Math.round(performance.now() - start),
                };
            }
        }
    }

    private mapWeatherCode(code: number): string {
        if (code === 0) return 'Clear sky';
        if (code <= 3) return 'Partly cloudy';
        if (code <= 48) return 'Foggy';
        if (code <= 55) return 'Drizzle';
        if (code <= 65) return 'Rain';
        if (code <= 75) return 'Snowfall';
        if (code <= 82) return 'Rain showers';
        if (code >= 95) return 'Thunderstorm';
        return 'Clear';
    }
}