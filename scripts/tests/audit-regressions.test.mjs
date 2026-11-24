import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OpenAI } from '../agents-sdk/node_modules/openai/index.mjs';
import { operationCatalog, runInvocation, runWorkspace } from '../openai-agents.mjs';
import { trackResponseStream } from '../openai-stream-integrity.mjs';
import { discover, estimateWork } from '../openai-workbench.mjs';

const fakeKey = 'sk-local-test-not-a-real-key';
const api = fetch => new OpenAI({ apiKey: fakeKey, maxRetries: 0, fetch });
async function invoke(client, invocation) {
    const prior = process.exitCode;
    const messages = [];
    try {
        process.exitCode = 0;
        await runInvocation(client, invocation, row => messages.push(row));
        return { code: process.exitCode, result: messages.at(-1) };
    } finally { process.exitCode = prior; }
}
async function withDirectory(callback) {
    const directory = await mkdtemp(path.join(tmpdir(), 'legatus-regression-Ž-'));
    try { await callback(directory); }
    finally { await rm(directory, { recursive: true, force: true }); }
}
const batchId = 'batch_fixture';
const fileId = 'file-result';
const successRow = custom_id => JSON.stringify({ custom_id,
    response: { status_code: 200, body: { id: 'resp_fixture' } }, error: null }) + '\n';

test('Batch separates provider completion, saved bytes, counts and input reconciliation', async () => {
    for (const [raw, expected, state] of [
        [successRow('a') + successRow('b'), 0, 'counts-verified'],
        [successRow('a'), 1, 'count-mismatch'],
        [successRow('a') + successRow('a'), 1, 'invalid-results'],
    ]) await withDirectory(async directory => {
        const routes = [];
        const client = api(async url => {
            const route = new URL(url).pathname;
            routes.push(route);
            return route === '/v1/batches/' + batchId ? Response.json({
                object: 'batch', id: batchId, status: 'completed', output_file_id: fileId,
                request_counts: { total: 2, completed: 2, failed: 0 },
            }) : new Response(raw);
        });
        const checkpointPath = path.join(directory, 'wait.jsonl');
        const { code, result } = await invoke(client, { action: 'batches.wait', id: batchId, outputDirectory: directory, checkpointPath });
        assert.equal(code, expected);
        assert.equal(result.data.batch.status, 'completed');
        assert.equal(result.data.artifactsCollected, expected === 0);
        assert.equal(result.data.artifactVerification.state, state);
        if (!expected) assert.equal(result.data.artifactVerification.inputIdsCompared, false);
        assert.equal(await readFile(path.join(directory, 'output.jsonl'), 'utf8'), raw);
        assert.equal(JSON.parse((await readFile(checkpointPath, 'utf8')).trim().split('\n').at(-1)).artifactVerification, state);
        assert.deepEqual(routes, ['/v1/batches/' + batchId, '/v1/files/' + fileId + '/content']);
    });
});

test('Responses stream without a prefix stays incomplete while a resumed stream keeps its completion', async () => {
    const id = 'resp_fixture';
    const payload = 'data: ' + JSON.stringify({type:'response.completed', sequence_number: 8,
        response: {id, object: 'response', status: 'completed', output: []}}) + '\n\n';
    const client = api(async () => new Response(payload, { headers: { 'content-type': 'text/event-stream' } }));
    const request = { action: 'responses.retrieve', id, request: { stream: true } };
    const partial = await invoke(client, request);
    assert.equal(partial.code, 1);
    assert.equal(partial.result.outcome, 'response.completed');
    assert.equal(partial.result.receipt.streamIntegrity.state, 'incomplete-history');
    const resumed = await invoke(client, { ...request, request: { stream: true, starting_after: 7 } });
    assert.equal(resumed.code, 0);
    assert.equal(resumed.result.receipt.streamIntegrity.origin, 'requested-cursor');
});

