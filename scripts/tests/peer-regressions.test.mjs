import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OpenAI } from '../agents-sdk/node_modules/openai/index.mjs';
import { operationCatalog, runInvocation, runWorkspace } from '../openai-agents.mjs';
import { auditSchema, discover } from '../openai-workbench.mjs';

async function invoke(invocation, fetch) {
    const previous = process.exitCode;
    const rows = [];
    try {
        process.exitCode = 0;
        const client = new OpenAI({ apiKey: 'sk-fixture-not-a-real-secret', maxRetries: 0, fetch });
        await runInvocation(client, invocation, row => rows.push(structuredClone(row)));
        return { exit: process.exitCode, result: rows.at(-1) };
    } finally { process.exitCode = previous; }
}
async function scratch(operation) {
    const root = await mkdtemp(path.join(tmpdir(), 'legatus-peer-ž-'));
    try { return await operation(root); }
    finally { await rm(root, { recursive: true, force: true }); }
}
function events(rows) {
    return new Response(rows.map(row => 'data: ' + JSON.stringify(row) + '\n\n').join(''),
        { headers: { 'content-type': 'text/event-stream' } });
}

test('Agents creation proves the selected root turn, and a watcher accepts nullable environment events', async () => {
    const session_id = 'sess_test', turn_id = 'turn_main', subagent_id = null;
    const scope = { session_id, turn_id, subagent_id };
    const created = { type: 'agent.session.created', session_id, session: { object: 'agent.session', id: session_id } };
    const ready = { type: 'agent.session.environment.ready', ...scope, turn_id: null };
    const main = { ...scope, type: 'agent.session.turn.created' };
    const done = { ...scope, type: 'agent.session.turn.completed', turn: { id: turn_id, session_id, subagent_id, status: 'completed' } };
    const delta = { ...scope, type: 'agent.session.turn.output_text.delta', turn_id: null, delta: 'fixture' };
    const other = { ...done, turn_id: 'turn_other', turn: { ...done.turn, id: 'turn_other' } };
    const conflict = { ...done, turn: { ...done.turn, status: 'failed' } };
    const create = { action: 'sessions.create', request: { stream: true } };
    const watch = { action: 'sessions.events.stream', id: session_id, stopOnTurn: true, turnId: turn_id };
    for (const [request, frames, exit] of [
        [create, [created, ready, main, other, done], 0],
        [create, [created, ready, main, delta, done], 0],
        [create, [created, ready, main, other], 1],
        [create, [created, ready, done], 1],
        [watch, [ready, delta, done], 0],
        [watch, [ready, { ...done, turn: { ...done.turn, status: undefined } }], 1],
        [watch, [ready, conflict], 1],
    ]) assert.equal((await invoke(request, async () => events(frames))).exit, exit);
});

test('Responses rejects an incorrect nested type before confirming history and local typos before dispatch', async () => {
    const base = { action: 'responses.create', request: { stream: true } };
    let calls = 0;
    const fetch = async () => {
        calls++;
        return events([{ type: 'response.created', sequence_number: 0,
            response: { object: 'other', id: 'resp_test', status: 'in_progress' } }]);
    };
    const bad = await invoke({ ...base, checkpointPat: 'unwritten' }, fetch);
    assert.equal(bad.result.dispatch, 'not-attempted');
    assert.equal(calls, 0);
    const mismatch = await invoke(base, fetch);
    assert.equal(mismatch.exit, 1);
    assert.equal(mismatch.result.receipt.resourceId, undefined);
    assert.equal(mismatch.result.receipt.streamIntegrity.lastDurableContiguousSequence, undefined);
    assert.equal(calls, 1);
});

test('Responses and Workspace accept exactly one substantive request body', async () => {
    const base = { action: 'responses.create' };
    const body = { model: 'fixture', input: 'fixture', store: false };
    const workspace = { action: 'workspace.trigger', id: 'agtch_fixture' };
    const workspaceBody = { input: 'fixture' };
    for (const [invokeAction, action, request, alternative] of [
        [invoke, base, body, { ...body, store: true }],
        [async (invocation, fetch) => {
            const previous = process.exitCode;
            try {
                process.exitCode = 0;
                let result;
                await runWorkspace('fixture_access_token', invocation, row => { result = row; }, fetch);
                return { exit: process.exitCode, result };
            } finally { process.exitCode = previous; }
        }, workspace, workspaceBody, { input: 'different text' }],
    ]) {
        const sent = [];
        const fetch = async (url, init) => {
            sent.push(JSON.parse(init.body));
            return action === base
                ? Response.json({ object: 'response', id: 'resp_fixture', status: 'completed', output: [] })
                : Response.json({ agent_trigger_run_id: 'apirun_fixture', conversation_url: 'https://chatgpt.com/c/fixture' }, { status: 202 });
        };
        const rejected = await invokeAction({ ...action, request, rawRequest: JSON.stringify(alternative) }, fetch);
        assert.equal(rejected.result.dispatch, 'not-attempted');
        assert.equal(sent.length, 0);
        for (const fields of [{ request }, { rawRequest: JSON.stringify(request) }, { request: {}, rawRequest: JSON.stringify(request) }]) {
            assert.equal((await invokeAction({ ...action, ...fields }, fetch)).exit, 0);
        }
        assert.deepEqual(sent, [request, request, request]);
    }
});

