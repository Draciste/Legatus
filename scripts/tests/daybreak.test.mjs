import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInvocation } from '../openai-agents.mjs';

const blue = 'daybreak_blue';
const model = 'gpt-6-sol';
const input = 'Outline a review of a fictional patch that improves error handling.';
const sessionId = 'sess_daybreak_fixture';
const turnId = 'turn_daybreak_fixture';

function sessionRequest(extra = {}) {
    return {
        agent: { model, tools: [] }, environment: { type: 'none' }, input,
        access_programs: { cyber: blue }, ...extra,
    };
}

function sdkResponse(data) {
    return { asResponse: async () => Response.json(data, { headers: { 'x-request-id': 'req_daybreak_fixture' } }) };
}

function sdkStream(events) {
    async function* readEvents() { yield* events; }
    return Object.assign(Promise.resolve(readEvents()), {
        asResponse: async () => new Response('', { headers: { 'content-type': 'text/event-stream' } }),
    });
}

function agentClient(sessions) {
    return { beta: { agents: { sessions } } };
}

function createdSession(fields = {}) {
    return { type: 'agent.session.created', event_id: 'evt_session_created', session: {
        id: sessionId, object: 'agent.session', agent: { model }, ...fields,
    } };
}

function turnEvent(status, id = turnId, subagent = null) {
    return {
        type: `agent.session.turn.${status}`, event_id: `evt_${id}_${status}`, session_id: sessionId, turn_id: id,
        turn: { id, object: 'agent.session.turn', session_id: sessionId, subagent_id: subagent,
            status: status === 'created' ? 'in_progress' : status },
    };
}

async function invoke(client, action, args = {}) {
    const lines = [];
    const previous = process.exitCode;
    try {
        process.exitCode = 0;
        await runInvocation(client, { action, request: {}, timeoutSeconds: 10, ...args }, value => {
            lines.push(structuredClone(value));
        });
        return { lines, result: lines.at(-1), exit: process.exitCode };
    } finally {
        process.exitCode = previous;
    }
}

test('a buffered Daybreak session forwards its settings and records matching configuration without recording input', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'legatus-daybreak-'));
    const checkpointPath = join(directory, 'session.jsonl');
    t.after(async () => {
        await unlink(checkpointPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
        await rmdir(directory);
    });
    let sent;
    const client = agentClient({ create(request) {
        sent = request;
        return sdkResponse({
            id: sessionId, object: 'agent.session', status: 'in_progress',
            agent: { model }, access_programs: { cyber: blue },
        });
    } });

    const request = sessionRequest({ metadata: { job_ref: 'daybreak_fixture' } });
    const { exit, result } = await invoke(client, 'sessions.create', { request, checkpointPath });
    assert.equal(exit, 0);
    assert.deepEqual(sent, request);
    assert.equal(result.receipt.sessionId, sessionId);
    assert.equal(result.receipt.daybreak.requestedProgram, blue);
    assert.equal(result.receipt.daybreak.observedProgram, blue);
    assert.equal(result.receipt.daybreak.configurationState, 'confirmed');
    assert.equal(result.receipt.daybreak.acceptanceState, 'accepted');
    assert.equal(result.receipt.daybreak.jobRef, 'daybreak_fixture');
    assert.equal(result.receipt.daybreak.inputSha256, createHash('sha256').update(JSON.stringify(input)).digest('hex'));

    const rawCheckpoint = await readFile(checkpointPath, 'utf8');
    const checkpoint = rawCheckpoint.trim().split('\n').map(line => JSON.parse(line));
    const pending = checkpoint.find(record => record.phase === 'dispatch_pending');
    assert.equal(pending.daybreak.requestedProgram, blue);
    assert.equal(pending.daybreak.configurationState, 'unconfirmed');
    assert.ok(checkpoint.some(record => record.sessionId === sessionId &&
        record.daybreak?.configurationState === 'confirmed'));
    assert.equal(rawCheckpoint.includes(input), false);
});

