const pcm = 1;
const ieeeFloat = 3;
const extensible = 0xfffe;
const standardSubtypeSuffix = Buffer.from('00001000800000aa00389b71', 'hex');

// Inspect chunks by offset, without holding the samples in memory.
export async function verifyWave(file, size, signal) {
    const invalid = () => Error('WAV chunk sizes or sample alignment do not match the received file.');
    const read = async (offset, length) => {
        signal?.throwIfAborted();
        if (offset + length > size) throw invalid();
        const buffer = Buffer.alloc(length);
        let used = 0;
        while (used < length) {
            const { bytesRead } = await file.read(buffer, used, length - used, offset + used);
            if (!bytesRead) throw invalid();
            used += bytesRead;
        }
        return buffer;
    };
    const header = await read(0, 12);
    const rf64 = header.toString('latin1', 0, 4) === 'RF64';
    if ((!rf64 && header.toString('latin1', 0, 4) !== 'RIFF') || header.toString('latin1', 8, 12) !== 'WAVE') {
        throw Error('Expected a RIFF/WAVE or RF64/WAVE container.');
    }
    let offset = 12;
    let extendedSize, extendedFrames;
    if (rf64) {
        const ds64 = await read(offset, 36);
        const length = ds64.readUInt32LE(4);
        if (header.readUInt32LE(4) !== 0xffffffff || ds64.toString('latin1', 0, 4) !== 'ds64' ||
            length < 28 || ds64.readBigUInt64LE(8) !== BigInt(size - 8) || ds64.readUInt32LE(32) !== 0) throw invalid();
        extendedSize = ds64.readBigUInt64LE(16);
        extendedFrames = ds64.readBigUInt64LE(24);
        if (extendedSize > BigInt(size)) throw invalid();
        offset += 8 + length + (length % 2);
    } else if (header.readUInt32LE(4) !== size - 8) {
        throw invalid();
    }
    let alignment, sampleBytes, factFrames;
    let linear = false;
    for (let chunks = 0; offset < size; chunks++) {
        if (chunks >= 65536) throw invalid();
        const chunk = await read(offset, 8);
        const kind = chunk.toString('latin1', 0, 4);
        let length = chunk.readUInt32LE(4);
        if (rf64 && kind === 'data' && length === 0xffffffff) length = Number(extendedSize);
        const start = offset + 8;
        offset = start + length + (length % 2);
        if (offset > size) throw invalid();
        if (kind === 'fmt ') {
            if (alignment !== undefined || length < 16) throw invalid();
            const format = await read(start, 16);
            const channels = format.readUInt16LE(2);
            const sampleRate = format.readUInt32LE(4);
            const bits = format.readUInt16LE(14);
            alignment = format.readUInt16LE(12);
            if (!alignment || !channels || !sampleRate) throw invalid();
            let encoding = format.readUInt16LE(0);
            let validBits = bits;
            if (encoding === extensible) {
                if (length < 40) throw invalid();
                const extension = await read(start + 16, 24);
                const extraBytes = extension.readUInt16LE(0);
                if (extraBytes < 22 || extraBytes + 18 > length) throw invalid();
                if (extension.subarray(12).equals(standardSubtypeSuffix)) {
                    encoding = extension.readUInt32LE(8);
                    validBits = extension.readUInt16LE(2);
                }
            }
            if (encoding === pcm || encoding === ieeeFloat) {
                linear = true;
                if (!bits || bits % 8 || !validBits || validBits > bits ||
                    alignment !== channels * bits / 8 || format.readUInt32LE(8) !== sampleRate * alignment) throw invalid();
                if (encoding === ieeeFloat && ((bits !== 32 && bits !== 64) || validBits !== bits)) throw invalid();
            }
        } else if (rf64 && kind === 'fact') {
            if (factFrames !== undefined || length < 4) throw invalid();
            factFrames = (await read(start, 4)).readUInt32LE(0);
        } else if (kind === 'data') {
            if (!alignment || sampleBytes !== undefined || !length || length % alignment ||
                (rf64 && extendedSize !== BigInt(length))) throw invalid();
            sampleBytes = length;
        }
    }
    if (offset !== size || !sampleBytes) throw invalid();
    if (rf64 && linear) {
        const frames = BigInt(sampleBytes / alignment);
        if ((extendedFrames !== 0n && extendedFrames !== frames) ||
            (factFrames === 0xffffffff && extendedFrames !== frames) ||
            (factFrames > 0 && factFrames !== 0xffffffff && BigInt(factFrames) !== frames)) throw invalid();
    }
}
