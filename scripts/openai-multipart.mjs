import { createHash } from 'node:crypto';
import path from 'node:path';

export const uploadPartBytes = 64_000_000;
const maxMultipartBytes = 8_000_000_000;
const chunkBytes = 16 * 1024 * 1024;

export function checkUpload(value, id, expectedBytes, status) {
    if (!value || (value.object !== undefined && value.object !== 'upload') ||
        typeof value.id !== 'string' || !/^upload_[A-Za-z0-9_-]{1,249}$/.test(value.id) ||
        (id && value.id !== id) || !Number.isSafeInteger(value.bytes) || value.bytes < 0 ||
        (expectedBytes !== undefined && value.bytes !== expectedBytes) || value.status !== status) {
        throw Error('Upload response did not match the expected identity, size, or state.');
    }
}

export function checkUploadMetadata(value, expected = {}) {
    for (const field of ['filename', 'purpose']) {
        if (typeof value[field] !== 'string' || !value[field].trim() ||
            (expected[field] !== undefined && value[field] !== expected[field])) {
            throw Error(`Upload metadata does not match the expected ${field}.`);
        }
    }
}

export function checkUploadedFile(file, receipt, bytes, ...expectedMetadata) {
    if (file?.object !== 'file' || typeof file.id !== 'string' || !/^file[-_][A-Za-z0-9_-]{1,251}$/.test(file.id)) {
        throw Error('Upload did not return a matching File object.');
    }
    receipt.observedFileId = file.id;
    if (file.bytes !== null && file.bytes !== bytes) {
        throw Error('Completed upload and its File disagree on the byte count.');
    }
    checkUploadMetadata(file);
    for (const expected of expectedMetadata) checkUploadMetadata(file, expected);
    return file.id;
}

export function checkCompletedFile(result, receipt, expected = {}) {
    const fileId = checkUploadedFile(result.file, receipt, result.bytes, result, expected);
    checkUploadMetadata(result, expected);
    return fileId;
}

export async function transferUpload(client, handle, filename, params, options, call, receipt, record) {
    const original = await handle.stat();
    if (!original.isFile() || original.size < 1 || original.size > maxMultipartBytes) {
        throw Error('Select a nonempty regular file within the 8 GB multipart limit.');
    }
    const { purpose, mime_type, expires_after, verify_md5: verifyMd5 = false } = params;
    if (typeof purpose !== 'string' || !purpose.trim() || typeof mime_type !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(mime_type) ||
        typeof verifyMd5 !== 'boolean' ||
        Object.keys(params).some(key => !['purpose', 'mime_type', 'expires_after', 'verify_md5'].includes(key))) {
        throw Error('Multipart transfer takes purpose, mime_type and optional expires_after or verify_md5.');
    }
    const requestedMetadata = { filename: path.basename(filename), purpose };
    await record('upload_create_pending', { bytes: original.size });
    const upload = await call('upload_create', client.uploads.create({
        bytes: original.size, ...requestedMetadata, mime_type,
        ...(expires_after ? { expires_after } : {}),
    }, options));
    checkUpload(upload, undefined, original.size, 'pending');
    receipt.uploadId = upload.id;
    checkUploadMetadata(upload, requestedMetadata);
    receipt.confirmedStep = 'upload_created';
    await record('upload_observed', { bytes: original.size });

    const partIds = [];
    const checksum = createHash('sha256');
    const optionalMd5 = verifyMd5 ? createHash('md5') : null;
    const buffer = Buffer.allocUnsafe(Math.min(original.size, chunkBytes));
    async function verifySource() {
        const current = await handle.stat();
        if (current.size !== original.size || current.mtimeMs !== original.mtimeMs || current.ctimeMs !== original.ctimeMs) {
            throw Error('Input file changed during multipart transfer.');
        }
    }
    for (let offset = 0; offset < original.size; offset += buffer.length) {
        options.signal.throwIfAborted();
        await verifySource();
        const bytes = Math.min(buffer.length, original.size - offset);
        let copied = 0;
        while (copied < bytes) {
            const { bytesRead } = await handle.read(buffer, copied, bytes - copied, offset + copied);
            if (!bytesRead) throw Error('Unexpected end of multipart source.');
            copied += bytesRead;
        }
        const data = buffer.subarray(0, bytes);
        checksum.update(data);
        optionalMd5?.update(data);
        await record('part_dispatch_pending', { offset, bytes });
        const part = await call('upload_part', client.uploads.parts.create(upload.id, {
            data: new File([data], 'part.bin'),
        }, options));
        if (part?.object !== 'upload.part' || part.upload_id !== upload.id || typeof part.id !== 'string' ||
            part.id.length > 256 || !/^(?:part|uploadpart)_[A-Za-z0-9_-]+$/.test(part.id) || partIds.includes(part.id)) {
            throw Error('Upload part response did not match the requested upload.');
        }
        partIds.push(part.id);
        receipt.partId = part.id;
        receipt.confirmedStep = 'part_uploaded';
        await record('part_observed', { partId: part.id, offset, bytes });
    }
    await verifySource();
    receipt.sourceSha256 = checksum.digest('hex');
    await record('upload_complete_pending', { partCount: partIds.length });
    const result = await call('upload_complete', client.uploads.complete(upload.id, {
        part_ids: partIds, ...(optionalMd5 ? { md5: optionalMd5.digest('hex') } : {}),
    }, options));
    checkUpload(result, upload.id, original.size, 'completed');
    receipt.fileId = checkCompletedFile(result, receipt, requestedMetadata);
    receipt.resourceStatus = result.status;
    receipt.confirmedStep = 'upload_completed';
    await record('upload_completed', { partCount: partIds.length });
    return result;
}
