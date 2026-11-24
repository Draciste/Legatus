import { open, realpath, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { publishFile } from './publish-openai-file.mjs';

const url = 'wss://api.openai.com/v1/live/sessions';
const maxOutputBytes = 16 * 1024 * 1024;
const maxSessionDuration = 120;

export async function runLiveAudio(WebSocketTransport, apiKey, handle, destination, params, signal, receipt, record) {
    const { session, listen_seconds: listenSeconds = 5, retain_partial: retainPartial = false } = params;
    const format = session?.audio?.format;
    const modelId = value => typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,120}$/.test(value) ? value : undefined;
    const rate = format?.rate;
    const input = await handle.stat();
    if (!format || format.type !== 'audio/pcm' || ![16000, 24000].includes(rate) || typeof session.model !== 'string' || !session.model.trim() ||
        Object.keys(params).some(key => !['session', 'listen_seconds', 'retain_partial'].includes(key)) ||
        typeof retainPartial !== 'boolean' ||
        !Number.isInteger(listenSeconds) || listenSeconds < 1 || listenSeconds > 30 ||
        !input.isFile() || input.size < 2 || input.size % 2 || input.size > rate * 2 * maxSessionDuration) {
        throw Error('Expected up to 120 seconds of raw mono PCM16, matching session.audio.format, and optional listen_seconds=1..30.');
    }
    receipt.requestedModel = modelId(session.model);
    if (!WebSocketTransport) throw Error('This Node runtime has no qualified Live WebSocket transport.');
    const header = Buffer.alloc(12);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead === header.length && /^(?:RIFF|RIFX|RF64)$/.test(header.toString('ascii', 0, 4))
        && header.toString('ascii', 8, 12) === 'WAVE') {
        throw Error('This is a WAV container. Pass raw PCM without its file header.');
    }
    signal.throwIfAborted();
    const temporary = path.join(await realpath(path.dirname(destination)), '.legatus-part-' + randomUUID());
    const output = await open(temporary, 'wx+', 0o600);
    let socket;
    let receivedBytes = 0;
    let writtenBytes = 0;
    let sentBytes = 0;
    let localCloseRequested = false;
    let reportedFormat;
    let formatRejected = false;
    let inputTranscript = '';
    let outputTranscript = '';
    let transcriptTruncated = false;
    let outputWork = Promise.resolve();
    let finalEvent;
    let start, close, fail;
    const started = new Promise(resolve => { start = resolve; });
    const ended = new Promise(resolve => { close = resolve; });
    const failure = new Promise((resolve, reject) => { fail = reject; });
    const abort = () => fail(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    failure.catch(() => {});
    let closing = false;
    const awaitSocket = pending => Promise.race([pending, failure]);
    const send = body => {
        if (socket.readyState !== 1 || socket.bufferedAmount > 256 * 1024) {
            throw Error('The Live audio connection cannot accept more input.');
        }
        socket.send(JSON.stringify(body));
    };
    async function collectOutput(transportError) {
        closing = true;
        const sessionClosed = Boolean(finalEvent);
        const inputComplete = sentBytes === input.size;
        const usageVerified = sessionClosed && finalEvent.usage.seconds >= 0;
        const closedNormally = !transportError && usageVerified && localCloseRequested && finalEvent.reason === 'close_requested';
        const clipLength = () => writtenBytes - writtenBytes % 2;
        let audio = null;
        let outputError;
        try { await outputWork; }
        catch (error) { outputError = { category: error.name, code: error.code }; }
        const completeMedia = Boolean(receivedBytes && receivedBytes === writtenBytes && writtenBytes % 2 === 0 && !outputError);
        const partial = !(closedNormally && inputComplete && completeMedia);
        try {
            if (!formatRejected && clipLength() && (!partial || retainPartial)) {
                if (partial) await output.truncate(clipLength());
                await output.sync();
                const bytes = clipLength();
                const hash = createHash('sha256');
                for await (const chunk of output.createReadStream({ start: 0, end: bytes - 1, autoClose: false })) hash.update(chunk);
                const sha256 = hash.digest('hex');
                await output.close();
                const publication = await publishFile(temporary, destination, { expectedBytes: bytes, expectedSha256: sha256 });
                audio = { path: destination, bytes, sha256, publication, format: reportedFormat ?? format,
                    formatSource: reportedFormat ? 'reported' : 'requested', partial };
            }
        } catch (error) { outputError = { category: error.name, code: error.code, publication: error.publication }; }
        return { audio, inputTranscript, outputTranscript, transcriptTruncated, usage: usageVerified ? finalEvent.usage : undefined,
            ...(sessionClosed && !usageVerified ? { usageError: 'Live terminal event reported negative usage seconds.' } : {}),
            closeReason: finalEvent?.reason, sessionClosed, localCloseRequested, inputComplete,
            outputComplete: Boolean(audio && !partial), audioReceived: receivedBytes > 0, outputPublished: Boolean(audio),
            applicationComplete: null, sentBytes, receivedBytes, requestedFormat: format, outputError,
            ...(transportError ? { interrupted: true, transportError: { category: transportError.name, code: transportError.code } } : {}) };
    }
    try {
        await record('live_connecting');
        signal.throwIfAborted();
        await record('live_connection_attempted');
        socket = new WebSocketTransport(url, { headers: {
            Authorization: 'Bearer ' + apiKey, 'X-Client-Request-Id': receipt.clientRequestId,
        } });
        socket.addEventListener('open', () => {
            try { send({ type: 'session.start', session: { store: false, ...session } }); }
            catch (error) { fail(error); }
        });
        socket.addEventListener('error', () => fail(Error('Live WebSocket transport failed.')));
        socket.addEventListener('close', () => {
            if (!closing) fail(Error('Live disconnected before session.closed.'));
        });
        socket.addEventListener('message', event => {
            if (finalEvent || closing) return;
            try {
                if (typeof event.data !== 'string' || event.data.length > 1024 * 1024) throw Error('Unexpected Live event size or encoding.');
                const body = JSON.parse(event.data);
                if (body.type === 'error') throw Object.assign(Error('Live API returned a session error.'),
                    { code: body.error?.code, type: body.error?.type, param: body.error?.param });
                if (body.type === 'session.started') {
                    if (modelId(body.session?.model)) receipt.reportedModel = modelId(body.session.model);
                    const id = body.session?.id;
                    if (!/^live_[A-Za-z0-9_-]{1,235}$/.test(id ?? '') || (receipt.liveSessionId && receipt.liveSessionId !== id)) {
                        throw Error('Live session identity is invalid.');
                    }
                    receipt.liveSessionId = id;
                    if (body.session.audio && Object.hasOwn(body.session.audio, 'format')) {
                        const outputFormat = body.session.audio.format;
                        if (outputFormat?.type !== 'audio/pcm' || ![16000, 24000].includes(outputFormat.rate)) {
                            formatRejected = true;
                            throw Error('Live reported an unsupported output audio format.');
                        }
                        if ((reportedFormat && reportedFormat.rate !== outputFormat.rate) ||
                            (!reportedFormat && receivedBytes && format.rate !== outputFormat.rate)) {
                            formatRejected = true;
                            throw Error('Live changed the output audio format within the same session.');
                        }
                        reportedFormat = { type: outputFormat.type, rate: outputFormat.rate };
                    }
                    start();
                }
                if (body.type === 'session.output_audio.delta') {
                    if (typeof body.delta !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.delta)) {
                        throw Error('Live output audio has invalid base64.');
                    }
                    const data = Buffer.from(body.delta, 'base64');
                    if (!data.length || data.toString('base64').replace(/=+$/, '') !== body.delta.replace(/=+$/, '') ||
                        (body.delta.endsWith('=') && body.delta.length % 4 !== 0)) {
                        throw Error('Live output audio has invalid base64.');
                    }
                    if (receivedBytes + data.length > maxOutputBytes) throw Error('Live output audio budget exceeded.');
                    receivedBytes += data.length;
                    outputWork = outputWork.then(async () => { await output.writeFile(data); writtenBytes += data.length; });
                    outputWork.catch(fail);
                }
                if (typeof body.delta === 'string') {
                    if (body.type === 'session.input_transcript.delta') {
                        transcriptTruncated ||= inputTranscript.length + body.delta.length > 65536;
                        inputTranscript += body.delta.slice(0, 65536 - inputTranscript.length);
                    }
                    if (body.type === 'session.output_transcript.delta') {
                        transcriptTruncated ||= outputTranscript.length + body.delta.length > 65536;
                        outputTranscript += body.delta.slice(0, 65536 - outputTranscript.length);
                    }
                }
                if (body.type === 'session.closed') {
                    if (!receipt.liveSessionId || body.session?.id !== receipt.liveSessionId ||
                        typeof body.reason !== 'string' || !body.reason.trim() || !Number.isFinite(body.usage?.seconds)) {
                        throw Error('Live terminal event omitted the expected identity, reason or usage.');
                    }
                    finalEvent = body;
                    closing = true;
                    close();
                }
            } catch (error) { fail(error); }
        });
        await awaitSocket(Promise.race([started, ended]));
        if (!receipt.liveSessionId) throw Error('Live ended before starting.');
        await record('live_started');
        const frame = Buffer.alloc(rate / 5);
        let nextFrameAt = performance.now();
        for (let offset = 0; offset < input.size && !finalEvent; offset += frame.length) {
            const frameBytes = Math.min(frame.length, input.size - offset);
            let copied = 0;
            while (copied < frameBytes) {
                const { bytesRead } = await handle.read(frame, copied, frameBytes - copied, offset + copied);
                if (!bytesRead) throw Error('Live input ended prematurely.');
                copied += bytesRead;
            }
            if (finalEvent) break;
            send({ type: 'session.input_audio.append', audio: frame.subarray(0, frameBytes).toString('base64') });
            sentBytes += frameBytes;
            nextFrameAt += frameBytes * 1000 / (rate * 2);
            await awaitSocket(Promise.race([ended, delay(Math.max(0, nextFrameAt - performance.now()), undefined, { signal })]));
        }
        const silence = Buffer.alloc(frame.length).toString('base64');
        for (let frameNumber = 0; frameNumber < 8 && !finalEvent; frameNumber++) {
            send({ type: 'session.input_audio.append', audio: silence });
            await awaitSocket(Promise.race([ended, delay(100, undefined, { signal })]));
        }
        if (!finalEvent) await awaitSocket(Promise.race([ended, delay(listenSeconds * 1000, undefined, { signal })]));
        if (!finalEvent) {
            localCloseRequested = true;
            send({ type: 'session.close' });
        }
        await awaitSocket(ended);
        receipt.resourceStatus = 'closed';
        receipt.liveCloseReason = finalEvent.reason;
        receipt.liveUsageVerification = finalEvent.usage.seconds >= 0 ? 'verified' : 'invalid';
        if (receipt.liveUsageVerification === 'verified') receipt.liveUsageSeconds = finalEvent.usage.seconds;
        await record('live_closed', { outputBytes: receivedBytes, closeReason: finalEvent.reason });
        return await collectOutput();
    } catch (error) {
        if (!retainPartial || !socket) throw error;
        return await collectOutput(error);
    } finally {
        closing = true;
        signal.removeEventListener('abort', abort);
        try { socket?.close(); } catch {}
        await outputWork.catch(() => {});
        await output.close().catch(() => {});
        await unlink(temporary).catch(() => {});
    }
}
