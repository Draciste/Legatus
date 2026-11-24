import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { requireOrdinaryWindowsPath } from './publish-openai-file.mjs';
import { responseOutputIssue } from './openai-stream-integrity.mjs';

const websocketUrl = 'wss://api.openai.com/v1/responses';
const httpBase = 'https://api.openai.com/v1';
const eventLimit = 1024 * 1024;
const turnLimit = 8 * eventLimit;
const maxOutputTokens = 256;
const expectedText = 'ORCHID-724';
const terminalStatuses = new Map([
    ['response.completed', 'completed'], ['response.failed', 'failed'], ['response.incomplete', 'incomplete'],
]);
const referenceText = Array.from({ length: 36 }, (_, index) =>
    `Sample record ${index + 1} is synthetic and irrelevant to the requested code.`).join('\n');

function safeToken(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,240}$/.test(value) && !value.startsWith('sk-')
        ? value : undefined;
}

function pilotError(code) {
    return Object.assign(Error(code), { pilotCode: code });
}

export function connectWebSocket(Transport, apiKey, clientRequestId, signal) {
    const socket = new Transport(websocketUrl, { headers: {
        Authorization: 'Bearer ' + apiKey, 'X-Client-Request-Id': clientRequestId,
    } });
    let wake;
    let failure;
    let pendingBytes = 0;
    const inbox = [];
    const notify = () => wake?.();
    const fail = code => {
        failure ??= pilotError(code);
        notify();
    };
    const onError = () => fail('websocket_transport_error');
    const onClose = () => fail('websocket_disconnected');
    const onAbort = () => fail('local_deadline');
    const onMessage = event => {
        if (failure) return;
        if (typeof event.data !== 'string' || event.data.length > eventLimit) return fail('invalid_websocket_event');
        const bytes = Buffer.byteLength(event.data);
        if (bytes > eventLimit || pendingBytes + bytes > turnLimit || inbox.length >= 4096) {
            return fail('websocket_event_limit');
        }
        pendingBytes += bytes;
        inbox.push({ text: event.data, bytes });
        notify();
    };
    socket.addEventListener('open', notify);
    socket.addEventListener('error', onError);
    socket.addEventListener('close', onClose);
    socket.addEventListener('message', onMessage);
    signal.addEventListener('abort', onAbort, { once: true });

    async function waitFor(ready) {
        while (!ready()) {
            if (failure) throw failure;
            signal.throwIfAborted();
            await new Promise(resolve => { wake = resolve; });
            wake = undefined;
        }
    }

    return {
        ready: () => waitFor(() => socket.readyState === 1),
        send(text, markDispatch, allowBuffered = false) {
            if (failure) throw failure;
            if (socket.readyState !== 1 || (!allowBuffered && inbox.length)) throw pilotError('unexpected_websocket_state');
            markDispatch();
            socket.send(text);
        },
        hasPendingEvents: () => inbox.length > 0,
        deliverLocal(value) {
            if (failure) return;
            inbox.push({ value, bytes: 0 });
            notify();
        },
        async *events() {
            while (true) {
                await waitFor(() => inbox.length > 0);
                const { text, bytes, value } = inbox.shift();
                pendingBytes -= bytes;
                yield text === undefined ? value : JSON.parse(text);
            }
        },
        close() {
            signal.removeEventListener('abort', onAbort);
            socket.removeEventListener('open', notify);
            socket.removeEventListener('error', onError);
            socket.removeEventListener('close', onClose);
            socket.removeEventListener('message', onMessage);
            if (socket.readyState < 2) socket.close();
        },
    };
}

function tokenUsage(usage) {
    const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
    return {
        input: count(usage?.input_tokens), cachedInput: count(usage?.input_tokens_details?.cached_tokens),
        output: count(usage?.output_tokens), reasoningOutput: count(usage?.output_tokens_details?.reasoning_tokens),
        total: count(usage?.total_tokens),
    };
}

