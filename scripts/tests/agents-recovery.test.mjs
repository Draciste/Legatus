import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import filesystem from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { runInvocation, runWorkspace } from '../openai-agents.mjs';
import { estimateWork } from '../openai-workbench.mjs';

async function invoke(client, action, fields = {}) {
    const lines = [];
    const previous = process.exitCode;
    try {
        process.exitCode = 0;
        await runInvocation(client, { action, request: {}, timeoutSeconds: 10, ...fields }, value => lines.push(value));
        return { lines, exit: process.exitCode };
    } finally { process.exitCode = previous; }
}

function response(body, status = 200) {
    return { asResponse: async () => Response.json(body, { status }) };
}

test('Batch retains verified outputs when staging cleanup fails and preserves input HTTP details', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'legatus-batch-staging-'));
    const savedRmdir = filesystem.rmdir;
    filesystem.rmdir = async target => {
        if (String(target).includes('.legatus-batch-input-')) throw Object.assign(Error('Local fixture'), { code: 'ENOTEMPTY' });
        return savedRmdir(target);
    };
    syncBuiltinESMExports();
    try {
        const batch = { object: 'batch', id: 'batch_fixture', status: 'completed', endpoint: '/v1/responses',
            input_file_id: 'file-input', output_file_id: 'file-output', request_counts: { total: 1, completed: 1, failed: 0 } };
        const input = JSON.stringify({ custom_id: 'row', method: 'POST', url: '/v1/responses', body: {} });
        const output = JSON.stringify({ custom_id: 'row', response: { status_code: 200, body: {} }, error: null });
        for (const status of [200, 404, 429]) {
            const outputDirectory = await mkdtemp(join(directory, 'case-'));
            const client = { batches: { retrieve: () => response(batch) }, files: { content: id => ({
                asResponse: async () => {
                    if (id === 'file-output') return new Response(output);
                    if (status === 200) return new Response(input);
                    const headers = new Headers({ 'x-request-id': 'req_input', 'retry-after': '10' });
                    throw Object.assign(Error('Input GET fixture'), { status, headers });
                },
            }) } };
            const outcome = await invoke(client, 'batches.wait', { id: batch.id, outputDirectory, verifyInputIds: true });
            const result = outcome.lines.at(-1);
            assert.equal(outcome.exit, status === 200 ? 0 : 1);
            assert.equal(result.data.artifactVerification.state, status === 200 ? 'input-ids-verified' : 'input-unavailable');
            assert.equal(result.localWarnings[0].code, 'ENOTEMPTY');
            assert.equal(await readFile(result.data.files[0].path, 'utf8'), output);
            if (status !== 200) {
                assert.equal(result.data.artifactVerification.inputError.httpStatus, status);
                assert.equal(result.data.artifactVerification.inputError.headers['x-request-id'], 'req_input');
            }
        }
    } finally {
        filesystem.rmdir = savedRmdir;
        syncBuiltinESMExports();
        await rm(directory, { recursive: true, force: true });
    }
});

test('Workspace attributes checkpoint setup, ambiguous conflicts and accepted runs to the right stage', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'legatus-workspace-'));
    const checkpointPath = join(directory, 'existing.jsonl');
    const invocation = {
        action: 'workspace.trigger', id: 'agtch_fixture', request: { input: 'hello' }, timeoutSeconds: 10,
    };
    const previous = process.exitCode;
    try {
        await writeFile(checkpointPath, 'existing');
        const lines = [];
        let calls = 0;
        const mock = async status => {
            await runWorkspace('fixture-token-0123456789', invocation, value => lines.push(value), async () => {
                calls++;
                return status === 202
                    ? Response.json({ agent_trigger_run_id: 'apirun_fixture', conversation_url: 'invalid' }, { status })
                    : Response.json({ error: { code: 'conflict' } }, { status });
            });
            return lines.pop();
        };
        await runWorkspace('fixture-token-0123456789', { ...invocation, checkpointPath },
            value => lines.push(value), () => { calls++; });
        assert.equal(calls, 0);
        assert.equal(lines[0].dispatch, 'not-attempted');
        assert.equal(lines[0].outcomeUnconfirmed, false);
        assert.equal(await readFile(checkpointPath, 'utf8'), 'existing');
        assert.equal((await mock(409)).outcomeUnconfirmed, true);
        assert.equal((await mock(425)).outcomeUnconfirmed, true);
        const accepted = await mock(202);
        assert.equal(accepted.kind, 'error');
        assert.equal(accepted.receipt.workspaceRunId, 'apirun_fixture');
        assert.equal(accepted.outcomeUnconfirmed, false);
        assert.equal(calls, 3);
    } finally {
        process.exitCode = previous;
        await rm(directory, { recursive: true, force: true });
    }
});

