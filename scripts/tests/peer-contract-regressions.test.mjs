import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildClient, runInvocation } from '../openai-agents.mjs';
import { trackResponseStream } from '../openai-stream-integrity.mjs';
import { discover } from '../openai-workbench.mjs';

const runtime = path.resolve(import.meta.dirname, '../agents-sdk');
const apiKey = 'fixture-not-a-real-credential';

async function invoke(client, invocation, receiveSteer) {
    const rows = [], previous = process.exitCode;
    try {
        process.exitCode = 0;
        await runInvocation(client, { timeoutSeconds: 2, request: {}, ...invocation }, row => rows.push(row), receiveSteer);
        return { exit: process.exitCode, last: rows.at(-1) };
    } finally { process.exitCode = previous; }
}

test('scoped pages reject wrong or absent owners throughout the page and preserve pagination', async () => {
    let page, calls = 0;
    const client = await buildClient(apiKey, runtime, async () => {
        calls++;
        return Response.json(page);
    });
    for (const [action, type, owner, id, request = {}, ownerFields = {}] of [
        ['sessions.artifacts.list', 'agent.session.artifact', 'session_id', 'sess_known',
            { environment_id: 'env_known' }, { environment_id: 'env_known' }],
        ['sessions.traces.list', 'agent.session.trace', 'session_id', 'sess_known'],
        ['sessions.subagents.list', 'agent.session.subagent', 'session_id', 'sess_known'],
        ['sessions.turns.list', 'agent.session.turn', 'session_id', 'sess_known'],
        ['sessions.subagents.turns.list', 'agent.session.turn', 'subagent_id', 'sub_known',
            { session_id: 'sess_known' }, { session_id: 'sess_known' }],
        ['sessions.turns.items.list', 'message', 'turn_id', 'turn_known', { session_id: 'sess_known' }],
        ['containers.files.list', 'container.file', 'container_id', 'cntr_known'],
        ['vectorstores.files.list', 'vector_store.file', 'vector_store_id', 'vs_known'],
    ]) {
        const row = { id: 'row_valid', [type === 'message' ? 'type' : 'object']: type, [owner]: id, ...ownerFields };
        for (const bad of [undefined, { ...row, [owner]: undefined }, { ...row, [owner]: 'wrong_owner' },
            { ...row, [type === 'message' ? 'type' : 'object']: null },
            ...(type === 'message' ? [] : [{ ...row, id: undefined }, { ...row, id: 24 }])]) {
            const before = calls;
            page = { object: 'list', data: bad ? [row, bad] : [row], last_id: 'row_valid', has_more: true };
            const result = await invoke(client, { action, id, request });
            assert.equal(calls, before + 1, action);
            assert.equal(result.exit, bad ? 1 : 0, action);
            if (bad) {
                assert.equal(result.last.stage, 'response-body');
                assert.equal(result.last.data, undefined);
            } else assert.deepEqual(result.last.data, page);
        }
        for (const field of Object.keys(ownerFields)) {
            page = { data: [row, { ...row, id: 'other', [field]: 'wrong_scope' }], has_more: true };
            assert.equal((await invoke(client, { action, id, request })).exit, 1);
        }
        if (type !== 'message') for (const invalidPage of [
            { data: [row], last_id: 'wrong_anchor' }, { data: [row], object: 'page' }, { data: [row, row] },
        ]) {
            page = { ...invalidPage, has_more: true };
            assert.equal((await invoke(client, { action, id, request })).exit, 1);
        }
        page = { data: [], has_more: false };
        assert.equal((await invoke(client, { action, id, request })).exit, 0);
    }
});

