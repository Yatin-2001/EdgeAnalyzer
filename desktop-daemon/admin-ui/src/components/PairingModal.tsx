import React, { useState, useEffect, useRef } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { X, Clock, ShieldCheck, RefreshCw } from 'lucide-react';

interface Props {
    isOpen: boolean;
    onClose: () => void;
}

export const PairingModal: React.FC<Props> = ({ isOpen, onClose }) => {
    const [pin, setPin] = useState<string>('');
    const [hostIp, setHostIp] = useState<string>('');
    const [port, setPort] = useState<number>(8080);
    const [timeLeft, setTimeLeft] = useState<number>(60);
    const [loading, setLoading] = useState<boolean>(false);
    const [error, setError] = useState<string | null>(null);

    const timerRef = useRef<NodeJS.Timeout | null>(null);

    const fetchPin = async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch('/api/mesh/pin/generate', { method: 'POST' });
            if (!res.ok) {
                throw new Error(`Server returned ${res.status}`);
            }
            const data = await res.json();
            setPin(data.pin);
            setHostIp(data.host || window.location.hostname);
            setPort(data.port || 8080);
            setTimeLeft(data.expiresIn || 60);
        } catch (err: any) {
            console.error('Failed to generate PIN:', err);
            setError('Cannot reach daemon. Ensure node server is running on 8080.');
        } finally {
            setLoading(false);
        }
    };

    // Lifecycle on modal open/close
    useEffect(() => {
        if (isOpen) {
            fetchPin();

            // Independent 1-second interval loop
            timerRef.current = setInterval(() => {
                setTimeLeft((prev) => {
                    if (prev <= 1) {
                        fetchPin();
                        return 60;
                    }
                    return prev - 1;
                });
            }, 1000);
        } else {
            // Reset state on close
            if (timerRef.current) clearInterval(timerRef.current);
            setPin('');
            setError(null);
            setTimeLeft(60);
        }

        return () => {
            if (timerRef.current) clearInterval(timerRef.current);
        };
    }, [isOpen]);

    if (!isOpen) return null;

    const qrPayload = JSON.stringify({
        ip: hostIp,
        port,
        pin,
    });

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
            <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl text-slate-100">
                {/* Header */}
                <div className="flex justify-between items-center pb-4 border-b border-slate-800">
                    <div className="flex items-center gap-2">
                        <ShieldCheck className="w-5 h-5 text-indigo-400" />
                        <h2 className="font-semibold text-lg">Pair New Mesh Client</h2>
                    </div>
                    <button onClick={onClose} className="text-slate-400 hover:text-white transition">
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {/* Content */}
                <div className="my-6 flex flex-col items-center">
                    {error ? (
                        <div className="w-full bg-rose-500/10 border border-rose-500/30 p-4 rounded-xl text-center mb-4">
                            <p className="text-xs text-rose-300 font-medium mb-2">{error}</p>
                            <button
                                onClick={fetchPin}
                                className="inline-flex items-center gap-1.5 text-xs bg-rose-500/20 text-rose-300 px-3 py-1.5 rounded-lg hover:bg-rose-500/30 transition"
                            >
                                <RefreshCw className="w-3.5 h-3.5" /> Retry Connection
                            </button>
                        </div>
                    ) : (
                        <>
                            {/* QR Code */}
                            <div className="bg-white p-3 rounded-xl mb-4 shadow-md">
                                {pin ? (
                                    <QRCodeSVG value={qrPayload} size={180} />
                                ) : (
                                    <div className="w-[180px] h-[180px] flex items-center justify-center text-slate-400 text-xs font-mono">
                                        {loading ? 'Generating PIN...' : 'No PIN'}
                                    </div>
                                )}
                            </div>

                            {/* Target Host */}
                            <div className="text-xs text-slate-400 font-mono mb-4">
                                Target Host: <span className="text-indigo-300 font-semibold">{hostIp || '...'}:{port}</span>
                            </div>

                            {/* PIN Code */}
                            <p className="text-xs uppercase tracking-widest text-slate-400 mb-1 font-semibold">
                                One-Time Access PIN
                            </p>
                            <div className="text-4xl font-extrabold tracking-widest font-mono text-indigo-400 bg-slate-800/80 px-6 py-2 rounded-lg border border-slate-700">
                                {loading || !pin ? '------' : `${pin.slice(0, 3)}-${pin.slice(3)}`}
                            </div>

                            {/* Countdown */}
                            <div className="flex items-center gap-2 mt-4 text-xs font-medium text-amber-400">
                                <Clock className="w-4 h-4" />
                                <span>Expires in {timeLeft} seconds</span>
                            </div>
                        </>
                    )}
                </div>

                <p className="text-xs text-slate-400 text-center leading-relaxed">
                    Open EdgeAnalyzer on your mobile device, enter this PIN or scan the QR code to establish mutual zero-trust authentication.
                </p>
            </div>
        </div>
    );
};