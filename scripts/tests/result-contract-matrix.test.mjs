import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildClient, runInvocation } from '../openai-agents.mjs';

const sdk = fileURLToPath(new URL('../agents-sdk/', import.meta.url));
async function run(action, result, options = {}) {
    const oldExit = process.exitCode;
    try {
        process.exitCode = 0;
        const rows = [];
        let calls = 0;
        const client = await buildClient('fixture', sdk, async (url, options) => {
            calls++;
            if (options.body) await new Request(url, { ...options, duplex: 'half' }).arrayBuffer();
            return result instanceof Response ? result : Response.json(result);
        });
        await runInvocation(client, { action, ...options }, row => rows.push(row));
        return { exit: process.exitCode, calls, result: rows.at(-1) };
    } finally { process.exitCode = oldExit; }
}

test('cursor checks cover all item routes, including compatible nullable item IDs', async () => {
    for (const [action, id, request] of [
        ['sessions.items.list', 'sess_fixture', {}],
        ['sessions.subagents.items.list', 'sub_fixture', { session_id: 'sess_fixture' }],
        ['sessions.turns.items.list', 'turn_fixture', { session_id: 'sess_fixture' }],
        ['sessions.subagents.turns.items.list', 'turn_fixture', { session_id: 'sess_fixture', subagent_id: 'sub_fixture' }],
        ['responses.inputitems.list', 'resp_fixture', {}],
        ['conversations.items.list', 'conv_fixture', {}],
    ]) {
        const item = { type: 'message', id: 'msg_one', turn_id: 'turn_fixture', role: 'user', status: 'completed',
            content: [{ type: 'input_text', text: 'Fixture' }] };
        const list = (data, has_more = false) => ({ object: 'list', data, has_more,
            first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null });
        const invoke = (value, after) => run(action, value, { id, request: { ...request, ...(after ? { after } : {}) } });
        const first = await invoke(list([item], true));
        assert.equal(first.exit, 0, action);
        assert.equal(first.result.receipt.pagination.nextPage, item.id);
        const second = await invoke(list([{ ...item, id: 'msg_two' }]), item.id);
        assert.equal(second.exit, 0, action);
        assert.equal(second.result.receipt.pagination.state, 'complete');
        for (const [value, anchor] of [
            [{ ...list([item]), first_id: 'wrong' }], [{ ...list([item]), last_id: 'wrong' }],
            [list([item, item])], [list([item]), item.id], [list([{ ...item, type: undefined }])],
            [{ ...list([item]), object: 'page' }],
        ]) assert.equal((await invoke(value, anchor)).exit, 1, action);
        assert.equal((await invoke(list([]))).exit, 0, action);
        if (action.startsWith('sessions.')) {
            const nullable = await invoke(list([item, { ...item, id: null }], true));
            assert.equal(nullable.exit, 0, action);
            assert.equal(nullable.result.receipt.pagination.state, 'cursor-unavailable');
        }
    }
});

