import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

let cachedUvBin: string | null = null;

/**
 * Resolves the `uv` executable across Windows, macOS, and Linux:
 * 1. process.env.UV_BIN
 * 2. System PATH (`where uv` / `which uv`)
 * 3. Standard user/homebrew install locations
 */
export async function resolveUvBinary(): Promise<string | null> {
    if (cachedUvBin && fs.existsSync(cachedUvBin)) {
        return cachedUvBin;
    }

    const envBin = process.env.UV_BIN?.trim();
    if (envBin && fs.existsSync(envBin)) {
        cachedUvBin = envBin;
        return cachedUvBin;
    }

    // Check PATH via OS-native lookup
    try {
        const lookupCmd = process.platform === 'win32' ? 'where' : 'which';
        const { stdout } = await execFileAsync(lookupCmd, ['uv'], { timeout: 3000 });
        const firstMatch = stdout
            .split(/\r?\n/)
            .map((l) => l.trim())
            .find((l) => l.length > 0 && fs.existsSync(l));
        if (firstMatch) {
            cachedUvBin = firstMatch;
            return cachedUvBin;
        }
    } catch {
        // Fall through to standard install locations
    }

    const home = os.homedir();
    const candidates =
        process.platform === 'win32'
            ? [
                path.join(home, '.local', 'bin', 'uv.exe'),
                path.join(home, '.cargo', 'bin', 'uv.exe'),
                path.join(process.env.LOCALAPPDATA || '', 'Programs', 'uv', 'uv.exe'),
            ]
            : [
                path.join(home, '.local', 'bin', 'uv'),
                '/opt/homebrew/bin/uv',
                '/usr/local/bin/uv',
                path.join(home, '.cargo', 'bin', 'uv'),
            ];

    for (const candidate of candidates) {
        if (candidate && fs.existsSync(candidate)) {
            cachedUvBin = candidate;
            return cachedUvBin;
        }
    }

    return null;
}

/**
 * Terminates a spawned subprocess and all its child processes cleanly across OSes.
 * - Windows: `taskkill /pid <pid> /T /F` (kills both uv.exe and child python.exe)
 * - macOS / Linux: sends SIGTERM to the negative process group (-pid), escalating to SIGKILL after 3s
 */
export async function killProcessTree(pid: number | undefined): Promise<void> {
    if (!pid || pid <= 0) return;

    if (process.platform === 'win32') {
        try {
            await execFileAsync('taskkill', ['/pid', String(pid), '/T', '/F'], { timeout: 5000 });
        } catch {
            // Process may have already exited
            try {
                process.kill(pid, 'SIGKILL');
            } catch {}
        }
        return;
    }

    // POSIX: negative PID targets the detached process group
    try {
        process.kill(-pid, 'SIGTERM');
    } catch {
        try {
            process.kill(pid, 'SIGTERM');
        } catch {
            return;
        }
    }

    await new Promise((resolve) => setTimeout(resolve, 3000));

    try {
        process.kill(-pid, 0);
        process.kill(-pid, 'SIGKILL');
    } catch {
        try {
            process.kill(pid, 'SIGKILL');
        } catch {}
    }
}

/**
 * Checks whether `targetRealPath` is contained inside `allowedRootRealPath` (cross-OS safe).
 */
export function isPathInsideRoot(targetRealPath: string, allowedRootRealPath: string): boolean {
    const normalizedTarget =
        process.platform === 'win32' ? targetRealPath.toLowerCase() : targetRealPath;
    const normalizedRoot =
        process.platform === 'win32' ? allowedRootRealPath.toLowerCase() : allowedRootRealPath;

    const rel = path.relative(normalizedRoot, normalizedTarget);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Returns OS-aware forbidden system & credential root paths that mounts can never touch.
 */
export function getDeniedMountRoots(): string[] {
    const home = os.homedir();
    const rawRoots = [
        path.join(home, '.ssh'),
        path.join(home, '.aws'),
        path.join(home, '.gnupg'),
        ...(process.platform === 'win32'
            ? [
                process.env.WINDIR || 'C:\\Windows',
                process.env.ProgramFiles || 'C:\\Program Files',
                process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
            ]
            : ['/etc', '/System', '/usr', '/bin', '/sbin', '/var/run']),
    ];

    const resolved: string[] = [];
    for (const root of rawRoots) {
        if (!root) continue;
        try {
            resolved.push(fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root));
        } catch {
            resolved.push(path.resolve(root));
        }
    }
    return resolved;
}

export function isPathInDeniedRoots(targetRealPath: string): string | null {
    for (const denied of getDeniedMountRoots()) {
        if (isPathInsideRoot(targetRealPath, denied)) {
            return denied;
        }
    }
    return null;
}

/**
 * Runs a subprocess with a strict timeout and kills the entire process tree if it exceeds `timeoutMs`.
 */
export function execCommandWithTimeout(params: {
    command: string;
    args: string[];
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs: number;
}): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
    return new Promise((resolve) => {
        const child = spawn(params.command, params.args, {
            cwd: params.cwd,
            env: params.env ?? process.env,
            detached: process.platform !== 'win32',
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });

        let stdout = '';
        let stderr = '';
        let settled = false;
        let timedOut = false;

        child.stdout?.on('data', (chunk: Buffer) => {
            if (stdout.length < 16384) stdout += chunk.toString('utf8');
        });
        child.stderr?.on('data', (chunk: Buffer) => {
            if (stderr.length < 16384) stderr += chunk.toString('utf8');
        });

        const timer = setTimeout(() => {
            if (settled) return;
            timedOut = true;
            killProcessTree(child.pid).catch(() => {});
        }, params.timeoutMs);

        child.on('error', (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ exitCode: -1, stdout, stderr: `${stderr}\n${err.message}`.trim(), timedOut });
        });

        child.on('close', (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ exitCode: code ?? -1, stdout, stderr, timedOut });
        });
    });
}