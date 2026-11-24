import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import test from 'node:test';
import { discover, estimateWork } from '../openai-workbench.mjs';
import { buildClient, operationCatalog, runInvocation } from '../openai-agents.mjs';

const images = {"png": "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mOsMAoIYGBgYGBigAIAFF4BTnydIREAAAAASUVORK5CYII=", "jpeg": "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAgX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCJANdf/9k=", "gif": "R0lGODdhAgACAIAAAAAAAAAAACwAAAAAAgACAAAIBgABCAQQEAA7", "webp": "UklGRjAAAABXRUJQVlA4ICQAAABwAQCdASoCAAIAAUAmJaACdAFAAAD+89ra5/8Q5/W3/cprEAA="};
const runtime = fileURLToPath(new URL('../agents-sdk/', import.meta.url));
const projectKey = 'sk-local-project-test-key-fixture';
const adminKey = 'sk-local-admin-test-key-fixture';
const response = (id, extra = {}) => ({ object: 'response', id, status: 'completed', output: [], ...extra });
const json = value => Response.json(value);
const steerRejection = { code: 'response_already_completed', message: 'Fixture: already completed',
    type: 'invalid_request_error' };

async function invoke(client, action, request = {}, extras = {}, receiveSteer) {
    const before = process.exitCode;
    process.exitCode = 0;
    try {
        const rows = [];
        await runInvocation(client, { action, request, ...extras }, async row => rows.push(structuredClone(row)), receiveSteer);
        return { final: rows.at(-1), rows, exitCode: process.exitCode };
    } finally { process.exitCode = before; }
}

test('cache comparison is opt-in and provider observations retain actual cache counts', async () => {
    const requests = [];
    let reportedBaseline = 'resp_baseline';
    const client = await buildClient(projectKey, runtime, async (url, init) => {
        assert.equal(new URL(url).pathname, '/v1/responses');
        requests.push(JSON.parse(init.body));
        return json(response('resp_new', requests.at(-1).prompt_cache_options ? {
            prompt_cache_options: { comparison_response_id: reportedBaseline },
            prompt_cache_diagnostics: { type: 'cache_miss', reason: 'tools_changed', cache_missed_tokens: 7 },
            usage: { input_tokens: 142, input_tokens_details: { cached_tokens: 96 } },
        } : {}));
    });
    const common = { model: 'gpt-6.2-sol', input: 'test' };
    const normal = await invoke(client, 'responses.create', common);
    assert.equal(normal.final.receipt.promptCache, undefined);
    const options = { comparison_response_id: 'resp_baseline', ttl: '30m' };
    const checked = await invoke(client, 'responses.create', { ...common, prompt_cache_options: options });
    assert.deepEqual(requests[1].prompt_cache_options, options);
    assert.equal(checked.final.receipt.promptCache.state, 'cache_miss');
    assert.equal(checked.final.receipt.promptCache.reason, 'tools_changed');
    assert.equal(checked.final.receipt.promptCache.cachedInputTokens, 96);
    reportedBaseline = 'resp_other';
    const mismatched = await invoke(client, 'responses.create', { ...common, prompt_cache_options: options });
    assert.equal(mismatched.final.receipt.promptCache.state, 'baseline-mismatch');
    const malformed = await invoke(client, 'responses.create', { ...common,
        prompt_cache_options: { comparison_response_id: ['resp_baseline'] } });
    assert.equal(malformed.final.dispatch, 'not-attempted');
    assert.equal(requests.length, 3);
});

test('admin usage is a one-page read with the admin credential and retains pagination', async () => {
    const calls = [];
    const makePage = () => ({ object: 'page', has_more: true, next_page: 'opaque-cursor/next=',
        data: [{ object: 'bucket', start_time: 86400, end_time: 172800,
            results: [{ object: 'organization.costs.result', amount: { value: 0.34, currency: 'usd' } }] }] });
    const client = await buildClient(null, runtime, async (url, init) => {
        calls.push({ url: new URL(url), auth: new Headers(init.headers).get('Authorization'), method: init.method });
        return json(makePage());
    }, adminKey);
    const query = { start_time: 86400, end_time: 172800, group_by: ['api_source'], project_ids: ['proj_example'] };
    const bill = await invoke(client, 'admin.usage.costs', query);
    assert.equal(bill.exitCode, 0);
    assert.equal(calls[0].url.pathname, '/v1/organization/costs');
    assert.equal(calls[0].auth, 'Bearer ' + adminKey);
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].url.searchParams.get('start_time'), '86400');
    assert.equal(bill.final.receipt.pagination.nextPage, 'opaque-cursor/next=');
    assert.equal(bill.final.receipt.credentialRoute, 'openai-admin-api-key');
    assert.equal(bill.final.data.data[0].results[0].amount.currency, 'usd');
    assert.equal(JSON.stringify(bill).includes(adminKey), false);
    await invoke(client, 'admin.usage.completions', { ...query, page: bill.final.receipt.pagination.nextPage });
    assert.equal(calls[1].url.pathname, '/v1/organization/usage/completions');
    assert.equal(calls[1].url.searchParams.get('page'), 'opaque-cursor/next=');
    const ordinary = await buildClient(projectKey, runtime, async () => assert.fail('must not send without admin key'));
    const denied = await invoke(ordinary, 'admin.usage.costs', query);
    assert.equal(denied.exitCode, 1);
    const invalid = await invoke(client, 'admin.usage.costs', { ...query, end_time: 120 });
    assert.equal(invalid.final.dispatch, 'not-attempted');
    assert.equal(calls.length, 2);
});

