import { inflateSync } from 'node:zlib';

const pngMagic = '89504e470d0a1a0a';
const pngDepths = new Map([[0, [1, 2, 4, 8, 16]], [2, [8, 16]], [3, [1, 2, 4, 8]], [4, [8, 16]], [6, [8, 16]]]);
const pngChannels = new Map([[0, 1], [2, 3], [3, 1], [4, 2], [6, 4]]);
const pngScanBudget = 16 * 1024 * 1024;
const adam7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
const svgNamespace = 'http://www.w3.org/2000/svg';
const crcTable = Uint32Array.from({ length: 256 }, (_, seed) => {
    let crc = seed;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    return crc;
});

function paeth(left, above, upperLeft) {
    const prediction = left + above - upperLeft;
    const a = Math.abs(prediction - left), b = Math.abs(prediction - above), c = Math.abs(prediction - upperLeft);
    return a <= b && a <= c ? left : b <= c ? above : upperLeft;
}

function indexedRowFits(raw, first, previous, length, width, depth, palette, filter) {
    const perByte = 8 / depth, mask = (1 << depth) - 1;
    for (let column = 0; column < length; column++) {
        const left = column ? raw[first + column - 1] : 0;
        const above = previous === undefined ? 0 : raw[previous + column];
        const upperLeft = previous === undefined || !column ? 0 : raw[previous + column - 1];
        const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? above :
            filter === 3 ? (left + above) >>> 1 : paeth(left, above, upperLeft);
        raw[first + column] += predictor;
        const last = Math.min(width - column * perByte, perByte);
        for (let pixel = 0; pixel < last; pixel++) {
            const index = (raw[first + column] >>> (8 - (pixel + 1) * depth)) & mask;
            if (index >= palette) return false;
        }
    }
    return true;
}

function pngScanlines(bytes, start, size, lastIdatStart, header, passes, indexed) {
    if (size < 8) return false;
    const [first, second] = header;
    if ((first & 15) !== 8 || first >> 4 > 7 || ((first * 256 + second) % 31) !== 0 || (second & 32)) return false;
    const expected = passes.reduce((sum, pass) => sum + pass.stride * pass.rows, 0);
    if (expected > pngScanBudget) return { pngDataValidation: 'zlib-header-only' };
    const compressed = Buffer.allocUnsafe(size);
    for (let at = start, copied = 0; copied < size;) {
        const chunkSize = bytes.readUInt32BE(at);
        bytes.copy(compressed, copied, at + 8, at + 8 + chunkSize);
        copied += chunkSize;
        at += chunkSize + 12;
    }
    let at = 0;
    const { buffer: raw, engine } = inflateSync(compressed, { info: true, maxOutputLength: expected });
    if (raw.length !== expected || engine.bytesWritten < lastIdatStart) return false;
    for (const { stride, rows, width } of passes) {
        let previous;
        for (let row = 0; row < rows; row++, at += stride) {
            const filter = raw[at];
            if (filter > 4) return false;
            if (indexed && indexed.palette < 1 << indexed.depth &&
                !indexedRowFits(raw, at + 1, previous, stride - 1, width, indexed.depth, indexed.palette, filter)) return false;
            previous = at + 1;
        }
    }
    const trailing = size - engine.bytesWritten;
    return { pngDataValidation: 'filtered-scanlines', ...(indexed ? { pngPaletteValidation: 'indices-checked' } : {}),
        ...(trailing ? { pngTrailingIdatBytes: trailing } : {}) };
}

