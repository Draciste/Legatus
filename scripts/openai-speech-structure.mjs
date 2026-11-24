import { verifyWave } from './openai-wave.mjs';
import { verifyAacMp4 } from './openai-aac-mp4.mjs';

const sideDataLimit = 16 * 1024 * 1024;
const malformed = format => Error('Incomplete or invalid speech data for ' + format + '.');
const oggTable = Uint32Array.from({ length: 256 }, (_, index) => {
    let crc = index << 24;
    for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0);
    return crc;
});

async function flacStructure(read, size) {
    if ((await read(0, 4)).toString() !== 'fLaC') return false;
    let at = 4, last = false;
    while (!last) {
        if (at > sideDataLimit) return false;
        const header = await read(at, 4), type = header[0] & 127, length = header.readUIntBE(1, 3);
        last = Boolean(header[0] & 128);
        if (type === 127 || at + 4 + length > size) return false;
        if (at === 4) {
            if (type !== 0 || length !== 34) return false;
            const streamInfo = await read(at + 4, length);
            const minBlock = streamInfo.readUInt16BE(0), maxBlock = streamInfo.readUInt16BE(2);
            const audio = streamInfo.readUInt32BE(10);
            if (minBlock < 16 || maxBlock < minBlock || !(audio >>> 12) || ((audio >>> 4) & 31) < 3) return false;
        } else if (type === 0) return false;
        at += 4 + length;
    }
    const frame = await read(at, 6);
    return frame[0] === 0xff && (frame[1] & 0xfe) === 0xf8 && frame[2] >>> 4 !== 0 &&
        (frame[2] & 15) !== 15 && frame[3] >>> 4 <= 10 && !(frame[3] & 1);
}

function opusHead(packet) {
    if (packet.length < 19 || packet.toString('latin1', 0, 8) !== 'OpusHead' ||
        !packet[8] || packet[8] > 15 || !packet[9]) return false;
    const channels = packet[9];
    if (packet[18] === 0) return channels <= 2 && (packet[8] > 1 || packet.length === 19);
    if (packet.length < 21 + channels || !packet[19] || packet[20] > packet[19] ||
        packet[19] + packet[20] > 255) return false;
    return packet.subarray(21, 21 + channels).every(channel => channel === 255 || channel < packet[19] + packet[20]);
}

function opusTags(packet) {
    if (packet.length < 16 || packet.toString('latin1', 0, 8) !== 'OpusTags') return false;
    let at = 12 + packet.readUInt32LE(8);
    if (at + 4 > packet.length) return false;
    const count = packet.readUInt32LE(at);
    at += 4;
    for (let i = 0; i < count; i++) {
        if (at + 4 > packet.length) return false;
        at += 4 + packet.readUInt32LE(at);
        if (at > packet.length) return false;
    }
    return true;
}

function opusDuration(toc, secondByte) {
    const config = toc >>> 3, code = toc & 3;
    const frame = config < 12 ? [480, 960, 1920, 2880][config & 3]
        : config < 16 ? 480 << (config & 1) : 120 << (config & 3);
    const count = code === 0 ? 1 : code === 3 ? secondByte & 63 : 2;
    const duration = frame * count;
    return duration <= 5760 ? duration : 0;
}