test('only supported acknowledgements can omit buffered API data', async () => {
    const noContent = () => ({ asResponse: async () => new Response(null, { status: 204 }) });
    const deleted = await invoke({ files: { delete: noContent } }, 'files.delete', { id: 'file-fixture' });
    assert.equal(deleted.exit, 0);
    assert.equal(deleted.lines[0].data, null);
    const unexpected = await invoke({ beta: { agents: { retrieve: noContent } } }, 'agents.retrieve', { id: 'agent_fixture' });
    assert.equal(unexpected.exit, 1);
    assert.equal(unexpected.lines[0].kind, 'error');
    const emptyBody = () => ({ asResponse: async () => new Response('', { headers: { 'content-type': 'application/json' } }) });
    const empty = await invoke({ beta: { agents: { create: emptyBody } } }, 'agents.create');
    assert.equal(empty.exit, 1);
    assert.equal(empty.lines[0].outcomeUnconfirmed, true);
});

test('buffered resource results bind IDs and documented parent identities', async () => {
    const agent = {id:'agt_fixture',object:'agent'};
    const containerFile = {id:'cfile_fixture',object:'container.file',container_id:'cntr_fixture'};
    const client = { beta:{agents:{retrieve:()=>response(agent)}}, containers:{files:{
        retrieve:()=>response(containerFile), create:()=>response(containerFile),
    }} };
    assert.equal((await invoke(client,'agents.retrieve',{id:agent.id})).exit,0);
    assert.equal((await invoke(client,'agents.retrieve',{id:'agt_other_fixture'})).exit,1);
    assert.equal((await invoke(client,'containers.files.retrieve',{id:containerFile.id,request:{container_id:'cntr_fixture'}})).exit,0);
    assert.equal((await invoke(client,'containers.files.retrieve',{id:containerFile.id,request:{container_id:'cntr_other_fixture'}})).exit,1);
    assert.equal((await invoke(client,'containers.files.create',{id:'cntr_fixture',request:{file_id:'file_fixture'}})).exit,0);
});