test('session spend control is explicit, validated, verified and visible when paused', async () => {
    const calls = [];
    const session = { id: 'sess_demo', object: 'agent.session', status: 'active' };
    const client = await buildClient(projectKey, runtime, async (url, init) => {
        const body = init.body ? JSON.parse(init.body) : null;
        calls.push({ url: new URL(url), body, method: init.method });
        if (body?.stream) return new Response(
            'data: ' + JSON.stringify({ type: 'agent.session.created', event_id: 'evt_created',
                session: { ...session, spend_control: { limit: 50, consumed: 0 } } }) + '\n\n' +
            'data: ' + JSON.stringify({ type: 'agent.session.budget_reached', event_id: 'evt_budget',
                session: { ...session, status: 'budget_reached', spend_control: { limit: 50, consumed: 51 } } }) + '\n\n',
            { headers: { 'Content-Type': 'text/event-stream' } });
        if (body?.spend_control?.limit === 55) return json({ ...session, spend_control: { limit: 50, consumed: 0 } });
        if (body && Object.hasOwn(body, 'spend_control')) return json({ ...session, spend_control: { limit: null, consumed: 24 } });
        return json(session);
    });
    const ordinary = await invoke(client, 'sessions.create', { agent: { model: 'gpt-6.2-sol' } });
    assert.equal(ordinary.exitCode, 0);
    assert.equal(Object.hasOwn(calls[0].body, 'spend_control'), false);
    const rejected = await invoke(client, 'sessions.update', { spend_control: { limit: 0.1 } }, { id: session.id });
    assert.equal(rejected.final.dispatch, 'not-attempted');
    const remove = await invoke(client, 'sessions.update', { spend_control: null }, { id: session.id });
    assert.equal(remove.exitCode, 0);
    assert.equal(remove.final.receipt.sessionBudget.verification, 'matched');
    assert.equal(remove.final.receipt.sessionBudget.consumed, 24);
    assert.equal(calls[1].body.spend_control, null);
    const mismatch = await invoke(client, 'sessions.update', { spend_control: { limit: 55 } }, { id: session.id });
    assert.equal(mismatch.exitCode, 1);
    assert.equal(mismatch.final.receipt.sessionBudget.verification, 'mismatch');
    const stream = await invoke(client, 'sessions.create', { spend_control: { limit: 50 }, stream: true });
    assert.equal(stream.final.outcome, 'agent.session.budget_reached');
    assert.equal(stream.final.receipt.sessionBudget.consumed, 51);
    assert.equal(stream.exitCode, 1);
});