test('Only a streamed Responses retrieval can establish an origin from a cursor', async () => {
    let calls = 0;
    const fetch = async () => {
        calls++;
        return events([{ type: 'response.completed', sequence_number: 7,
            response: { object: 'response', status: 'completed', id: 'resp_cursor', output: [] } }]);
    };
    const cursor = { stream: true, starting_after: 6 };
    for (const invocation of [{ action: 'responses.create', request: { ...cursor, model: 'fixture' } },
        { action: 'responses.retrieve', id: 'resp_cursor', request: { ...cursor, stream: false } }]) {
        assert.equal((await invoke(invocation, fetch)).result.dispatch, 'not-attempted');
    }
    assert.equal(calls, 0);
    const result = await invoke({ action: 'responses.retrieve', id: 'resp_cursor', request: cursor }, fetch);
    assert.equal(result.exit, 0);
    assert.equal(result.result.receipt.streamIntegrity.origin, 'requested-cursor');
    assert.equal(calls, 1);
});

test('Responses pilot rejects fields outside its catalog before any transport starts', async () => {
    const catalog = operationCatalog()['responses.pilot'];
    assert.deepEqual(catalog.localOptions, ['checkpointPath', 'projectHint', 'timeoutSeconds']);
    let calls = 0;
    const client = {
        baseURL: 'https://api.openai.com/v1', apiKey: 'sk-fixture-not-a-real-secret',
        WebSocketTransport: class { constructor() { calls++; throw Error('Local fixture'); } },
        responses: { create() { calls++; throw Error('Local fixture'); } },
    };
    const prior = process.exitCode;
    try {
        const base = { action: 'responses.pilot', request: { model: 'fixture' } };
        for (const fields of [
            { id: 'unexpected' }, { inputFile: 'in.txt' }, { inputMediaType: 'text/plain' },
            { outputFile: 'out.json' }, { outputDirectory: 'out' }, { eventFile: 'events.jsonl' },
            { stableInstructions: 'fixture' }, { idempotencyKey: 'unexpected' }, { turnId: 'unexpected' },
            { stopOnTurn: true }, { includeApiMessage: true }, { pollSeconds: 1 },
            { timeoutSeconds: 3601 }, { verifyInputIds: true },
        ]) {
            const rows = [];
            await runInvocation(client, { ...base, ...fields }, row => rows.push(row));
            assert.equal(rows[0].dispatch, 'not-attempted', JSON.stringify(fields));
        }
        assert.equal(calls, 0);
        const rows = [];
        await runInvocation(client, { ...base, projectHint: 'fixture', timeoutSeconds: 1,
            outputFile: null, stopOnTurn: false, pollSeconds: 0 }, row => rows.push(row));
        assert.equal(calls, 1);
        assert.equal(rows[0].data.arms.http.status, 'stopped');
        assert.equal(rows[0].data.arms.websocket.status, 'not_attempted');
    } finally { process.exitCode = prior; }
});

test('Batch wait compares exact IDs on request, preserves bytes and distinguishes GET from local preflight', async () => {
    const input = ['a', 'b'].map(custom_id => JSON.stringify({ custom_id, method: 'POST', url: '/v1/responses', body: {} })).join('\n');
    const batch = { object: 'batch', id: 'batch_test', status: 'completed', endpoint: '/v1/responses',
        input_file_id: 'file-source', output_file_id: 'file-output', request_counts: { total: 2, completed: 2, failed: 0 } };
    for (const [second, exit, state] of [['b', 0, 'input-ids-verified'], ['c', 1, 'input-id-mismatch']]) {
        await scratch(async outputDirectory => {
            const output = ['a', second].map(custom_id => JSON.stringify({ custom_id,
                response: { status_code: 200, body: {} }, error: null })).join('\n');
            const calls = [];
            const fetch = async url => {
                const pathname = new URL(url).pathname;
                calls.push(pathname);
                if (pathname === '/v1/batches/batch_test') return Response.json(batch);
                return new Response(pathname.includes('file-source') ? input : output);
            };
            const req = { action: 'batches.wait', id: batch.id, outputDirectory, verifyInputIds: true };
            const missing = await invoke({ ...req, outputDirectory: path.join(outputDirectory, 'missing') }, fetch);
            assert.equal(missing.result.dispatch, 'not-attempted');
            assert.equal(calls.length, 0);
            const result = await invoke(req, fetch);
            assert.equal(result.exit, exit);
            assert.equal(result.result.data.artifactVerification.state, state);
            assert.deepEqual(calls, ['/v1/batches/batch_test', '/v1/files/file-output/content', '/v1/files/file-source/content']);
            assert.equal(await readFile(path.join(outputDirectory, 'output.jsonl'), 'utf8'), output);
            assert.deepEqual(await readdir(outputDirectory), ['output.jsonl']);
        });
    }
});

