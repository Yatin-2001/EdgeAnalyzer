import * as SecureStore from 'expo-secure-store';

export type SearchProvider = 'tavily_keyless' | 'brave_custom';

export class SecureStorageService {
    private static readonly BRAVE_API_KEY = 'edge_analyzer_brave_api_key';
    private static readonly SEARCH_PROVIDER_KEY = 'edge_analyzer_search_provider';

    /**
     * Encrypts and persists the Brave Search API key.
     */
    public static async saveBraveApiKey(key: string): Promise<void> {
        const trimmed = key.trim();
        if (!trimmed) throw new Error('API key cannot be empty.');
        await SecureStore.setItemAsync(this.BRAVE_API_KEY, trimmed, {
            keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
        });
    }

    /**
     * Retrieves the raw API key for HTTPS requests.
     */
    public static async getBraveApiKey(): Promise<string | null> {
        return SecureStore.getItemAsync(this.BRAVE_API_KEY);
    }

    /**
     * Deletes the stored API key.
     */
    public static async deleteBraveApiKey(): Promise<void> {
        await SecureStore.deleteItemAsync(this.BRAVE_API_KEY);
    }

    /**
     * Returns a masked preview displaying only the last 4 characters.
     */
    public static async getMaskedBraveApiKey(): Promise<string | null> {
        const key = await this.getBraveApiKey();
        if (!key) return null;
        if (key.length <= 4) return '••••' + key;
        const maskedPart = '•'.repeat(Math.min(key.length - 4, 16));
        return `${maskedPart}${key.slice(-4)}`;
    }

    /**
     * Manages active search engine provider selection.
     */
    public static async getActiveSearchProvider(): Promise<SearchProvider> {
        const provider = await SecureStore.getItemAsync(this.SEARCH_PROVIDER_KEY);
        return (provider as SearchProvider) || 'tavily_keyless';
    }

    public static async setActiveSearchProvider(provider: SearchProvider): Promise<void> {
        await SecureStore.setItemAsync(this.SEARCH_PROVIDER_KEY, provider);
    }
}