test('opaque pagination validates environment paths and stops repeated cursors', async () => {
    const directory = '/workspace/výstupy', id = 'env_known';
    const file = { object: 'agent.environment.file', environment_id: id, path: directory + '/část/prázdný', size_bytes: 0 };
    let page, query;
    const transport = async input => {
        query = new URL(typeof input === 'string' ? input : input.url).searchParams;
        return Response.json(page);
    };
    const client = await buildClient(apiKey, runtime, transport);
    const admin = await buildClient(null, runtime, transport, 'fixture-admin-credential');
    for (const action of ['environments.files.list', 'admin.usage.costs', 'admin.usage.completions']) {
        const environment = action.startsWith('environments');
        const request = environment ? { path: directory + '/', page: 'opaque/current=' }
            : { start_time: 1, page: 'opaque/current=' };
        const rows = environment ? [file] : [{ object: 'bucket', start_time: 1, end_time: 2, results: [] }];
        for (const [hasMore, token, state] of [[true, 'opaque/next=', 'next-page-available'],
            [true, request.page, 'cursor-stalled'], [true, null, 'cursor-unavailable'], [false, request.page, 'complete']]) {
            page = { object: 'page', has_more: hasMore, data: hasMore ? rows : [],
                [environment ? 'next' : 'next_page']: token };
            const result = await invoke(environment ? client : admin, { action, id: environment ? id : undefined, request });
            assert.equal(query.get('page'), request.page);
            if (environment) assert.equal(query.get('path'), request.path);
            assert.equal(result.exit, 0);
            assert.deepEqual(result.last.data, page);
            assert.deepEqual(result.last.receipt.pagination, { state, hasMore,
                ...(state === 'next-page-available' ? { nextPage: token } : {}) });
        }
    }
    for (const row of [{ path: directory + '-jiné/a' }, { path: directory }, { path: directory + '/../jiné' },
        { path: 'relative/a' }, { path: directory + '/\0' }, { environment_id: 'env_other' },
        { size_bytes: -1 }, { size_bytes: 0.5 }, { size_bytes: Number.MAX_SAFE_INTEGER + 1 }, { size_bytes: undefined }]) {
        page = { object: 'page', data: [file, { ...file, ...row }], has_more: false };
        const result = await invoke(client, { action: 'environments.files.list', id, request: { path: directory } });
        assert.equal(result.exit, 1, JSON.stringify(row));
        assert.equal(result.last.stage, 'response-body');
        assert.equal(result.last.data, undefined);
    }
    page = { object: 'page', data: [{ ...file, path: '/data/načtené.json' }], has_more: false, next: null };
    for (const request of [{}, { path: '/' }, { path: '/data/./' }]) {
        const result = await invoke(client, { action: 'environments.files.list', id, request });
        assert.equal(result.exit, 0);
        assert.deepEqual(result.last.data, page);
    }
    for (const path of ['relative', 'C:/workspace/výstupy', '/workspace/\0']) {
        query = undefined;
        assert.equal((await invoke(client, { action: 'environments.files.list', id, request: { path } })).exit, 1);
        assert.equal(query, undefined);
    }
});

function socketScenario(variant) {
    let connections = 0;
    const sent = [];
    return { sent, get connections() { return connections; }, apiKey, baseURL: 'https://api.openai.com/v1',
        WebSocketTransport: class extends EventTarget {
            readyState = 1;
            constructor() { super(); connections++; }
            send(serialized) {
                const msg = JSON.parse(serialized);
                const fire = event => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(event) }));
                const answer = (type, id, status, previous_response_id) =>
                    fire({ type, response: { object: 'response', id, status, previous_response_id,
                        ...(type === 'response.completed' && id === 'resp_original' && variant.startsWith('pending')
                            ? { output: [{ type: 'mcp_approval_request', id: 'mcpr_fixture', name: 'fixture', arguments: '{}' }] }
                            : status === 'completed' ? { output: [] } : {}) } });
                sent.push(msg);
                const steer = { previous_response_id: 'resp_original', id: 'steer_test' };
                if (msg.type === 'response.create') {
                    answer('response.created', 'resp_original', 'in_progress',
                        variant === 'wrong-original-at-start' ? 'resp_wrong' : 'resp_parent');
                    return;
                }
                if (variant.startsWith('rejection')) {
                    const input = variant === 'rejection-missing' ? undefined
                        : variant === 'rejection-wrong' ? 'other input' : msg.input;
                    fire({ type: 'response.steer.failed', steer: { previous_response_id: 'resp_original', input },
                        error: { code: 'fixture-rejected', message: 'fixture', type: 'invalid_request_error' } });
                    if (variant === 'rejection-buffered') answer('response.completed', 'resp_original', 'completed', 'resp_parent');
                    return;
                }
                fire({ type: 'response.steer.accepted', steer });
                const original = () => answer('response.completed', 'resp_original', 'completed',
                    variant === 'wrong-original-at-end' ? 'resp_wrong' : 'resp_parent');
                if (variant !== 'pending-premature') original();
                if (variant.startsWith('pending')) {
                    const stub = { type: 'mcp_approval_response',
                        ...(variant === 'pending-wrong' ? {} : { approval_request_id: 'mcpr_fixture' }),
                        ...(variant === 'pending-supplied' ? { approve: true } : {}) };
                    fire({ type: 'response.steer.pending', steer,
                        ...(variant === 'pending-missing' ? {} : { reason: 'waiting_for_required_input',
                            required_input: variant === 'pending-duplicate' ? [stub, stub] : [stub] }) });
                    if (variant === 'pending-premature') original();
                    return;
                }
                answer('response.created', 'resp_next', 'in_progress', 'resp_original');
                answer('response.completed', 'resp_next', 'completed', 'resp_original');
            }
            close() { this.readyState = 3; }
        } };
}