function pngStructure(bytes) {
    if (bytes.subarray(0, 8).toString('hex') !== pngMagic) return false;
    let imageData = 0, idatStart, lastIdatStart = 0, color, depth, passes, palette = 0, transparency = false, idatClosed = false;
    const zlibHeader = [];
    for (let at = 8; at + 12 <= bytes.length;) {
        const size = bytes.readUInt32BE(at);
        const type = bytes.toString('latin1', at + 4, at + 8);
        const data = at + 8, end = data + size;
        if (size > 0x7fffffff || end + 4 > bytes.length || !/^[A-Za-z]{4}$/.test(type)) return false;
        let crc = 0xffffffff;
        for (let offset = at + 4; offset < end; offset++) crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[offset]) & 255];
        if (((crc ^ 0xffffffff) >>> 0) !== bytes.readUInt32BE(end)) return false;
        if (at === 8) {
            if (type !== 'IHDR' || size !== 13) return false;
            const width = bytes.readUInt32BE(data), height = bytes.readUInt32BE(data + 4);
            depth = bytes[data + 8];
            color = bytes[data + 9];
            const interlace = bytes[data + 12];
            if (!width || !height || width > 0x7fffffff || height > 0x7fffffff ||
                !pngDepths.get(color)?.includes(depth) || bytes[data + 10] || bytes[data + 11] || interlace > 1) return false;
            passes = (interlace ? adam7 : [[0, 0, 1, 1]]).flatMap(([x, y, dx, dy]) => width > x && height > y
                ? [{ width: Math.ceil((width - x) / dx),
                    stride: 1 + Math.ceil(Math.ceil((width - x) / dx) * pngChannels.get(color) * depth / 8),
                    rows: Math.ceil((height - y) / dy) }] : []);
        } else if (type === 'IDAT') {
            if (idatClosed || (color === 3 && !palette)) return false;
            idatStart ??= at;
            for (let offset = data; offset < end && zlibHeader.length < 2; offset++) zlibHeader.push(bytes[offset]);
            if (size) lastIdatStart = imageData;
            imageData += size;
        } else {
            if (idatStart !== undefined) idatClosed = true;
            if (type === 'PLTE') {
                if (palette || transparency || idatClosed || color === 0 || color === 4 || !size || size % 3 ||
                    size > 3 * (color === 3 ? 2 ** depth : 256)) return false;
                palette = size / 3;
            } else if (type === 'tRNS') {
                if (transparency || idatClosed) return false;
                const samples = color === 0 ? 1 : color === 2 ? 3 : 0;
                if (color === 3 ? (!palette || !size || size > palette) :
                    (!samples || size !== 2 * samples)) return false;
                for (let i = 0; i < samples; i++) if (bytes.readUInt16BE(data + 2 * i) >= 2 ** depth) return false;
                transparency = true;
            } else if (type === 'IEND') {
                return size === 0 && end + 4 === bytes.length &&
                    pngScanlines(bytes, idatStart, imageData, lastIdatStart, zlibHeader, passes, color === 3 && { depth, palette });
            } else if (/^[A-Z]/.test(type)) return false;
        }
        at = end + 4;
    }
    return false;
}

function gifStructure(bytes) {
    if (bytes.length < 14 || !/^GIF8[79]a$/.test(bytes.toString('latin1', 0, 6)) ||
        !bytes.readUInt16LE(6) || !bytes.readUInt16LE(8)) return false;
    const palette = flags => flags & 0x80 ? 3 * (2 << (flags & 7)) : 0;
    const screenWidth = bytes.readUInt16LE(6), screenHeight = bytes.readUInt16LE(8);
    const globalPalette = palette(bytes[10]);
    let at = 13 + globalPalette, count = 0, controlPresent = false, transparentIndex;
    while (at < bytes.length) {
        const type = bytes[at++];
        if (type === 0x3b) return count > 0 && !controlPresent && at === bytes.length;
        if (type === 0x21 && at < bytes.length) {
            const label = bytes[at++];
            if (label === 0xf9) {
                if (controlPresent || at + 6 > bytes.length || bytes[at] !== 4 ||
                    bytes[at + 5] !== 0 || (bytes[at + 1] & 0xe0)) return false;
                controlPresent = true;
                if (bytes[at + 1] & 1) transparentIndex = bytes[at + 4];
                at += 6;
                continue;
            }
            if (label === 0x01 || label === 0xff) {
                const length = label === 0x01 ? 12 : 11;
                if (bytes[at] !== length || at + 1 + length >= bytes.length) return false;
                if (label === 0x01) {
                    if (globalPalette && transparentIndex >= globalPalette / 3) return false;
                    controlPresent = false;
                    transparentIndex = undefined;
                }
            }
        }
        else if (type === 0x2c && at + 9 < bytes.length) {
            const width = bytes.readUInt16LE(at + 4), height = bytes.readUInt16LE(at + 6);
            if (!width || !height || bytes.readUInt16LE(at) + width > screenWidth ||
                bytes.readUInt16LE(at + 2) + height > screenHeight) return false;
            const localPalette = palette(bytes[at + 8]), activePalette = localPalette || globalPalette;
            if (activePalette && transparentIndex >= activePalette / 3) return false;
            controlPresent = false;
            transparentIndex = undefined;
            at += 9 + localPalette;
            if (bytes[at] < 2 || bytes[at] > 8 || !bytes[at + 1]) return false;
            at++;
            count++;
        } else return false;
        while (at < bytes.length && bytes[at] !== 0) at += bytes[at] + 1;
        if (at >= bytes.length) return false;
        at++;
    }
    return false;
}

