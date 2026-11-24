import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open } from 'node:fs/promises';
import path from 'node:path';

const statOptions = { bigint: true };
const copyFallbackCodes = new Set(['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV']);

export function requireOrdinaryWindowsPath(filename) {
    if (process.platform !== 'win32' || !filename) return;
    if (/^[/\\]{2}[?.][/\\]/.test(filename) ||
        filename.slice(path.parse(filename).root.length).split(/[/\\]/).some(part => part !== '.' && part !== '..' &&
            (part.length > 255 || /[:<>|"*?\x00-\x1f]|[. ]$/.test(part) ||
                /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\s*\.|$)/i.test(part)))) {
        throw Error('Select an ordinary Windows output path.');
    }
}

function artifactError(code, message, cause) {
    return Object.assign(new Error(message, { cause }), { code });
}

function sameFile(first, second) {
    return first?.isFile() && second.isFile() && first.ino !== 0n &&
        first.ino === second.ino && first.dev === second.dev;
}

function sameSnapshot(first, second) {
    return sameFile(first, second) && first.size === second.size && first.mtimeNs === second.mtimeNs;
}

async function readStaged(handle, snapshot, expectedSha256, signal, output) {
    const hash = expectedSha256 && createHash('sha256');
    let bytes = 0n;
    for await (const chunk of handle.createReadStream({ start: 0, autoClose: false, signal })) {
        bytes += BigInt(chunk.byteLength);
        if (bytes > snapshot.size) break;
        hash?.update(chunk);
        if (output) await output.writeFile(chunk);
    }
    if (bytes !== snapshot.size || !sameSnapshot(snapshot, await handle.stat(statOptions))) {
        throw artifactError('ARTIFACT_STAGING_CHANGED', 'Staged artifact changed during verification.');
    }
    const sha256 = hash?.digest('hex');
    if (expectedSha256 && sha256 !== expectedSha256) {
        throw artifactError('ARTIFACT_DIGEST_MISMATCH', 'Staged artifact does not match the expected SHA-256.');
    }
    return sha256;
}

async function checkFinalPath(destination, snapshot) {
    try {
        if (sameSnapshot(snapshot, await lstat(destination, statOptions))) return;
    } catch (cause) {
        throw artifactError('ARTIFACT_PUBLICATION_UNVERIFIED', 'Artifact destination could not be verified.', cause);
    }
    throw artifactError('ARTIFACT_PUBLICATION_UNVERIFIED', 'Artifact destination differs from the published file.');
}

async function describeFailedCopy(destination, created) {
    if (!created) return 'ownership-unverified';
    try {
        if (!sameFile(created, await lstat(destination, statOptions))) return 'different-file';
        // The pathname can change after lstat. Keep any provisional copy for reconciliation.
        return 'retained-for-review';
    } catch (error) {
        return error.code === 'ENOENT' ? 'absent' : 'ownership-unverified';
    }
}

async function copyExclusively(source, snapshot, destination, expectedSha256, signal) {
    signal?.throwIfAborted();
    const output = await open(destination, 'wx+', 0o600);
    let created;
    try {
        created = await output.stat(statOptions);
        await readStaged(source, snapshot, undefined, signal, output);
        signal?.throwIfAborted();
        await output.sync();
        const copied = await output.stat(statOptions);
        if (!sameFile(created, copied) || copied.size !== snapshot.size) {
            throw artifactError('ARTIFACT_COPY_UNVERIFIED', 'Artifact copy did not establish the expected identity and length.');
        }
        const sha256 = expectedSha256 && await readStaged(output, copied, expectedSha256, signal);
        await output.close();
        await checkFinalPath(destination, copied);
        return { mode: 'exclusive-copy', atomic: false, bytes: Number(copied.size), ...(sha256 && { sha256 }) };
    } catch (cause) {
        await output.close().catch(() => {});
        const cleanup = await describeFailedCopy(destination, created);
        throw Object.assign(artifactError(cause.code ?? 'ARTIFACT_COPY_FAILED', 'Exclusive artifact publication failed.', cause),
            { publication: { mode: 'exclusive-copy', verified: false, cleanup } });
    }
}

// Callers finish, sync and close their private staging writer before publication.
// A hard link exposes the complete staging file without replacing a destination.
// The fallback exposes a provisional copy until verification, sync and close.
export async function publishFile(temporary, destination, { expectedBytes, expectedSha256, signal } = {}) {
    requireOrdinaryWindowsPath(destination);
    if ((expectedBytes !== undefined && (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0)) ||
        (expectedSha256 !== undefined && (typeof expectedSha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(expectedSha256)))) {
        throw TypeError('Artifact expectations must be an exact byte count and a hexadecimal SHA-256 digest.');
    }
    const digest = expectedSha256?.toLowerCase();
    signal?.throwIfAborted();
    const stagedPath = await lstat(temporary, statOptions);
    if (!stagedPath.isFile() || stagedPath.size > BigInt(Number.MAX_SAFE_INTEGER) ||
        (expectedBytes !== undefined && stagedPath.size !== BigInt(expectedBytes))) {
        throw artifactError('ARTIFACT_STAGING_CHANGED', 'Expected a regular staging file with the specified length.');
    }
    const source = await open(temporary, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        const snapshot = await source.stat(statOptions);
        if (!sameSnapshot(stagedPath, snapshot)) {
            throw artifactError('ARTIFACT_STAGING_CHANGED', 'Staged file identity changed before publication.');
        }
        if (digest) await readStaged(source, snapshot, digest, signal);
        signal?.throwIfAborted();
        try {
            await link(temporary, destination);
        } catch (error) {
            if (!copyFallbackCodes.has(error.code)) throw error;
            return await copyExclusively(source, snapshot, destination, digest, signal);
        }
        try {
            await checkFinalPath(destination, snapshot);
        } catch (error) {
            throw Object.assign(error, { publication: { mode: 'hard-link', verified: false } });
        }
        return { mode: 'hard-link', atomic: true, bytes: Number(snapshot.size), ...(digest && { sha256: digest }) };
    } finally {
        await source.close();
    }
}