test('conversation retrieval, listing and creation honor item identity and message shape', async () => {
    const message = { type: 'message', id: 'msg_fixture', role: 'unknown', status: 'incomplete', content: [] };
    const retrieval = { id: message.id, request: { conversation_id: 'conv_fixture' } };
    assert.equal((await run('conversations.items.retrieve', message, retrieval)).exit, 0);
    for (const wrong of [{ id: 'msg_other' }, { conversation_id: 'conv_other' }, { status: 'invalid' }, { content: {} }]) {
        assert.equal((await run('conversations.items.retrieve', { ...message, ...wrong }, retrieval)).exit, 1);
    }
    const page = data => ({ object: 'list', data, has_more: false });
    const id = 'conv_fixture';
    const create = { id, request: { items: [{ role: 'user', content: 'Fixture' }] } };
    const stored = { ...message, role: 'user', content: [{ type: 'input_text', text: 'Fixture' }] };
    assert.equal((await run('conversations.items.create', page([stored]), create)).exit, 0);
    for (const data of [[null], [{ ...message, id: null }], [message, message], []]) {
        assert.equal((await run('conversations.items.create', page(data), create)).exit, 1);
    }
    const call = { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', status: 'completed',
        name: 'fixture', arguments: '{}' };
    const output = { type: 'function_call_output', id: 'fco_fixture', status: 'completed', output: 'Fixture' };
    const omitted = await run('conversations.items.list', page([output]), { id });
    assert.equal(omitted.exit, 0);
    assert.equal(omitted.result.receipt.conversationItems.outputsWithoutCallId, 1);
    const unknown = await run('conversations.items.list', page([{ type: 'future_item', id: 'future_fixture' }]), { id });
    assert.equal(unknown.exit, 0);
    assert.deepEqual(unknown.result.receipt.conversationItems, { verification: 'partial', uncheckedTypes: ['future_item'] });
    for (const bad of [{ ...call, id: null }, { ...call, status: 'wrong' }, { ...output, call_id: 17 },
        { ...stored, content: [{ type: 'input_file', file_id: 17 }] },
        { ...stored, content: [{ type: 'input_image', detail: false, image_url: 'https://example.test/image' }] }]) {
        assert.equal((await run('conversations.items.list', page([bad]), { id })).exit, 1);
    }
    for (const attachment of [{ type: 'input_file', file_id: 'file_fixture' },
        { type: 'input_image', detail: 'original', file_id: null, image_url: 'https://example.test/image' },
        { type: 'computer_screenshot', file_id: 'file_fixture', image_url: null, detail: 'auto' }]) {
        assert.equal((await run('conversations.items.retrieve', { ...stored, content: [attachment] }, retrieval)).exit, 0);
    }
    const submitOutput = { id, request: { items: [{ type: 'function_call_output', call_id: 'call_fixture', output: 'Fixture' }] } };
    assert.equal((await run('conversations.items.create', page([{ ...output, call_id: 'call_fixture' }]), submitOutput)).exit, 0);
    for (const reply of [output, { ...output, call_id: 'call_other' }, stored,
        { ...output, call_id: 'call_fixture', output: 'Other result' }]) {
        const mismatch = await run('conversations.items.create', page([reply]), submitOutput);
        assert.equal(mismatch.exit, 1);
        assert.equal(mismatch.result.outcomeUnconfirmed, true);
        assert.equal(mismatch.result.receipt.conversationItems.verification, 'mismatch');
    }
    const referenced = { id, request: { items: [{ id: stored.id }] } };
    assert.equal((await run('conversations.items.create', page([stored]), referenced)).exit, 0);
    assert.equal((await run('conversations.items.create', page([{ ...stored, id: 'msg_other' }]), referenced)).exit, 1);
    assert.equal((await run('conversations.items.list', page([]), { id })).exit, 0);
});

test('conversation write verifies lossless arguments and inline attachments', async () => {
    const go = (input, output) => run('conversations.items.create', { object: 'list', data: [output], has_more: false },
        { id: 'conv_fixture', request: { items: [input] } });
    const call = { type: 'function_call', call_id: 'call_fixture', name: 'fixture',
        arguments: '{"id":9007199254740993,"levels":[1,2]}' };
    const stored = { ...call, id: 'fc_fixture', status: 'completed' };
    const normalized = { ...stored, arguments: '{ "levels": [1e0,2], "id": 9007199254740993.0 }' };
    assert.equal((await go(call, normalized)).exit, 0);
    for (const args of ['{"id":9007199254740992,"levels":[1,2]}', '{"id":9007199254740993,"levels":[2,1]}']) {
        assert.equal((await go(call, { ...stored, arguments: args })).exit, 1);
    }
    const file = { type: 'input_file', file_data: 'data:text/plain;base64,SGVsbG8=' };
    const message = content => ({ type: 'message', role: 'user', content: [content] });
    const item = content => ({ ...message(content), id: 'msg_fixture', status: 'completed' });
    assert.equal((await go(message(file), item({ ...file, file_data: 'SGVsbG8' }))).exit, 0);
    assert.equal((await go(message(file), item({ ...file, file_data: 'V29ybGQ=' }))).exit, 1);
    const converted = await go(message(file), item({ type: 'input_file', file_id: 'file_fixture' }));
    assert.equal(converted.exit, 1);
    assert.equal(converted.result.receipt.conversationItems.correlation, 'partial');
    assert.equal(converted.result.data.data[0].content[0].file_id, 'file_fixture');
});