function jpegStructure(bytes) {
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
    let at = 2, components, needsLines = false, hasDnl = false, scans = 0, scanData = false, inEntropy = false;
    while (at < bytes.length) {
        if (inEntropy) {
            const markerOffset = bytes.indexOf(0xff, at);
            if (markerOffset > at) scanData = true;
            at = markerOffset;
        }
        if (at < 0 || bytes[at++] !== 0xff) return false;
        while (bytes[at] === 0xff) at++;
        const marker = bytes[at++];
        if (inEntropy && marker === 0) { scanData = true; continue; }
        if (inEntropy && marker >= 0xd0 && marker <= 0xd7) continue;
        if (marker === 0xd9) return Boolean(components) && !needsLines && scanData && at === bytes.length;
        if (!marker || marker === 0xd8 || at + 2 > bytes.length) return false;
        const size = bytes.readUInt16BE(at);
        if (size < 2 || at + size > bytes.length) return false;
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
            if (needsLines || size < 8 || bytes.readUInt16BE(at + 5) === 0 ||
                !bytes[at + 7] || size !== 8 + 3 * bytes[at + 7]) return false;
            components = new Set();
            for (let i = at + 8; i < at + size; i += 3) {
                if (components.has(bytes[i])) return false;
                components.add(bytes[i]);
            }
            needsLines = bytes.readUInt16BE(at + 3) === 0;
            hasDnl = false;
            scans = 0;
        } else if (marker === 0xdc) {
            if (!inEntropy || !scanData || scans !== 1 || hasDnl || size !== 4 || !bytes.readUInt16BE(at + 2)) return false;
            needsLines = false;
            hasDnl = true;
        } else if (inEntropy && needsLines) {
            return false;
        }
        inEntropy = marker === 0xda;
        if (inEntropy) {
            const count = bytes[at + 2];
            if (!components || (needsLines && scans) || size < 6 || !count || count > 4 || size !== 6 + 2 * count) return false;
            const selected = new Set();
            for (let i = 0; i < count; i++) {
                const selector = bytes[at + 3 + 2 * i];
                if (!components.has(selector) || selected.has(selector)) return false;
                selected.add(selector);
            }
            scans++;
        }
        at += size;
    }
    return false;
}