test('inference output matches the unambiguous input cardinality', async () => {
    const model = 'omni-moderation-latest';
    const categories = ['harassment', 'harassment/threatening', 'hate', 'hate/threatening', 'illicit', 'illicit/violent',
        'self-harm', 'self-harm/instructions', 'self-harm/intent', 'sexual', 'sexual/minors', 'violence', 'violence/graphic'];
    const map = value => Object.fromEntries(categories.map(category => [category, value]));
    const clean = { flagged: false, categories: map(false), category_scores: map(0), category_applied_input_types: map(['text']) };
    let body = { id: 'mod_fixture', model, results: [clean] };
    const client = { embeddings:{create:()=>response({object:'list',model:'fixture',usage:{prompt_tokens:2,total_tokens:2},
        data:[{object:'embedding',index:0,embedding:[0.01]}]})},
        moderations:{create:()=>response(body)} };
    assert.equal((await invoke(client,'embeddings.create',{request:{input:[2,5]}})).exit,0);
    assert.equal((await invoke(client,'embeddings.create',{request:{input:[[2],[5]]}})).exit,1);
    assert.equal((await invoke(client,'moderations.create',{request:{input:['first','second']}})).exit,1);
    assert.equal((await invoke(client,'moderations.create',{request:{input:[{type:'text',text:'first'},{type:'text',text:'second'}]}})).exit,0);
    for (const [changes, reason] of [
        [{ categories: { ...clean.categories, harassment: true } }, 'flag-contradiction'],
        [{ category_scores: { ...clean.category_scores, harassment: 1.01 } }, 'category-score'],
        [{ category_applied_input_types: { ...clean.category_applied_input_types, harassment: ['image'] } }, 'category-modality'],
        [{ categories: {} }, 'category-coverage'],
    ]) {
        body = { ...body, results: [{ ...clean, ...changes }] };
        const reply = await invoke(client, 'moderations.create', { request: { model, input: 'Fixture' } });
        assert.equal(reply.exit, 1);
        assert.equal(reply.lines[0].receipt.moderationVerification.reason, reason);
        assert.deepEqual(reply.lines[0].data, body);
    }
    const { illicit, 'illicit/violent': illicitViolent, ...legacyCategories } = clean.categories;
    const legacyScores = Object.fromEntries(Object.keys(legacyCategories).map(category => [category, 0]));
    body = { id: 'mod_fixture', model: 'text-moderation-007',
        results: [{ flagged: false, categories: legacyCategories, category_scores: legacyScores }] };
    assert.equal((await invoke(client, 'moderations.create', { request: { model: 'text-moderation-latest', input: 'Fixture' } })).exit, 0);
    const wrongProfile = await invoke(client, 'moderations.create', { request: { model, input: 'Fixture' } });
    assert.equal(wrongProfile.lines[0].receipt.moderationVerification.reason, 'model-profile-mismatch');
});

test('the main Agents turn is distinct from a completed child turn', async () => {
    const child = { id: 'turn_child', subagent_id: 'subagent_one', status: 'completed' };
    const root = { id: 'turn_root', subagent_id: null, status: 'failed' };
    async function* events() {
        yield { type: 'agent.session.turn.completed', session_id: 'sess_sample', turn: child };
        yield { type: 'agent.session.turn.failed', session_id: 'sess_sample', turn: root };
    }
    const stream = () => Object.assign(Promise.resolve(events()), {
        asResponse: async () => new Response('', { headers: { 'content-type': 'text/event-stream' } }),
    });
    const client = { beta: { agents: { sessions: { events: { stream } } } } };
    const args = { id: 'sess_sample', stopOnTurn: true };
    const mainRun = await invoke(client, 'sessions.events.stream', args);
    assert.equal(mainRun.exit, 1);
    assert.equal(mainRun.lines.at(-1).outcome, 'agent.session.turn.failed');
    assert.equal(mainRun.lines.at(-1).receipt.turnId, root.id);
    const selectedChild = await invoke(client, 'sessions.events.stream', { ...args, turnId: child.id });
    assert.equal(selectedChild.exit, 0);
    assert.equal(selectedChild.lines.at(-1).receipt.turnId, child.id);
});

test('Agents environment failure is reported even by a watcher', async () => {
    async function* events() { yield { type: 'agent.session.environment.failed', session_id: 'sess_sample' }; }
    const stream = () => Object.assign(Promise.resolve(events()), {
        asResponse: async () => new Response('', { headers: { 'content-type': 'text/event-stream' } }),
    });
    const client = { beta: { agents: { sessions: { events: { stream } } } } };
    const reply = await invoke(client, 'sessions.events.stream', { id: 'sess_sample' });
    assert.equal(reply.exit, 1);
    assert.equal(reply.lines.at(-1).outcome, 'agent.session.environment.failed');
});