test('Batch does not reuse a previous HTTP response as proof of a later read', async () => {
    let calls = 0;
    const action = { action: 'batches.wait', id: 'batch_test', pollSeconds: 1, timeoutSeconds: 5 };
    const { exit, result } = await invoke(action, async () => {
        if (++calls > 1) throw Error('Connection ended before a response.');
        return Response.json({ object: 'batch', id: 'batch_test', status: 'in_progress' });
    });
    assert.equal(calls, 2);
    assert.equal(exit, 1);
    assert.equal(result.dispatch, 'attempted');
    assert.equal(result.readOnly, true);
    assert.equal(result.outcomeUnconfirmed, false);
    assert.equal(result.receipt.resourceStatus, 'in_progress');
});

test('Batch timeout during throttling retains the latest HTTP attempt separately from resource state', async () => {
    await scratch(async outputDirectory => {
        const checkpointPath = path.join(outputDirectory, 'checkpoint.jsonl');
        let calls = 0;
        const action = { action: 'batches.wait', id: 'batch_test', pollSeconds: 1, timeoutSeconds: 2, checkpointPath };
        const { exit, result } = await invoke(action, async () => ++calls === 1
            ? Response.json({ object: 'batch', id: 'batch_test', status: 'in_progress' }, { headers: { 'x-request-id': 'req_first' } })
            : Response.json({ error: { code: 'rate_limit_exceeded' } },
                { status: 429, headers: { 'retry-after': '10', 'x-request-id': 'req_throttled' } }));
        assert.equal(calls, 2);
        assert.equal(exit, 1);
        assert.equal(result.localDeadlineReached, true);
        assert.equal(result.httpStatus, 429);
        assert.equal(result.receipt.resourceStatus, 'in_progress');
        assert.equal(result.receipt.headers['x-request-id'], 'req_throttled');
        const journal = (await readFile(checkpointPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        const last = journal.at(-1);
        assert.equal(last.httpStatus, 429);
        assert.equal(last.headers['x-request-id'], 'req_throttled');
        assert.equal(last.headerObservedAt, journal.find(row => row.phase === 'batch_read_backoff').headerObservedAt);
    });
});

test('Batch preflight rejects an output collision without creating the checkpoint', async () => {
    await scratch(async outputDirectory => {
        for (const name of ['output.jsonl', 'error.jsonl']) {
            const checkpointPath = path.join(outputDirectory, name);
            let calls = 0;
            const result = await invoke({ action: 'batches.wait', id: 'batch_test', outputDirectory, checkpointPath },
                async () => { calls++; throw Error('Should not dispatch'); });
            assert.equal(result.result.dispatch, 'not-attempted');
            assert.equal(calls, 0);
            assert.deepEqual(await readdir(outputDirectory), []);
        }
    });
});

test('WAV validates declared lengths and linear frame metadata before publication', async () => {
    await scratch(async directory => {
        const wave = Buffer.from('524946462800000057415645666d74201000000001000100803e0000007d000002001000646174610400000001000200', 'hex');
        const rf64 = Buffer.concat([
            Buffer.from('52463634ffffffff57415645', 'hex'), Buffer.alloc(36), wave.subarray(12),
        ]);
        rf64.write('ds64', 12);
        rf64.writeUInt32LE(28, 16);
        rf64.writeBigUInt64LE(BigInt(rf64.length - 8), 20);
        rf64.writeBigUInt64LE(4n, 28);
        rf64.writeBigUInt64LE(2n, 36);
        rf64.writeUInt32LE(0xffffffff, 76);
        const wrongFrames = Buffer.from(rf64);
        wrongFrames.writeBigUInt64LE(999n, 36);
        const unknownFrames = Buffer.from(rf64);
        unknownFrames.writeBigUInt64LE(0n, 36);
        const withFact = Buffer.concat([rf64.subarray(0, 72),
            Buffer.from('6661637404000000ffffffff', 'hex'), rf64.subarray(72)]);
        withFact.writeBigUInt64LE(BigInt(withFact.length - 8), 20);
        const wrongFact = Buffer.from(withFact);
        wrongFact.writeUInt32LE(3, 80);
        const alignment = Buffer.from(wave);
        alignment.writeUInt16LE(1, 32);
        alignment.writeUInt32LE(3, 40);
        alignment[47] = 0;
        const byteRate = Buffer.from(wave);
        byteRate.writeUInt32LE(1, 28);
        const bits = Buffer.from(wave);
        bits.writeUInt16LE(0, 34);
        const float = Buffer.from(wave);
        float.writeUInt16LE(3, 20);
        float.writeUInt32LE(64000, 28);
        float.writeUInt16LE(4, 32);
        float.writeUInt16LE(32, 34);
        const compressed = Buffer.from(wave);
        compressed.writeUInt16LE(0x11, 20);
        compressed.writeUInt32LE(9000, 28);
        compressed.writeUInt16LE(4, 34);
        const extension = Buffer.from('16000c00040000000100000000001000800000aa00389b71', 'hex');
        const extended = Buffer.concat([wave.subarray(0, 36), extension, wave.subarray(36)]);
        extended.writeUInt32LE(extended.length - 8, 4);
        extended.writeUInt32LE(40, 16);
        extended.writeUInt16LE(0xfffe, 20);
        const badExtension = Buffer.from(extended);
        badExtension.writeUInt16LE(17, 38);
        for (const [variant, body, exit] of [['full', wave, 0], ['short', wave.subarray(0, 45), 1],
            ['rf64', rf64, 0], ['rf64-short', rf64.subarray(0, rf64.length - 1), 1],
            ['rf64-wrong-frames', wrongFrames, 1], ['rf64-unknown-frames', unknownFrames, 0],
            ['rf64-fact-uses-ds64', withFact, 0], ['rf64-wrong-fact', wrongFact, 1],
            ['bad-alignment', alignment, 1], ['bad-byte-rate', byteRate, 1], ['zero-bits', bits, 1],
            ['float', float, 0], ['compressed', compressed, 0], ['extensible-pcm', extended, 0],
            ['invalid-precision', badExtension, 1]]) {
            const outputFile = path.join(directory, variant + '.wav');
            const result = await invoke({ action: 'audio.speech.create', outputFile, request: { response_format: 'wav' } },
                async () => new Response(body, { headers: { 'content-type': 'audio/wav' } }));
            assert.equal(result.exit, exit, variant);
            if (exit) await assert.rejects(readFile(outputFile), { code: 'ENOENT' });
            else assert.deepEqual(await readFile(outputFile), body);
        }
    });
});

test('Windows checks ordinary name aliases according to the actual directory', { skip: process.platform !== 'win32' }, async () => {
    await scratch(async directory => {
        const action = { action: 'responses.retrieve', id: 'resp_test',
            request: { stream: true, starting_after: 1 }, timeoutSeconds: 2 };
        for (const [first, second] of [['ITEM.jsonl', 'item.jsonl'], ['İ.jsonl', 'i\u0307.jsonl']]) {
            await scratch(async control => {
                const { open } = await import('node:fs/promises');
                await (await open(path.join(control, first), 'wx')).close();
                let distinct = true;
                try { await (await open(path.join(control, second), 'wx')).close(); }
                catch (error) { assert.equal(error.code, 'EEXIST'); distinct = false; }
                let dispatches = 0;
                const result = await invoke({ ...action, checkpointPath: path.join(directory, first), eventFile: path.join(directory, second) },
                    async () => {
                        dispatches++;
                        return events([{ type: 'response.completed', sequence_number: 2,
                            response: { object: 'response', status: 'completed', id: 'resp_test', output: [] } }]);
                    });
                assert.equal(result.exit, distinct ? 0 : 1);
                assert.equal(dispatches, distinct ? 1 : 0);
            });
        }
    });
});

test('Catalogue separates launcher fields, API parameters, credential source and local commands', () => {
    const catalog = operationCatalog();
    assert.deepEqual(catalog['workspace.trigger'].localOptions, ['idempotencyKey']);
    assert.deepEqual(catalog['workspace.trigger'].optional, ['conversation_key']);
    assert.deepEqual(catalog['uploads.transfer'].required, ['purpose', 'mime_type']);
    assert.equal(catalog['models.list'].credentialSources.node, 'OPENAI_API_KEY');
    for (const action of ['audit.schema', 'audit.validate', 'estimate', 'benchmark']) {
        const top = discover(action).matches[0];
        assert.equal(top.action, action);
        assert.equal(top.usesNetwork, false);
    }
    const [observed, inferred] = auditSchema.properties.findings.items.anyOf;
    assert.equal(observed.properties.evidence.minItems, 1);
    assert.equal(inferred.properties.evidence.minItems, undefined);
    assert.equal(new RegExp(observed.properties.title.pattern).test('   '), false);
});