test('Multi-agent uses explicit beta routing, preserves child output and verifies returned IDs', async () => {
    const calls = [];
    const outputs = [{ type: 'multi_agent_call', id: 'mac_example', status: 'completed' },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Synthesis' }] }];
    let responseId = 'resp_run';
    const client = await buildClient(projectKey, runtime, async (url, init) => {
        calls.push({ url: new URL(url), body: init.body ? JSON.parse(init.body) : undefined,
            beta: new Headers(init.headers).get('openai-beta') });
        return json(response(responseId, { output: outputs }));
    });
    const multi = await invoke(client, 'responses.multiagent.create',
        { model: 'gpt-6.2-sol', input: 'Compare two outlines.', multi_agent: { max_concurrent_subagents: 2 } });
    assert.equal(multi.exitCode, 0);
    assert.equal(calls[0].url.searchParams.get('beta'), 'true');
    assert.equal(calls[0].beta, 'responses_multi_agent=v1');
    assert.deepEqual(calls[0].body.multi_agent, { enabled: true, max_concurrent_subagents: 2 });
    assert.equal(calls[0].body.store, false);
    assert.deepEqual(multi.final.data.output, outputs);
    await invoke(client, 'responses.multiagent.retrieve', {}, { id: responseId });
    assert.equal(calls[1].beta, 'responses_multi_agent=v1');
    responseId = 'resp_other';
    const wrong = await invoke(client, 'responses.multiagent.retrieve', {}, { id: 'resp_run' });
    assert.equal(wrong.exitCode, 1);
    assert.equal(wrong.final.stage, 'response-body');
});

function socketClient(variant) {
    const sent = [];
    return { sent, baseURL: 'https://api.openai.com/v1', apiKey: projectKey, WebSocketTransport: class extends EventTarget {
        readyState = 0;
        constructor() {
            super();
            queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); });
        }
        fire(event) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(event) })); }
        send(text) {
            const event = JSON.parse(text);
            sent.push(event);
            if (event.type === 'response.create') {
                if (variant === 'error-before-id') return this.fire({ type: 'error', code: 'fixture_error' });
                if (variant === 'disconnect-before-id') return this.close();
                this.fire({ type: 'response.created', response: response('resp_initial', { status: 'in_progress' }) });
                if (variant === 'finished') this.fire({ type: 'response.completed', response: response('resp_initial') });
                return;
            }
            if (variant === 'generic-error') return this.fire({ type: 'error', code: 'fixture_error' });
            if (['rejected-without-id', 'rejected-without-error'].includes(variant)) {
                return this.fire({ type: 'response.steer.failed', steer: { previous_response_id: 'resp_initial', input: event.input },
                    ...(variant === 'rejected-without-id' ? { error: steerRejection } : {}) });
            }
            const steer = { id: 'steer_one', previous_response_id: variant === 'wrong' ? 'resp_wrong' : 'resp_initial' };
            this.fire({ type: 'response.steer.accepted', steer });
            if (variant === 'disconnected') return this.close();
            if (variant === 'error-after-accept') return this.fire({ type: 'error', code: 'fixture_error' });
            if (variant === 'pending') {
                this.fire({ type: 'response.completed', response: response('resp_initial', {
                    output: [{ type: 'function_call', call_id: 'call_fixture', name: 'fixture', arguments: '{}' }],
                }) });
                return this.fire({ type: 'response.steer.pending', steer,
                    reason: 'waiting_for_required_input', required_input: [
                        { type: 'function_call_output', call_id: 'call_fixture', name: 'fixture' },
                    ] });
            }
            if (variant === 'completed-after-acceptance') {
                this.fire({ type: 'response.completed', response: response('resp_initial') });
            } else this.fire({ type: 'response.incomplete', response: response('resp_initial', {
                status: 'incomplete', incomplete_details: { reason: 'steered' } }) });
            this.fire({ type: 'response.created', response: response('resp_continuation', {
                status: 'in_progress', previous_response_id: 'resp_initial' }) });
            if (variant === 'error-after-successor') return this.fire({ type: 'error', code: 'fixture_error' });
            if (variant === 'disconnect-after-successor') return this.close();
            if (variant === 'reject-after-successor') return this.fire({ type: 'response.steer.failed',
                steer, error: steerRejection });
            this.fire({ type: 'response.completed', response: response('resp_continuation',
                variant === 'wrong-terminal-parent' ? { previous_response_id: 'resp_other' }
                    : { previous_response_id: 'resp_initial' }) });
        }
        close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
    } };
}

test('steering observes the continuation and records no second create on queued, pending or lost acknowledgement', async () => {
    const base = { response: { model: 'gpt-6.2-sol', input: 'Find three surnames.' } };
    for (const variant of ['ok', 'pending', 'wrong', 'disconnected']) {
        const client = socketClient(variant);
        const result = await invoke(client, 'responses.steer', { ...base, steer_input: 'Only Czech spellings.' });
        assert.deepEqual(client.sent.map(row => row.type), ['response.create', 'response.steer']);
        assert.equal(client.sent[1].previous_response_id, 'resp_initial');
        if (variant === 'ok') {
            assert.equal(result.exitCode, 0);
            assert.equal(result.final.outcome, 'continuation-completed');
            assert.equal(result.final.continuation.id, 'resp_continuation');
        } else {
            assert.equal(result.exitCode, 1);
            assert.equal(result.final.outcome, variant === 'pending' ? 'needs-client-input' : 'unconfirmed');
        }
    }
    const interactive = socketClient('ok');
    const result = await invoke(interactive, 'responses.steer', base, {}, async () => 'Use original spelling.');
    assert.equal(result.exitCode, 0);
    assert.equal(interactive.sent[1].input, 'Use original spelling.');
});