test('Agents watch ignores an unattributed turn and identifies the actual root termination', async () => {
    async function* events() {
        yield { type: 'agent.session.turn.completed', turn: { id: 'turn_unknown', status: 'completed' } };
        yield { type: 'agent.session.turn.failed', turn: { id: 'turn_root', subagent_id: null, status: 'failed' } };
    }
    const stream = () => Object.assign(Promise.resolve(events()), {
        asResponse: async () => new Response('', { headers: { 'content-type': 'text/event-stream' } }),
    });
    const client = { beta: { agents: { sessions: { events: { stream } } } } };
    const focused = await invoke(client, 'sessions.events.stream', { id: 'sess_sample', stopOnTurn: true });
    assert.equal(focused.exit, 1);
    assert.equal(focused.lines.at(-1).receipt.turnId, 'turn_root');
    assert.equal(focused.lines.at(-1).outcome, 'agent.session.turn.failed');
    const watch = await invoke(client, 'sessions.events.stream', { id: 'sess_sample' });
    assert.equal(watch.lines.at(-1).outcome, 'unconfirmed');
    assert.equal(watch.lines.at(-1).lastTerminalTurn.turnId, 'turn_root');
});

test('Agents keeps contradictory terminal events as evidence without claiming a selected turn', async () => {
    const contradiction = { type: 'agent.session.turn.completed', session_id: 'sess_sample',
        session: { id: 'sess_other' }, turn: { id: 'turn_root', subagent_id: null } };
    async function* events() { yield contradiction; }
    const stream = () => Object.assign(Promise.resolve(events()), {
        asResponse: async () => new Response('', { headers: { 'content-type': 'text/event-stream' } }),
    });
    const client = { beta: { agents: { sessions: { events: { stream } } } } };
    const result = await invoke(client, 'sessions.events.stream', { id: 'sess_sample', stopOnTurn: true });
    assert.equal(result.exit, 1);
    assert.deepEqual(result.lines.find(line => line.kind === 'event').event, contradiction);
    assert.equal(result.lines.at(-1).kind, 'error');
    assert.equal(result.lines.at(-1).turnOutcome, 'unconfirmed');
});

test('Stable instructions produce the same prompt for Responses and input token count', async () => {
    const requests = [];
    const client = { responses: {
        create: params => { requests.push(params); return response({ object: 'response', id: 'resp_fixture', status: 'queued' }); },
        inputTokens: { count: params => { requests.push(params); return response({ input_tokens: params.model === 'bad' ? null : 42 }); } },
    } };
    const args = { request: { model: 'fixture', input: 'Vstup' }, stableInstructions: 'Pokyny' };
    const count = await invoke(client, 'responses.inputtokens', args);
    assert.equal(count.exit, 0);
    assert.equal(count.lines[0].data.input_tokens, 42);
    assert.equal((await invoke(client, 'responses.create', args)).exit, 0);
    assert.deepEqual(requests[0].input, requests[1].input);
    assert.equal(requests[0].input[0].role, 'developer');
    assert.equal((await invoke(client, 'responses.inputtokens', { ...args, request: { ...args.request, model: 'bad' } })).exit, 1);
});

test('SDK detects lossy request numbers and preserves the original number text in API results', async () => {
    let calls = 0;
    const client = { responses: { create: () => {
        calls++;
        return { asResponse: async () => new Response(
            '{"object":"response","id":"resp_fixture","status":"completed","exact":9007199254740993,"decimal":0.100000000000000000001}',
            { headers: { 'content-type': 'application/json' } }) };
    } } };
    const request = await invoke(client, 'responses.create', { rawRequest: '{"input":9007199254740993}' });
    assert.equal(request.lines[0].dispatch, 'not-attempted');
    assert.equal(request.lines[0].localCode, 'json_precision');
    assert.equal(calls, 0);
    const good = await invoke(client, 'responses.create', { rawRequest: '{"temperature":0.10}' });
    const encoded = JSON.stringify(good.lines[0].data);
    assert.match(encoded, /"exact":9007199254740993(?:,|})/);
    assert.match(encoded, /"decimal":0\.100000000000000000001(?:,|})/);
    const duplicate = await invoke(client, 'responses.create', { rawRequest: '{"input":{"a":1,"a":2}}' });
    assert.equal(duplicate.lines[0].localCode, 'ambiguous_json');
    assert.equal(calls, 1);
});

