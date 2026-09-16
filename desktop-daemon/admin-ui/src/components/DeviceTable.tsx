import React from 'react';
import { type DeviceInfo } from '../hooks/useMeshAdmin';
import { Smartphone, Monitor, Tablet, Trash2 } from 'lucide-react';

interface Props {
    devices: DeviceInfo[];
    onRevoke: (id: string) => void;
}

export const DeviceTable: React.FC<Props> = ({ devices, onRevoke }) => {
    const getTierBadge = (tier: string) => {
        switch (tier) {
            case 'thick_desktop':
                return (
                    <span className="flex items-center gap-1 text-xs bg-purple-500/10 text-purple-400 border border-purple-500/20 px-2 py-0.5 rounded">
            <Monitor className="w-3.5 h-3.5" /> Desktop
          </span>
                );
            case 'thick_mobile':
                return (
                    <span className="flex items-center gap-1 text-xs bg-blue-500/10 text-blue-400 border border-blue-500/20 px-2 py-0.5 rounded">
            <Smartphone className="w-3.5 h-3.5" /> Mobile
          </span>
                );
            default:
                return (
                    <span className="flex items-center gap-1 text-xs bg-slate-500/10 text-slate-400 border border-slate-500/20 px-2 py-0.5 rounded">
            <Tablet className="w-3.5 h-3.5" /> Thin Client
          </span>
                );
        }
    };

    return (
        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-lg">
            <div className="px-6 py-4 border-b border-slate-800 flex justify-between items-center">
                <h3 className="font-semibold text-slate-200">Paired Mesh Clients</h3>
                <span className="text-xs text-slate-400">{devices.length} registered</span>
            </div>

            <div className="overflow-x-auto">
                <table className="w-full text-left text-sm text-slate-300">
                    <thead className="bg-slate-800/50 text-xs uppercase text-slate-400 tracking-wider">
                    <tr>
                        <th className="px-6 py-3">Device</th>
                        <th className="px-6 py-3">Tier</th>
                        <th className="px-6 py-3">IP Address</th>
                        <th className="px-6 py-3">Status</th>
                        <th className="px-6 py-3 text-right">Action</th>
                    </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60">
                    {devices.length === 0 ? (
                        <tr>
                            <td colSpan={5} className="px-6 py-8 text-center text-slate-500">
                                No devices paired yet.
                            </td>
                        </tr>
                    ) : (
                        devices.map((dev) => (
                            <tr key={dev.deviceId} className="hover:bg-slate-800/30 transition">
                                <td className="px-6 py-4 font-medium text-slate-100">{dev.deviceName}</td>
                                <td className="px-6 py-4">{getTierBadge(dev.deviceTier)}</td>
                                <td className="px-6 py-4 text-xs font-mono text-slate-400">{dev.network.ip}</td>
                                <td className="px-6 py-4">
                                    {dev.isRevoked ? (
                                        <span className="inline-flex items-center gap-1.5 text-xs text-rose-400">
                        <span className="w-2 h-2 rounded-full bg-rose-500"></span> Revoked
                      </span>
                                    ) : dev.isOnline ? (
                                        <span className="inline-flex items-center gap-1.5 text-xs text-emerald-400">
                        <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span> Online
                      </span>
                                    ) : (
                                        <span className="inline-flex items-center gap-1.5 text-xs text-slate-500">
                        <span className="w-2 h-2 rounded-full bg-slate-600"></span> Offline
                      </span>
                                    )}
                                </td>
                                <td className="px-6 py-4 text-right">
                                    {!dev.isRevoked && (
                                        <button
                                            onClick={() => onRevoke(dev.deviceId)}
                                            className="p-1.5 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 transition"
                                            title="Revoke Trust"
                                        >
                                            <Trash2 className="w-4 h-4" />
                                        </button>
                                    )}
                                </td>
                            </tr>
                        ))
                    )}
                    </tbody>
                </table>
            </div>
        </div>
    );
};