test('steering verifies model and parents, echoed input and pending prerequisites in both client modes', async () => {
    const response = { model: 'gpt-6.2-sol', input: 'Original', previous_response_id: 'resp_parent' };
    for (const interactive of [false, true]) {
        const run = (client, model = response.model) => invoke(client, { action: 'responses.steer',
            request: { response: { ...response, model }, ...(interactive ? {} : { steer_input: 'Czech' }) } },
        interactive ? async () => 'Czech' : undefined);
        for (const model of ['gpt-5.6', 'gpt-4.1-mini', 'unqualified-alias']) {
            const client = socketScenario('good');
            const result = await run(client, model);
            assert.equal(result.last.localCode, 'steer_requires_gpt_6_model_id');
            assert.equal(client.connections, 0);
        }
        for (const [variant, outcome, code, frames] of [
            ['good', 'continuation-completed', undefined, 2],
            ['wrong-original-at-start', 'unconfirmed', 'unexpected_original_parent', 1],
            ['wrong-original-at-end', 'unconfirmed', 'unexpected_original_parent', 2],
            ['pending-good', 'needs-client-input', undefined, 2],
            ['pending-premature', 'unconfirmed', 'premature_steer_pending', 2],
            ['pending-missing', 'unconfirmed', 'invalid_steer_pending', 2],
            ['pending-wrong', 'unconfirmed', 'invalid_steer_pending', 2],
            ['pending-supplied', 'unconfirmed', 'invalid_steer_pending', 2],
            ['pending-duplicate', 'unconfirmed', 'invalid_steer_pending', 2],
            ['rejection-good', 'steer-rejected', undefined, 2],
            ['rejection-buffered', 'steer-rejected', undefined, 2],
            ['rejection-missing', 'unconfirmed', 'invalid_steer_input', 2],
            ['rejection-wrong', 'unconfirmed', 'steer_input_mismatch', 2],
        ]) {
            const client = socketScenario(variant);
            const result = await run(client);
            assert.equal(result.last.outcome, outcome, variant);
            assert.equal(result.last.localCode, code, variant);
            assert.equal(client.sent.length, frames, variant);
            if (['pending-premature', 'pending-good', 'rejection-buffered'].includes(variant)) {
                assert.equal(result.last.original?.id, 'resp_original', variant);
                assert.equal(result.last.original?.status, 'completed', variant);
            }
        }
    }
});

test('random SSE padding does not retract a durable cursor, but content changes do', () => {
    const stream = trackResponseStream(undefined);
    const created = { type: 'response.created', sequence_number: 0, response: { id: 'resp_fixture' } };
    const text = { type: 'response.output_text.delta', sequence_number: 1, delta: 'A', obfuscation: 'one' };
    for (const event of [created, text]) stream.delivered(stream.observe(event).cursor);
    stream.synced();
    assert.equal(stream.observe({ ...text, obfuscation: 'other' }).disposition, 'duplicate');
    assert.equal(stream.snapshot().lastDurableContiguousSequence, 1);
    assert.equal(stream.observe({ ...text, delta: 'B' }).disposition, 'conflicting-sequence');
    assert.equal(stream.snapshot().lastDurableContiguousSequence, 0);
});

