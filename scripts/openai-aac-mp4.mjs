// Verify that an AAC track maps to actual bytes in a self-contained MP4.
const aacObjectTypes = new Set([1, 2, 3, 4, 5, 6, 17, 19, 20, 23, 29, 39]);
const invalid = () => Error('Expected an MP4 with AAC samples mapped to its media payload.');
const tableEntryLimit = 1_000_000;
const fourcc = (buffer, at) => buffer.toString('latin1', at, at + 4);

function descriptor(bytes, start, end) {
    const tag = bytes[start++];
    let length = 0;
    for (let count = 0; count < 4 && start < end; count++) {
        const byte = bytes[start++];
        length = length * 128 + (byte & 127);
        if (!(byte & 128)) return start + length <= end ? { tag, start, end: start + length } : undefined;
    }
}

function declaredAac(bytes) {
    const es = descriptor(bytes, 4, bytes.length);
    if (es?.tag !== 3 || es.end - es.start < 3) return false;
    const flags = bytes[es.start + 2];
    let at = es.start + 3 + (flags & 0x80 ? 2 : 0);
    if (flags & 0x40) at += 1 + bytes[at];
    if (flags & 0x20) at += 2;
    const decoder = descriptor(bytes, at, es.end);
    if (decoder?.tag !== 4 || decoder.end - decoder.start < 13 ||
        (bytes[decoder.start + 1] >>> 2) !== 5) return false;
    const indication = bytes[decoder.start];
    if ([0x66, 0x67, 0x68].includes(indication)) return true;
    if (indication !== 0x40) return false;
    const config = descriptor(bytes, decoder.start + 13, decoder.end);
    if (config?.tag !== 5 || config.end - config.start < 2) return false;
    const objectType = bytes[config.start] >>> 3;
    const extended = 32 + ((bytes[config.start] & 7) << 3) + (bytes[config.start + 1] >>> 5);
    return aacObjectTypes.has(objectType === 31 ? extended : objectType);
}