test('malformed terminal output preserves remote completion as an observation', async () => {
    const response = { id: 'resp_fixture', object: 'response', status: 'completed', output: [42] };
    const apiResult = api(async () => Response.json(response));
    const buffered = await invoke(apiResult, { action: 'responses.retrieve', id: response.id });
    assert.equal(buffered.code, 1);
    assert.equal(buffered.result.receipt.resourceStatus, 'completed');
    assert.equal(buffered.result.receipt.responseOutputVerification.reason, 'output-item');
    assert.deepEqual(buffered.result.data, response);
    const payload = 'data: ' + JSON.stringify({ type: 'response.completed', sequence_number: 8, response }) + '\n\n';
    const streamed = await invoke(api(async () => new Response(payload, { headers: { 'content-type': 'text/event-stream' } })),
        { action: 'responses.retrieve', id: response.id, request: { stream: true, starting_after: 7 } });
    assert.equal(streamed.code, 1);
    assert.equal(streamed.result.outcome, 'response-output-unverified');
    assert.equal(streamed.result.receipt.observedResponseOutcome, 'response.completed');
    assert.equal(streamed.result.receipt.resourceId, response.id);
});

test('SSE replay is independent of JSON object key order and still detects changes to arrays', () => {
    const trace = trackResponseStream();
    trace.observe({ type: 'response.created', sequence_number: 0, response: { id: 'resp_fixture' } });
    trace.observe({ type: 'delta', sequence_number: 1, data: { a: 1, b: [2, 3] } });
    assert.equal(trace.observe({ data: { b: [2, 3], a: 1 }, sequence_number: 1, type: 'delta' }).disposition, 'duplicate');
    assert.equal(trace.observe({ data: { b: [3, 2], a: 1 }, sequence_number: 1, type: 'delta' }).disposition, 'conflicting-sequence');
});

test('Skill versions create and retrieve verify the parent and delete accepts its documented shorter shape', async () => {
    await withDirectory(async directory => {
        const inputFile = path.join(directory, 'fixture.txt');
        await writeFile(inputFile, 'fixture');
        let parent = 'skill_expected';
        const client = api(async (url, options) => {
            assert.match(new URL(url).pathname, /^\/v1\/skills\/skill_expected\/versions(?:\/1)?$/);
            if (options.body) await new Request(url, { ...options, duplex: 'half' }).arrayBuffer();
            return Response.json({ object: options.method === 'DELETE' ? 'skill.version.deleted' : 'skill.version',
                id: 'version_example', version: '1',
                ...(options.method === 'DELETE' ? { deleted: true } : { skill_id: parent }) });
        });
        const create = { action: 'skills.versions.create', id: 'skill_expected', inputFile };
        const retrieve = { action: 'skills.versions.retrieve', id: '1', request: { skill_id: 'skill_expected' } };
        for (const operation of [create, retrieve]) assert.equal((await invoke(client, operation)).code, 0);
        parent = 'skill_other';
        for (const operation of [create, retrieve]) assert.equal((await invoke(client, operation)).code, 1);
        assert.equal((await invoke(client, { ...retrieve, action: 'skills.versions.delete' })).code, 0);
    });
});

test('Direct models recipe and paginated API lists validate their envelope and result', async () => {
    let body = { object: 'list', data: [] };
    const routes = [];
    const client = api(async url => {
        routes.push(new URL(url).pathname);
        return Response.json(body);
    });
    assert.equal((await invoke(client, { action: 'models.list' })).code, 0);
    assert.deepEqual(routes, ['/v1/models']);
    const invalid = await invoke(client, { action: 'files.list', timeoutSeconds: -1 });
    assert.equal(invalid.result.dispatch, 'not-attempted');
    assert.equal(routes.length, 1);
    const statusRows = [];
    await runWorkspace('fixture_token_abcdefgh', { action: 'workspace.status', id: 'agtch_fixture',
        request: { run_id: 'apirun_fixture' } }, row => statusRows.push(row), async () =>
        Response.json({ object: 'workspace_agent.trigger_run', id: 'apirun_fixture', api_trigger_id: 'agtch_fixture', status: 'completed' }));
    assert.equal(statusRows.at(-1).receipt.resourceStatus, 'completed');
    const oldExit = process.exitCode;
    try {
        await runWorkspace('fixture_token_abcdefgh', { action: 'workspace.status', id: 'agtch_fixture',
            request: { run_id: 'apirun_fixture' } }, row => statusRows.push(row), async () =>
            Response.json({ object: 'workspace_agent.trigger_run', id: 'apirun_fixture', api_trigger_id: 'agtch_fixture', status: 'new_state' }));
        assert.equal(process.exitCode, 1);
        assert.equal(statusRows.at(-1).data.status, 'new_state');
        assert.equal(statusRows.at(-1).receipt.resourceStatusClassification, 'unknown');
        assert.equal(statusRows.at(-1).receipt.resourceStatus, undefined);
    } finally { process.exitCode = oldExit; }
    for (const [result, code, warning] of [[{ data: [] }, 0], [{}, 1], [{ data: false }, 1],
        [{ data: [], has_more: true, last_id: null }, 0, 'cursor-unavailable'],
        [{ data: [{ id: 'file-a', object: 'file' }], has_more: true }, 0, 'next-page-available'],
        [{ data: [{ id: 'file-a', object: 'model' }], has_more: true }, 1]]) {
        body = result;
        const observed = await invoke(client, { action: 'files.list' });
        assert.equal(observed.code, code);
        assert.equal(observed.result.receipt?.pagination?.state, warning);
    }
});

