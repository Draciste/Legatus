import { createHash, randomUUID } from 'node:crypto';
import { open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { parseApiJson } from './openai-json.mjs';
import { publishFile, requireOrdinaryWindowsPath } from './publish-openai-file.mjs';
import { maxArtifactBytes } from './openai-local-limits.mjs';

const maxRows = 50000;
const maxLineBytes = 16 * 1024 * 1024;
const terminalStates = new Set(['completed', 'failed', 'expired', 'cancelled']);

function requireDownload(receipt, fileId) {
    if (Number.isSafeInteger(receipt?.bytes) && receipt.bytes > maxArtifactBytes) {
        throw Error('Artifact is over the local 1 GiB streaming limit. Retain it for separate review.');
    }
    if (typeof fileId !== 'string' || !/^file[-_][A-Za-z0-9_-]+$/.test(fileId) ||
        !receipt || receipt.fileId !== fileId || receipt.error ||
        typeof receipt.path !== 'string' || !Number.isSafeInteger(receipt.bytes) ||
        receipt.bytes < 0 || !/^[a-f0-9]{64}$/.test(receipt.sha256 ?? '')) {
        throw Error('Collect the matching file with its current files.content or batches.wait receipt, including SHA-256.');
    }
    return receipt;
}

async function scanArtifact(artifact, onRow, signal) {
    const file = await open(artifact.path, 'r');
    const checksum = createHash('sha256');
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0;
    let rows = 0;
    let fragments = [];
    let lineBytes = 0;
    function consume(piece) {
        if (piece.length) fragments.push(piece);
        lineBytes += piece.length;
        if (lineBytes > maxLineBytes) throw Error('JSONL line is over 16 MiB.');
    }
    async function finishLine() {
        const text = decoder.decode(Buffer.concat(fragments, lineBytes));
        fragments = [];
        lineBytes = 0;
        if (!text.trim()) return;
        if (++rows > maxRows) throw Error('JSONL exceeds 50,000 data rows.');
        const row = parseBatchJson(text);
        if (typeof row?.custom_id !== 'string' || !row.custom_id.length || row.custom_id.length > 1024) {
            throw Error('JSONL contains an invalid custom_id.');
        }
        await onRow(row, text.trimEnd());
    }
    try {
        const info = await file.stat();
        if (!info.isFile() || info.size !== artifact.bytes) throw Error('Artifact size differs from the recorded download.');
        for await (const chunk of file.createReadStream({ autoClose: false, signal })) {
            bytes += chunk.length;
            if (bytes > artifact.bytes) throw Error('Artifact grew during reading.');
            checksum.update(chunk);
            let start = 0;
            for (let position = chunk.indexOf(10); position !== -1; position = chunk.indexOf(10, start)) {
                consume(chunk.subarray(start, position));
                await finishLine();
                start = position + 1;
            }
            consume(chunk.subarray(start));
        }
        if (lineBytes) await finishLine();
        if (bytes !== artifact.bytes || checksum.digest('hex') !== artifact.sha256) {
            throw Error('Artifact bytes differ from the recorded download.');
        }
    } finally {
        await file.close();
    }
    return rows;
}

function classifyResultRow(row, batchStatus) {
    const status = row.response?.status_code;
    if (Number.isInteger(status) && status >= 200 && status < 300 && row.error == null && row.response?.body != null) {
        return 'returned';
    }
    if (batchStatus === 'expired' && row.response === null && row.error?.code === 'batch_expired') return 'expiredUnexecuted';
    if (row.error || (Number.isInteger(status) && status >= 400 && status < 600)) return 'reviewError';
    throw Error('A result row did not establish a response or a known error.');
}

function classifyArtifactRow(row, batchStatus, kind) {
    const result = classifyResultRow(row, batchStatus);
    if ((kind === 'output') !== (result === 'returned')) throw Error('Unexpected Batch result file for this row.');
    return result;
}

function validInputRow(row, endpoint) {
    return row.method === 'POST' && row.url === endpoint &&
        row.body && typeof row.body === 'object' && !Array.isArray(row.body);
}

export async function verifyBatchArtifacts(batch, files, signal, input) {
    const expected = { returned: batch.request_counts?.completed, errors: batch.request_counts?.failed };
    const observed = { returned: 0, errors: 0, expiredUnexecuted: 0 };
    const ids = new Set();
    try {
        for (const file of files) {
            if (file.error) return { state: 'incomplete-download', expected };
            await scanArtifact(file, row => {
                if (ids.has(row.custom_id) || ids.size >= maxRows) throw Error('Invalid or excessive Batch result identities.');
                ids.add(row.custom_id);
                const result = classifyArtifactRow(row, batch.status, file.type);
                observed[result === 'reviewError' ? 'errors' : result]++;
            }, signal);
        }
    } catch {
        return { state: signal?.aborted ? 'deadline' : 'invalid-results', expected, observed };
    }
    let inputIdsCompared = false;
    if (input) {
        const original = new Set();
        try {
            await scanArtifact(requireDownload(input, batch.input_file_id), row => {
                if (!validInputRow(row, batch.endpoint) || original.has(row.custom_id)) throw Error('Invalid original request.');
                original.add(row.custom_id);
            }, signal);
        } catch {
            return { state: signal?.aborted ? 'deadline' : 'invalid-input', expected, observed, inputIdsCompared };
        }
        inputIdsCompared = true;
        if (Array.from(ids).some(id => !original.has(id)) || (batch.status === 'completed' && ids.size !== original.size)) {
            return { state: 'input-id-mismatch', expected, observed, inputIdsCompared };
        }
    }
    if (batch.status !== 'completed' || ![expected.returned, expected.errors, batch.request_counts?.total]
        .every(count => Number.isSafeInteger(count) && count >= 0)) {
        return { state: 'counts-unconfirmed', expected, observed, inputIdsCompared };
    }
    const matches = expected.returned + expected.errors === batch.request_counts.total &&
        expected.returned === observed.returned && expected.errors === observed.errors;
    return { state: matches ? (inputIdsCompared ? 'input-ids-verified' : 'counts-verified') : 'count-mismatch',
        expected, observed, inputIdsCompared };
}

function downloadFromResult(result) {
    if (result?.receipt?.action !== 'files.content') return null;
    if (result.data?.fileId != null && result.data.fileId !== result.receipt.requestedId) {
        throw Error('The result File ID disagrees with the requested File ID.');
    }
    return { ...result.data, fileId: result.receipt.requestedId };
}

function inputFromResult(result, sourcePath) {
    if (result?.receipt?.action === 'uploads.transfer' && result.receipt.resourceStatus === 'completed' &&
        result.data?.file?.id === result.receipt.fileId && result.data.file.purpose === 'batch') {
        return { path: sourcePath, bytes: result.data.bytes, fileId: result.receipt.fileId,
            sha256: result.receipt.sourceSha256 };
    }
    return downloadFromResult(result);
}

export function parseBatchJson(text) {
    // Decision fields must be exact integers. Other numeric values stay opaque,
    // and original request lines are published directly from their input text.
    return parseApiJson(text, { preserveNumbers: true });
}

export async function planBatchRecovery({ wait, input, inputSourcePath, output, error, retryPath }) {
    requireOrdinaryWindowsPath(retryPath);
    const batch = wait?.data?.batch;
    if (wait?.receipt?.action !== 'batches.wait' || batch?.object !== 'batch' ||
        !/^batch_[A-Za-z0-9_-]+$/.test(batch.id ?? '') || batch.id !== wait.receipt.requestedId ||
        (wait.receipt.resourceId != null && wait.receipt.resourceId !== batch.id) ||
        (wait.receipt.resourceStatus != null && wait.receipt.resourceStatus !== batch.status) ||
        typeof batch.endpoint !== 'string' || !/^\/v1(?:\/[A-Za-z0-9_-]+)+$/.test(batch.endpoint) ||
        (batch.output_file_id && batch.output_file_id === batch.error_file_id) ||
        !terminalStates.has(batch.status)) {
        throw Error('A matching terminal Batch receipt with a valid endpoint and File identities is required.');
    }
    const original = requireDownload(inputFromResult(input, inputSourcePath), batch.input_file_id);
    const observed = new Map();
    for (const [kind, supplied] of [['output', output], ['error', error]]) {
        const fileId = batch[kind + '_file_id'];
        if (!fileId) continue;
        const listed = wait.data.files?.filter(file => file.type === kind && file.fileId === fileId) ?? [];
        const successful = listed.filter(receipt => !receipt.error).map(receipt => requireDownload(receipt, fileId));
        const artifact = requireDownload(supplied ? downloadFromResult(supplied) : successful[0], fileId);
        if (successful.some(receipt => receipt.bytes !== artifact.bytes || receipt.sha256 !== artifact.sha256)) {
            throw Error('Successful receipts disagree on the Batch artifact bytes.');
        }
        await scanArtifact(artifact, row => {
            if (observed.has(row.custom_id)) throw Error('Duplicate or conflicting result custom_id.');
            observed.set(row.custom_id, classifyArtifactRow(row, batch.status, kind));
        });
    }

    const tally = { returned: 0, expiredUnexecuted: 0, reviewError: 0, unresolved: 0 };
    const examples = { expiredUnexecuted: [], reviewError: [], unresolved: [] };
    const seen = new Set();
    const temporary = retryPath && path.join(path.dirname(retryPath), '.legatus-part-' + randomUUID());
    const writer = temporary && await open(temporary, 'wx', 0o600);
    const retryHash = writer && createHash('sha256');
    let retryBytes = 0;
    try {
        const total = await scanArtifact(original, async (row, text) => {
            if (seen.has(row.custom_id) || !validInputRow(row, batch.endpoint)) {
                throw Error('Input JSONL contains duplicate IDs or requests inconsistent with the recorded Batch endpoint.');
            }
            seen.add(row.custom_id);
            const state = observed.get(row.custom_id) ?? 'unresolved';
            tally[state]++;
            if (examples[state]?.length < 12) examples[state].push(row.custom_id);
            if (state === 'expiredUnexecuted' && writer) {
                const bytes = Buffer.from(text + '\n');
                await writer.writeFile(bytes);
                retryHash.update(bytes);
                retryBytes += bytes.length;
            }
        });
        if (!total || [...observed.keys()].some(id => !seen.has(id))) throw Error('Result IDs do not match the original input.');
        const counts = batch.request_counts;
        const countsMatch = Boolean(counts && Number.isSafeInteger(counts.total) && Number.isSafeInteger(counts.completed) &&
            counts.total === total && counts.completed === tally.returned &&
            Number.isSafeInteger(counts.failed) && [tally.reviewError, tally.reviewError + tally.expiredUnexecuted].includes(counts.failed));
        const canPublish = batch.status === 'expired' && countsMatch && !tally.unresolved && tally.expiredUnexecuted > 0;
        if (writer) await writer.sync();
        await writer?.close();
        const publication = canPublish && temporary ? await publishFile(temporary, retryPath,
            { expectedBytes: retryBytes, expectedSha256: retryHash.digest('hex') }) : undefined;
        return { batchId: batch.id, batchStatus: batch.status, inputFileId: batch.input_file_id, total, countsMatch,
            tally, examples, canPublish, retryPath: canPublish ? retryPath ?? null : null, publication, submitted: false,
            note: 'Returned means HTTP success. Assess the content separately. Unresolved and other errors need review.' };
    } finally {
        await writer?.close();
        if (temporary) await unlink(temporary).catch(() => {});
    }
}