export async function verifyAacMp4(read, size) {
    let count = 0;
    async function* boxes(start, end) {
        for (let at = start; at < end;) {
            if (++count > 65536 || end - at < 8) throw invalid();
            const head = await read(at, 8);
            const type = fourcc(head, 4);
            let length = head.readUInt32BE(0), headerBytes = 8;
            if (length === 1) {
                if (end - at < 16) throw invalid();
                const extended = (await read(at + 8, 8)).readBigUInt64BE();
                if (extended > BigInt(end - at)) throw invalid();
                length = Number(extended);
                headerBytes = 16;
            } else if (!length) length = end - at;
            if (length < headerBytes || length > end - at) throw invalid();
            yield { type, offset: at, start: at + headerBytes, end: at + length };
            at += length;
        }
    }
    async function child(parent, type) {
        if (parent) for await (const box of boxes(parent.start, parent.end)) if (box.type === type) return box;
    }
    async function bytes(box, length) {
        if (box && box.end - box.start >= length) return read(box.start, length);
    }
    async function mediaDuration(media) {
        const header = await child(media, 'mdhd');
        const fullBox = await bytes(header, 4);
        if (!fullBox || fullBox[0] > 1 || fullBox.readUIntBE(1, 3)) throw invalid();
        const wide = fullBox[0] === 1;
        const data = await bytes(header, wide ? 36 : 24);
        if (!data || !data.readUInt32BE(wide ? 20 : 12)) throw invalid();
        if (wide) {
            const duration = data.readBigUInt64BE(24);
            return duration === 0xffffffffffffffffn ? null : duration;
        }
        const duration = data.readUInt32BE(16);
        return duration === 0xffffffff ? null : BigInt(duration);
    }
    async function sampleDescription(entry) {
        const head = await bytes(entry, 28);
        if (!head) return false;
        const fixedLength = { 0: 28, 1: 44, 2: 64 }[head.readUInt16BE(8)];
        if (!fixedLength || entry.start + fixedLength > entry.end) return false;
        const sampleBoxes = { start: entry.start + fixedLength, end: entry.end };
        const esds = await child(sampleBoxes, 'esds') ?? await child(await child(sampleBoxes, 'wave'), 'esds');
        const length = esds && esds.end - esds.start;
        return length >= 6 && length <= 65536 && declaredAac(await read(esds.start, length));
    }
    const mediaPayloads = [], fragments = [];
    let movie;
    for await (const box of boxes(0, size)) {
        if (box.type === 'ftyp' && box.end - box.start < 8) throw invalid();
        if (box.type === 'mdat' && box.start < box.end) mediaPayloads.push(box);
        if (box.type === 'moof') fragments.push(box);
        if (box.type === 'moov') {
            if (movie) throw invalid();
            movie = box;
        }
    }
    if (!movie || !mediaPayloads.length) return false;

    function inMedia(start, length) {
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) ||
            start < 0 || length <= 0 || length > size - start) return false;
        let low = 0, high = mediaPayloads.length;
        while (low < high) {
            const mid = (low + high) >>> 1;
            const media = mediaPayloads[mid];
            if (start < media.start) high = mid;
            else if (start >= media.end) low = mid + 1;
            else return length <= media.end - start;
        }
        return false;
    }

    async function tableBytes(box, skip, entries, length) {
        if (!box || entries > tableEntryLimit || box.end - box.start !== skip + length) throw invalid();
        return read(box.start + skip, length);
    }

    async function classicDuration(table, sampleCount) {
        const box = await child(table, 'stts');
        const header = await bytes(box, 8);
        if (!header || header.readUInt32BE(0)) throw invalid();
        const count = header.readUInt32BE(4);
        const runs = await tableBytes(box, 8, count, count * 8);
        let samples = 0, duration = 0n;
        for (let at = 0; at < runs.length; at += 8) {
            const length = runs.readUInt32BE(at), delta = runs.readUInt32BE(at + 4);
            if (!length || !delta || length > sampleCount - samples) throw invalid();
            samples += length;
            duration += BigInt(length) * BigInt(delta);
        }
        if (samples !== sampleCount) throw invalid();
        return duration;
    }

    async function classicSamples(table, descriptions) {
        const sizeBox = await child(table, 'stsz') ?? await child(table, 'stz2');
        const sizeHeader = await bytes(sizeBox, 12);
        if (!sizeHeader) throw invalid();
        const sampleCount = sizeHeader.readUInt32BE(8);
        const constantSize = sizeBox.type === 'stsz' ? sizeHeader.readUInt32BE(4) : 0;
        const bits = sizeBox.type === 'stsz' ? 32 : sizeHeader[7];
        if (![4, 8, 16, 32].includes(bits) || (bits === 32 && sizeBox.type === 'stz2')) throw invalid();
        const sizes = await tableBytes(sizeBox, 12, constantSize ? 0 : sampleCount,
            constantSize ? 0 : Math.ceil(sampleCount * bits / 8));
        function sampleSize(index) {
            if (bits === 4) return (sizes[index >>> 1] >>> (index % 2 ? 0 : 4)) & 15;
            return sizes.readUIntBE(index * (bits / 8), bits / 8);
        }
        const chunkBox = await child(table, 'stco') ?? await child(table, 'co64');
        const runBox = await child(table, 'stsc');
        const chunkHeader = await bytes(chunkBox, 8), runHeader = await bytes(runBox, 8);
        const duration = await classicDuration(table, sampleCount);
        if (!sampleCount && !chunkBox && !runBox) return { found: false, duration };
        if (!chunkHeader || !runHeader) throw invalid();
        const chunkCount = chunkHeader.readUInt32BE(4), runCount = runHeader.readUInt32BE(4);
        const offsetWidth = chunkBox.type === 'stco' ? 4 : 8;
        const chunks = await tableBytes(chunkBox, 8, chunkCount, chunkCount * offsetWidth);
        const runs = await tableBytes(runBox, 8, runCount, runCount * 12);
        if (!sampleCount && !chunkCount && !runCount) return { found: false, duration };
        if (!sampleCount || !chunkCount || !runCount || runs.readUInt32BE(0) !== 1) throw invalid();

        let sample = 0, found = false;
        for (let run = 0; run < runCount; run++) {
            const first = runs.readUInt32BE(run * 12), perChunk = runs.readUInt32BE(run * 12 + 4);
            const description = descriptions[runs.readUInt32BE(run * 12 + 8)];
            const next = run + 1 < runCount ? runs.readUInt32BE((run + 1) * 12) : chunkCount + 1;
            if (!description || !perChunk || next <= first || next > chunkCount + 1 ||
                (next - first) * perChunk > sampleCount - sample) throw invalid();
            for (let chunk = first - 1; chunk < next - 1; chunk++) {
                const offset = offsetWidth === 4 ? chunks.readUInt32BE(chunk * 4) : Number(chunks.readBigUInt64BE(chunk * 8));
                let length = constantSize * perChunk;
                if (!constantSize) {
                    for (let i = sample; i < sample + perChunk; i++) {
                        const value = sampleSize(i);
                        if (description.aac && !value) throw invalid();
                        length += value;
                    }
                }
                if (description.aac && (!description.local || !inMedia(offset, length))) throw invalid();
                sample += perChunk;
            }
            found ||= description.aac;
        }
        if (sample !== sampleCount) throw invalid();
        return { found, duration };
    }

    const audioTracks = new Map(), defaults = new Map(), decodeEnds = new Map();
    const declaredDurations = new Map(), fragmentedTracks = new Set();
    let found = false;
    for await (const track of boxes(movie.start, movie.end)) {
        if (track.type !== 'trak') continue;
        const media = await child(track, 'mdia');
        const handler = await bytes(await child(media, 'hdlr'), 12);
        if (!handler || fourcc(handler, 8) !== 'soun') continue;
        const info = await child(media, 'minf');
        const table = await child(info, 'stbl');
        const stsd = await child(table, 'stsd');
        const heading = await bytes(stsd, 8);
        if (!heading) continue;
        const dref = await child(await child(info, 'dinf'), 'dref');
        const references = [false];
        if (dref) {
            const header = await bytes(dref, 8);
            if (!header) throw invalid();
            for await (const entry of boxes(dref.start + 8, dref.end)) {
                const fields = await bytes(entry, 4);
                references.push(Boolean(fields && (fields.readUInt32BE() & 1)));
            }
            if (references.length - 1 !== header.readUInt32BE(4)) throw invalid();
        }
        const descriptions = [null];
        for await (const entry of boxes(stsd.start + 8, stsd.end)) {
            const aac = entry.type === 'mp4a' && await sampleDescription(entry);
            const reference = aac && (await read(entry.start + 6, 2)).readUInt16BE();
            descriptions.push({ aac, local: dref ? references[reference] : reference === 1 });
        }
        if (!descriptions.some(entry => entry?.aac)) continue;
        if (descriptions.length - 1 !== heading.readUInt32BE(4)) throw invalid();
        const tkhd = await child(track, 'tkhd');
        const version = await bytes(tkhd, 1);
        const trackIdOffset = version?.[0] === 1 ? 20 : 12;
        const fields = await bytes(tkhd, trackIdOffset + 4);
        const id = fields?.readUInt32BE(trackIdOffset);
        if (!id || version[0] > 1 || audioTracks.has(id)) throw invalid();
        audioTracks.set(id, descriptions);
        declaredDurations.set(id, await mediaDuration(media));
        const classic = await classicSamples(table, descriptions);
        decodeEnds.set(id, classic.duration);
        found ||= classic.found;
    }
    if (!audioTracks.size) return false;
    const mvex = await child(movie, 'mvex');
    if (mvex) for await (const box of boxes(mvex.start, mvex.end)) {
        if (box.type !== 'trex') continue;
        const fields = await bytes(box, 24);
        if (!fields || defaults.has(fields.readUInt32BE(4))) throw invalid();
        defaults.set(fields.readUInt32BE(4), { description: fields.readUInt32BE(8),
            duration: fields.readUInt32BE(12), size: fields.readUInt32BE(16) });
    }

    for (const moof of fragments) {
        let previousEnd = moof.offset;
        for await (const traf of boxes(moof.start, moof.end)) {
            if (traf.type !== 'traf') continue;
            const tfhd = await child(traf, 'tfhd');
            const header = await bytes(tfhd, 8);
            if (!header) throw invalid();
            const flags = header.readUIntBE(1, 3), id = header.readUInt32BE(4);
            if (header[0] || flags & ~0x03003b) throw invalid();
            const fieldBytes = (flags & 1 ? 8 : 0) + [2, 8, 16, 32].filter(bit => flags & bit).length * 4;
            const fields = await tableBytes(tfhd, 8, 0, fieldBytes);
            let at = 0, base = flags & 0x020000 ? moof.offset : previousEnd;
            if (flags & 1) {
                base = Number(fields.readBigUInt64BE(at));
                at += 8;
            }
            const track = audioTracks.get(id), trackDefaults = defaults.get(id);
            const descriptionIndex = flags & 2 ? fields.readUInt32BE(at) : trackDefaults?.description;
            if (flags & 2) at += 4;
            const defaultDuration = flags & 8 ? fields.readUInt32BE(at) : trackDefaults?.duration;
            if (flags & 8) at += 4;
            const defaultSize = flags & 16 ? fields.readUInt32BE(at) : trackDefaults?.size;
            const description = track?.[descriptionIndex];
            let decodeTime = decodeEnds.get(id);
            if (track) {
                const tfdt = await child(traf, 'tfdt');
                if (tfdt) {
                    const header = await bytes(tfdt, 4);
                    if (!header || header[0] > 1 || header.readUIntBE(1, 3)) throw invalid();
                    const data = await tableBytes(tfdt, 4, 0, header[0] ? 8 : 4);
                    const start = header[0] ? data.readBigUInt64BE() : BigInt(data.readUInt32BE());
                    if (start < decodeTime) throw invalid();
                    decodeTime = start;
                }
            }
            let end = base, lastDataEnd;
            for await (const trun of boxes(traf.start, traf.end)) {
                if (trun.type !== 'trun') continue;
                const run = await bytes(trun, 8);
                if (!run) throw invalid();
                const options = run.readUIntBE(1, 3), samples = run.readUInt32BE(4);
                if (run[0] > 1 || options & ~0x0f05 || (flags & 0x010000 && samples) ||
                    (track && samples && !description)) throw invalid();
                const sizeOffset = options & 0x100 ? 4 : 0;
                const stride = [0x100, 0x200, 0x400, 0x800].filter(bit => options & bit).length * 4;
                const prefix = (options & 1 ? 4 : 0) + (options & 4 ? 4 : 0);
                const entries = await tableBytes(trun, 8, stride ? samples : 0, prefix + stride * samples);
                const start = options & 1 ? base + entries.readInt32BE() : end;
                let length = samples ? defaultSize * samples : 0;
                if (options & 0x200) {
                    length = 0;
                    for (let i = 0; i < samples; i++) {
                        const value = entries.readUInt32BE(prefix + i * stride + sizeOffset);
                        if (description?.aac && !value) throw invalid();
                        length += value;
                    }
                }
                if (description?.aac && samples) {
                    if (!description.local || !inMedia(start, length)) throw invalid();
                    found = true;
                }
                if (track && samples) {
                    fragmentedTracks.add(id);
                    if (options & 0x100) {
                        for (let i = 0; i < samples; i++) {
                            const delta = entries.readUInt32BE(prefix + i * stride);
                            if (!delta) throw invalid();
                            decodeTime += BigInt(delta);
                        }
                    } else {
                        if (!defaultDuration) throw invalid();
                        decodeTime += BigInt(samples) * BigInt(defaultDuration);
                    }
                }
                end = start + length;
                if (samples) lastDataEnd = lastDataEnd === undefined ? end : Math.max(lastDataEnd, end);
            }
            if (track) decodeEnds.set(id, decodeTime);
            previousEnd = lastDataEnd ?? end;
        }
    }
    for (const [id, duration] of declaredDurations) {
        if (!fragmentedTracks.has(id) && duration !== null && duration !== decodeEnds.get(id)) throw invalid();
    }
    return found;
}