test('discovery selects explicit content, scoped traces and Unicode Multi-agent variants', () => {
    for (const [query, action, needsOutput] of [
        ['get file content', 'files.content', true], ['přečti obsah souboru', 'files.content', true],
        ['list the contents of a file', 'files.content', true], ['vypiš obsah souboru', 'files.content', true],
        ['list the contents of a container file', 'containers.files.content.retrieve', true],
        ['vypiš obsah artefaktu relace', 'sessions.artifacts.content', true],
        ['list files', 'files.list'], ['retrieve file metadata', 'files.retrieve'],
        ['get session artifact content', 'sessions.artifacts.content', true],
        ['stáhni metadata artefaktu', 'sessions.artifacts.retrieve'],
        ['download container file', 'containers.files.content.retrieve', true],
        ['list session trace', 'sessions.traces.list'],
        ['read multi‑agent response', 'responses.multiagent.retrieve'],
        ['start multi–agent response with subagents', 'responses.multiagent.create'],
    ]) {
        const first = discover(query).matches[0];
        assert.equal(first?.action, action, query);
        assert.equal(Boolean(first.outputFile), Boolean(needsOutput), query);
    }
    assert.deepEqual(discover('list remote jobs').matches, []);
    assert.deepEqual(discover('list API jobs').matches, []);
    assert.deepEqual(discover('list Jobs').matches, []);
    assert.deepEqual(discover('get vector store file content').matches, []);
    for (const query of ['stáhni obsah a metadata artefaktu', 'get artifact content and metadata']) {
        const expected = ['sessions.artifacts.retrieve', 'sessions.artifacts.content'];
        const found = discover(query);
        assert.deepEqual(found.workflow?.actions, expected, query);
        assert.deepEqual(found.matches.map(match => match.action).sort(), [...expected].sort(), query);
    }
    assert.equal(discover('list local jobs').matches[0]?.action, 'jobs');
});

test('a runtime cannot borrow its parser or its transitive dependency from an ancestor', async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), 'legatus-runtime-pin-'));
    try {
        const root = path.join(scratch, 'runtime');
        await cp(runtime, root, { recursive: true });
        await mkdir(path.join(scratch, 'node_modules'));
        assert.equal((await buildClient(apiKey, root)).runtimeVersion, '7.63.0');
        for (const name of ['saxes', 'xmlchars']) {
            const local = path.join(root, 'node_modules', name), ancestor = path.join(scratch, 'node_modules', name);
            await rename(local, ancestor);
            await assert.rejects(buildClient(apiKey, root));
            await rename(ancestor, local);
            const manifest = path.join(local, 'package.json');
            const original = await readFile(manifest, 'utf8');
            await writeFile(manifest, JSON.stringify({ ...JSON.parse(original), version: '0.0.0-test' }));
            await assert.rejects(buildClient(apiKey, root), new RegExp('Installed ' + name));
            await writeFile(manifest, original);
        }
        assert.equal(typeof (await buildClient(apiKey, root)).SaxesParser, 'function');
    } finally { await rm(scratch, { recursive: true, force: true }); }
});

function oggPage(packet, sequence, flags, granule = 0n, lacing = [packet.length], serial = 5) {
    const page = Buffer.alloc(27 + lacing.length + packet.length);
    page.write('OggS');
    page[5] = flags;
    page.writeBigInt64LE(granule, 6);
    page.writeUInt32LE(serial, 14);
    page.writeUInt32LE(sequence, 18);
    page[26] = lacing.length;
    page.set(lacing, 27);
    packet.copy(page, 27 + lacing.length);
    let crc = 0;
    for (const byte of page) {
        crc ^= byte << 24;
        for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0);
    }
    page.writeUInt32LE(crc >>> 0, 22);
    return page;
}