test('session event acknowledgements distinguish dispatch, HTTP status and the response body', async () => {
    const action = 'sessions.events.create';
    const id = 'sess_fixture';
    const request = { events: [] };
    const accepted = await run(action, new Response(null, { status: 202 }), { id, request });
    assert.equal(accepted.calls, 1);
    assert.equal(accepted.exit, 0);
    assert.equal(accepted.result.receipt.eventAcceptance, 'accepted');
    for (const value of [new Response(null, { status: 200 }), Response.json({ object: 'unrelated' }, { status: 202 })]) {
        const unexpected = await run(action, value, { id, request });
        assert.equal(unexpected.calls, 1);
        assert.equal(unexpected.exit, 1);
        assert.notEqual(unexpected.result.receipt.eventAcceptance, 'accepted');
        assert.equal(unexpected.result.outcomeUnconfirmed, true);
    }
    const invalid = await run(action, null, { id, request: { events: 'wrong' } });
    assert.equal(invalid.exit, 1);
    assert.equal(invalid.calls, 0);
});

test('multipart direct completion retains the observed File identity when metadata disagree', async () => {
    const options = { id: 'upload_fixture', request: { part_ids: ['part_fixture'] } };
    const file = { object: 'file', id: 'file-fixture', filename: 'original.txt', purpose: 'assistants', bytes: null };
    const result = { object: 'upload', id: options.id, status: 'completed', bytes: 8, filename: file.filename,
        purpose: file.purpose, file };
    const accepted = await run('uploads.complete', result, options);
    assert.equal(accepted.exit, 0);
    assert.equal(accepted.result.receipt.fileId, file.id);
    for (const invalidId of [[file.id], 'file-' + 'a'.repeat(252)]) {
        const invalid = await run('uploads.complete', { ...result, file: { ...file, id: invalidId } }, options);
        assert.equal(invalid.exit, 1);
        assert.equal(invalid.result.receipt.observedFileId, undefined);
    }
    for (const diff of [{ filename: 'wrong.txt' }, { purpose: 'vision' }, { bytes: 7 }]) {
        const mismatch = await run('uploads.complete', { ...result, file: { ...file, ...diff } }, options);
        assert.equal(mismatch.exit, 1);
        assert.equal(mismatch.result.receipt.observedFileId, file.id);
        assert.equal(mismatch.result.receipt.fileId, undefined);
    }
});

test('transcript timing checks preserve overlap and distinguish missing annotations from invalid ones', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'legatus-transcript-'));
    try {
        const action = 'audio.transcriptions.create';
        const inputFile = join(folder, 'fixture.wav');
        const header = Buffer.from('52494646247d000057415645666d74201000000001000100803e0000007d00000200100064617461007d0000', 'hex');
        await writeFile(inputFile, Buffer.concat([header, Buffer.alloc(32000)]));
        const segment = { start: 0, end: 1, text: 'Fixture', id: 'seg_a', speaker: 'A', type: 'transcript.text.segment' };
        const response = { text: 'Fixture', duration: 1 };
        const diarized = { inputFile, request: { model: 'gpt-4o-transcribe-diarize', response_format: 'diarized_json',
            chunking_strategy: 'auto' } };
        for (const [segments, expected] of [[[], 0], [[segment, { ...segment, id: 'seg_b', start: 0.5 }], 0],
            [[segment, { ...segment, start: 0.5 }], 1], [[{ ...segment, end: 1.01 }], 1]]) {
            const observed = await run(action, { ...response, segments }, diarized);
            assert.equal(observed.calls, 1);
            assert.equal(observed.exit, expected);
        }
        const verbose = { inputFile, request: { model: 'whisper-1', response_format: 'verbose_json' } };
        for (const [words, expected] of [[undefined, 0], [[{ start: 0, end: 1.0009, word: 'Fixture' }], 0],
            [[{ start: 0, end: 1.01, word: 'Fixture' }], 1]]) {
            const observed = await run(action, { ...response, language: 'english', words }, verbose);
            assert.equal(observed.calls, 1);
            assert.equal(observed.exit, expected);
        }
    } finally { await rm(folder, { recursive: true, force: true }); }
});