function replayItems(items) {
    return items.map(({ created_by, ...item }) => {
        if (item.type === 'message' && item.role === 'assistant') return item;
        if (item.type === 'reasoning' && typeof item.encrypted_content === 'string' && item.encrypted_content) return item;
        throw pilotError('unreplayable_output_item');
    });
}

function totals(arm, expectedTurns) {
    const rows = arm.turns;
    const sum = field => rows.reduce((total, row) => total + (row[field] ?? 0), 0);
    const usage = Object.fromEntries(Object.keys(tokenUsage()).map(key => [key,
        rows.length === expectedTurns && rows.every(row => row.usage?.[key] != null)
            ? rows.reduce((total, row) => total + row.usage[key], 0) : null,
    ]));
    return { requestJsonBytes: sum('requestJsonBytes'), eventJsonBytes: sum('eventJsonBytes'),
        elapsedTurnMs: Math.round(sum('elapsedMs')), usage };
}

export async function runResponsesPilot(client, apiKey, invocation, emit, onDispatch = () => {}) {
    const request = invocation.request;
    if (!request || typeof request !== 'object' || Array.isArray(request) ||
        Object.keys(request).some(key => !['model', 'turns', 'order'].includes(key))) {
        throw Error('Responses pilot accepts only model, optional turns and optional order.');
    }
    const { model, turns = 2, order = 'http-first' } = request;
    const { timeoutSeconds = 120, checkpointPath } = invocation;
    if (typeof model !== 'string' || !/^[A-Za-z0-9_.:-]{1,240}$/.test(model) || model.startsWith('sk-') ||
        !Number.isInteger(turns) || turns < 2 || turns > 5 ||
        !['http-first', 'websocket-first'].includes(order) || !Number.isInteger(timeoutSeconds) ||
        timeoutSeconds < 1 || timeoutSeconds > 3600) {
        throw Error('Provide a model, 2–5 turns, http-first or websocket-first, and a valid local deadline.');
    }
    if (client.baseURL !== httpBase || typeof client.WebSocketTransport !== 'function' ||
        typeof apiKey !== 'string' || !/^sk-[A-Za-z0-9_-]{16,}$/.test(apiKey)) {
        throw Error('Responses pilot requires the official API client, an API key and the native WebSocket transport.');
    }

    const receipt = { action: 'responses.pilot', pilotId: randomUUID(), projectHint: safeToken(invocation.projectHint) };
    const data = { scope: 'synthetic_prompts', model, order, plannedTurnsPerArm: turns,
        store: false, serviceTier: 'default', maxOutputTokensPerTurn: maxOutputTokens,
        measurements: {
            payload: 'UTF-8 of compact request and parsed event JSON; excludes framing, headers and compression.',
            latency: 'Per-turn local dispatch to terminal event or failure; WebSocket handshake reported separately.',
            usage: 'API response usage. Capacity and billed cost are not measured by this pilot.',
        },
        arms: { http: { status: 'not_attempted', turns: [] }, websocket: { status: 'not_attempted', turns: [] } },
    };
    const common = { model, store: false, service_tier: 'default', max_output_tokens: maxOutputTokens,
        include: ['reasoning.encrypted_content'],
        instructions: 'This is a synthetic transport benchmark. Respond with only the requested benchmark code.',
    };
    const signal = AbortSignal.timeout(timeoutSeconds * 1000);
    requireOrdinaryWindowsPath(checkpointPath);
    const checkpoint = checkpointPath && await open(checkpointPath, 'wx', 0o600);
    async function record(phase, fields) {
        if (!checkpoint) return;
        try {
            await checkpoint.writeFile(JSON.stringify({ ...receipt, ...fields, phase, at: new Date().toISOString() }) + '\n');
            await checkpoint.sync();
        } catch {
            data.checkpointWriteFailed = true;
            throw pilotError('checkpoint_write_failed');
        }
    }

    async function runArm(name) {
        const arm = data.arms[name];
        const websocket = name === 'websocket';
        const wsClientRequestId = websocket ? randomUUID() : undefined;
        const armStartedAt = performance.now();
        let connection;
        let previousId;
        const history = [];
        try {
            signal.throwIfAborted();
            if (websocket) {
                arm.clientRequestId = wsClientRequestId;
                const connectingAt = performance.now();
                try {
                    connection = connectWebSocket(client.WebSocketTransport, apiKey, wsClientRequestId, signal);
                    await connection.ready();
                } finally { arm.handshakeElapsedMs = Math.round(performance.now() - connectingAt); }
            }
            for (let index = 0; index < turns; index++) {
                signal.throwIfAborted();
                const user = { role: 'user', content: index === 0
                    ? `Remember the benchmark code ${expectedText}. Return it now.\n\n${referenceText}`
                    : 'Repeat the benchmark code requested in the first turn.' };
                const row = { pilotArm: name, pilotTurn: index + 1, attemptId: randomUUID(),
                    clientRequestId: wsClientRequestId ?? randomUUID() };
                arm.turns.push(row);
                const payload = websocket
                    ? { type: 'response.create', ...common, input: [user],
                        ...(previousId ? { previous_response_id: previousId } : {}) }
                    : { ...common, stream: true, input: [...history, user] };
                const text = JSON.stringify(payload);
                let dispatch = false;
                let startedAt;
                let stream;
                const markDispatch = () => {
                    startedAt = performance.now();
                    dispatch = true;
                    onDispatch();
                    row.requestJsonBytes = Buffer.byteLength(text);
                };
                try {
                    await record('dispatch_pending', row);
                    signal.throwIfAborted();
                    if (websocket) {
                        connection.send(text, markDispatch);
                        stream = connection.events();
                    } else {
                        markDispatch();
                        const response = await client.responses.create(payload, { maxRetries: 0, signal,
                            headers: { 'X-Client-Request-Id': row.clientRequestId } }).withResponse();
                        stream = response.data;
                        row.httpStatus = response.response.status;
                        row.requestId = safeToken(response.request_id ?? response.response.headers.get('x-request-id'));
                        if (!/^text\/event-stream(?:[;\s]|$)/i.test(response.response.headers.get('content-type') ?? '')) {
                            throw pilotError('unexpected_http_content_type');
                        }
                    }
                    row.eventJsonBytes = 0;
                    for await (const event of stream) {
                        if (!event || typeof event.type !== 'string') throw pilotError('invalid_response_event');
                        const bytes = Buffer.byteLength(JSON.stringify(event));
                        row.eventJsonBytes += bytes;
                        if (bytes > eventLimit || row.eventJsonBytes > turnLimit) throw pilotError('response_event_limit');
                        if (event.type === 'error') {
                            row.apiErrorCode = safeToken(event.error?.code ?? event.code);
                            row.apiErrorType = safeToken(event.error?.type);
                            if (!row.responseId && (row.apiErrorType === 'invalid_request_error' ||
                                row.apiErrorCode === 'previous_response_not_found')) row.resourceStatus = 'rejected';
                            throw pilotError('api_error_event');
                        }
                        if (event.type === 'response.output_text.delta') {
                            row.firstTextMs ??= Math.round(performance.now() - startedAt);
                        }
                        const terminal = terminalStatuses.get(event.type);
                        if (event.type !== 'response.created' && event.type !== 'response.in_progress' && !terminal) continue;
                        const response = event.response;
                        const id = response?.id;
                        if (response?.object !== 'response' || !/^resp_[A-Za-z0-9_-]{1,235}$/.test(id ?? '') ||
                            (row.responseId && row.responseId !== id) ||
                            (websocket && previousId === id)) throw pilotError('response_identity_mismatch');
                        const firstId = !row.responseId;
                        row.responseId = id;
                        if (terminal) {
                            if (response.status !== terminal) throw pilotError('response_status_mismatch');
                            row.elapsedMs = Math.round(performance.now() - startedAt);
                            row.resourceStatus = terminal;
                            row.usage = tokenUsage(response.usage);
                        }
                        if (firstId) await record('response_observed', row);
                        if (!terminal) continue;
                        if (terminal !== 'completed') {
                            row.apiErrorCode = safeToken(response.error?.code ?? response.incomplete_details?.reason);
                            throw pilotError('response_' + terminal);
                        }
                        const outputIssue = responseOutputIssue(response);
                        if (outputIssue) throw pilotError('invalid_terminal_' + outputIssue.replaceAll('-', '_'));
                        const output = response.output.flatMap(item => item.type === 'message' && item.role === 'assistant'
                            ? (item.content ?? []).filter(part => part.type === 'output_text').map(part => part.text) : []);
                        row.expectedOutput = output.join('').trim() === expectedText;
                        await record('response_terminal', row);
                        previousId = id;
                        if (!websocket && index + 1 < turns) history.push(user, ...replayItems(response.output));
                        break;
                    }
                    if (row.resourceStatus !== 'completed') throw pilotError('stream_ended_before_terminal');
                } catch (error) {
                    row.localCode = signal.aborted ? 'local_deadline' : error.pilotCode ??
                        (error instanceof SyntaxError ? 'invalid_response_event' : 'request_failed');
                    if (Number.isInteger(error.status) && error.status >= 400 && error.status <= 599) {
                        row.httpStatus = error.status;
                        if (!row.responseId && error.status < 500 && ![408, 409, 425].includes(error.status)) {
                            row.resourceStatus = 'rejected';
                        }
                    }
                    row.apiErrorCode ??= safeToken(error.code);
                    row.requestId ??= safeToken(error.request_id ?? error.headers?.get?.('x-request-id'));
                    if (startedAt !== undefined) row.elapsedMs ??= Math.round(performance.now() - startedAt);
                    row.dispatch = dispatch ? 'attempted' : 'not-attempted';
                    row.outcomeUnconfirmed = dispatch && !row.resourceStatus;
                    await record('error', row).catch(() => {});
                    throw error;
                } finally {
                    if (!websocket) stream?.controller?.abort();
                }
            }
            arm.status = 'completed';
        } catch (error) {
            arm.status = 'stopped';
            arm.localCode = arm.turns.at(-1)?.localCode ??
                (signal.aborted ? 'local_deadline' : error.pilotCode ?? 'connection_setup_failed');
        } finally {
            connection?.close();
            arm.elapsedMs = Math.round(performance.now() - armStartedAt);
        }
    }

    try {
        for (const name of order === 'http-first' ? ['http', 'websocket'] : ['websocket', 'http']) {
            await runArm(name);
            if (data.arms[name].status !== 'completed') break;
        }
    } finally {
        if (checkpoint) {
            try { await checkpoint.close(); }
            catch { data.checkpointWriteFailed = true; }
        }
    }
    const arms = Object.values(data.arms);
    for (const arm of arms) arm.totals = totals(arm, turns);
    data.transportCompleted = arms.every(arm => arm.status === 'completed');
    data.expectedOutputsMatched = data.transportCompleted ? arms.every(arm => arm.turns.every(row => row.expectedOutput)) : null;
    data.comparisonAvailable = data.expectedOutputsMatched === true;
    if (!data.transportCompleted || data.checkpointWriteFailed) data.status = 'partial';
    else data.status = data.comparisonAvailable ? 'completed' : 'comparison_failed';
    receipt.outcomeUnconfirmed = arms.some(arm => arm.turns.some(row => row.outcomeUnconfirmed));
    await emit({ kind: 'result', receipt, data });
    if (data.status !== 'completed') process.exitCode = 1;
}
