import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { requireOrdinaryWindowsPath } from './publish-openai-file.mjs';
import { connectWebSocket } from './openai-responses-pilot.mjs';
import { responseOutputIssue } from './openai-stream-integrity.mjs';

const control = Symbol('local-steer-input');
const endpoint = 'https://api.openai.com/v1';
const validId = (value, prefix) => typeof value === 'string' &&
    /^[A-Za-z0-9_-]{1,256}$/.test(value) && value.startsWith(prefix);
const token = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,120}$/.test(value) &&
    !value.startsWith('sk-') ? value : undefined;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = code => Object.assign(Error(code), { code });
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const supplied = (part, names) => names.some(name => nonempty(part[name]));
const matchesParent = (response, parent) =>
    !Object.hasOwn(response, 'previous_response_id') || response.previous_response_id === parent;
const normalizedInput = input => Array.isArray(input)
    ? input.map(item => ({ type: 'message', ...item })) : input;
const pendingCallTypes = new Set(['function_call_output', 'custom_tool_call_output', 'computer_call_output',
    'shell_call_output', 'apply_patch_call_output', 'tool_search_output']);

function validPending(event) {
    if (!token(event.reason) || !Array.isArray(event.required_input)) return false;
    if (event.reason === 'waiting_for_required_input' && !event.required_input.length) return false;
    const observed = new Set();
    return event.required_input.every(stub => {
        if (!object(stub)) return false;
        const approval = stub.type === 'mcp_approval_response';
        if (!approval && !pendingCallTypes.has(stub.type)) return false;
        const identityField = approval ? 'approval_request_id' : 'call_id';
        const extra = stub.type === 'function_call_output' ? 'name' : stub.type === 'tool_search_output' ? 'execution' : undefined;
        const id = token(stub[identityField]), anchor = identityField + ':' + id;
        if (!id || observed.has(anchor) || Object.keys(stub).some(key => !['type', identityField, extra].includes(key)) ||
            (extra === 'name' && !token(stub.name)) || (extra === 'execution' && stub.execution !== 'client')) return false;
        observed.add(anchor);
        return true;
    });
}

function matchesPendingCalls(stubs, output) {
    if (!Array.isArray(output)) return !stubs.length;
    return stubs.every(stub => {
        const approval = stub.type === 'mcp_approval_response';
        const callType = approval ? 'mcp_approval_request' : stub.type.slice(0, -'_output'.length) +
            (stub.type === 'tool_search_output' ? '_call' : '');
        const matches = output.filter(item => item?.type === callType &&
            (approval ? item.id === stub.approval_request_id : item.call_id === stub.call_id));
        return matches.length === 1 && (stub.name === undefined || matches[0].name === stub.name) &&
            (stub.execution === undefined || matches[0].execution === stub.execution);
    });
}
const terminalTypes = new Set(['response.incomplete', 'response.completed', 'response.failed']);

function terminalResponse(event) {
    const response = event.response;
    if (!validId(response?.id, 'resp_') || response.object !== 'response' ||
        response.status !== event.type.slice('response.'.length)) throw fail('invalid_terminal_response');
    return response;
}
const contentParts = {
    input_text: part => nonempty(part.text),
    input_image: part => supplied(part, ['file_id', 'image_url']),
    input_file: part => supplied(part, ['file_id', 'file_url', 'file_data']),
};
export const steeringUnsupportedFields = ['type', 'stream', 'background', 'multi_agent', 'betas', 'access_programs'];
export const steeringModelFamily = 'GPT-6';

function validMessage(item) {
    if (!object(item) || item.role !== 'user' || (item.type !== undefined && item.type !== 'message') ||
        Object.keys(item).some(key => !['type', 'role', 'content'].includes(key))) return false;
    return nonempty(item.content) || (Array.isArray(item.content) && item.content.length > 0 &&
        item.content.every(part => object(part) && Object.hasOwn(contentParts, part.type) && contentParts[part.type](part)));
}

