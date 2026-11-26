import { useEffect, useState } from 'react';
import { Loader2, Play, X } from 'lucide-react';
import type { AgentInputField, RegisteredAgentDTO } from '../types/agentTypes';

interface Props {
    agent: RegisteredAgentDTO | null;
    onClose: () => void;
    onLaunch: (agentId: string, inputs: Record<string, unknown>) => Promise<void>;
}

function buildInitialInputs(fields: AgentInputField[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const f of fields) {
        if (f.default !== undefined) {
            out[f.key] = f.default;
        } else if (f.type === 'boolean') {
            out[f.key] = false;
        } else if (f.type === 'number') {
            out[f.key] = f.min ?? 0;
        } else if (f.type === 'select') {
            out[f.key] = f.options?.[0] ?? '';
        } else {
            out[f.key] = '';
        }
    }
    return out;
}

export function AgentLaunchModal({ agent, onClose, onLaunch }: Props) {
    const [launchInputs, setLaunchInputs] = useState<Record<string, unknown>>({});
    const [isLaunching, setIsLaunching] = useState(false);
    const [launchError, setLaunchError] = useState<string | null>(null);

    useEffect(() => {
        if (agent) {
            setLaunchInputs(buildInitialInputs(agent.manifest.inputs ?? []));
            setLaunchError(null);
            setIsLaunching(false);
        }
    }, [agent]);

    if (!agent) return null;

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        for (const field of agent.manifest.inputs ?? []) {
            if (field.required) {
                const val = launchInputs[field.key];
                if (val === undefined || val === null || String(val).trim() === '') {
                    setLaunchError(`"${field.label}" is required.`);
                    return;
                }
            }
        }

        setIsLaunching(true);
        setLaunchError(null);
        try {
            await onLaunch(agent.agentId, launchInputs);
            onClose();
        } catch (err: unknown) {
            setLaunchError(err instanceof Error ? err.message : String(err));
        } finally {
            setIsLaunching(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4">
            <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-lg p-6 shadow-2xl">
                <div className="flex items-center justify-between pb-3 border-b border-slate-800">
                    <div>
                        <h3 className="text-base font-bold text-slate-100">
                            Launch: {agent.name}
                        </h3>
                        <p className="text-xs text-slate-400 font-mono">
                            {agent.agentId} • v{agent.version}
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="text-slate-400 hover:text-slate-200"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                <form onSubmit={handleSubmit} className="mt-4 space-y-4">
                    {(agent.manifest.inputs ?? []).length === 0 ? (
                        <p className="text-xs text-slate-400">
                            This agent requires no input parameters. Click Run on Mesh to start immediately.
                        </p>
                    ) : (
                        agent.manifest.inputs.map((field) => {
                            const val = launchInputs[field.key];
                            return (
                                <div key={field.key}>
                                    <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                                        {field.label}
                                        {field.required && (
                                            <span className="text-rose-400 ml-1">*</span>
                                        )}
                                    </label>

                                    {field.type === 'textarea' && (
                                        <textarea
                                            rows={3}
                                            value={String(val ?? '')}
                                            placeholder={field.placeholder}
                                            onChange={(e) =>
                                                setLaunchInputs((prev) => ({
                                                    ...prev,
                                                    [field.key]: e.target.value,
                                                }))
                                            }
                                            className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500"
                                        />
                                    )}

                                    {field.type === 'string' && (
                                        <input
                                            type="text"
                                            value={String(val ?? '')}
                                            placeholder={field.placeholder}
                                            onChange={(e) =>
                                                setLaunchInputs((prev) => ({
                                                    ...prev,
                                                    [field.key]: e.target.value,
                                                }))
                                            }
                                            className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500"
                                        />
                                    )}

                                    {field.type === 'number' && (
                                        <input
                                            type="number"
                                            min={field.min}
                                            max={field.max}
                                            value={Number(val ?? 0)}
                                            onChange={(e) =>
                                                setLaunchInputs((prev) => ({
                                                    ...prev,
                                                    [field.key]: Number(e.target.value),
                                                }))
                                            }
                                            className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500"
                                        />
                                    )}

                                    {field.type === 'boolean' && (
                                        <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                                            <input
                                                type="checkbox"
                                                checked={Boolean(val)}
                                                onChange={(e) =>
                                                    setLaunchInputs((prev) => ({
                                                        ...prev,
                                                        [field.key]: e.target.checked,
                                                    }))
                                                }
                                                className="rounded border-slate-600 bg-slate-950 text-indigo-500"
                                            />
                                            Enabled
                                        </label>
                                    )}

                                    {field.type === 'select' && (
                                        <select
                                            value={String(val ?? '')}
                                            onChange={(e) =>
                                                setLaunchInputs((prev) => ({
                                                    ...prev,
                                                    [field.key]: e.target.value,
                                                }))
                                            }
                                            className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500"
                                        >
                                            {(field.options ?? []).map((opt) => (
                                                <option key={opt} value={opt}>
                                                    {opt}
                                                </option>
                                            ))}
                                        </select>
                                    )}
                                </div>
                            );
                        })
                    )}

                    {launchError && (
                        <div className="p-2.5 rounded-lg bg-rose-950/50 border border-rose-500/40 text-xs text-rose-200">
                            {launchError}
                        </div>
                    )}

                    <div className="flex justify-end gap-2.5 pt-2">
                        <button
                            type="button"
                            onClick={onClose}
                            className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-300 bg-slate-800 hover:bg-slate-700"
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            disabled={isLaunching}
                            className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50"
                        >
                            {isLaunching ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                                <Play className="w-3.5 h-3.5" />
                            )}
                            Run on Mesh
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}