test('speech checks inner structure and exposes framed SSE and completion separately', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'legatus-speech-structure-'));
    try {
        const streamInfo = Buffer.alloc(42);
        streamInfo.write('fLaC');
        streamInfo[4] = 128;
        streamInfo[7] = 34;
        streamInfo.writeUInt16BE(4096, 8);
        streamInfo.writeUInt16BE(4096, 10);
        streamInfo.writeUInt32BE(24000 * 4096 + 15 * 16, 18);
        const flac = Buffer.concat([streamInfo, Buffer.from('fff8800800050014', 'hex')]);
        const opusHeader = Buffer.alloc(19);
        opusHeader.write('OpusHead');
        opusHeader[8] = opusHeader[9] = 1;
        const tags = Buffer.alloc(16);
        tags.write('OpusTags');
        const opus = Buffer.concat([oggPage(opusHeader, 0, 2), oggPage(tags, 1, 0),
            oggPage(Buffer.from([0xf8, 0xff, 0xfe]), 2, 4, 960n)]);
        const brokenOpus = Buffer.from(opus);
        brokenOpus[brokenOpus.length - 1] ^= 1;
        const mp3 = Buffer.alloc(417);
        Buffer.from('fffb9000', 'hex').copy(mp3);
        const adts = Buffer.from('fff15040011ffc00', 'hex');
        let body, mime;
        const client = await buildClient(apiKey, runtime, async () =>
            new Response(body, { headers: { 'content-type': mime } }));
        const cases = [
            ['flac', Buffer.from('fLaC'), false], ['flac', streamInfo, false], ['flac', flac, true],
            ['opus', Buffer.from('OggSOpusHead'), false], ['opus', opus, true, 'ogg-eos-verified'], ['opus', brokenOpus, false],
            ['mp3', Buffer.from('49443304000000000000', 'hex'), false],
            ['mp3', mp3, true], ['aac', adts, true],
            ['sse', Buffer.from('not SSE'), false], ['sse', Buffer.from(': hi\r\ndata: {}\r\n'), false],
            ['sse', Buffer.from('data: {}\r\r'), true, 'not-observed'],
            ['sse', Buffer.from('\ufeff: comment\r\n\ndata: {"type":"speech.audio.done"}\n\n'), true, 'speech-done-observed'],
        ];
        for (const [index, [format, bytes, valid, completion]] of cases.entries()) {
            body = bytes;
            mime = format === 'sse' ? 'text/event-stream' : format === 'opus' ? 'application/ogg' : 'audio/' + format;
            const outputFile = path.join(directory, 'test-' + index);
            const result = await invoke(client, { action: 'audio.speech.create', outputFile,
                request: { model: 'fixture', voice: 'alloy', input: 'hello',
                    ...(format === 'sse' ? { stream_format: 'sse' } : { response_format: format }) } });
            assert.equal(result.exit, valid ? 0 : 1, format + ':' + index);
            if (valid) {
                assert.deepEqual(await readFile(outputFile), body);
                assert.equal(result.last.data.media.completion, completion);
            } else await assert.rejects(readFile(outputFile), { code: 'ENOENT' });
        }
        assert.equal((await readdir(directory)).length, cases.filter(row => row[2]).length);
    } finally { await rm(directory, { recursive: true, force: true }); }
});

function bmff(type, ...payload) {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(8 + payload.reduce((total, bytes) => total + bytes.length, 0));
    header.write(type, 4);
    return Buffer.concat([header, ...payload]);
}