function checkInput(input) {
    if (!nonempty(input) && !(Array.isArray(input) && input.length && input.every(validMessage))) {
        throw fail('invalid_steer_input');
    }
    if (Buffer.byteLength(JSON.stringify(input)) > 1024 * 1024) throw fail('steer_input_too_large');
    return input;
}

export async function runSteeredResponse(client, invocation, emit, receiveSteer) {
    const { request, clientRequestId = randomUUID(), timeoutSeconds, checkpointPath, projectHint } = invocation;
    const receipt = { action: 'responses.steer', clientRequestId: clientRequestId || randomUUID(),
        projectHint: token(projectHint), credentialRoute: 'openai-project-api-key', transport: 'websocket',
        dispatched: false, steerDispatch: 'not-attempted' };
    let checkpoint, socket, result, original, continuation, sentInput;
    const warnings = [];
    const record = async (phase, bestEffort = true) => {
        if (!checkpoint) return;
        try {
            await checkpoint.writeFile(JSON.stringify({ ...receipt, phase, at: new Date().toISOString() }) + '\n');
            await checkpoint.sync();
        } catch (error) {
            if (!bestEffort) throw fail('checkpoint_write_failed');
            warnings.push({ phase, code: 'checkpoint_write_failed' });
        }
    };
    try {
        const { response, steer_input: scheduled } = request;
        if (client.baseURL !== endpoint || !client.apiKey || typeof client.WebSocketTransport !== 'function') {
            throw fail('official_responses_websocket_required');
        }
        if (!object(response) || !token(response.model) ||
            !(typeof response.input === 'string' || (Array.isArray(response.input) && response.input.every(object))) ||
            (response.store != null && typeof response.store !== 'boolean') ||
            (Object.hasOwn(response, 'stream_id') && !nonempty(response.stream_id)) ||
            steeringUnsupportedFields.some(key => Object.hasOwn(response, key)) ||
            Object.keys(request).some(key => !['response', 'steer_input'].includes(key)) ||
            (receiveSteer ? scheduled !== undefined : scheduled === undefined) || timeoutSeconds > 3600) {
            throw fail('invalid_steer_request');
        }
        if (!/^gpt-6(?=$|[.-])/.test(response.model)) throw fail('steer_requires_gpt_6_model_id');
        const originalParent = response.previous_response_id ?? null;
        const stream = response.stream_id;
        const laneMatches = event => event.stream_id === undefined
            ? stream === undefined || !(event.type === 'response.created' || terminalTypes.has(event.type))
            : event.stream_id === stream;
        if (originalParent !== null && !validId(originalParent, 'resp_')) throw fail('invalid_original_parent');
        const observeOriginal = async responseResult => {
            if (!matchesParent(responseResult, originalParent)) throw fail('unexpected_original_parent');
            original = responseResult;
            receipt.originalStatus = original.status;
            receipt.originalOutputIssue = responseOutputIssue(original);
            await record('original_terminal');
        };
        if (response.conversation != null || (response.context_management != null &&
            (!Array.isArray(response.context_management) ||
                response.context_management.some(item => item?.type === 'compaction')))) {
            throw fail('conversation_or_compaction_not_steerable');
        }
        if (scheduled !== undefined) checkInput(scheduled);
        receipt.storeRequested = response.store === true;
        const payload = JSON.stringify({ ...response, store: response.store ?? false, type: 'response.create' });
        if (Buffer.byteLength(payload) > 16 * 1024 * 1024) throw fail('steer_request_too_large');
        if (checkpointPath) {
            await requireOrdinaryWindowsPath(checkpointPath);
            checkpoint = await open(checkpointPath, 'wx', 0o600);
        }
        const signal = AbortSignal.timeout(timeoutSeconds * 1000);
        await record('before_connect', false);
        socket = connectWebSocket(client.WebSocketTransport, client.apiKey, receipt.clientRequestId, signal);
        await socket.ready();
        await record('dispatch_pending', false);
        socket.send(payload, () => { receipt.dispatched = true; });
        const events = socket.events();
        let bytes = 0;
        for await (const event of events) {
            if (signal.aborted) throw fail('local_deadline');
            if (result) {
                // A rejection or protocol error settles the steering state.
                // Preserve the original result if it already arrived behind it.
                bytes += Buffer.byteLength(JSON.stringify(event));
                if (bytes > 64 * 1024 * 1024) throw fail('steer_stream_limit');
                if (terminalTypes.has(event?.type) && laneMatches(event) && event.response?.id === receipt.originalResponseId) {
                    await observeOriginal(terminalResponse(event));
                    break;
                }
                if (!socket.hasPendingEvents()) break;
                continue;
            }
            if (object(event) && Object.hasOwn(event, control)) {
                if (event.error) throw event.error;
                const input = checkInput(event[control]);
                if (!event.checkpointed) {
                    await record('steer_dispatch_pending', false);
                    event.checkpointed = true;
                }
                if (socket.hasPendingEvents()) {
                    socket.deliverLocal(event);
                    continue;
                }
                socket.send(JSON.stringify({ type: 'response.steer', previous_response_id: receipt.originalResponseId,
                    input }), () => { receipt.steerDispatch = 'attempted'; sentInput = normalizedInput(input); }, true);
                continue;
            }
            if (!object(event) || typeof event.type !== 'string') throw fail('invalid_websocket_event');
            bytes += Buffer.byteLength(JSON.stringify(event));
            if (bytes > 64 * 1024 * 1024) throw fail('steer_stream_limit');
            if (!laneMatches(event)) {
                result = { outcome: 'unconfirmed', outcomeUnconfirmed: true, localCode: 'steer_stream_mismatch' };
                if (original || !socket.hasPendingEvents()) break;
                continue;
            }
            if (event.type === 'response.created') {
                const id = event.response?.id;
                if (!validId(id, 'resp_') || event.response.object !== 'response') throw fail('invalid_response_identity');
                if (!receipt.originalResponseId) {
                    if (!matchesParent(event.response, originalParent)) throw fail('unexpected_original_parent');
                    receipt.originalResponseId = id;
                    await record('original_observed');
                    if (scheduled !== undefined) socket.deliverLocal({ [control]: scheduled });
                    else Promise.resolve().then(receiveSteer).then(
                        steer => socket.deliverLocal({ [control]: steer }),
                        error => socket.deliverLocal({ [control]: undefined, error }));
                } else {
                    if (receipt.continuationResponseId || id === receipt.originalResponseId || receipt.steerDispatch !== 'accepted' ||
                        !matchesParent(event.response, receipt.originalResponseId)) {
                        throw fail('unexpected_continuation_identity');
                    }
                    receipt.continuationResponseId = id;
                    await record('continuation_observed');
                }
                await emit({ kind: 'event', event });
            } else if (['response.steer.accepted', 'response.steer.pending', 'response.steer.failed'].includes(event.type)) {
                const { id, previous_response_id: previous } = event.steer ?? {};
                const state = event.type.split('.').at(-1);
                const rejectedBeforeId = state === 'failed' && receipt.steerDispatch === 'attempted' && id === undefined;
                if ((!validId(id, 'steer_') && !rejectedBeforeId) || !receipt.originalResponseId ||
                    previous !== receipt.originalResponseId || (receipt.steerId && receipt.steerId !== id) ||
                    (receipt.steerDispatch !== 'attempted' && receipt.steerDispatch !== 'accepted') ||
                    (state === 'accepted' && receipt.steerDispatch !== 'attempted') ||
                    (state === 'pending' && receipt.steerDispatch !== 'accepted') ||
                    receipt.continuationResponseId) {
                    throw fail('steer_correlation_mismatch');
                }
                if (state === 'failed' && (!object(event.error) || !token(event.error.code) ||
                    typeof event.error.message !== 'string' || event.error.type !== 'invalid_request_error')) {
                    throw fail('invalid_steer_failure');
                }
                if (state === 'failed') {
                    checkInput(event.steer.input);
                    if (!isDeepStrictEqual(normalizedInput(event.steer.input), sentInput)) throw fail('steer_input_mismatch');
                }
                if (state === 'pending' && !validPending(event)) throw fail('invalid_steer_pending');
                if (state === 'pending' && event.reason === 'waiting_for_required_input' && original?.status !== 'completed') {
                    result = { outcome: 'unconfirmed', outcomeUnconfirmed: true, localCode: 'premature_steer_pending' };
                    if (original || !socket.hasPendingEvents()) break;
                    continue;
                }
                if (state === 'pending' && event.required_input.length &&
                    !matchesPendingCalls(event.required_input, original?.output)) {
                    result = { outcome: 'unconfirmed', outcomeUnconfirmed: true, localCode: 'unverified_pending_call' };
                    if (original || !socket.hasPendingEvents()) break;
                    continue;
                }
                if (id !== undefined) receipt.steerId = id;
                if (state === 'failed') receipt.steerErrorCode = token(event.error?.code);
                if (state === 'pending') {
                    receipt.pendingReason = event.reason;
                    receipt.pendingInputCount = event.required_input.length;
                }
                receipt.steerDispatch = state;
                await record(event.type);
                if (receipt.steerDispatch !== 'accepted') {
                    result = { outcome: state === 'failed' ? 'steer-rejected' :
                        event.reason === 'waiting_for_required_input' ? 'needs-client-input' : 'steer-pending',
                        providerEvent: event };
                    if (original || !socket.hasPendingEvents()) break;
                    continue;
                }
                await emit({ kind: 'event', event });
            } else if (terminalTypes.has(event.type)) {
                const responseResult = terminalResponse(event);
                if (responseResult.id === receipt.originalResponseId && !original) {
                    await observeOriginal(responseResult);
                    if (receipt.steerDispatch === 'not-attempted') {
                        result = { outcome: receipt.originalOutputIssue ? 'original-output-unverified' :
                            original.status === 'completed' ? 'completed-without-steer' : 'original-not-completed' };
                        break;
                    }
                } else if (responseResult.id === receipt.continuationResponseId && !continuation && original) {
                    if (!matchesParent(responseResult, receipt.originalResponseId)) throw fail('unexpected_continuation_parent');
                    continuation = responseResult;
                    receipt.continuationStatus = continuation.status;
                    receipt.continuationOutputIssue = responseOutputIssue(continuation);
                    await record('continuation_terminal');
                    result = { outcome: receipt.continuationOutputIssue ? 'continuation-output-unverified' :
                        receipt.originalOutputIssue ? 'original-output-unverified' :
                        continuation.status === 'completed' ? 'continuation-completed' : 'continuation-not-completed' };
                    break;
                } else throw fail('unexpected_terminal_identity');
            } else if (event.type === 'error') {
                receipt.providerErrorCode = token(event.code ?? event.error?.code);
                result = { outcome: 'unconfirmed', outcomeUnconfirmed: true, providerEvent: event };
                if (original || !socket.hasPendingEvents()) break;
            }
        }
    } catch (error) {
        const code = token(error.pilotCode ?? error.code) ?? 'steer_transport_error';
        if (!receipt.dispatched) {
            process.exitCode = 1;
            result = { kind: 'error', stage: 'preflight', dispatch: 'not-attempted', outcomeUnconfirmed: false, localCode: code };
        } else if (result) warnings.push({ phase: 'original-observation', code });
        else result = { outcome: 'unconfirmed', outcomeUnconfirmed: true, localCode: code };
    } finally {
        if (receipt.dispatched && result?.outcome) {
            receipt.outcome = result.outcome;
            receipt.outcomeUnconfirmed = result.outcomeUnconfirmed ?? false;
            if (result.localCode) receipt.localCode = result.localCode;
            await record('steering_ended');
        }
        try { socket?.close(); }
        catch { warnings.push({ phase: 'close', code: 'websocket_close_failed' }); }
        try { await checkpoint?.close(); }
        catch { warnings.push({ phase: 'close', code: 'checkpoint_close_failed' }); }
    }
    if (result?.outcome !== 'continuation-completed' || receipt.originalOutputIssue) process.exitCode = 1;
    await emit({ kind: 'result', ...result, receipt, original, continuation,
        ...(warnings.length ? { localWarnings: warnings } : {}) });
}