test('Live keeps an identified early close distinct from complete input and ignores late media', async () => {
    let seconds = 1;
    class EarlyClose extends EventTarget {
        readyState = 1;
        bufferedAmount = 0;
        constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
        send(payload) {
            assert.equal(JSON.parse(payload).type, 'session.start');
            this.emit({ type: 'session.started', session: { id: 'live_fixture' } });
            this.emit({ type: 'session.output_audio.delta', delta: 'AQI=' });
            this.emit({ type: 'session.closed', session: { id: 'live_fixture' }, reason: 'close_requested', usage: { seconds } });
            this.emit({ type: 'session.output_audio.delta', delta: 'AwQ=' });
        }
        emit(data) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })); }
        close() {}
    }
    const folder = await mkdtemp(join(tmpdir(), 'legatus-live-fixture-'));
    const inputFile = join(folder, 'input.pcm');
    const outputFile = join(folder, 'output.pcm');
    try {
        await writeFile(inputFile, Buffer.from([0, 0, 0, 0]));
        const client = { live: { create() {} }, WebSocketTransport: EarlyClose, apiKey: 'offline-fixture' };
        const request = { session: { model: 'fixture', audio: { format: { type: 'audio/pcm', rate: 16000 } } },
            retain_partial: true };
        const reply = await invoke(client, 'live.audio', { inputFile, outputFile, request });
        assert.equal(reply.exit, 1);
        const data = reply.lines[0].data;
        assert.equal(data.sessionClosed, true);
        assert.equal(data.localCloseRequested, false);
        assert.equal(data.inputComplete, false);
        assert.equal(data.audio.partial, true);
        assert.deepEqual(await readFile(outputFile), Buffer.from([1, 2]));
        seconds = -1;
        const negativePath = join(folder, 'negative.pcm');
        const negative = await invoke(client, 'live.audio', { inputFile, outputFile: negativePath, request });
        const outcome = negative.lines[0];
        assert.equal(negative.exit, 1);
        assert.equal(outcome.data.sessionClosed, true);
        assert.equal(outcome.data.usage, undefined);
        assert.equal(outcome.receipt.liveUsageVerification, 'invalid');
        assert.equal(outcome.receipt.liveUsageSeconds, undefined);
        assert.deepEqual(await readFile(negativePath), Buffer.from([1, 2]));
    } finally { await rm(folder, { recursive: true, force: true }); }
});

test('Live publishes one ordered PCM clip from multiple ordinary audio chunks', async () => {
    const pcm = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    class AudioReply extends EventTarget {
        readyState = 1;
        bufferedAmount = 0;
        replied = false;
        constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
        emit(data) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })); }
        send(payload) {
            const type = JSON.parse(payload).type;
            if (type === 'session.start') this.emit({ type: 'session.started', session: { id: 'live_fixture' } });
            if (type === 'session.input_audio.append' && !this.replied) {
                this.replied = true;
                for (const chunk of [pcm.subarray(0, 3), pcm.subarray(3, 6), pcm.subarray(6)]) {
                    this.emit({ type: 'session.output_audio.delta', delta: chunk.toString('base64') });
                }
            }
            if (type === 'session.close') this.emit({ type: 'session.closed', session: { id: 'live_fixture' },
                reason: 'close_requested', usage: { seconds: 1 } });
        }
        close() {}
    }
    const folder = await mkdtemp(join(tmpdir(), 'legatus-live-clip-'));
    const inputFile = join(folder, 'input.pcm');
    const outputFile = join(folder, 'output.pcm');
    const originalOpen = filesystem.open;
    let writes = 0;
    filesystem.open = async (...args) => {
        const file = await originalOpen(...args);
        if (typeof args[0] === 'string' && basename(args[0]).startsWith('.legatus-part-') && args[1] === 'wx+') {
            const writeFile = file.writeFile.bind(file);
            file.writeFile = (...writeArgs) => { writes++; return writeFile(...writeArgs); };
        }
        return file;
    };
    syncBuiltinESMExports();
    try {
        await writeFile(inputFile, Buffer.alloc(4));
        const client = { live: { create() {} }, WebSocketTransport: AudioReply, apiKey: 'offline-fixture' };
        const request = { session: { model: 'fixture', audio: { format: { type: 'audio/pcm', rate: 16000 } } },
            listen_seconds: 1 };
        const result = await invoke(client, 'live.audio', { inputFile, outputFile, request });
        assert.equal(result.exit, 0);
        assert.equal(result.lines[0].data.outputComplete, true);
        assert.equal(result.lines[0].data.audio.partial, false);
        assert.equal(writes, 1);
        assert.deepEqual(await readFile(outputFile), pcm);
    } finally {
        filesystem.open = originalOpen;
        syncBuiltinESMExports();
        await rm(folder, { recursive: true, force: true });
    }
});

