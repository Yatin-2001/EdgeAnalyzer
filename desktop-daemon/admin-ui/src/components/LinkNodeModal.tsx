import { useState } from 'react';
import { X, Server, ArrowRight, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';

interface Props {
    isOpen: boolean;
    onClose: () => void;
    onSuccess: () => void;
}

export function LinkNodeModal({ isOpen, onClose, onSuccess }: Props) {
    const [targetIp, setTargetIp] = useState('');
    const [targetPort, setTargetPort] = useState('8080');
    const [pin, setPin] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [successMsg, setSuccessMsg] = useState<string | null>(null);

    if (!isOpen) return null;

    const handleConnect = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!targetIp.trim() || !pin.trim()) {
            setError('Please provide both the Target IP and the Pairing PIN.');
            return;
        }

        setIsLoading(true);
        setError(null);
        setSuccessMsg(null);

        try {
            const res = await fetch('/api/mesh/cluster/join', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    targetIp: targetIp.trim(),
                    targetPort: parseInt(targetPort, 10) || 8080,
                    pin: pin.trim(),
                }),
            });

            const data = await res.json();
            if (!res.ok) {
                throw new Error(data.error || 'Failed to link desktop nodes');
            }

            setSuccessMsg(`Successfully linked with ${data.peerName}! (${data.unifiedDeviceCount} total devices in cluster)`);
            setTimeout(() => {
                onSuccess();
                onClose();
            }, 1500);
        } catch (err: unknown) {
            setError(
                err instanceof Error
                    ? err.message
                    : 'Connection failed'
            );
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm">
            <div className="relative w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden p-6">
                <button
                    onClick={onClose}
                    className="absolute top-4 right-4 p-1.5 text-slate-400 hover:text-slate-200 rounded-lg hover:bg-slate-800 transition"
                >
                    <X className="w-5 h-5" />
                </button>

                <div className="flex items-center gap-3 mb-5">
                    <div className="p-2 bg-indigo-600/20 border border-indigo-500/30 rounded-xl text-indigo-400">
                        <Server className="w-5 h-5" />
                    </div>
                    <div>
                        <h2 className="text-lg font-bold text-slate-100">Link Desktop Node</h2>
                        <p className="text-xs text-slate-400">Federate with another running desktop daemon</p>
                    </div>
                </div>

                {error && (
                    <div className="flex items-center gap-2 p-3 mb-4 text-xs text-rose-400 bg-rose-950/40 border border-rose-800/50 rounded-xl">
                        <AlertCircle className="w-4 h-4 shrink-0" />
                        <span>{error}</span>
                    </div>
                )}

                {successMsg && (
                    <div className="flex items-center gap-2 p-3 mb-4 text-xs text-emerald-400 bg-emerald-950/40 border border-emerald-800/50 rounded-xl">
                        <CheckCircle2 className="w-4 h-4 shrink-0" />
                        <span>{successMsg}</span>
                    </div>
                )}

                <form onSubmit={handleConnect} className="space-y-4">
                    <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-1">Target Desktop LAN IP</label>
                        <input
                            type="text"
                            placeholder="e.g. 192.168.1.50"
                            value={targetIp}
                            onChange={(e) => setTargetIp(e.target.value)}
                            className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                            disabled={isLoading}
                        />
                    </div>

                    <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-1">Target Daemon Port</label>
                        <input
                            type="text"
                            placeholder="8080"
                            value={targetPort}
                            onChange={(e) => setTargetPort(e.target.value)}
                            className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                            disabled={isLoading}
                        />
                    </div>

                    <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-1">Target 6-Digit Pairing PIN</label>
                        <input
                            type="text"
                            placeholder="e.g. 482019"
                            maxLength={6}
                            value={pin}
                            onChange={(e) => setPin(e.target.value)}
                            className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-slate-100 tracking-wider font-mono placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                            disabled={isLoading}
                        />
                        <p className="text-[11px] text-slate-500 mt-1">
                            Obtain this PIN by clicking "Pair New Device" on the target desktop.
                        </p>
                    </div>

                    <button
                        type="submit"
                        disabled={isLoading}
                        className="w-full flex items-center justify-center gap-2 mt-2 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-semibold rounded-xl shadow-lg transition"
                    >
                        {isLoading ? (
                            <>
                                <Loader2 className="w-4 h-4 animate-spin" />
                                Connecting & Uniting Rosters...
                            </>
                        ) : (
                            <>
                                Connect & Federate
                                <ArrowRight className="w-4 h-4" />
                            </>
                        )}
                    </button>
                </form>
            </div>
        </div>
    );
}