test('vector search and embeddings verify the content before releasing it to consumers', async () => {
    const hit = { file_id: 'file-test', filename: 'fixture.txt', score: 1,
        content: [{ type: 'text', text: 'A visible passage' }] };
    const search = (data, has_more = false) => run('vectorstores.search',
        { object: 'vector_store.search_results.page', data, has_more, next_page: has_more ? 'opaque' : null },
        { id: 'vs_test', request: { query: 'word' } });
    assert.equal((await search([])).exit, 0);
    assert.equal((await search([hit, { ...hit, score: 0 }])).exit, 0);
    assert.equal((await search([hit], true)).result.receipt.pagination.state, 'cursor-unavailable');
    assert.equal((await search([{ ...hit, score: 1.01 }])).exit, 1);
    assert.equal((await search([{ ...hit, content: [{ type: 'text', text: 10 }] }])).exit, 1);
    const embed = (vectors, request) => run('embeddings.create', { object: 'list', model: 'text-embedding-3-small',
        usage: { prompt_tokens: 3, total_tokens: 3 },
        data: vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })) },
        { request: { input: vectors.map(() => 'check'), ...request } });
    const base64 = 'AACAPwAAAEA=';
    assert.equal((await embed([base64], { dimensions: 2, encoding_format: 'base64' })).exit, 0);
    assert.equal((await embed([base64], {})).exit, 0);
    assert.equal((await embed([[1, 2]], { dimensions: 2, encoding_format: 'float' })).exit, 0);
    for (const [vectors, options] of [
        [[[1]], { dimensions: 2 }], [[base64], { encoding_format: 'float' }], [[[1, 2], [1]], {}],
        [[[1, 2], base64], {}], [['AA=='], {}], [['AAABf4A='], {}], [['AADAfw=='], {}],
    ]) assert.equal((await embed(vectors, options)).exit, 1);
});

test('inline media preserves partial results and unknown Responses preserve raw state', async () => {
    const image = { b64_json: 'YQ==' };
    const partial = await run('images.generate', { data: [image] }, { request: { n: 2 } });
    assert.equal(partial.exit, 1);
    assert.deepEqual(partial.result.data.data, [image]);
    assert.equal(partial.result.receipt.imageOutput.completion, 'partial');
    assert.equal((await run('images.generate', { data: [{ b64_json: 'YR==' }] })).exit, 1);
    assert.equal((await run('images.generate', { data: [{ b64_json: 'YWE\n' }] })).exit, 1);
    assert.equal((await run('images.generate', { data: [{ url: 'https://example.com/artifact.png' }] },
        { request: { response_format: 'url' } })).exit, 0);
    const explicit = { request: { output_format: 'svg' } };
    const different = await run('images.generate', { output_format: 'png', data: [image] }, explicit);
    const invalidBytes = await run('images.generate', { output_format: 'svg', data: [image] }, explicit);
    for (const mismatch of [different, invalidBytes]) {
        assert.equal(mismatch.exit, 1);
        assert.equal(mismatch.result.receipt.imageOutput.formatVerification, 'mismatch');
        assert.deepEqual(mismatch.result.data.data, [image]);
    }
    for (const [status, exit] of [['queued', 0], ['completed', 0], ['new_state', 1]]) {
        const observed = await run('responses.retrieve', { object: 'response', id: 'resp_fixture', status, output: [] },
            { id: 'resp_fixture' });
        assert.equal(observed.exit, exit);
        assert.equal(observed.result.data.status, status);
        assert.equal(observed.result.receipt.resourceStatus, exit ? undefined : status);
        assert.equal(observed.result.receipt.resourceStatusClassification, exit ? 'unknown' : undefined);
    }
});