test('a session with no explicit program echo keeps its Daybreak configuration unconfirmed', async () => {
    const client = agentClient({ create: () => sdkResponse({
        id: sessionId, object: 'agent.session', status: 'idle', agent: { model },
        metadata: { access_programs: blue },
    }) });
    const { exit, result } = await invoke(client, 'sessions.create', { request: sessionRequest() });
    assert.equal(exit, 0);
    assert.equal(result.receipt.sessionId, sessionId);
    assert.equal(result.receipt.daybreak.requestedProgram, blue);
    assert.equal(result.receipt.daybreak.configurationState, 'unconfirmed');
    assert.equal(result.receipt.daybreak.observedProgram, undefined);
});

test('session completion is independent of configuration evidence and ignores the completed child turn', async () => {
    const events = [
        createdSession(),
        turnEvent('created'),
        turnEvent('completed', 'turn_previous_fixture'),
        turnEvent('completed', 'turn_child_fixture', 'subagent_fixture'),
        turnEvent('completed'),
    ];
    const client = agentClient({ create: () => sdkStream(events) });
    const { exit, result } = await invoke(client, 'sessions.create', { request: sessionRequest({ stream: true }) });
    assert.equal(exit, 0);
    assert.equal(result.outcome, 'agent.session.turn.completed');
    assert.equal(result.receipt.turnId, turnId);
    assert.equal(result.receipt.daybreak.configurationState, 'unconfirmed');
});

test('a wrong-session SSE event cannot supply program or terminal evidence', async () => {
    const events = [
        createdSession(),
        createdSession({ id: 'sess_other_fixture', access_programs: { cyber: blue } }),
        turnEvent('completed'),
    ];
    const client = agentClient({ create: () => sdkStream(events) });
    const { exit, result } = await invoke(client, 'sessions.create', { request: sessionRequest({ stream: true }) });
    assert.equal(exit, 1);
    assert.equal(result.turnOutcome, 'unconfirmed');
    assert.equal(result.receipt.sessionId, sessionId);
    assert.equal(result.receipt.turnId, undefined);
    assert.equal(result.receipt.daybreak.configurationState, 'unconfirmed');
    assert.equal(result.receipt.daybreak.observedProgram, undefined);
});

test('stream EOF retains an identified session even without a confirmed turn outcome', async () => {
    const events = [
        createdSession({ access_programs: { cyber: blue } }),
        { type: 'agent.session.idle', session_id: sessionId },
    ];
    const client = agentClient({ create: () => sdkStream(events) });
    const { exit, result } = await invoke(client, 'sessions.create', { request: sessionRequest({ stream: true }) });
    assert.equal(exit, 1);
    assert.equal(result.outcome, 'unconfirmed');
    assert.equal(result.receipt.sessionId, sessionId);
    assert.equal(result.receipt.turnId, undefined);
    assert.equal(result.receipt.daybreak.configurationState, 'confirmed');
});

test('an explicit provider mismatch remains visible on an identified accepted session', async () => {
    const client = agentClient({ create: () => sdkResponse({
        id: sessionId, object: 'agent.session', status: 'in_progress', agent: { model },
        access_programs: { cyber: 'standard' },
    }) });
    const { result } = await invoke(client, 'sessions.create', { request: sessionRequest() });
    assert.equal(result.receipt.sessionId, sessionId);
    assert.equal(result.receipt.daybreak.requestedProgram, blue);
    assert.equal(result.receipt.daybreak.configurationState, 'mismatch');
    assert.equal(result.receipt.daybreak.observedProgram, 'standard');
});

test('ordinary Responses traffic keeps its request and receipt shape when Daybreak is absent', async () => {
    let sent;
    const client = { responses: { create(request) {
        sent = request;
        return sdkResponse({ id: 'resp_daybreak_fixture', object: 'response', status: 'completed', model, output: [] });
    } } };
    const request = { model, input };
    const { exit, result } = await invoke(client, 'responses.create', { request });
    assert.equal(exit, 0);
    assert.deepEqual(sent, { ...request, store: false });
    assert.equal(Object.hasOwn(result.receipt, 'daybreak'), false);
});