test('steering uses correlated terminal evidence for both input modes and retains the checkpoint for uncertain results', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'legatus-steer-states-'));
    const original = { model: 'gpt-6.2-sol', input: 'Original', store: true };
    const cases = [
        ['error-before-id', undefined, undefined, 'not-attempted'],
        ['disconnect-before-id', undefined, undefined, 'not-attempted'],
        ['generic-error', 'resp_initial', undefined, 'attempted'],
        ['rejected-without-error', 'resp_initial', undefined, 'attempted', 'invalid_steer_failure'],
        ['error-after-accept', 'resp_initial', undefined, 'accepted'],
        ['error-after-successor', 'resp_initial', 'resp_continuation', 'accepted'],
        ['disconnect-after-successor', 'resp_initial', 'resp_continuation', 'accepted'],
        ['reject-after-successor', 'resp_initial', 'resp_continuation', 'accepted', 'steer_correlation_mismatch'],
        ['wrong-terminal-parent', 'resp_initial', 'resp_continuation', 'accepted', 'unexpected_continuation_parent'],
    ];
    try {
        for (const [variant, originalId, successorId, state, code] of cases) {
            for (const interactive of [false, true]) {
                const client = socketClient(variant);
                const checkpointPath = path.join(directory, variant + '-' + interactive + '.jsonl');
                const result = await invoke(client, 'responses.steer',
                    interactive ? { response: original } : { response: original, steer_input: 'Update' },
                    { checkpointPath }, interactive ? async () => 'Update' : undefined);
                const row = JSON.parse((await readFile(checkpointPath, 'utf8')).trim().split('\n').at(-1));
                assert.equal(result.exitCode, 1, variant);
                assert.equal(result.final.outcome, 'unconfirmed', variant);
                assert.equal(result.final.outcomeUnconfirmed, true, variant);
                if (code) {
                    assert.equal(result.final.localCode, code, variant);
                    assert.equal(row.localCode, code, variant);
                }
                if (result.final.providerEvent?.type === 'error') assert.equal(row.providerErrorCode, 'fixture_error');
                assert.equal(row.phase, 'steering_ended', variant);
                assert.equal(row.originalResponseId, originalId, variant);
                assert.equal(row.continuationResponseId, successorId, variant);
                assert.equal(row.steerDispatch, state, variant);
                assert.equal(row.outcomeUnconfirmed, true, variant);
                assert.equal(client.sent.length, originalId ? 2 : 1, variant);
            }
        }
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('GPT-Image 2.6 and GPT-Live 1.1 use requested models and wire parameters', async () => {
    const folder = await mkdtemp(path.join(tmpdir(), 'legatus-media-'));
    try {
        const input = path.join(folder, 'picture.png');
        const markup = path.join(folder, 'overlay.png');
        const bytes = Buffer.from(images.png, 'base64');
        await writeFile(input, bytes);
        await writeFile(markup, bytes);
        const calls = [];
        const animation = images.gif;
        let generated = animation;
        const client = await buildClient(projectKey, runtime, async (url, init) => {
            const target = new URL(url).pathname;
            calls.push(target);
            if (target === '/v1/images/edits') {
                const fields = await new Request(url, { method: 'POST', headers: init.headers, body: init.body, duplex: 'half' }).formData();
                assert.equal(fields.get('model'), 'gpt-image-2.6-sunburst');
                assert.equal(fields.get('output_format'), 'svg');
                assert.deepEqual(Buffer.from(await fields.get('image').arrayBuffer()), bytes);
                assert.deepEqual(Buffer.from(await fields.get('markup').arrayBuffer()), bytes);
                const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64');
                return json({ output_format: 'svg', data: [{ b64_json: svg }] });
            }
            const payload = JSON.parse(init.body);
            if (target === '/v1/images/generations') {
                assert.equal(payload.model, 'gpt-image-2.6-flare');
                assert.equal(payload.frame_count, 4);
                return json({ output_format: 'gif', data: [{ b64_json: generated }] });
            }
            assert.equal(payload.session.model, 'gpt-live-1.1');
            assert.equal(payload.session.wake_policy.type, 'speech');
            assert.equal(payload.session.idle_timeout_s, 20);
            return json({ session: { id: 'live_fixture', model: 'gpt-live-1.1' }, transport: { type: 'webrtc', sdp: 'v=0' } });
        });
        const image = await invoke(client, 'images.edit', { model: 'gpt-image-2.6-sunburst', prompt: 'Remove mark', output_format: 'svg' },
            { inputFile: input, markupFile: markup });
        assert.equal(image.exitCode, 0);
        assert.equal(image.final.receipt.markup.bytes, bytes.length);
        assert.equal(image.final.receipt.imageOutput.reportedFormat, 'svg');
        assert.equal(image.final.receipt.imageOutput.formatVerification, 'verified');
        const gif = await invoke(client, 'images.generate', { model: 'gpt-image-2.6-flare', prompt: 'Loop', output_format: 'gif',
            frame_count: 4, frame_duration_ms: 200 });
        assert.equal(gif.exitCode, 0);
        assert.equal(gif.final.receipt.imageOutput.reportedFormat, 'gif');
        const gifPath = path.join(folder, 'out.gif');
        const gifRequest = { model: 'gpt-image-2.6-flare', prompt: 'Loop', output_format: 'gif', frame_count: 4 };
        const saved = await invoke(client, 'images.generate', gifRequest, { outputFile: gifPath });
        assert.equal(saved.final.data.image.validation, 'raster-container-structure');
        assert.deepEqual(await readFile(gifPath), Buffer.from(animation, 'base64'));
        const existing = await invoke(client, 'images.generate', gifRequest, { outputFile: gifPath });
        assert.equal(existing.final.dispatch, 'not-attempted');
        generated = 'PHN2Zz4=';
        const wrongPath = path.join(folder, 'wrong.gif');
        const wrong = await invoke(client, 'images.generate', gifRequest, { outputFile: wrongPath });
        assert.equal(wrong.final.stage, 'output');
        await assert.rejects(readFile(wrongPath), { code: 'ENOENT' });
        const bad = await invoke(client, 'images.generate', { model: 'gpt-image-2.6-flare', prompt: 'Loop', output_format: 'gif', frame_count: 1 });
        assert.equal(bad.final.dispatch, 'not-attempted');
        const live = await invoke(client, 'live.create', { session: { model: 'gpt-live-1.1', wake_policy: { type: 'speech' },
            idle_timeout_s: 20 }, transport: { type: 'webrtc', sdp: 'v=0' } });
        assert.equal(live.exitCode, 0);
        assert.equal(live.final.receipt.reportedModel, 'gpt-live-1.1');
        assert.equal(calls.length, 5);
        assert.deepEqual(await readFile(input), bytes);
        const catalog = operationCatalog();
        assert.equal(catalog['admin.usage.costs'].credentialSources.node, 'OPENAI_ADMIN_KEY');
        assert.deepEqual(catalog['images.edit'].localOptions, ['inputFile', 'inputMediaType', 'markupFile']);
    } finally { await rm(folder, { recursive: true, force: true }); }
});

test('the duplex CLI reads a late steering instruction and exits with stdin still open', async () => {
    const fixture = 'const projectKey=' + JSON.stringify(projectKey) + ';const response=' + response.toString() +
        ';globalThis.WebSocket=(' + socketClient.toString() + ')("ok").WebSocketTransport;';
    const shell = spawn(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(fixture),
        fileURLToPath(new URL('../openai-agents.mjs', import.meta.url)), runtime, '--interactive-steer'], {
        env: { ...process.env, OPENAI_API_KEY: projectKey, OPENAI_ADMIN_KEY: '', NODE_OPTIONS: '' },
        signal: AbortSignal.timeout(10_000),
    });
    const exit = new Promise((resolve, reject) => { shell.once('close', resolve); shell.once('error', reject); });
    // A failed child must not leave a rejected process promise unhandled while reading stdout.
    exit.catch(() => {});
    const rows = [];
    shell.stdin.write(JSON.stringify({ action: 'responses.steer', timeoutSeconds: 5,
        request: { response: { model: 'gpt-6.2-sol', input: 'Original request' } } }) + '\n');
    try {
        for await (const line of createInterface({ input: shell.stdout })) {
            const row = JSON.parse(line);
            rows.push(row);
            if (row.event?.type === 'response.created' && row.event.response.id === 'resp_initial') {
                shell.stdin.write(JSON.stringify({ steer_input: 'Follow-up decided after launch' }) + '\n');
            }
        }
        assert.equal(await exit, 0);
        assert.equal(rows.at(-1).outcome, 'continuation-completed');
        assert.equal(rows.at(-1).receipt.steerId, 'steer_one');
    } finally {
        shell.stdin.destroy();
        if (shell.exitCode === null) shell.kill();
    }
});