test('Live can retain aligned partial audio on disconnect and report silent closure', async () => {
    class SyntheticSocket extends EventTarget {
        readyState = 1;
        bufferedAmount = 0;
        constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
        emit(data) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })); }
        send(payload) {
            const type = JSON.parse(payload).type;
            if (type === 'session.start') this.emit({ type: 'session.started', session: { id: 'live_fixture' } });
            else if (type === 'session.close') this.emit({ type: 'session.closed', session: { id: 'live_fixture' },
                reason: 'close_requested', usage: { seconds: 1 } });
        }
        close() {}
    }
    class Interrupt extends SyntheticSocket {
        send(payload) {
            super.send(payload);
            if (JSON.parse(payload).type === 'session.input_audio.append') {
                this.emit({ type: 'session.output_audio.delta', delta: 'AQID' });
                this.emit({ type: 'session.output_transcript.delta', delta: 'partial transcript' });
                this.dispatchEvent(new Event('close'));
                this.emit({ type: 'session.output_audio.delta', delta: 'BAU=' });
                this.emit({ type: 'session.output_transcript.delta', delta: 'late transcript' });
            }
        }
    }
    const folder = await mkdtemp(join(tmpdir(), 'legatus-live-fixture-'));
    const inputFile = join(folder, 'input.pcm');
    const outputFile = join(folder, 'output.pcm');
    try {
        await writeFile(inputFile, Buffer.from([0, 0, 0, 0]));
        const client = { live: { create() {} }, WebSocketTransport: Interrupt, apiKey: 'offline-fixture' };
        const fields = { inputFile, outputFile, request: { session: { model: 'fixture',
            audio: { format: { type: 'audio/pcm', rate: 16000 } } }, retain_partial: true, listen_seconds: 1 } };
        const failure = await invoke(client, 'live.audio', fields);
        assert.equal(failure.exit, 1);
        const outcome = failure.lines[0];
        assert.equal(outcome.data.sessionClosed, false);
        assert.equal(outcome.receipt.outcomeUnconfirmed, true);
        assert.equal(outcome.data.audio.partial, true);
        assert.equal(outcome.data.receivedBytes, 3);
        assert.equal(outcome.data.outputTranscript, 'partial transcript');
        assert.deepEqual(await readFile(outputFile), Buffer.from([1, 2]));
        const silent = await invoke({ ...client, WebSocketTransport: SyntheticSocket }, 'live.audio',
            { ...fields, outputFile: join(folder, 'silent.pcm') });
        assert.equal(silent.lines[0].data.sessionClosed, true);
        assert.equal(silent.lines[0].data.audioReceived, false);
        assert.equal(silent.lines[0].data.outputPublished, false);
        assert.equal(silent.lines[0].data.outputComplete, false);
    } finally { await rm(folder, { recursive: true, force: true }); }
});