test('new Daybreak session generates a recoverable job reference and rejects contradictory returned metadata', async () => {
    let sentJobRef;
    const client = agentClient({ create(request) {
        sentJobRef = request.metadata.job_ref;
        return sdkResponse({
            id: sessionId, object: 'agent.session', status: 'in_progress',
            access_programs: { cyber: blue }, metadata: { job_ref: 'different_job' },
        });
    } });
    const { exit, result } = await invoke(client, 'sessions.create', { request: sessionRequest() });
    assert.equal(exit, 1);
    assert.equal(result.kind, 'error');
    assert.ok(sentJobRef);
    assert.equal(result.receipt.daybreak.jobRef, sentJobRef);
    assert.equal(result.receipt.daybreak.configurationState, 'unconfirmed');
    assert.equal(result.outcomeUnconfirmed, true);
});

test('standalone retrieval reports a same-ID configuration observation without inventing a request', async () => {
    const client = agentClient({ retrieve: () => sdkResponse({
        id: sessionId, object: 'agent.session', status: 'idle', access_programs: { cyber: blue },
    }) });
    const matching = await invoke(client, 'sessions.retrieve', { id: sessionId });
    assert.equal(matching.exit, 0);
    assert.equal(matching.result.receipt.daybreak.configurationState, 'observed');
    assert.equal(matching.result.receipt.daybreak.observedProgram, blue);
    assert.equal(matching.result.receipt.daybreak.requestedProgram, undefined);

    const different = await invoke(client, 'sessions.retrieve', { id: 'sess_different_fixture' });
    assert.equal(different.exit, 1);
    assert.equal(different.result.kind, 'error');
    assert.equal(different.result.receipt.daybreak?.observedProgram, undefined);
});

test('terminal-only stream does not attribute completion to a newly submitted Daybreak turn', async () => {
    const events = [
        createdSession({ access_programs: { cyber: blue } }),
        turnEvent('completed'),
    ];
    const client = agentClient({ create: () => sdkStream(events) });
    const { exit, result } = await invoke(client, 'sessions.create', { request: sessionRequest({ stream: true }) });
    assert.equal(exit, 1);
    assert.equal(result.outcome, 'unconfirmed');
    assert.equal(result.receipt.daybreak.configurationState, 'confirmed');
});

test('a conflicting parent session on the nested turn cannot confirm turn success', async () => {
    const terminalEvent = turnEvent('completed');
    terminalEvent.turn.session_id = 'sess_unrelated_fixture';
    const events = [createdSession({ access_programs: { cyber: blue } }), turnEvent('in_progress'), terminalEvent];
    const client = agentClient({ create: () => sdkStream(events) });
    const { exit, result } = await invoke(client, 'sessions.create', { request: sessionRequest({ stream: true }) });
    assert.equal(exit, 1);
    assert.notEqual(result.outcome, 'agent.session.turn.completed');
    assert.equal(result.receipt.sessionId, sessionId);
    assert.equal(result.receipt.daybreak.configurationState, 'confirmed');
});

test('Responses accepts explicit Daybreak and preserves the provider refusal without replay', async () => {
    const refusal = { type: 'refusal', refusal: 'Synthetic refusal.' };
    let calls = 0;
    const client = { responses: { create(request, options) {
        calls++;
        assert.deepEqual(request.access_programs, { cyber: blue });
        assert.equal(options.maxRetries, 0);
        return sdkResponse({ id: 'resp_daybreak_fixture', object: 'response', status: 'completed', model,
            access_programs: { cyber: blue }, output: [{ type: 'message', content: [refusal] }] });
    } } };
    const request = { model, input, access_programs: { cyber: blue } };
    const { exit, result } = await invoke(client, 'responses.create', { request });
    assert.equal(exit, 0);
    assert.equal(calls, 1);
    assert.equal(result.receipt.daybreak.configurationState, 'confirmed');
    assert.equal(result.receipt.daybreak.failureCategory, undefined);
    assert.equal(result.receipt.safetyOutcome, 'content-refusal');
    assert.deepEqual(result.data.output[0].content, [refusal]);
});