test('steering preserves completed originals, rejects invalid frames before dispatch, and distinguishes rejection from unknown delivery', async () => {
    const original = { model: 'gpt-6.2-sol', input: 'Outline two sources.' };
    const update = 'Only public sources.';
    for (const variant of ['finished', 'rejected-without-id', 'generic-error', 'completed-after-acceptance']) {
        const client = socketClient(variant);
        const { final } = await invoke(client, 'responses.steer', { response: original, steer_input: update });
        if (variant === 'finished') {
            assert.deepEqual(client.sent.map(frame => frame.type), ['response.create']);
            assert.equal(final.outcome, 'completed-without-steer');
            assert.equal(final.original.id, 'resp_initial');
            assert.equal(final.receipt.steerDispatch, 'not-attempted');
        } else if (variant === 'rejected-without-id') {
            assert.equal(final.outcome, 'steer-rejected');
            assert.equal(final.receipt.steerErrorCode, 'response_already_completed');
            assert.equal(final.receipt.outcomeUnconfirmed, false);
        } else if (variant === 'generic-error') {
            assert.equal(final.outcome, 'unconfirmed');
            assert.equal(final.outcomeUnconfirmed, true);
            assert.equal(final.providerEvent.code, 'fixture_error');
        } else {
            assert.equal(final.outcome, 'continuation-completed');
            assert.equal(final.original.status, 'completed');
        }
    }
    for (const request of [
        { response: { ...original, conversation: 'conv_demo' }, steer_input: update },
        { response: { ...original, context_management: [{ type: 'compaction', compact_threshold: 5000 }] }, steer_input: update },
        { response: original, steer_input: [{ role: 'user' }] },
        { response: original, steer_input: [{ role: 'user', content: [{ type: 'input_text' }] }] },
        { response: original, steer_input: [{ role: 'user', content: 'hello', id: 'msg_one' }] },
    ]) {
        const client = socketClient('ok');
        client.WebSocketTransport = class { constructor() { assert.fail('invalid input opened a socket'); } };
        const { final } = await invoke(client, 'responses.steer', request);
        assert.equal(final.dispatch, 'not-attempted');
        assert.notEqual(final.localCode, 'steer_transport_error');
    }
    const client = socketClient('ok');
    const good = await invoke(client, 'responses.steer', { response: original,
        steer_input: [{ role: 'user', content: [{ type: 'input_text', text: update }] }] });
    assert.equal(good.final.outcome, 'continuation-completed');
    const exported = operationCatalog()['responses.steer'];
    assert.equal(exported.mutatesRemoteState, true);
    assert.match(exported.persistsRemoteResponse, /store=true/);
});