test('empty Agents event acceptance is recognized without relaxing Responses contracts', async () => {
    const create = () => ({ asResponse: async () => new Response(null, { status: 202 }) });
    const client = { beta: { agents: { sessions: { events: { create } } } }, responses: { create } };
    const accepted = await invoke(client, 'sessions.events.create', { id: 'sess_sample', request: { events: [] } });
    assert.equal(accepted.exit, 0);
    assert.equal(accepted.lines[0].receipt.httpStatus, 202);
    assert.equal(accepted.lines[0].receipt.eventAcceptance, 'accepted');
    assert.equal(accepted.lines[0].data, null);
    const invalid = await invoke(client, 'responses.create', { request: {} });
    assert.equal(invalid.exit, 1);
    assert.equal(invalid.lines[0].dispatch, 'response-received');
});

test('checkpoint write and close errors preserve an accepted Response and its identity', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'legatus-checkpoint-'));
    const checkpointPath = join(folder, 'submit.jsonl');
    const originalOpen = filesystem.open;
    let dispatched = 0;
    filesystem.open = async (file, ...args) => {
        const handle = await originalOpen(file, ...args);
        if (file !== checkpointPath) return handle;
        const sync = handle.sync.bind(handle);
        const close = handle.close.bind(handle);
        handle.sync = async () => {
            if (dispatched) throw Error('Fixture write failure');
            await sync();
        };
        handle.close = async () => {
            await close();
            throw Error('Fixture close failure');
        };
        return handle;
    };
    syncBuiltinESMExports();
    try {
        const create = () => {
            dispatched++;
            return response({ object: 'response', id: 'resp_fixture', status: 'queued' });
        };
        const result = await invoke({ responses: { create } }, 'responses.create', { checkpointPath });
        assert.equal(dispatched, 1);
        assert.equal(result.exit, 0);
        assert.equal(result.lines.length, 1);
        assert.equal(result.lines[0].receipt.resourceId, 'resp_fixture');
        assert.equal(result.lines[0].data.status, 'queued');
        assert.ok(result.lines[0].localWarnings.some(warning => warning.phase === 'close'));
        assert.ok(result.lines[0].localWarnings.some(warning => warning.phase === 'response_received'));
    } finally {
        filesystem.open = originalOpen;
        syncBuiltinESMExports();
        await rm(folder, { recursive: true, force: true });
    }
});

test('Agents preserves a completed turn when a requested event file fails to close', async () => {
    const folder = await mkdtemp(join(tmpdir(),'legatus-agent-events-'));
    const eventFile = join(folder,'events.jsonl');
    const originalOpen = filesystem.open;
    filesystem.open = async (file,...args) => {
        const handle = await originalOpen(file,...args);
        if (file === eventFile) {
            const close = handle.close.bind(handle);
            handle.close = async () => { await close(); throw Error('Synthetic close failure'); };
        }
        return handle;
    };
    syncBuiltinESMExports();
    try {
        const stream = () => Object.assign(Promise.resolve((async function*() {
            yield {type:'agent.session.turn.completed',session_id:'sess_fixture',turn_id:'turn_fixture',subagent_id:null,
                turn:{id:'turn_fixture',status:'completed'}};
        })()), {asResponse:async()=>new Response('',{headers:{'content-type':'text/event-stream'}})});
        const client = {beta:{agents:{sessions:{events:{stream}}}}};
        const result = await invoke(client,'sessions.events.stream',{id:'sess_fixture',eventFile,stopOnTurn:true});
        assert.equal(result.exit,1);
        assert.equal(result.lines.at(-1).outcome,'agent.session.turn.completed');
        assert.equal(result.lines.at(-1).receipt.turnId,'turn_fixture');
        assert.equal(result.lines.at(-1).observedEventsSaved,false);
    } finally {
        filesystem.open = originalOpen;
        syncBuiltinESMExports();
        await rm(folder,{recursive:true,force:true});
    }
});