function mp4Example({ handler = 'soun', objectType = 2, samples = 1, fragment = false, initialization = true,
    offsetDelta = 0, description = 1, sampleSize = 4, compactBits, wideOffset = false, explicitFragment = false,
    externalReference = false, firstDescriptionIsNotAac = false, sampleDuration = 1024,
    timingCount = undefined, missingTiming = false, mediaScale = 48000, mediaDuration, wideMediaClock = false } = {}) {
    const u32 = (...values) => {
        const buffer = Buffer.alloc(4 * values.length);
        values.forEach((value, index) => buffer.writeUInt32BE(value, index * 4));
        return buffer;
    };
    const descriptor = (tag, data) => Buffer.concat([Buffer.from([tag, data.length]), data]);
    const codec = Buffer.from([0x40, 0x15, ...Buffer.alloc(11)]);
    const config = descriptor(5, Buffer.from([(objectType << 3) | 2, 0x10]));
    const decoder = descriptor(4, Buffer.concat([codec, config]));
    const es = descriptor(3, Buffer.concat([Buffer.from([0, 1, 0]), decoder]));
    const entryHeader = Buffer.alloc(28);
    entryHeader.writeUInt16BE(1, 6);
    const entries = [bmff('mp4a', entryHeader, bmff('esds', Buffer.alloc(4), es))];
    if (firstDescriptionIsNotAac) entries.unshift(bmff('alac', entryHeader));
    const hdlr = Buffer.alloc(12);
    hdlr.write(handler, 8);
    const classicCount = fragment ? 0 : samples;
    const duration = mediaDuration ?? classicCount * sampleDuration;
    const mediaHeader = Buffer.alloc(wideMediaClock ? 36 : 24);
    mediaHeader[0] = Number(wideMediaClock);
    mediaHeader.writeUInt32BE(mediaScale, wideMediaClock ? 20 : 12);
    if (wideMediaClock) mediaHeader.writeBigUInt64BE(BigInt(duration), 24);
    else mediaHeader.writeUInt32BE(duration, 16);
    const encodedSize = compactBits === 4 ? [sampleSize << 4] : compactBits === 8 ? [sampleSize] : [0, sampleSize];
    const sampleSizes = compactBits
        ? bmff('stz2', u32(0, compactBits, classicCount), Buffer.from(classicCount ? encodedSize : []))
        : bmff('stsz', u32(0, 0, classicCount), u32(...Array(classicCount).fill(sampleSize)));
    const chunkOffset = Buffer.alloc(wideOffset ? 8 : 4);
    const offsets = bmff(wideOffset ? 'co64' : 'stco', u32(0, classicCount ? 1 : 0),
        classicCount ? chunkOffset : Buffer.alloc(0));
    const stsc = bmff('stsc', u32(0, classicCount ? 1 : 0, ...(classicCount ? [1, classicCount, description] : [])));
    const stts = bmff('stts', u32(0, classicCount ? 1 : 0,
        ...(classicCount ? [timingCount ?? classicCount, sampleDuration] : [])));
    const trackHeader = Buffer.alloc(16);
    trackHeader.writeUInt32BE(7, 12);
    const dinf = bmff('dinf', bmff('dref', u32(0, 1), bmff('url ', u32(externalReference ? 0 : 1))));
    const track = bmff('trak', bmff('tkhd', trackHeader), bmff('mdia', bmff('mdhd', mediaHeader), bmff('hdlr', hdlr),
        bmff('minf', dinf, bmff('stbl', bmff('stsd', u32(0, entries.length), ...entries),
            sampleSizes, offsets, stsc, ...(missingTiming ? [] : [stts])))));
    const trex = bmff('mvex', bmff('trex', u32(0, 7, description, sampleDuration, sampleSize, 0)));
    const tfhd = explicitFragment ? bmff('tfhd', u32(3, 7, 0, 0, description)) : bmff('tfhd', u32(0x020000, 7));
    const run = offset => bmff('moof', bmff('traf', tfhd, explicitFragment
        ? bmff('trun', u32(0x300, samples, ...Array.from({ length: samples }, () => [sampleDuration, sampleSize]).flat()))
        : bmff('trun', u32(1, samples, offset))));
    const result = Buffer.concat([bmff('ftyp', Buffer.from('isom\0\0\0\0')),
        ...(initialization ? [bmff('moov', track, ...(fragment ? [trex] : []))] : []),
        ...(fragment ? [run(run(0).length + 8 + offsetDelta)] : []),
        bmff('mdat', Buffer.alloc(4))]);
    if (classicCount) {
        const at = result.indexOf(wideOffset ? 'co64' : 'stco') + 12;
        const offset = result.length - 4 + offsetDelta;
        if (wideOffset) result.writeBigUInt64BE(BigInt(offset), at);
        else result.writeUInt32BE(offset, at);
    }
    if (fragment && explicitFragment) result.writeBigUInt64BE(BigInt(result.length - 4 + offsetDelta), result.indexOf('tfhd') + 12);
    return result;
}