test('catalog preserves the requested resource level and excludes billing records from rate-limit evidence', () => {
    const cases = [
        ['smaž relaci', 'sessions.delete'], ['delete a session', 'sessions.delete'],
        ['delete session artifacts', 'sessions.artifacts.delete'], ['list agents in a session', 'sessions.subagents.list'],
        ['start live session', 'live.create'], ['steer response', 'responses.steer'],
        ['read organization costs', 'admin.usage.costs'], ['list usage', 'admin.usage.completions'],
        ['edit an image', 'images.edit'], ['vyhledej soubory ve vektorovém úložišti', 'vectorstores.files.list'],
        ['compare observed token costs', 'estimate'],
        ['list vector store files', 'vectorstores.files.list'], ['delete a file', 'files.delete'],
    ];
    for (const [query, expected] of cases) assert.equal(discover(query).matches[0]?.action, expected, query);
    for (const [query, expected] of [
        ['list Agents sessions', 'sessions.list'], ['get Agents session', 'sessions.retrieve'],
        ['get agent session turn', 'sessions.turns.retrieve'], ['list Agents session subagents', 'sessions.subagents.list'],
        ['start multiagent response', 'responses.multiagent.create'], ['read multi-agent response', 'responses.multiagent.retrieve'],
        ['obnov multiagentní odpověď', 'responses.multiagent.retrieve'],
    ]) assert.equal(discover(query).matches[0]?.action, expected, query);
    for (const query of ['list local jobs', 'Seznam místních úloh', 'Recover a local checkpoint', 'find checkpoints']) {
        const { matches } = discover(query);
        assert.deepEqual(matches.map(item => item.action), ['jobs'], query);
        assert.equal(matches[0].usesNetwork, false);
        assert.equal(matches[0].credential, 'none');
        assert.equal(matches[0].mcp.tool, 'list_jobs');
    }
    for (const query of ['zastav relaci', 'delete', 'list and delete sessions', 'nesmaž relaci', 'delete a session or file']) {
        assert.deepEqual(discover(query).matches, [], query);
    }
    const input = {
        model: 'fixture', mode: 'standard',
        forecast: { inputTokens: 2, outputTokens: 3 },
        scope: { organization: 'org', project: 'proj' },
        capacity: { model: 'fixture', mode: 'standard', organization: 'org', project: 'proj', source: 'fixture',
            tpm: 100, tpmUsed: 0, checkedAt: '2025-01-01T00:00:00Z', validUntil: '2099-01-01T00:00:00Z' },
    };
    for (const action of ['admin.usage.costs', 'admin.usage.completions']) {
        const result = estimateWork({ ...input, capacity: { ...input.capacity, sourceAction: action, scopeConfirmed: true } });
        assert.equal(result.capacityEvidence.fresh, false);
        assert.equal(result.capacityEvidence.sourceApplicability, 'billing-only');
        assert.equal(result.checks[0].fitsEstimate, null);
    }
});

function pngFixture(chunks) {
    const parts = [Buffer.from('89504e470d0a1a0a', 'hex')];
    for (const [type, data] of [...chunks, ['IEND', Buffer.alloc(0)]]) {
        const payload = Buffer.concat([Buffer.from(type), data]);
        let crc = 0xffffffff;
        for (const byte of payload) {
            crc ^= byte;
            for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
        }
        const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
        length.writeUInt32BE(data.length);
        checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
        parts.push(length, payload, checksum);
    }
    return Buffer.concat(parts);
}