test('Speech confirms WAV before publication and preserves explicit speech events separately', async () => {
    await withDirectory(async directory => {
        let reply;
        const client = api(async () => reply);
        const wav = Buffer.alloc(46);
        wav.write('RIFF');
        wav.writeUInt32LE(38, 4);
        wav.write('WAVEfmt ', 8);
        wav.writeUInt32LE(16, 16);
        wav.writeUInt16LE(1, 20);
        wav.writeUInt16LE(1, 22);
        wav.writeUInt32LE(24000, 24);
        wav.writeUInt32LE(48000, 28);
        wav.writeUInt16LE(2, 32);
        wav.writeUInt16LE(16, 34);
        wav.write('data', 36);
        wav.writeUInt32LE(2, 40);
        const route = { action: 'audio.speech.create', request: { model: 'fixture', input: 'hello', voice: 'alloy', response_format: 'wav' } };
        for (const [name, make, code] of [
            ['good', () => new Response(wav, { headers: { 'content-type': 'audio/wav' } }), 0],
            ['json', () => Response.json({ status: 'ok' }), 1],
            ['mislabeled', () => new Response('not a wave', { headers: { 'content-type': 'audio/wav' } }), 1],
        ]) {
            reply = make();
            const outputFile = path.join(directory, name + '.wav');
            const result = await invoke(client, { ...route, outputFile });
            assert.equal(result.code, code);
            if (code) await assert.rejects(access(outputFile), { code: 'ENOENT' });
            else {
                assert.deepEqual(await readFile(outputFile), wav);
                assert.equal(result.result.data.media.format, 'wav');
            }
        }
        reply = new Response('data: {}\n\n', { headers: { 'content-type': 'text/event-stream' } });
        const events = await invoke(client, { ...route, request: { ...route.request, stream_format: 'sse' },
            outputFile: path.join(directory, 'speech.sse') });
        assert.equal(events.result.data.media.kind, 'speech-events');
    });
});

test('Calendar checks preserve dates for prices and require real zoned observation instants for capacity', () => {
    const input = { model: 'fixture', mode: 'standard', scope: { organization: 'org', project: 'proj' },
        forecast: { inputTokens: 2, outputTokens: 3 },
        pricing: { model: 'fixture', mode: 'standard', currency: 'USD', source: 'fixture', checkedAt: '2024-02-29',
            perMillion: { input: 1, output: 2 } },
        capacity: { model: 'fixture', mode: 'standard', organization: 'org', project: 'proj', source: 'fixture',
            tpm: 100, tpmUsed: 0, checkedAt: '2024-02-29T12:34:00+01:00', validUntil: '2099-01-01T00:00:00Z' } };
    assert.equal(estimateWork(input).checks[0].fitsEstimate, true);
    assert.equal(estimateWork(input).estimatedTokenCost, 0.000008);
    for (const checkedAt of ['2025-02-29T12:00:00Z', '2024-04-31T12:00:00Z', '2024-02-29T12:34:00']) {
        assert.equal(estimateWork({ ...input, capacity: { ...input.capacity, checkedAt } }).checks[0].fitsEstimate, null);
    }
    assert.equal(estimateWork({ ...input, pricing: { ...input.pricing, checkedAt: '2025-02-29' } }).estimatedTokenCost, null);
});

test('Catalog and discovery describe streaming, billing, models and token counting', () => {
    assert.equal(operationCatalog()['sessions.create'].optionalStream, true);
    assert.equal(operationCatalog()['responses.pilot'].providerMetered, true);
    for (const [query, action] of [['list models', 'models.list'], ['token count', 'responses.inputtokens'],
        ['spočítat počet tokenů', 'responses.inputtokens']]) {
        assert.equal(discover(query).matches[0].action, action);
    }
});