test('speech verifies WAV identity, AAC track structure and the Opus tail before success', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'legatus-verified-media-'));
    try {
        const wave = Buffer.from('524946462800000057415645666d74201000000001000100803e0000007d000002001000646174610400000001000200', 'hex');
        const rf64 = Buffer.concat([Buffer.from('52463634ffffffff57415645', 'hex'), Buffer.alloc(36), wave.subarray(12)]);
        rf64.write('ds64', 12);
        rf64.writeUInt32LE(28, 16);
        rf64.writeBigUInt64LE(BigInt(rf64.length - 8), 20);
        rf64.writeBigUInt64LE(4n, 28);
        rf64.writeBigUInt64LE(2n, 36);
        rf64.writeUInt32LE(0xffffffff, 76);
        const changed = (bytes, field, value) => {
            const copy = Buffer.from(bytes);
            copy.write(value, field);
            return copy;
        };
        const opusHeader = Buffer.alloc(19);
        opusHeader.write('OpusHead');
        opusHeader[8] = opusHeader[9] = 1;
        const tags = Buffer.alloc(16);
        tags.write('OpusTags');
        const packet = Buffer.from([0xf8, 0xff, 0xfe]);
        opusHeader.writeUInt16LE(312, 10);
        const headers = Buffer.concat([oggPage(opusHeader, 0, 2), oggPage(tags, 1, 0)]);
        const prefix = Buffer.concat([headers, oggPage(packet, 2, 0, 960n)]);
        const end = oggPage(packet, 3, 4, 1700n);
        const corrupt = Buffer.from(end);
        corrupt[corrupt.length - 1] ^= 1;
        const nonAsciiWave = Buffer.from(wave);
        nonAsciiWave[0] |= 128;
        const nonAsciiOpus = Buffer.from(opusHeader);
        nonAsciiOpus[0] |= 128;
        const cases = [
            ['wav', wave, 0, true], ['wav', changed(wave, 0, 'TST0'), 1, false],
            ['wav', nonAsciiWave, 1, false],
            ['wav', changed(wave, 8, 'AVI '), 1, false], ['wav', rf64, 0, true],
            ['wav', changed(rf64, 8, 'AVI '), 1, false],
            ['aac', mp4Example(), 0, true], ['aac', mp4Example({ handler: 'vide' }), 1, false],
            ['aac', mp4Example({ objectType: 7 }), 1, false], ['aac', mp4Example({ samples: 0 }), 1, false],
            ['aac', mp4Example({ fragment: true }), 0, true],
            ['aac', mp4Example({ wideMediaClock: true }), 0, true],
            ['aac', mp4Example({ mediaScale: 0 }), 1, false],
            ['aac', mp4Example({ fragment: true, wideMediaClock: true, mediaScale: 0 }), 1, false],
            ['aac', mp4Example({ wideMediaClock: true, mediaDuration: 1025 }), 1, false],
            ['aac', mp4Example({ mediaDuration: 0xffffffff }), 0, true],
            ['aac', mp4Example({ wideOffset: true, compactBits: 4 }), 0, true],
            ['aac', mp4Example({ compactBits: 8 }), 0, true],
            ['aac', mp4Example({ compactBits: 16 }), 0, true],
            ['aac', mp4Example({ firstDescriptionIsNotAac: true, description: 2 }), 0, true],
            ['aac', mp4Example({ firstDescriptionIsNotAac: true }), 1, false],
            ['aac', mp4Example({ externalReference: true }), 1, false],
            ['aac', mp4Example({ missingTiming: true }), 1, false],
            ['aac', mp4Example({ timingCount: 2 }), 1, false],
            ['aac', mp4Example({ sampleDuration: 0 }), 1, false],
            ['aac', mp4Example({ fragment: true, sampleDuration: 0 }), 1, false],
            ['aac', mp4Example({ fragment: true, explicitFragment: true, sampleDuration: 0 }), 1, false],
            ['aac', mp4Example({ sampleSize: 0 }), 1, false],
            ['aac', mp4Example({ description: 2 }), 1, false],
            ['aac', mp4Example({ offsetDelta: -4 }), 1, false],
            ['aac', mp4Example({ fragment: true, offsetDelta: 1 }), 1, false],
            ['aac', mp4Example({ fragment: true, sampleSize: 0 }), 1, false],
            ['aac', mp4Example({ fragment: true, explicitFragment: true }), 0, true],
            ['aac', mp4Example({ fragment: true, explicitFragment: true, sampleSize: 0 }), 1, false],
            ['aac', mp4Example({ fragment: true, explicitFragment: true, offsetDelta: 1 }), 1, false],
            ['aac', mp4Example({ fragment: true, initialization: false }), 1, false],
            ['opus', Buffer.concat([oggPage(nonAsciiOpus, 0, 2), oggPage(tags, 1, 0), oggPage(packet, 2, 4)]), 1, false],
            ['opus', Buffer.concat([prefix, end]), 0, true, 'ogg-eos-verified'],
            ['opus', prefix, 1, true, 'missing-eos'],
            ['opus', Buffer.concat([prefix, end.subarray(0, -1)]), 1, true, 'truncated-page'],
            ['opus', Buffer.concat([prefix, corrupt]), 1, true, 'invalid-page'],
            ['opus', Buffer.concat([prefix, oggPage(packet, 3, 4, 959n)]), 1, true, 'invalid-granule'],
            ['opus', Buffer.concat([prefix, oggPage(packet, 3, 4, 1921n)]), 1, true, 'invalid-granule'],
            ['opus', Buffer.concat([prefix, oggPage(packet, 3, 0, 1919n)]), 1, true, 'invalid-granule'],
            ['opus', Buffer.concat([prefix, oggPage(Buffer.from([0xfb, 0]), 3, 4, 1700n)]), 1, true, 'invalid-packet-duration'],
            ['opus', Buffer.concat([headers, oggPage(packet, 2, 4, 311n)]), 1, false],
            ['opus', Buffer.concat([headers, oggPage(packet, 2, 4, 312n)]), 0, true, 'ogg-eos-verified'],
            ['opus', Buffer.concat([headers, oggPage(packet, 2, 0, 3000n), oggPage(packet, 3, 4, 3800n)]),
                0, true, 'ogg-eos-verified'],
            ['opus', Buffer.concat([headers, oggPage(Buffer.concat([packet, Buffer.alloc(252)]), 2, 0, -1n, [255]),
                oggPage(Buffer.from([0]), 3, 5, 960n, [1])]), 0, true, 'ogg-eos-verified'],
            ['opus', Buffer.concat([prefix, end, oggPage(opusHeader, 0, 2, 0n, [19], 6),
                oggPage(tags, 1, 0, 0n, [16], 6), oggPage(packet, 2, 4, 960n, [3], 6)]),
                0, true, 'ogg-eos-verified'],
        ];
        let body, mime;
        const client = await buildClient(apiKey, runtime, async () => new Response(body, {
            headers: { 'content-type': mime, 'content-length': String(body.length) },
        }));
        for (const [index, [format, bytes, exit, saved, completion]] of cases.entries()) {
            [body, mime] = [bytes, format === 'aac' ? 'audio/mp4' : 'audio/' + format];
            const outputFile = path.join(directory, 'media-' + index);
            const result = await invoke(client, { action: 'audio.speech.create', outputFile,
                request: { model: 'fixture', voice: 'alloy', input: 'hello', response_format: format } });
            assert.equal(result.exit, exit, format + ':' + index);
            if (saved) {
                assert.deepEqual(await readFile(outputFile), bytes);
                assert.equal(result.last.data.media.completion, completion);
                if (format === 'aac') assert.equal(result.last.data.media.validation, 'mp4-aac-sample-map');
            } else await assert.rejects(readFile(outputFile), { code: 'ENOENT' });
        }
    } finally { await rm(directory, { recursive: true, force: true }); }
});