test('expired Batch returns its published output even with a missing error file', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'legatus-batch-'));
    try {
        const client = {
            batches: { retrieve: () => response({ id: 'batch_fixture', object: 'batch', status: 'expired',
                output_file_id: 'file-output', error_file_id: 'file-error' }) },
            files: { content: id => ({ asResponse: async () => {
                if (id === 'file-error') throw Error('Fixture unavailable');
                return new Response('fixture\n');
            } }) },
        };
        const reply = await invoke(client, 'batches.wait', {
            id: 'batch_fixture', outputDirectory: folder, checkpointPath: join(folder, 'submit.jsonl'),
        });
        assert.equal(reply.exit, 1);
        const { files, outcome } = reply.lines[0].data;
        assert.equal(outcome, 'review-required');
        assert.equal(files.length, 2);
        assert.equal(await readFile(files[0].path, 'utf8'), 'fixture\n');
        assert.equal(files[1].fileId, 'file-error');
        assert.ok(files[1].error);
    } finally { await rm(folder, { recursive: true, force: true }); }
});

test('completed Batch exposes invalid or empty artifacts without changing remote status', async () => {
    for (const [reference,category] of [['file-empty','empty_output_for_completed_requests'],['unknown','invalid_batch_file_id']]) {
        const folder = await mkdtemp(join(tmpdir(), 'legatus-batch-output-'));
        try {
            let downloads=0;
            const client = { batches:{retrieve:()=>response({id:'batch_fixture',object:'batch',status:'completed',
                output_file_id:reference, request_counts:{total:1,completed:1,failed:0}})}, files:{content:()=>({asResponse:async()=>{
                    downloads++;
                    return new Response('');
                }})} };
            const result = await invoke(client,'batches.wait',{id:'batch_fixture',outputDirectory:folder});
            assert.equal(result.exit,1);
            assert.equal(result.lines[0].data.batch.status,'completed');
            assert.equal(result.lines[0].data.artifactsCollected,false);
            assert.equal(result.lines[0].data.files[0].error.category,category);
            assert.equal(downloads,reference === 'unknown' ? 0 : 1);
        } finally { await rm(folder,{recursive:true,force:true}); }
    }
});

test('pilot checkpoint failure is classified before the first synthetic turn', async () => {
    const folder = await mkdtemp(join(tmpdir(),'legatus-pilot-preflight-'));
    const checkpointPath = join(folder,'used.jsonl');
    try {
        await writeFile(checkpointPath,'existing result');
        const client = {baseURL:'https://api.openai.com/v1',apiKey:'sk-offline-fixture-no-network',
            WebSocketTransport:class { constructor() { assert.fail('Unexpected connection'); } }};
        const result = await invoke(client,'responses.pilot',{request:{model:'fixture'},checkpointPath});
        assert.equal(result.exit,1);
        assert.equal(result.lines[0].dispatch,'not-attempted');
        assert.equal(result.lines[0].outcomeUnconfirmed,false);
    } finally { await rm(folder,{recursive:true,force:true}); }
});

test('for multi-step delegation, unknown peaks stay unknown and expired capacity cannot confirm fit', () => {
    const base = { model: 'fixture', mode: 'standard', capacity: { tpm: 1000, tpmUsed: 300 } };
    const forecast = { inputTokens: 100, outputTokens: 100, multiStep: true };
    assert.equal(estimateWork({ ...base, forecast }).checks[0].fitsEstimate, null);
    const measured = { ...forecast, minuteWindows: [{ modelInputTokens: 550, modelOutputTokens: 150 }],
        tpmHeadroomTokens: 25 };
    assert.deepEqual(estimateWork({ ...base, forecast: measured }).checks[0],
        { kind: 'tpm', free: 700, need: 725, numericalFit: false, fitsEstimate: null });
    assert.equal(estimateWork({ ...base, capacity: { ...base.capacity, validUntil: '2000-01-01T00:00:00Z' },
        forecast: measured }).checks[0].fitsEstimate, null);
});