test('Responses null program confirms standard configuration while missing evidence remains unconfirmed', async () => {
    const response = { id: 'resp_daybreak_fixture', object: 'response', status: 'completed', model };
    const data = extra => ({ responses: { create: () => sdkResponse({ ...response, ...extra }) } });
    const request = { model, input, access_programs: { cyber: blue } };
    const missing = await invoke(data({}), 'responses.create', { request });
    assert.equal(missing.result.receipt.daybreak.configurationState, 'unconfirmed');
    const standard = await invoke(data({ access_programs: null }), 'responses.create', { request });
    assert.equal(standard.result.receipt.daybreak.configurationState, 'mismatch');
    assert.equal(standard.result.receipt.daybreak.observedProgram, 'standard');
});

test('Daybreak validation rejects invalid or misplaced selectors before dispatch', async t => {
    let calls = 0;
    const unexpected = () => { calls++; throw new Error('Unexpected SDK dispatch'); };
    const client = { responses: { create: unexpected }, ...agentClient({
        create: unexpected, update: unexpected, events: { create: unexpected },
    }) };
    const cases = [
        ['null selector', 'sessions.create', { request: sessionRequest({ access_programs: null }) }],
        ['bad enum', 'responses.create', { request: { model, input, access_programs: { cyber: 'blue' } } }],
        ['nested agent selector', 'sessions.create', { request: {
            ...sessionRequest(), agent: { model, access_programs: { cyber: blue } },
        } }],
        ['selector on update', 'sessions.update', { id: sessionId, request: { access_programs: { cyber: blue } } }],
        ['selector on input event', 'sessions.events.create', { id: sessionId, request: { events: [
            { type: 'agent.session.input.message', input: [], access_programs: { cyber: blue } },
        ] } }],
    ];
    for (const [name, action, args] of cases) {
        await t.test(name, async () => {
            const { exit, result } = await invoke(client, action, args);
            assert.equal(exit, 1);
            assert.equal(result.dispatch, 'not-attempted');
        });
    }
    assert.equal(calls, 0);
});

test('provider access errors and uncertain dispatch receive distinct Daybreak classifications with no retry', async t => {
    const cases = [
        [400, 'invalid_access_program', 'model-program-mismatch', false],
        [400, 'unsupported_access_program', 'program-unsupported', false],
        [403, 'access_program_not_enabled', 'project-access-not-enabled', false],
        [403, 'cyber_policy', 'provider-cyber-policy', false],
        [404, 'model_not_found', 'model-access', false],
        [401, 'invalid_api_key', 'authentication', false],
        [403, 'insufficient_permissions', 'permission', false],
        [429, 'credit_balance_exhausted', 'billing', false],
        [429, 'rate_limit_exceeded', 'rate-limit', false],
        [429, undefined, 'quota-unconfirmed', false],
        [undefined, undefined, 'transport-unconfirmed', true],
    ];
    for (const [status, code, category, uncertain] of cases) {
        await t.test(category, async () => {
            let calls = 0;
            const client = agentClient({ create(request, options) {
                calls++;
                assert.equal(request.access_programs.cyber, blue);
                assert.equal(options.maxRetries, 0);
                return { asResponse: async () => {
                    const error = new Error('Synthetic provider failure');
                    if (status) Object.assign(error, { status, code });
                    throw error;
                } };
            } });
            const { exit, result } = await invoke(client, 'sessions.create', { request: sessionRequest() });
            assert.equal(exit, 1);
            assert.equal(calls, 1);
            assert.equal(result.outcomeUnconfirmed, uncertain);
            assert.equal(result.receipt.daybreak.acceptanceState, uncertain ? 'unconfirmed' : 'rejected');
            assert.equal(result.receipt.daybreak.failureCategory, category);
        });
    }
});