async function oggOpusStructure(read, size) {
    let serial, sequence = 0, packetIndex = 0, packetBytes = 0, fragments = [];
    let pages = 0, anyAudio = false, lastGranule, initial = 0n, preSkip = 0n;
    const toc = Buffer.alloc(2);
    const serials = new Set();
    const outcome = completion => anyAudio && {
        validation: completion === 'ogg-eos-verified' ? 'ogg-page-structure' : 'ogg-audio-prefix',
        completion, verifiedPages: pages,
    };
    for (let at = 0; at < size;) {
        if (pages >= 65536) return outcome('validation-limit');
        if (size - at < 27) return outcome('truncated-page');
        const header = await read(at, 27);
        const flags = header[5], currentSerial = header.readUInt32LE(14);
        const granule = header.readBigInt64LE(6), eos = Boolean(flags & 4);
        if (header.toString('latin1', 0, 4) !== 'OggS' || header[4] || flags & 0xf8 ||
            header.readUInt32LE(18) !== sequence || (serial !== undefined && serial !== currentSerial) ||
            Boolean(flags & 2) !== (sequence === 0) || Boolean(flags & 1) !== Boolean(packetBytes)) return outcome('invalid-page');
        if (sequence === 0) {
            if (serials.has(currentSerial)) return outcome('invalid-page');
            serials.add(currentSerial);
            serial = currentSerial;
        }
        if (size - at < 27 + header[26]) return outcome('truncated-page');
        const lacing = await read(at + 27, header[26]);
        const payloadSize = lacing.reduce((total, value) => total + value, 0);
        const next = at + 27 + lacing.length + payloadSize;
        if (next > size) return outcome('truncated-page');
        const payload = await read(at + 27 + lacing.length, payloadSize);
        const expectedCrc = header.readUInt32LE(22);
        header.fill(0, 22, 26);
        let checksum = 0;
        for (const part of [header, lacing, payload]) {
            for (const byte of part) checksum = (checksum << 8) ^ oggTable[(checksum >>> 24) ^ byte];
        }
        if (checksum >>> 0 !== expectedCrc) return outcome('invalid-page');
        let offset = 0, completedHeader = false, samples = 0n;
        for (const [index, length] of lacing.entries()) {
            if (packetIndex < 2) fragments.push(payload.subarray(offset, offset + length));
            else if (packetBytes < 2) payload.copy(toc, packetBytes, offset, offset + Math.min(length, 2 - packetBytes));
            packetBytes += length;
            offset += length;
            if (packetBytes > sideDataLimit) return outcome('validation-limit');
            if (length === 255) continue;
            if (packetIndex < 2) {
                const packet = Buffer.concat(fragments, packetBytes);
                if (index !== lacing.length - 1 || (packetIndex === 0 ? !opusHead(packet) : !opusTags(packet))) {
                    return outcome('invalid-page');
                }
                if (packetIndex === 0) preSkip = BigInt(packet.readUInt16LE(10));
                packetIndex++;
                completedHeader = true;
                fragments = [];
            } else {
                if (!packetBytes) return outcome('invalid-page');
                const duration = opusDuration(toc[0], packetBytes >= 2 ? toc[1] : 0);
                if (!duration) return outcome('invalid-packet-duration');
                samples += BigInt(duration);
            }
            packetBytes = 0;
        }
        if ((!sequence && packetIndex !== 1) || (eos && (packetIndex < 2 || packetBytes ||
            (lastGranule === undefined && samples === 0n)))) return outcome('invalid-page');
        if (completedHeader) {
            if (granule !== 0n) return outcome('invalid-granule');
        } else if (samples === 0n) {
            if (granule !== -1n || (eos && lastGranule - initial < preSkip)) return outcome('invalid-granule');
        } else {
            if (lastGranule === undefined) {
                if (granule < 0n || (eos ? granule < preSkip : granule < samples)) return outcome('invalid-granule');
                initial = granule > samples ? granule - samples : 0n;
            } else if (eos) {
                if (granule < lastGranule || granule > lastGranule + samples ||
                    granule - initial < preSkip) return outcome('invalid-granule');
            } else if (granule !== lastGranule + samples) return outcome('invalid-granule');
            lastGranule = granule;
            anyAudio = true;
        }
        pages++;
        if (eos) {
            if (next === size) return outcome('ogg-eos-verified');
            serial = undefined;
            sequence = packetIndex = 0;
            lastGranule = undefined;
            initial = preSkip = 0n;
        } else sequence++;
        at = next;
    }
    return outcome('missing-eos');
}