function webpChunks(bytes, start, end, frame) {
    let pixels = false, animated = false, animationHeader = false, animationFrames = 0, alpha = false;
    let canvas = frame;
    for (let at = start; at < end;) {
        if (at + 8 > end) return false;
        const type = bytes.toString('latin1', at, at + 4);
        const size = bytes.readUInt32LE(at + 4);
        const data = at + 8, next = data + size + (size & 1);
        if (next > end || ((size & 1) && bytes[next - 1] !== 0)) return false;
        if (type === 'VP8 ') {
            if (pixels || animated || size <= 10 || (bytes[data] & 1) ||
                bytes.subarray(data + 3, data + 6).toString('hex') !== '9d012a') return false;
            const width = bytes.readUInt16LE(data + 6) & 0x3fff, height = bytes.readUInt16LE(data + 8) & 0x3fff;
            if (!width || !height || (canvas && (canvas.width !== width || canvas.height !== height))) return false;
            pixels = true;
        } else if (type === 'VP8L') {
            if (pixels || animated || alpha || size <= 5 || bytes[data] !== 0x2f) return false;
            const header = bytes.readUInt32LE(data + 1);
            if (header >>> 29 || (canvas &&
                (canvas.width !== (header & 0x3fff) + 1 || canvas.height !== ((header >>> 14) & 0x3fff) + 1))) return false;
            pixels = true;
        } else if (type === 'VP8X') {
            if (frame || size !== 10 || at !== start) return false;
            canvas = { width: bytes.readUIntLE(data + 4, 3) + 1, height: bytes.readUIntLE(data + 7, 3) + 1 };
            if (canvas.width * canvas.height > 0xffffffff) return false;
            animated = Boolean(bytes[data] & 2);
        } else if (type === 'ALPH') {
            if (!canvas || animated || pixels || alpha || size <= 1) return false;
            const method = bytes[data] & 3;
            if (method > 1 || (method === 0 && size !== 1 + canvas.width * canvas.height)) return false;
            alpha = true;
        } else if (type === 'ANIM') {
            if (frame || !canvas || (animated && (animationHeader || size !== 6))) return false;
            if (animated) animationHeader = true;
        } else if (type === 'ANMF') {
            if (frame || !animationHeader || size < 16) return false;
            const width = bytes.readUIntLE(data + 6, 3) + 1, height = bytes.readUIntLE(data + 9, 3) + 1;
            if (2 * bytes.readUIntLE(data, 3) + width > canvas.width ||
                2 * bytes.readUIntLE(data + 3, 3) + height > canvas.height ||
                !webpChunks(bytes, data + 16, data + size, { width, height })) return false;
            animationFrames++;
        } else if (!frame && at === start) {
            return false;
        }
        at = next;
    }
    return animated ? !pixels && animationFrames > 0 : pixels;
}

function webpStructure(bytes) {
    return bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' &&
        bytes.readUInt32LE(4) + 8 === bytes.length && bytes.toString('latin1', 8, 12) === 'WEBP' &&
        webpChunks(bytes, 12, bytes.length);
}

function svgStructure(bytes, SaxesParser) {
    const parser = new SaxesParser({ xmlns: true });
    let root;
    parser.on('opentag', tag => { root ??= tag; });
    // No external resolver or DTD entity expansion. The original SVG bytes are never opened or rendered.
    parser.write(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).close();
    return root?.local === 'svg' && (root.uri === svgNamespace || (!root.uri && root.name === 'svg'));
}

export function checkSvgParser(SaxesParser) {
    const valid = Buffer.from('<svg xmlns="' + svgNamespace + '"><title>Fixture</title></svg>');
    const invalid = valid.subarray(0, -6);
    verifyImageStructure(valid, 'svg', SaxesParser);
    try { verifyImageStructure(invalid, 'svg', SaxesParser); }
    catch { return; }
    throw Error('The SVG XML parser did not reject an incomplete document.');
}

export function verifyImageStructure(bytes, format, SaxesParser) {
    const probe = { png: pngStructure, jpeg: jpegStructure, gif: gifStructure, webp: webpStructure, svg: svgStructure }[format];
    try {
        const valid = probe(bytes, SaxesParser);
        if (valid) return format === 'png' ? valid : {};
    } catch (error) {
        throw Error('Image bytes failed structural validation for ' + format + '.', { cause: error });
    }
    throw Error('Image bytes failed structural validation for ' + format + '.');
}
