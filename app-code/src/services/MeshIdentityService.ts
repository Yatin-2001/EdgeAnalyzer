import * as SecureStore from 'expo-secure-store';
import {
    getMeshNodeConfig,
    upsertMeshNodeConfig,
    DeviceTier,
    MeshNodeConfigRecord,
    getAllModels,
} from '../database/repository';

export class MeshIdentityService {
    private static instance: MeshIdentityService;
    private cachedConfig: MeshNodeConfigRecord | null = null;

    private constructor() {}

    public static getInstance(): MeshIdentityService {
        if (!MeshIdentityService.instance) {
            MeshIdentityService.instance = new MeshIdentityService();
        }
        return MeshIdentityService.instance;
    }

    public async getOrCreateIdentity(): Promise<MeshNodeConfigRecord> {
        if (this.cachedConfig) return this.cachedConfig;

        const existing = await getMeshNodeConfig();
        if (existing) {
            this.cachedConfig = existing;
            return existing;
        }

        const SECURE_NODE_KEY = 'mesh_hardware_node_id';
        let nodeId = await SecureStore.getItemAsync(SECURE_NODE_KEY);
        if (!nodeId) {
            nodeId = `node_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`;
            await SecureStore.setItemAsync(SECURE_NODE_KEY, nodeId);
        }

        const models = await getAllModels();
        const detectedTier: DeviceTier = models.length > 0 ? 'thick_mobile' : 'thin';
        const defaultName = detectedTier === 'thick_mobile' ? 'OnePlus 15 Node' : 'Tablet Client';

        await upsertMeshNodeConfig(nodeId, defaultName, detectedTier, false, null);

        const created = await getMeshNodeConfig();
        this.cachedConfig = created!;
        return this.cachedConfig;
    }

    public async updateTier(newTier: DeviceTier): Promise<void> {
        const config = await this.getOrCreateIdentity();
        await upsertMeshNodeConfig(
            config.node_id,
            config.node_name,
            newTier,
            config.is_worker_enabled === 1,
            config.cluster_secret
        );
        this.cachedConfig = await getMeshNodeConfig();
    }

    public async setWorkerEnabled(enabled: boolean): Promise<void> {
        const config = await this.getOrCreateIdentity();
        await upsertMeshNodeConfig(
            config.node_id,
            config.node_name,
            config.node_tier,
            enabled,
            config.cluster_secret
        );
        this.cachedConfig = await getMeshNodeConfig();
    }
}