async function eventFrames(file, signal) {
    const utf8 = new TextDecoder('utf-8', { fatal: true });
    let carry = '', name = '', data = [], dataLength = 0, count = 0, completion = 'not-observed', previousCR = false;
    function line(value) {
        if (!value) {
            if (data.length) {
                count++;
                const payload = data.join('\n');
                let kind;
                try { kind = JSON.parse(payload)?.type; } catch { /* Raw SSE text is allowed. */ }
                if (kind === 'error' || name === 'error' || kind === 'speech.audio.error') completion = 'error-observed';
                else if (completion !== 'error-observed') {
                    if ((!name || name === 'speech.audio.done') && kind === 'speech.audio.done') completion = 'speech-done-observed';
                    else if (payload === '[DONE]' && completion === 'not-observed') completion = 'sentinel-observed';
                }
            }
            name = '';
            data = [];
            dataLength = 0;
            return;
        }
        const colon = value.indexOf(':');
        const field = colon < 0 ? value : value.slice(0, colon);
        const content = colon < 0 ? '' : value.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') name = content;
        if (field === 'data') {
            dataLength += content.length + 1;
            if (dataLength > sideDataLimit) throw malformed('sse');
            data.push(content);
        }
    }
    function consume(text) {
        if (!text.length) return;
        if (previousCR && text[0] === '\n') text = text.slice(1);
        const combined = carry + text;
        const lines = combined.split(/\r\n|[\r\n]/);
        carry = lines.pop();
        if (carry.length > sideDataLimit) throw malformed('sse');
        for (const value of lines) line(value);
        previousCR = text.endsWith('\r');
    }
    for await (const chunk of file.createReadStream({ start: 0, autoClose: false, signal })) {
        consume(utf8.decode(chunk, { stream: true }));
    }
    consume(utf8.decode());
    if (!count) throw malformed('sse');
    return { validation: 'sse-framing', eventCount: count, completion, partialTail: Boolean(carry || data.length) };
}

async function mp3Structure(read, size) {
    const first = await read(0, 4);
    let at = 0;
    if (first.toString('latin1', 0, 3) === 'ID3') {
        const tag = await read(0, 10), lengths = tag.subarray(6);
        if (tag[3] < 2 || tag[3] > 4 || lengths.some(byte => byte & 128)) return false;
        at = 10 + lengths.reduce((length, byte) => (length << 7) + byte, 0) +
            (tag[3] === 4 && tag[5] & 16 ? 10 : 0);
    }
    const header = at ? await read(at, 4) : first;
    const version = (header[1] >>> 3) & 3, layer = (header[1] >>> 1) & 3;
    const bitrate = header[2] >>> 4, rate = (header[2] >>> 2) & 3;
    if (header[0] !== 0xff || (header[1] & 0xe0) !== 0xe0 || version === 1 || layer !== 1 || bitrate === 15 || rate === 3) return false;
    if (bitrate === 0) return size - at > 4; // Free-format Layer III uses an externally determined frame size.
    const rates = version === 3 ? [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
        : [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
    const sampleRate = [44100, 48000, 32000][rate] / (version === 3 ? 1 : version === 2 ? 2 : 4);
    const frameSize = Math.floor((version === 3 ? 144000 : 72000) * rates[bitrate - 1] / sampleRate) + ((header[2] >>> 1) & 1);
    return at + frameSize <= size;
}

async function aacStructure(read, size) {
    const header = await read(0, 8);
    if (header[0] === 0xff && (header[1] & 0xf6) === 0xf0) {
        const length = ((header[3] & 3) << 11) | (header[4] << 3) | (header[5] >>> 5);
        return ((header[2] >>> 2) & 15) <= 12 && length > (header[1] & 1 ? 7 : 9) && length <= size &&
            { validation: 'adts-frame-header' };
    }
    if (!['ftyp', 'moov', 'styp', 'moof', 'mdat', 'free', 'wide'].includes(header.toString('latin1', 4, 8))) return false;
    return await verifyAacMp4(read, size) && { validation: 'mp4-aac-sample-map' };
}

export async function verifySpeech(file, format, size, signal) {
    if (!size) throw malformed(format);
    if (format === 'sse') return eventFrames(file, signal);
    if (format === 'wav') {
        await verifyWave(file, size, signal);
        return { validation: 'wave-structure' };
    }
    if (format === 'pcm') {
        if (size % 2) throw malformed(format);
        return { validation: 'pcm-sample-alignment' };
    }
    async function read(at, length) {
        signal.throwIfAborted();
        if (!Number.isSafeInteger(at) || !Number.isSafeInteger(length) ||
            at < 0 || length < 0 || length > size - at) throw malformed(format);
        const buffer = Buffer.alloc(length);
        let used = 0;
        while (used < length) {
            const { bytesRead } = await file.read(buffer, used, length - used, at + used);
            if (!bytesRead) throw malformed(format);
            used += bytesRead;
        }
        return buffer;
    }
    const structure = { flac: flacStructure, opus: oggOpusStructure, mp3: mp3Structure, aac: aacStructure }[format];
    const evidence = await structure?.(read, size);
    if (!evidence) throw malformed(format);
    if (evidence !== true) return evidence;
    const validation = { flac: 'streaminfo-and-frame-header', mp3: 'mpeg-frame-header' };
    return { validation: validation[format] };
}