test('image publication and edit input validate cross-field structure and report bounded PNG validation', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'legatus-image-constraints-'));
    const ihdr = Buffer.from('00000001000000010802000000', 'hex');
    const rgb = deflateSync(Buffer.from([0, 255, 0, 0]));
    const png = (header = ihdr, data = rgb, other = []) =>
        pngFixture([['IHDR', header], ...other, ['IDAT', data]]);
    const header = (field, value) => { const bytes = Buffer.from(ihdr); bytes[field] = value; return bytes; };
    const palette = ['PLTE', Buffer.from([255, 0, 0])];
    const indexed = deflateSync(Buffer.from([0, 0]));
    const jpeg = Buffer.from(images.jpeg, 'base64');
    const badSelector = Buffer.from(jpeg);
    badSelector[jpeg.indexOf(Buffer.from([0xff, 0xda])) + 5] = 127;
    const zeroLines = Buffer.from(jpeg);
    zeroLines.writeUInt16BE(0, jpeg.indexOf(Buffer.from([0xff, 0xc0])) + 5);
    const withDnl = Buffer.concat([zeroLines.subarray(0, -2), Buffer.from('ffdc00040002', 'hex'), zeroLines.subarray(-2)]);
    const gif = Buffer.from(images.gif, 'base64');
    const offscreen = Buffer.from(gif);
    offscreen.writeUInt16LE(1, 20); // x-offset of the image descriptor
    const graphicControl = payload => Buffer.concat([gif.subarray(0, 19), Buffer.from([0x21, 0xf9, payload.length]),
        Buffer.from(payload), Buffer.from([0]), gif.subarray(19)]);
    const webp = Buffer.from(images.webp, 'base64');
    const repeated = Buffer.concat([webp, webp.subarray(12)]);
    repeated.writeUInt32LE(repeated.length - 8, 4);
    function riffChunk(type, payload) {
        const length = Buffer.alloc(4);
        length.writeUInt32LE(payload.length);
        return Buffer.concat([Buffer.from(type), length, payload, Buffer.alloc(payload.length % 2)]);
    }
    function extendedWebp(alpha, extras) {
        const header = Buffer.from([alpha ? 16 : 0, 0, 0, 0, 1, 0, 0, 1, 0, 0]);
        const body = Buffer.concat([Buffer.from('WEBP'), riffChunk('VP8X', header), ...extras, webp.subarray(12)]);
        const riff = Buffer.from('RIFF0000');
        riff.writeUInt32LE(body.length, 4);
        return Buffer.concat([riff, body]);
    }
    const largeHeader = Buffer.from(ihdr);
    largeHeader.writeUInt32BE(3000, 0);
    largeHeader.writeUInt32BE(3000, 4);
    const large = png(largeHeader, deflateSync(Buffer.alloc(3000 * 9001)));
    const media = [
        ['png', png(), true, 'filtered-scanlines'],
        ['png', png(header(8, 3)), false], ['png', png(header(9, 3), indexed), false],
        ['png', png(header(9, 3), indexed, [palette]), true, 'filtered-scanlines'],
        ['png', png(header(9, 3), deflateSync(Buffer.from([0, 1])), [palette]), false],
        // The packed low bits are row padding for a width of one pixel.
        ['png', png(Buffer.from('00000001000000010103000000', 'hex'),
            deflateSync(Buffer.from([0, 0x7f])), [palette]), true, 'filtered-scanlines'],
        ['png', png(Buffer.from('00000002000000010803000000', 'hex'),
            deflateSync(Buffer.from([1, 1, 255])), [['PLTE', Buffer.from([255, 0, 0, 0, 0, 0])]]), true, 'filtered-scanlines'],
        ['png', png(Buffer.from('00000002000000010803000000', 'hex'),
            deflateSync(Buffer.from([1, 1, 1])), [['PLTE', Buffer.from([255, 0, 0, 0, 0, 0])]]), false],
        ['png', png(Buffer.from('00000001000000020803000000', 'hex'),
            deflateSync(Buffer.from([0, 1, 2, 1])), [['PLTE', Buffer.from([255, 0, 0, 0, 0, 0])]]), false],
        ['png', png(Buffer.from('00000002000000010803000001', 'hex'),
            deflateSync(Buffer.from([0, 0, 0, 1])), [palette]), false],
        ['png', png(header(9, 3), indexed, [palette, ['tRNS', Buffer.from([100])]]), true, 'filtered-scanlines'],
        ['png', png(header(9, 3), indexed, [['tRNS', Buffer.from([100])], palette]), false],
        ['png', png(header(9, 6), deflateSync(Buffer.from([0, 255, 0, 0, 255])), [['tRNS', Buffer.alloc(6)]]), false],
        ...[10, 11, 12].map(field => ['png', png(header(field, 2)), false]),
        ['png', png(ihdr, Buffer.alloc(rgb.length, 255)), false],
        ['png', png(ihdr, Buffer.concat([rgb, Buffer.alloc(8)])), true, 'filtered-scanlines', 8],
        ['png', pngFixture([['IHDR', ihdr], ['IDAT', Buffer.concat([rgb, Buffer.alloc(8)])],
            ['IDAT', Buffer.from([0])]]), false],
        ['png', png(ihdr, deflateSync(Buffer.from([5, 0, 0, 0]))), false],
        ['png', png(ihdr, deflateSync(Buffer.from([0, 0, 0]))), false],
        ['png', png(header(12, 1)), true, 'filtered-scanlines'],
        ['png', pngFixture([['IHDR', ihdr], ['IDAT', rgb.subarray(0, 1)], ['IDAT', rgb.subarray(1)]]),
            true, 'filtered-scanlines'],
        ['png', pngFixture([['IHDR', ihdr], ['IDAT', rgb.subarray(0, 1)],
            ['tEXt', Buffer.from('note\0fixture')], ['IDAT', rgb.subarray(1)]]), false],
        ['png', large, true, 'zlib-header-only'],
        ['jpeg', zeroLines, false], ['jpeg', withDnl, true],
        ['jpeg', badSelector, false],
        ['gif', offscreen, false], ['gif', graphicControl([1, 1, 0, 1]), true],
        ['gif', graphicControl([0, 0, 0]), false], ['gif', graphicControl([1, 1, 0, 2]), false],
        ['webp', repeated, false],
        ['webp', extendedWebp(true, [riffChunk('ALPH', Buffer.from([0, 1, 2, 3, 4]))]), true],
        ['webp', extendedWebp(true, [riffChunk('ALPH', Buffer.from([2, 1, 2, 3, 4]))]), false],
        ['webp', extendedWebp(true, [riffChunk('ALPH', Buffer.from([0, 1]))]), false],
        ['webp', extendedWebp(false, [riffChunk('ANIM', Buffer.alloc(6))]), true],
    ];
    try {
        let output, format, effects = 0;
        const client = await buildClient(projectKey, runtime, async url => {
            effects++;
            assert.match(new URL(url).pathname, /^\/v1\/images\//);
            return json({ output_format: format, data: [{ b64_json: output.toString('base64') }] });
        });
        for (const [index, fixture] of media.entries()) {
            const [kind, contents, accepted, level, trailing] = fixture;
            format = kind;
            output = contents;
            const outputFile = path.join(directory, 'out-' + index + '.' + kind);
            const result = await invoke(client, 'images.generate', { model: 'fixture', prompt: 'Fixture',
                output_format: kind }, { outputFile });
            assert.equal(result.exitCode, accepted ? 0 : 1, 'case ' + index);
            if (accepted) {
                assert.deepEqual(await readFile(outputFile), contents);
                assert.equal(result.final.data.image.pngDataValidation, level);
                assert.equal(result.final.data.image.pngTrailingIdatBytes, trailing);
            } else await assert.rejects(readFile(outputFile), { code: 'ENOENT' });
        }
        for (const [kind, invalidPathField] of [['png', 'inputFile'], ['png', 'markupFile'], ['webp', 'inputFile']]) {
            const validFile = path.join(directory, 'valid.png');
            const invalidFile = path.join(directory, 'bad.' + kind);
            await writeFile(validFile, png());
            await writeFile(invalidFile, kind === 'png' ? png(header(10, 1)) : repeated);
            const edit = await invoke(client, 'images.edit', { model: 'fixture', prompt: 'Fixture' },
                { inputFile: validFile, [invalidPathField]: invalidFile });
            assert.equal(edit.final.dispatch, 'not-attempted', invalidPathField);
            assert.equal(edit.final.outcomeUnconfirmed, false);
        }
        assert.equal(effects, media.length);
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('image publication accepts valid XML and raster containers and rejects incomplete structures', async () => {
    const folder = await mkdtemp(path.join(tmpdir(), 'legatus-image-structure-'));
    try {
        const svg = 'http://www.w3.org/2000/svg';
        const cases = [
            ['svg', '<svg xmlns="' + svg + '" width="2"><rect width="2"/></svg>', true],
            ['svg', '<?xml version="1.0" encoding="UTF-8"?>\n<!-- žluťoučký -->\n<svg xmlns="' + svg + '"/>', true],
            ['svg', '<s:svg xmlns:s="' + svg + '"></s:svg>', true],
            ['svg', '<svg>', false], ['svg', '<svg><x></svg>', false],
            ['svg', '<svg/><svg/>', false], ['svg', '<x:svg xmlns:x="urn:wrong"/>', false],
            ['svg', Buffer.from([0xff, 0xfe]), false],
            ['png', Buffer.from(images.png, 'base64'), true],
            ['gif', Buffer.from(images.gif, 'base64'), true],
            ['jpeg', Buffer.from(images.jpeg, 'base64'), true],
            ['webp', Buffer.from(images.webp, 'base64'), true],
            ['png', Buffer.from('89504e470d0a1a0a', 'hex'), false],
            ['png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRj8AAAAASUVORK5CYII=', 'base64'), false],
            ['gif', 'GIF89a;', false], ['jpeg', Buffer.from('ffd8ff', 'hex'), false],
            ['webp', Buffer.from('524946460400000057454250', 'hex'), false],
        ];
        let data, format;
        const client = await buildClient(projectKey, runtime, async () =>
            json({ output_format: format, data: [{ b64_json: Buffer.from(data).toString('base64') }] }));
        for (const [index, [kind, bytes, accepted]] of cases.entries()) {
            [format, data] = [kind, bytes];
            const outputFile = path.join(folder, 'image-' + index + '.' + kind);
            const result = await invoke(client, 'images.generate',
                { model: 'fixture', prompt: 'Fixture', output_format: kind }, { outputFile });
            assert.equal(result.exitCode, accepted ? 0 : 1, kind + '/' + index);
            if (accepted) {
                assert.deepEqual(await readFile(outputFile), Buffer.from(bytes));
                assert.equal(result.final.data.image.validation,
                    kind === 'svg' ? 'well-formed-svg-xml' : 'raster-container-structure');
            } else await assert.rejects(readFile(outputFile), { code: 'ENOENT' });
        }
        const input = path.join(folder, 'source.png');
        const markup = path.join(folder, 'truncated.png');
        await writeFile(input, Buffer.from(images.png, 'base64'));
        await writeFile(markup, Buffer.from('89504e470d0a1a0a', 'hex'));
        const preflight = await invoke(client, 'images.edit', { model: 'fixture', prompt: 'Fixture' },
            { inputFile: input, markupFile: markup });
        assert.equal(preflight.final.dispatch, 'not-attempted');
    } finally { await rm(folder, { recursive: true, force: true }); }
});
