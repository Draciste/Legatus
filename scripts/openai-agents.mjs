import { createHash, randomInt, randomUUID } from 'node:crypto';
import { constants, existsSync, realpathSync } from 'node:fs';
import { lstat, mkdtemp, open, realpath, rmdir, unlink, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { checkCompletedFile, checkUpload, checkUploadedFile, checkUploadMetadata, transferUpload, uploadPartBytes } from './openai-multipart.mjs';
import { checkSvgParser, verifyImageStructure } from './openai-image-structure.mjs';
import { verifySpeech } from './openai-speech-structure.mjs';
import { runLiveAudio } from './openai-live.mjs';
import { runResponsesPilot } from './openai-responses-pilot.mjs';
import { runSteeredResponse, steeringModelFamily, steeringUnsupportedFields } from './openai-responses-steer.mjs';
import { publishFile, requireOrdinaryWindowsPath } from './publish-openai-file.mjs';
import { qualifyRuntime } from './openai-runtime-qualification.mjs';
import { describeFileInputs } from './openai-file-coverage.mjs';
import { responseOutputIssue, trackResponseStream } from './openai-stream-integrity.mjs';
import { compareJsonArguments, parseApiJson } from './openai-json.mjs';
import { verifyBatchArtifacts } from './openai-batch-recovery.mjs';
import { maxArtifactBytes as maxDownloadBytes } from './openai-local-limits.mjs';
import { classifyOpenAiFailure, describeDaybreak, observeDaybreak, prepareDaybreak, responseSafetyOutcome,
    verifyDaybreakSession } from './openai-daybreak.mjs';

const endpoint = 'https://api.openai.com/v1';
const operations = new Map();
const read = 'read';
const write = 'write';
const watch = 'watch';
const download = 'download';
const render = 'render';

function expose(resource, methods, root = 'beta.agents') {
    const sdkPath = root !== 'beta.agents' || resource === 'agents' ? root : root + '.' + resource;
    for (const [method, [kind, id = false, params = false, required = []]] of Object.entries(methods)) {
        operations.set(resource + '.' + method, { sdkPath, method, kind, id, params, required });
    }
}

const crud = {
    create: [write, false, true], list: [read, false, true], retrieve: [read, true],
    update: [write, true, true], delete: [write, true],
};
expose('agents', crud);
expose('sessions', crud);
expose('sessions.events', { create: [write, true, true], stream: [watch, true, true] });
expose('sessions.items', { list: [read, true, true] });
expose('sessions.turns', { list: [read, true, true], retrieve: [read, true, true, ['session_id']] });
expose('sessions.turns.items', { list: [read, true, true, ['session_id']] });
expose('sessions.subagents', { list: [read, true, true], retrieve: [read, true, true, ['session_id']] });
expose('sessions.subagents.items', { list: [read, true, true, ['session_id']] });
expose('sessions.subagents.turns', {
    list: [read, true, true, ['session_id']], retrieve: [read, true, true, ['session_id', 'subagent_id']],
});
expose('sessions.subagents.turns.items', { list: [read, true, true, ['session_id', 'subagent_id']] });
expose('sessions.traces', { list: [read, true, true] });
expose('sessions.artifacts', {
    list: [read, true, true], retrieve: [read, true, true, ['session_id']],
    delete: [write, true, true, ['session_id']], content: [download, true, true, ['session_id']],
});
expose('environments', { create: crud.create, list: crud.list, retrieve: crud.retrieve });
expose('environments.templates', crud);
expose('environments.files', { create: [write, true, true], list: [read, true, true] });
expose('automations', { ...crud, pause: [write, true], resume: [write, true] });
expose('automations.invocations', {
    create: [write, true], list: [read, true, true], retrieve: [read, true, true, ['automation_id']],
});
expose('vaults', crud);
expose('vaults.credentials', {
    create: [write, true, true], list: [read, true, true],
    retrieve: [read, true, true, ['vault_id']], update: [write, true, true, ['vault_id']],
    delete: [write, true, true, ['vault_id']],
});
expose('files', { create: crud.create, list: crud.list, retrieve: crud.retrieve, delete: crud.delete,
    content: [download, true] }, 'files');
expose('models', { list: [read] }, 'models');
expose('decisions', { create: crud.create }, 'decisions');
expose('responses', {
    create: crud.create, retrieve: [read, true, true], cancel: [write, true],
    delete: crud.delete, compact: crud.create, inputtokens: [read, false, true],
}, 'responses');
operations.get('responses.inputtokens').sdkPath = 'responses.inputTokens';
operations.get('responses.inputtokens').method = 'count';
expose('responses.inputitems', { list: [read, true, true] }, 'responses.inputItems');
expose('responses.multiagent', { create: crud.create, retrieve: [read, true, true] }, 'beta.responses');
const responseCreates = new Set(['responses.create', 'responses.multiagent.create']);
const responseRetrieves = new Set(['responses.retrieve', 'responses.multiagent.retrieve']);
const adminActions = new Set(['admin.usage.completions', 'admin.usage.costs']);
expose('admin.usage', { completions: [read, false, true], costs: [read, false, true] }, 'admin.organization.usage');
expose('batches', { create: crud.create, list: crud.list, retrieve: crud.retrieve, cancel: [write, true] }, 'batches');
operations.set('batches.wait', { ...operations.get('batches.retrieve'), kind: 'wait' });
expose('conversations', { create: crud.create, retrieve: crud.retrieve, update: crud.update,
    delete: crud.delete }, 'conversations');
expose('conversations.items', {
    create: [write, true, true], list: [read, true, true],
    retrieve: [read, true, true, ['conversation_id']], delete: [write, true, true, ['conversation_id']],
}, 'conversations.items');
expose('vectorstores', { ...crud, search: [read, true, true] }, 'vectorStores');
expose('vectorstores.files', {
    create: [write, true, true], list: [read, true, true],
    retrieve: [read, true, true, ['vector_store_id']], delete: [write, true, true, ['vector_store_id']],
}, 'vectorStores.files');
expose('skills', crud, 'skills');
expose('skills.versions', {
    create: [write, true, true], list: [read, true, true],
    retrieve: [read, true, true, ['skill_id']], delete: [write, true, true, ['skill_id']],
}, 'skills.versions');
expose('embeddings', { create: crud.create }, 'embeddings');
expose('moderations', { create: crud.create }, 'moderations');
expose('images', { generate: crud.create, edit: crud.create }, 'images');
expose('audio.transcriptions', { create: crud.create }, 'audio.transcriptions');
expose('audio.speech', { create: [render, false, true] }, 'audio.speech');
expose('containers', { create: crud.create, list: crud.list, retrieve: crud.retrieve, delete: crud.delete }, 'containers');
expose('containers.files', {
    create: [write, true, true], list: [read, true, true],
    retrieve: [read, true, true, ['container_id']], delete: [write, true, true, ['container_id']],
}, 'containers.files');
expose('containers.files.content', { retrieve: [download, true, true, ['container_id']] }, 'containers.files.content');
expose('provenance', { create: crud.create }, 'contentProvenanceChecks');
expose('uploads', { create: crud.create, complete: [write, true, true], cancel: [write, true] }, 'uploads');
expose('uploads.parts', { create: [write, true, true] }, 'uploads.parts');
operations.set('uploads.transfer', { ...operations.get('uploads.create'), kind: 'transfer' });
expose('live', { create: crud.create }, 'live');
expose('live.sessions', { downloadrecording: [download, true] }, 'live.sessions');
operations.get('live.sessions.downloadrecording').method = 'downloadRecording';
operations.set('live.audio', { ...operations.get('live.create'), kind: 'voice' });
const workspaceActions = new Set(['workspace.trigger', 'workspace.status']);

// Result identities from the pinned SDK. An argument can identify a parent,
// a version, or the returned object, depending on the action.
const identifiedResources = {
    agents: 'agent', sessions: 'agent.session', environments: 'agent.environment',
    'environments.templates': 'agent.environment.template', automations: 'agent.automation',
    vaults: 'vault', vectorstores: 'vector_store', conversations: 'conversation', skills: 'skill',
    containers: undefined, 'sessions.turns': 'agent.session.turn',
    'sessions.subagents': 'agent.session.subagent', 'sessions.subagents.turns': 'agent.session.turn',
    'sessions.artifacts': 'agent.session.artifact', 'automations.invocations': 'agent.automation.invocation',
    'vaults.credentials': 'vault.credential', 'vectorstores.files': 'vector_store.file',
    'skills.versions': 'skill.version', 'containers.files': 'container.file',
    'conversations.items': undefined,
};
// Page members expose these owners in the pinned SDK. Item unions expose a
// turn ID in turn-scoped endpoints, with their own type and ID conventions.
const listOwners = {
    'sessions.artifacts.list': ['agent.session.artifact', 'session_id'],
    'sessions.traces.list': ['agent.session.trace', 'session_id'],
    'sessions.subagents.list': ['agent.session.subagent', 'session_id'],
    'sessions.turns.list': ['agent.session.turn', 'session_id'],
    'sessions.subagents.turns.list': ['agent.session.turn', 'subagent_id', 'session_id'],
    'automations.invocations.list': ['agent.automation.invocation', 'automation_id'],
    'vaults.credentials.list': ['vault.credential', 'vault_id'],
    'vectorstores.files.list': ['vector_store.file', 'vector_store_id'],
    'skills.versions.list': ['skill.version', 'skill_id'],
    'containers.files.list': ['container.file', 'container_id'],
};
const itemPages = new Set(['sessions.items.list', 'sessions.subagents.items.list', 'sessions.turns.items.list',
    'sessions.subagents.turns.items.list', 'responses.inputitems.list']);
// These catalog routes use an SDK CursorPage with an identity on each row.
const identifiedPages = new Set(['agents.list', 'sessions.list', 'environments.list',
    'environments.templates.list', 'automations.list', 'vaults.list', 'files.list',
    'batches.list', 'vectorstores.list', 'skills.list', 'containers.list']);
const conversationRoles = new Set(['unknown', 'user', 'assistant', 'system', 'critic', 'discriminator', 'developer', 'tool']);
const messageStatuses = new Set(['in_progress', 'completed', 'incomplete']);
const conversationTextTypes = new Set(['text', 'input_text', 'output_text', 'summary_text', 'reasoning_text']);
const conversationImageDetails = new Set(['auto', 'low', 'high', 'original']);
const conversationFileDetails = new Set(['auto', 'low', 'high']);
const workspaceStatuses = new Set(['queued', 'in_progress', 'suspended', 'completed', 'failed']);
const moderationCategories = ['harassment', 'harassment/threatening', 'hate', 'hate/threatening', 'self-harm',
    'self-harm/instructions', 'self-harm/intent', 'sexual', 'sexual/minors', 'violence', 'violence/graphic'];
const omniModerationCategories = [...moderationCategories, 'illicit', 'illicit/violent'];
const imageOnlyModerationCategories = ['likely-csam', 'likely-csam/gen-ai'];
const imageModerationCategories = new Set(['self-harm', 'self-harm/instructions', 'self-harm/intent',
    'sexual', 'violence', 'violence/graphic', ...imageOnlyModerationCategories]);
for (const action of ['responses.delete', 'files.delete', 'containers.delete', 'containers.files.delete']) {
    operations.get(action).emptyStatus = 204;
}
operations.get('sessions.events.create').emptyStatus = 202;
operations.get('sessions.events.create').requiredArrays = ['events'];
operations.get('conversations.items.create').requiredArrays = ['items'];
for (const [action, operation] of operations) {
    const split = action.lastIndexOf('.');
    const resource = action.slice(0, split);
    const verb = action.slice(split + 1);
    if (!Object.hasOwn(identifiedResources, resource) || !['create', 'retrieve', 'update', 'delete', 'pause', 'resume'].includes(verb) ||
        action === 'conversations.items.create') continue;
    const object = identifiedResources[resource];
    const parents = verb === 'delete' ? {} : Object.fromEntries(operation.required.map(key => [key, key]));
    operation.result = {
        object: object && (verb === 'delete' ? object + '.deleted' : object),
        identity: operation.id && verb !== 'create' ? (resource === 'skills.versions' ? 'version' : 'id') : undefined,
        parents,
        deleted: verb === 'delete' && object !== undefined,
    };
}
for (const [action, field] of Object.entries({
    'automations.invocations.create': 'automation_id', 'vaults.credentials.create': 'vault_id',
    'vectorstores.files.create': 'vector_store_id', 'containers.files.create': 'container_id',
    'skills.versions.create': 'skill_id',
})) operations.get(action).result.parentArgument = field;
operations.get('vectorstores.files.create').result.parents.id = 'file_id';
operations.get('conversations.items.delete').result = { object: 'conversation', parents: { id: 'conversation_id' } };
operations.get('responses.delete').result = { identity: 'id', parents: {} };

const uploadFields = new Map([
    ['files.create', 'file'], ['audio.transcriptions.create', 'file'], ['images.edit', 'image'],
    ['skills.create', 'files'], ['skills.versions.create', 'files'],
    ['containers.files.create', 'file'], ['uploads.parts.create', 'data'],
    ['provenance.create', 'file'],
]);
const inputActions = new Set([...uploadFields.keys(), 'uploads.transfer', 'live.audio']);
const fileOutputKinds = new Set([download, render, 'voice']);
const imageActions = new Set(['images.generate', 'images.edit']);
const imageOutputFormats = { png: ['.png'], jpeg: ['.jpg', '.jpeg'], webp: ['.webp'], gif: ['.gif'], svg: ['.svg'] };
const provenanceMedia = new Map([
    ['.pdf', 'application/pdf'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
    ['.webp', 'image/webp'], ['.gif', 'image/gif'], ['.mp3', 'audio/mpeg'],
    ['.aac', 'audio/aac'], ['.pcm', 'audio/pcm'], ['.wav', 'audio/wav'], ['.ogg', 'audio/ogg'],
    ['.opus', 'audio/ogg'], ['.flac', 'audio/flac'], ['.m4a', 'audio/mp4'],
]);
const responseStreamActions = new Set([...responseCreates, ...responseRetrieves]);
const streamCapableActions = new Set([...responseStreamActions, 'sessions.create']);
const longActions = new Set(['sessions.events.stream', 'sessions.create', ...responseStreamActions, 'responses.steer',
    'batches.wait', 'images.generate', 'images.edit', 'audio.transcriptions.create', 'audio.speech.create',
    'uploads.transfer', 'live.audio']);
const speechFormats = new Set(['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm']);
const billingErrors = new Set(['insufficient_quota', 'credit_balance_exhausted', 'billing_hard_limit_reached',
    'organization_spend_limit_exceeded', 'organization_usage_limit_exceeded']);
const batchPending = new Set(['validating', 'in_progress', 'finalizing', 'cancelling']);
const batchTerminal = new Set(['completed', 'failed', 'expired', 'cancelled']);
const responseTerminal = new Set(['response.completed', 'response.failed', 'response.incomplete', 'error']);
const maxResponseBytes = 64 * 1024 * 1024;
const maxUploadBytes = 512 * 1024 * 1024;
const maxEditImageBytes = 50 * 1024 * 1024;
const maxMarkupBytes = 4 * 1024 * 1024;
const jsonMedia = /^application\/(?:json|[a-z0-9.+-]+\+json)(?:[;\s]|$)/i;
const streamMedia = /^text\/event-stream(?:[;\s]|$)/i;

const idPattern = /^[A-Za-z0-9_-]{1,256}$/;
const terminalTurnTypes = new Set([
    'agent.session.turn.completed', 'agent.session.turn.failed', 'agent.session.turn.cancelled',
]);
const lifecycleTurnTypes = new Set([...terminalTurnTypes, 'agent.session.turn.created', 'agent.session.turn.in_progress']);
const terminalSessionTypes = new Set(['agent.session.failed', 'agent.session.deleted', 'agent.session.environment.failed', 'agent.session.budget_reached', 'error']);
const knownCommands = new Set(['catalog', 'doctor', 'qualify']);
const metadataKeys = ['x-request-id', 'retry-after', 'retry-after-ms', 'x-ratelimit-limit-requests',
    'x-ratelimit-remaining-requests', 'x-ratelimit-reset-requests',
    'x-ratelimit-limit-tokens', 'x-ratelimit-remaining-tokens', 'x-ratelimit-reset-tokens',
    'x-ratelimit-limit-project-tokens', 'x-ratelimit-remaining-project-tokens', 'x-ratelimit-reset-project-tokens',
    'openai-organization', 'openai-processing-ms'];

function plainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const invocationFields = {
    action: 'string', request: 'object', id: 'string', rawRequest: 'string', inputFile: 'string',
    inputMediaType: 'string', stableInstructions: 'string', outputFile: 'string', outputDirectory: 'string', markupFile: 'string',
    eventFile: 'string', checkpointPath: 'string', projectHint: 'string', includeApiMessage: 'boolean',
    idempotencyKey: 'string', clientRequestId: 'string', stopOnTurn: 'boolean', turnId: 'string',
    pollSeconds: 'number', timeoutSeconds: 'number', verifyInputIds: 'boolean',
};

const pilotOptions = ['checkpointPath', 'projectHint', 'timeoutSeconds'];
const pilotFields = new Set(['action', 'request', 'rawRequest', ...pilotOptions]);
const steerOptions = [...pilotOptions, 'clientRequestId'];

function normalizeInvocation(invocation) {
    if (!plainObject(invocation) || typeof invocation.action !== 'string') throw Error('Expected a JSON invocation with an action.');
    for (const [key, value] of Object.entries(invocation)) {
        if (!Object.hasOwn(invocationFields, key)) throw Error('Unknown local invocation field. See the invocation envelope in catalog.');
        const type = invocationFields[key];
        if (value != null && (type === 'object' ? !plainObject(value) : typeof value !== type)) {
            throw Error(key + ' must use the invocation type ' + type + '.');
        }
        if (value && ((invocation.action === 'responses.pilot' && !pilotFields.has(key)) ||
            (invocation.action === 'responses.steer' && !pilotFields.has(key) && key !== 'clientRequestId'))) {
            throw Error(key + ' is not supported by ' + invocation.action + '. See its catalog entry.');
        }
    }
    if (invocation.verifyInputIds !== undefined && typeof invocation.verifyInputIds !== 'boolean') {
        throw Error('verifyInputIds must be a boolean.');
    }
    if (invocation.verifyInputIds && (invocation.action !== 'batches.wait' || !invocation.outputDirectory)) {
        throw Error('verifyInputIds requires batches.wait and an existing outputDirectory.');
    }
    const { action, request = {}, timeoutSeconds = action === 'responses.pilot' ? 120 : longActions.has(action) ? 600 : 60 } = invocation;
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 86400) {
        throw Error('timeoutSeconds must be an integer from 1 to 86400.');
    }
    if (invocation.pollSeconds != null && (!Number.isInteger(invocation.pollSeconds) ||
        invocation.pollSeconds < 0 || invocation.pollSeconds > 300)) throw Error('pollSeconds must be an integer from 1 to 300, or omitted.');
    if (invocation.clientRequestId != null && invocation.clientRequestId !== '' &&
        ((!responseCreates.has(action) && action !== 'responses.steer') || typeof invocation.clientRequestId !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(invocation.clientRequestId))) {
        throw Error('Invalid client request correlation ID.');
    }
    return { ...invocation, request, timeoutSeconds };
}

function requestBody({ request, rawRequest }) {
    if (rawRequest === undefined || rawRequest === null) return request;
    if (request && Object.keys(request).length) throw Error('Supply one request body using request or rawRequest.');
    return parseApiJson(rawRequest);
}

function resolveOperation(client, { sdkPath, method }) {
    const resource = sdkPath.split('.').reduce((parent, key) => parent?.[key], client);
    if (typeof resource?.[method] !== 'function') throw Error('Installed SDK does not expose ' + sdkPath + '.' + method);
    return resource[method].bind(resource);
}

function parseInvocation(invocation) {
    const { action, id, request, inputFile, markupFile, outputFile, outputDirectory, eventFile, inputMediaType, stableInstructions,
        pollSeconds, idempotencyKey, stopOnTurn, turnId } = invocation;
    const operation = operations.get(action);
    if (!operation) throw Error('Unknown action. Use catalog for the local operation list.');
    if (operation.id ? !identifier(id) : id != null && id !== '') throw Error('Invalid or missing -Id for ' + action);
    if (!plainObject(request) || (!operation.params && Object.keys(request).length)) {
        throw Error('This action needs a JSON object of the documented parameters, or no parameters.');
    }
    for (const name of operation.required) {
        if (typeof request[name] !== 'string' || !idPattern.test(request[name])) throw Error('A valid ' + name + ' is required.');
    }
    for (const name of operation.requiredArrays ?? []) {
        if (!Array.isArray(request[name])) throw Error('Supply an array for ' + name + '.');
    }
    if (action === 'conversations.items.create' && request.items.length > 20) throw Error('Supply up to 20 conversation items.');
    if (action === 'containers.files.create') {
        const hasFileId = Object.hasOwn(request, 'file_id');
        if ((hasFileId && !identifier(request.file_id)) || Boolean(inputFile) === hasFileId) {
            throw Error('Supply exactly one of -InputFile or a valid file_id for attaching to the container.');
        }
    } else if (Boolean(inputFile) !== inputActions.has(action)) {
        throw Error('Supply -InputFile exactly for the upload actions shown in catalog.');
    }
    if (inputMediaType && (!inputFile || !['provenance.create', 'containers.files.create', 'images.edit'].includes(action)
        || !/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i.test(inputMediaType))) {
        throw Error('A valid -InputMediaType applies only to selected file operations.');
    }
    if (!imageActions.has(action) && Boolean(outputFile) !== fileOutputKinds.has(operation.kind)) throw Error('An explicit new -OutputFile is required only for file outputs.');
    if ((outputDirectory || pollSeconds) && operation.kind !== 'wait') throw Error('Batch wait options require batches.wait.');
    if (idempotencyKey && (action !== 'sessions.events.create' || !idPattern.test(idempotencyKey))) {
        throw Error('-IdempotencyKey applies only to sessions.events.create and needs an ASCII identifier.');
    }
    if (action === 'sessions.events.create' && Object.hasOwn(request, 'Idempotency-Key')) {
        throw Error('Pass the idempotency key through -IdempotencyKey.');
    }
    const responseStream = responseStreamActions.has(action);
    const streamCapable = streamCapableActions.has(action);
    const streaming = operation.kind === watch || (streamCapable && request.stream === true);
    if (Object.hasOwn(request, 'stream') && (!streamCapable || typeof request.stream !== 'boolean')) {
        throw Error('Use a boolean stream option only with a supported streaming action.');
    }
    if (eventFile && !streaming) throw Error('-EventFile requires a streaming action.');
    if ((stopOnTurn || turnId) && (!streaming || responseStream)) throw Error('Turn stopping options apply only to Agents API event streams.');
    if (turnId && (!stopOnTurn || !idPattern.test(turnId))) throw Error('-TurnId requires -StopOnTurn and a valid turn ID.');
    const params = { ...request };
    if (action === 'environments.files.list' && params.path != null &&
        (typeof params.path !== 'string' || !params.path.startsWith('/') || params.path.includes('\0'))) {
        throw Error('Expected an absolute workspace directory for the file listing.');
    }
    if (stableInstructions) {
        if ((!responseCreates.has(action) && action !== 'responses.inputtokens') ||
            !(typeof params.input === 'string' || Array.isArray(params.input))) {
            throw Error('Stable instructions require Responses create or input token count with string or array input.');
        }
        if (params.previous_response_id != null || params.conversation != null) {
            throw Error('Use the stable prefix on the original or full-input request. Continue a stored context without prepending it again.');
        }
        const items = typeof params.input === 'string' ? [{ role: 'user', content: params.input }] : params.input;
        params.input = items[0]?.role === 'developer' && items[0].content === stableInstructions
            ? items : [{ role: 'developer', content: stableInstructions }, ...items];
    }
    if (responseCreates.has(action) && params.background !== true && params.store == null) params.store = false;
    if (action.startsWith('responses.multiagent.')) {
        if (Object.hasOwn(params, 'betas') || Object.hasOwn(params, 'access_programs')) {
            throw Error('Use the dedicated Multi-agent beta route without beta-header or access-program overrides.');
        }
        if (responseCreates.has(action)) {
            const config = params.multi_agent;
            if (config !== undefined && (!plainObject(config) || (config.enabled !== undefined && config.enabled !== true) ||
                (config.max_concurrent_subagents !== undefined &&
                    (!Number.isSafeInteger(config.max_concurrent_subagents) || config.max_concurrent_subagents < 1)))) {
                throw Error('Multi-agent concurrency, when supplied, must be a positive integer.');
            }
            params.multi_agent = { ...config, enabled: true };
        }
        params.betas = ['responses_multi_agent=v1'];
    }
    const cacheBaseline = params.prompt_cache_options?.comparison_response_id;
    if (responseCreates.has(action) && cacheBaseline != null &&
        (typeof cacheBaseline !== 'string' || !/^resp_[A-Za-z0-9_-]{1,251}$/.test(cacheBaseline))) {
        throw Error('Prompt-cache diagnostics require a valid baseline response ID.');
    }
    if (adminActions.has(action)) {
        if (!Number.isSafeInteger(params.start_time) || params.start_time < 0 ||
            (params.end_time !== undefined && (!Number.isSafeInteger(params.end_time) || params.end_time <= params.start_time)) ||
            (params.limit !== undefined && (!Number.isSafeInteger(params.limit) || params.limit < 1)) ||
            (params.page !== undefined && (typeof params.page !== 'string' || !params.page.trim()))) {
            throw Error('Supply a start time in Unix seconds and a valid optional end time, page cursor, and positive limit.');
        }
    }
    if (['sessions.create', 'sessions.update'].includes(action) && Object.hasOwn(params, 'spend_control') &&
        params.spend_control !== null) {
        const control = params.spend_control;
        if (!plainObject(control) || Object.keys(control).length !== 1 || !Object.hasOwn(control, 'limit') ||
            (control.limit !== null && (!Number.isSafeInteger(control.limit) || control.limit < 1))) {
            throw Error('spend_control.limit must be positive whole USD cents, or null to set an unlimited session.');
        }
    }
    if (markupFile && action !== 'images.edit') throw Error('MarkupFile is for images.edit only.');
    if (imageActions.has(action)) {
        if (params.n != null && (!Number.isSafeInteger(params.n) || params.n < 1)) {
            throw Error('Image result count must be a positive integer.');
        }
        if (outputFile && ((params.n != null && params.n !== 1) ||
            (params.response_format != null && params.response_format !== 'b64_json') ||
            !Object.hasOwn(imageOutputFormats, params.output_format) ||
            !imageOutputFormats[params.output_format].includes(path.extname(outputFile).toLowerCase()))) {
            throw Error('Image OutputFile requires a matching extension, explicit output_format and one base64 result.');
        }
        if ((params.output_format === 'gif' && (params.mask != null || params.output_compression != null || params.partial_images != null)) ||
            ((params.frame_count != null || params.frame_duration_ms != null) && params.output_format !== 'gif') ||
            (params.frame_count != null && (!Number.isInteger(params.frame_count) || params.frame_count < 2 || params.frame_count > 16)) ||
            (params.frame_duration_ms != null && (!Number.isSafeInteger(params.frame_duration_ms) || params.frame_duration_ms < 1))) {
            throw Error('GIF uses 2–16 frames and optional positive frame duration, without partial images, masks or compression.');
        }
        if (action === 'images.edit' && (params.markup != null || params.mask != null)) {
            throw Error('Use MarkupFile for a local overlay, or the native CLI image edit route for masks.');
        }
    }
    if (action === 'live.create' && (params.transport?.type !== 'webrtc' ||
        typeof params.transport.sdp !== 'string' || !params.transport.sdp.trim())) {
        throw Error('Use live.create with an explicit WebRTC SDP offer.');
    }
    if (params.session?.wake_policy != null || params.session?.idle_timeout_s != null) {
        if (action === 'live.audio') throw Error('Standby options require live.create with WebRTC.');
        if (action === 'live.create' && (params.session.wake_policy?.type !== 'speech' ||
            (params.session.idle_timeout_s != null && (!Number.isInteger(params.session.idle_timeout_s) ||
                params.session.idle_timeout_s < 5 || params.session.idle_timeout_s > 60)))) {
            throw Error('WebRTC standby uses wake_policy.type=speech and optional idle_timeout_s=5..60.');
        }
    }
    if (action === 'audio.transcriptions.create' && params.response_format && params.response_format !== 'json' &&
        params.response_format !== 'verbose_json' && params.response_format !== 'diarized_json') {
        throw Error('This operation returns a JSON transcript. Use native CLI for other transcript formats.');
    }
    if (action === 'audio.speech.create' &&
        ((params.response_format !== undefined && !speechFormats.has(params.response_format)) ||
        (params.stream_format !== undefined && !['audio', 'sse'].includes(params.stream_format)))) {
        throw Error('Use a documented speech response_format and stream_format.');
    }
    if (action === 'embeddings.create' &&
        ((params.dimensions != null && (!Number.isSafeInteger(params.dimensions) || params.dimensions < 1)) ||
            (params.encoding_format != null && !['float', 'base64'].includes(params.encoding_format)))) {
        throw Error('Use positive integer embedding dimensions and a supported encoding.');
    }
    if (action === 'decisions.create' &&
        (!Array.isArray(params.questions) || params.questions.length === 0 ||
            !params.questions.every(question => plainObject(question) && ['choice', 'predicate', 'score'].includes(question.type)))) {
        throw Error('Supply Decisions questions with type choice, predicate, or score.');
    }
    const daybreak = prepareDaybreak(action, params);
    return { operation, streaming, responseStream, params, daybreak };
}

function headersOf(headers) {
    const result = {};
    for (const key of metadataKeys) {
        const value = headers?.get?.(key);
        if (typeof value === 'string' && (/^[A-Za-z0-9._ :+/-]{1,200}$/.test(value) ||
            (key === 'retry-after' && /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)
                && Number.isFinite(Date.parse(value))))) result[key] = value;
    }
    return result;
}

function identifier(value) {
    return typeof value === 'string' && idPattern.test(value) ? value : undefined;
}

function safeToken(value) {
    return typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,120}$/.test(value) ? value : undefined;
}

function errorDetails(error) {
    const message = [error?.message, error?.error?.message].filter(value => typeof value === 'string').join(' ');
    const missingScopes = [...new Set(message.match(/\bapi\.[a-z_]+\.(?:read|write)\b/g) ?? [])];
    return {
        category: safeToken(error?.name) ?? 'UnknownError',
        ...(Number.isInteger(error?.status) ? { httpStatus: error.status } : {}),
        apiCode: safeToken(error?.code), apiType: safeToken(error?.type),
        parameter: safeToken(error?.param),
        ...(missingScopes.length ? { mentionedScopes: missingScopes } : {}),
        headers: headersOf(error?.headers),
    };
}

function apiMessage(error, credential) {
    const message = error?.error?.message;
    if (!Number.isInteger(error?.status) || typeof message !== 'string') return undefined;
    const safeMessage = credential ? message.replaceAll(credential, '[redacted]') : message;
    return safeMessage.replace(/\b(?:sk|rk)-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
        .replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 1200);
}

async function requireAvailable(destination) {
    try {
        await lstat(destination);
    } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
    }
    throw Error('Destination already exists.');
}

const outputConflict = () => Object.assign(Error('A destination already exists or aliases another output path.'),
    { code: 'output_paths_conflict' });

async function discardReservation(entry) {
    const original = entry.identity ??= await entry.file.stat({ bigint: true });
    await entry.file.close();
    const current = await lstat(entry.target, { bigint: true });
    if (!original.ino || original.ino !== current.ino || original.dev !== current.dev || current.size !== 0n) {
        throw Error('Could not confirm ownership of the empty output reservation.');
    }
    await unlink(entry.target);
    entry.removed = true;
}

async function preflightLocalOutputs(checkpointPath, eventFile, artifacts, warnings) {
    const reserved = [];
    try {
        for (const requested of [checkpointPath, eventFile]) {
            requireOrdinaryWindowsPath(requested);
            const target = requested;
            if (!target) { reserved.push(null); continue; }
            const file = await open(target, 'wx', 0o600);
            reserved.push({ target, file });
        }
        const parents = new Set(), destinations = new Set();
        for (const target of artifacts.filter(Boolean)) {
            requireOrdinaryWindowsPath(target);
            // Preserve native path resolution for the parent, including symlink/.. on POSIX.
            const parent = await realpath(path.dirname(target));
            const identity = path.join(parent, path.basename(target));
            if (destinations.has(identity)) throw outputConflict();
            destinations.add(identity);
            try {
                await lstat(target);
                throw outputConflict();
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
            // The sole multi-artifact route supplies distinct fixed filenames.
            parents.add(parent);
        }
        for (const parent of parents) {
            const probe = path.join(parent, '.legatus-probe-' + randomUUID());
            const file = await open(probe, 'wx', 0o600);
            const entry = { target: probe, file };
            try {
                await discardReservation(entry);
            } catch (error) {
                await file.close().catch(() => {});
                warnings.push({ resource: 'local-output', phase: 'probe-cleanup', probeName: path.basename(probe), ...errorDetails(error) });
                throw error;
            }
        }
        return [reserved[0]?.file, reserved[1]?.file];
    } catch (error) {
        for (const entry of reserved.filter(entry => entry && !entry.removed)) {
            try { await discardReservation(entry); }
            catch (cleanup) {
                await entry.file.close().catch(() => {});
                if (cleanup.code !== 'ENOENT') warnings.push({ resource: 'local-output', phase: 'rollback', ...errorDetails(cleanup) });
            }
        }
        if (error.code === 'EEXIST') throw outputConflict();
        throw error;
    }
}

function speechOutput(response, params) {
    const media = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (params.stream_format === 'sse') {
        if (media !== 'text/event-stream') throw Error('Expected an SSE speech event stream.');
        return { kind: 'speech-events', format: 'sse' };
    }
    if (media && !media.startsWith('audio/') && media !== 'application/octet-stream' &&
        !(params.response_format === 'opus' && media === 'application/ogg')) {
        throw Error('Expected audio bytes for the requested speech format.');
    }
    return { kind: 'speech-audio', format: params.response_format ?? 'mp3' };
}

async function saveDownload(response, destination, signal, speech) {
    if (!response.body) throw Error('API returned no downloadable body.');
    if (response.status === 206 || response.headers.has('content-range')) throw Error('API returned only part of the requested file.');
    const parent = await realpath(path.dirname(destination));
    const temporary = path.join(parent, '.legatus-part-' + randomUUID());
    const file = await open(temporary, speech ? 'wx+' : 'wx', 0o600);
    const checksum = createHash('sha256');
    let bytes = 0, media;
    try {
        try {
            for await (const chunk of Readable.fromWeb(response.body, { signal })) {
                bytes += chunk.length;
                if (bytes > maxDownloadBytes) throw Error('File exceeded the 1 GiB local download budget.');
                checksum.update(chunk);
                await file.writeFile(chunk);
            }
            const declaredLength = response.headers.get('content-length');
            if (!response.headers.has('content-encoding') && /^\d+$/.test(declaredLength ?? '') &&
                bytes !== Number(declaredLength)) throw Error('Downloaded file length does not match the HTTP response.');
            if (speech) media = { ...speech, ...await verifySpeech(file, speech.format, bytes, signal) };
            await file.sync();
        } finally {
            await file.close();
        }
        const sha256 = checksum.digest('hex');
        const publication = await publishFile(temporary, destination, { expectedBytes: bytes, expectedSha256: sha256, signal });
        return { path: destination, bytes, sha256, publication, ...(media ? { media } : {}) };
    } finally {
        await unlink(temporary).catch(() => {});
    }
}

async function saveImage(result, format, destination, signal, SaxesParser) {
    const encoded = result.data.length === 1 && result.data[0].b64_json;
    if (!base64Length(encoded) ||
        (result.output_format != null && result.output_format !== format)) {
        throw Error('Expected one base64 image in the selected format.');
    }
    const bytes = Buffer.from(encoded, 'base64');
    const details = verifyImageStructure(bytes, format, SaxesParser);
    return { ...await saveDownload(new Response(bytes), destination, signal),
        format, validation: format === 'svg' ? 'well-formed-svg-xml' : 'raster-container-structure', ...details };
}

async function readJsonResponse(response, allowEmpty = false) {
    if (!response.body && allowEmpty) return null;
    const json = jsonMedia.test(response.headers.get('content-type') ?? '');
    if (!response.body || (!json && !allowEmpty)) {
        throw Error('Expected an API JSON response.');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of Readable.fromWeb(response.body)) {
        if (chunk.length && !json) throw Error('Expected an empty acknowledgement or API JSON.');
        size += chunk.length;
        if (size > maxResponseBytes) throw Error('API JSON exceeded the 64 MiB local output budget.');
        chunks.push(chunk);
    }
    if (!size && allowEmpty) return null;
    if (!size) throw Error('Expected a nonempty API JSON response.');
    const data = parseApiJson(Buffer.concat(chunks, size), { preserveNumbers: true });
    if (data === null) throw Error('Expected API response data.');
    return data;
}

// The polling GET owns retries here. Creation, recovery and SDK retries stay separate.
async function readBatchWithBackoff(client,id,options,record,observeDispatch,observeHttp) {
    for (let attempt=0;;attempt++) {
        observeDispatch('attempted');
        try {
            const response = await client.batches.retrieve(id,options).asResponse();
            observeDispatch('response-received');
            observeHttp({ httpStatus: response.status, headers: headersOf(response.headers) }, 'response-observation');
            return response;
        }
        catch (error) {
            const details = errorDetails(error);
            const {httpStatus,apiCode,apiType,headers}=details;
            let observedAt;
            if (httpStatus) {
                observeDispatch('response-received');
                observedAt = observeHttp(details, 'failure-observation');
            }
            const billing = billingErrors.has(apiCode) || billingErrors.has(apiType);
            const throttle = httpStatus === 429 && (apiCode === 'rate_limit_exceeded' ||
                ['rate_limit_exceeded', 'rate_limit_error'].includes(apiType));
            if (billing || options.signal.aborted || attempt>=2 || !(throttle || [408,425,500,502,503,504].includes(httpStatus))) throw error;
            const after=headers['retry-after'];
            const millis=headers['retry-after-ms'];
            const suggested=millis && /^\d+$/.test(millis) ? Number(millis) :
                after && /^\d+$/.test(after) ? Number(after)*1000 : Date.parse(after)-Date.now();
            if (suggested===Infinity) throw error;
            const minimum=Number.isFinite(suggested) ? Math.max(0,suggested) : 0;
            if (minimum>=2_147_480_000) throw error;
            const waitMs=Math.max(minimum,250*2**attempt)+randomInt(0,151);
            await record('batch_read_backoff',{httpStatus,apiCode,headers,waitMs,
                headerObservedAt:observedAt,headerScope:'retry-observation'});
            await delay(waitMs,undefined,{signal:options.signal});
        }
    }
}

function batchDestinations(outputDirectory) {
    return ['output', 'error'].map(name => ({
        name, path: outputDirectory && outputDirectory + path.sep + name + '.jsonl',
    }));
}

async function waitForBatch(client, invocation, options, receipt, record, observeDispatch, warnings) {
    const { id, outputDirectory } = invocation;
    const destinations = batchDestinations(outputDirectory);
    if (outputDirectory) for (const file of destinations) await requireAvailable(file.path);
    let batch;
    for (;;) {
        const response = await readBatchWithBackoff(client,id,options,record, state => {
            observeDispatch(state);
            if (state === 'attempted') {
                for (const key of ['httpStatus', 'headers', 'headerObservedAt', 'headerScope', 'batchReadError']) delete receipt[key];
            }
        }, (details, headerScope) => {
            const { httpStatus, headers, apiCode, apiType } = details;
            Object.assign(receipt, { httpStatus, headers, headerScope, headerObservedAt: new Date().toISOString() });
            if (headerScope === 'failure-observation') receipt.batchReadError = { apiCode, apiType };
            return receipt.headerObservedAt;
        });
        batch = await readJsonResponse(response);
        if (batch?.id !== id || batch.object !== 'batch' || !safeToken(batch.status)) {
            throw Error('Expected the requested Batch object and its status.');
        }
        for (const key of ['resourceStatus', 'observedResourceStatus', 'resourceStatusClassification']) delete receipt[key];
        Object.assign(receipt, safeState(batch));
        await record('batch_observed', { outputFileId: identifier(batch.output_file_id),
            errorFileId: identifier(batch.error_file_id) });
        if (!batchPending.has(batch.status)) break;
        await delay((invocation.pollSeconds || 10) * 1000, undefined, { signal: options.signal });
    }
    const files = [];
    if (!batchTerminal.has(batch.status)) return { batch, files, artifactsCollected: outputDirectory ? false : null, outcome: 'unconfirmed' };
    for (const file of destinations) {
        const suppliedId = batch[file.name + '_file_id'];
        if (!file.path || suppliedId == null) continue;
        const fileId = identifier(suppliedId);
        if (!fileId || !/^file[-_][A-Za-z0-9_-]+$/.test(fileId)) {
            files.push({ type: file.name, error: { category: 'invalid_batch_file_id' } });
            continue;
        }
        let descriptor;
        try {
            const response = await client.files.content(fileId, options).asResponse();
            const saved = await saveDownload(response, file.path, options.signal);
            descriptor = { ...saved, type: file.name, fileId, headers: headersOf(response.headers) };
            if (file.name === 'output' && batch.request_counts?.completed > 0 && saved.bytes === 0) {
                descriptor.error = { category: 'empty_output_for_completed_requests' };
            }
        } catch (error) {
            descriptor = { type: file.name, fileId, error: errorDetails(error),
                ...(error.publication ? { publication: error.publication } : {}) };
        }
        files.push(descriptor);
        if (!descriptor.error) {
            try { await record('downloaded', { fileId, fileType: file.name, bytes: descriptor.bytes }); }
            catch (error) { descriptor.checkpointError = errorDetails(error); }
        }
    }
    const counts = batch.request_counts;
    let artifactVerification = { state: 'not-requested' };
    if (outputDirectory && invocation.verifyInputIds) {
        const inputId = batch.input_file_id;
        let staging;
        let inputPath;
        try {
            if (typeof inputId !== 'string' || !/^file[-_][A-Za-z0-9_-]+$/.test(inputId)) throw Error('Missing input identity.');
            try {
                staging = await mkdtemp(path.join(await realpath(outputDirectory), '.legatus-batch-input-'));
            } catch (error) {
                if (!['EACCES', 'EPERM'].includes(error.code)) throw error;
                staging = await mkdtemp(path.join(tmpdir(), '.legatus-batch-input-'));
            }
            inputPath = path.join(staging, 'input.jsonl');
            const response = await client.files.content(inputId, options).asResponse();
            const input = await saveDownload(response, inputPath, options.signal);
            artifactVerification = await verifyBatchArtifacts(batch, files, options.signal, { ...input, fileId: inputId });
        } catch (error) {
            artifactVerification = { state: options.signal.aborted ? 'deadline' : 'input-unavailable', inputIdsCompared: false,
                inputError: { fileId: identifier(inputId), ...errorDetails(error) } };
        } finally {
            for (const [phase, target, remove] of [['unlink', inputPath, unlink], ['rmdir', staging, rmdir]]) {
                if (!target) continue;
                try { await remove(target); }
                catch (error) {
                    if (error.code !== 'ENOENT') warnings.push({ resource: 'batch-input-staging', phase, ...errorDetails(error), code: safeToken(error.code) });
                }
            }
        }
    } else if (outputDirectory) {
        artifactVerification = await verifyBatchArtifacts(batch, files, options.signal);
    }
    const verified = ['counts-verified', 'input-ids-verified'].includes(artifactVerification.state);
    const clean = batch.status === 'completed' && Number.isSafeInteger(counts?.total) && counts.total > 0 &&
        counts.completed === counts.total && counts.failed === 0 &&
        (!outputDirectory || verified);
    const artifactsCollected = outputDirectory ? files.length > 0 && !files.some(file => file.error) &&
        (verified || (batch.status !== 'completed' &&
            artifactVerification.state === 'counts-unconfirmed' && !(counts?.completed > 0 &&
                !files.some(file => file.type === 'output')))) : null;
    return { batch, files, artifactsCollected, artifactVerification, outcome: clean ? 'completed' : 'review-required' };
}

function safeState(data) {
    const recognized = data?.object === 'response' ? responseStatuses.has(data.status) :
        data?.object === 'batch' ? batchPending.has(data.status) || batchTerminal.has(data.status) : true;
    if (!recognized && safeToken(data.status)) {
        return { resourceId: identifier(data.id), observedResourceStatus: data.status, resourceStatusClassification: 'unknown' };
    }
    return { resourceId: identifier(data?.id), resourceStatus: safeToken(data?.status) };
}
const responseStatuses = new Set(['completed', 'failed', 'in_progress', 'cancelled', 'queued', 'incomplete']);

function tokenPagination(hasMore, token, requestedToken) {
    if (!hasMore) return { state: 'complete', hasMore: false };
    if (typeof token !== 'string' || !token.trim()) return { state: 'cursor-unavailable', hasMore: true };
    if (token === requestedToken) return { state: 'cursor-stalled', hasMore: true };
    return { state: 'next-page-available', hasMore: true, nextPage: token };
}

function absoluteWorkspacePath(value) {
    return typeof value === 'string' && value.startsWith('/') && !value.includes('\0') &&
        !value.split('/').some(part => part === '.' || part === '..');
}

function verifyAnchors(page, params) {
    const ids = page.data.map(item => item.id);
    const known = ids.filter(identifier);
    const unique = new Set(known);
    if (unique.size !== known.length || [params.after, params.before].some(anchor => unique.has(anchor)) ||
        [['first_id', ids[0]], ['last_id', ids.at(-1)]].some(([field, expected]) =>
            page[field] != null && (!identifier(page[field]) || page[field] !== expected))) {
        throw Error('API page contains a conflicting resource ID or cursor.');
    }
    if (page.has_more !== undefined) return tokenPagination(page.has_more, identifier(ids.at(-1)), params.after);
}

const base64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function base64Length(value) {
    if (typeof value !== 'string' || !value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) ||
        (value.endsWith('=') && value.length % 4 !== 0)) return 0;
    const length = value.length - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0);
    const extra = length % 4;
    const last = base64Alphabet.indexOf(value[length - 1]);
    if (last < 0 || extra === 1 || (extra === 2 && (last & 15)) || (extra === 3 && (last & 3))) return 0;
    return Math.floor(length * 3 / 4);
}

function embeddingLength(value, encoding) {
    if (Array.isArray(value)) return encoding !== 'base64' && value.length && value.every(Number.isFinite) ? value.length : 0;
    if (encoding === 'float') return 0;
    const length = base64Length(value);
    if (!length || length % 4 !== 0) return 0;
    const bytes = Buffer.from(value, 'base64');
    for (let at = 0; at < bytes.length; at += 4) if (!Number.isFinite(bytes.readFloatLE(at))) return 0;
    return bytes.length / 4;
}

const probability = value => Number.isFinite(value) && value >= 0 && value <= 1;
const duration = value => Number.isFinite(value) && value >= 0;
const interval = value => plainObject(value) && duration(value.start) && duration(value.end) && value.end >= value.start;

function verifyDistribution(entries, expected, sameLabel) {
    if (!Array.isArray(entries) || entries.length !== expected.length) return false;
    const values = new Set(expected);
    let total = 0;
    for (const entry of entries) {
        if (!plainObject(entry) || !values.delete(entry.value) || !probability(entry.probability) || !sameLabel(entry)) return false;
        total += entry.probability;
    }
    return Math.abs(total - 1) <= entries.length * 1e-5;
}

function validImageResult(image, requestedFormat) {
    if (!plainObject(image)) return false;
    const useUrl = image.url != null, useBytes = image.b64_json != null;
    if (useUrl === useBytes || (requestedFormat === 'url' && !useUrl) || (requestedFormat === 'b64_json' && !useBytes)) return false;
    if (useBytes) return base64Length(image.b64_json) > 0;
    return typeof image.url === 'string' && URL.canParse(image.url) && ['https:', 'http:'].includes(new URL(image.url).protocol);
}

function conversationContent(part, functionOutput = false) {
    if (!plainObject(part)) return false;
    const { type, detail, file_id: fileId } = part;
    if (type === 'input_file') return (fileId == null || Boolean(identifier(fileId))) &&
        (detail === undefined || conversationFileDetails.has(detail)) &&
        ['file_data', 'file_url', 'filename'].every(field => part[field] === undefined ||
            (typeof part[field] === 'string' && part[field].trim().length > 0)) &&
        (part.file_url === undefined || URL.canParse(part.file_url)) &&
        Boolean(fileId || part.file_data || part.file_url);
    if (type === 'input_image' || (!functionOutput && type === 'computer_screenshot')) {
        const imageUrl = part.image_url;
        return (fileId == null || Boolean(identifier(fileId))) &&
            (imageUrl == null || (typeof imageUrl === 'string' && URL.canParse(imageUrl))) &&
            (detail === undefined || conversationImageDetails.has(detail)) && Boolean(fileId || imageUrl);
    }
    if (type === 'refusal') return !functionOutput && typeof part.refusal === 'string';
    return (functionOutput ? type === 'input_text' : conversationTextTypes.has(type)) && typeof part.text === 'string';
}

function validConversationItem(item, parent) {
    if (!plainObject(item) || !safeToken(item.type) || (item.id != null && !identifier(item.id)) ||
        (item.conversation_id != null && item.conversation_id !== parent)) return false;
    if (item.type === 'message') {
        return Boolean(identifier(item.id) && conversationRoles.has(item.role) && messageStatuses.has(item.status) &&
            (item.phase == null || ['commentary', 'final_answer'].includes(item.phase)) &&
            Array.isArray(item.content) && item.content.every(part => conversationContent(part)));
    }
    if (item.type === 'function_call') {
        return Boolean(identifier(item.id) && identifier(item.call_id) && identifier(item.name) &&
            messageStatuses.has(item.status) && typeof item.arguments === 'string');
    }
    if (item.type === 'function_call_output') {
        return Boolean(identifier(item.id) && (item.call_id === undefined || identifier(item.call_id)) &&
            messageStatuses.has(item.status) && (typeof item.output === 'string' ||
                (Array.isArray(item.output) && item.output.every(part => conversationContent(part, true)))));
    }
    return true;
}

function isConversationText(part) {
    return typeof part?.text === 'string' && (part.type == null || conversationTextTypes.has(part.type));
}

function conversationText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content) && content.every(isConversationText)) return content.map(part => part.text).join('');
}

function attachmentSources(part) {
    const sources = new Map();
    if (identifier(part.file_id)) sources.set('file_id', part.file_id);
    for (const key of ['file_data', 'file_url', 'image_url']) {
        const value = part[key];
        if (typeof value !== 'string') continue;
        const comma = value.indexOf(',');
        const dataUrl = /^data:/i.test(value);
        if (key === 'file_data' || dataUrl) {
            const payload = dataUrl && comma >= 0 && /;base64$/i.test(value.slice(0, comma)) ? value.slice(comma + 1) : value;
            if (base64Length(payload)) {
                const canonical = payload.replace(/=+$/, '');
                if (sources.has('inline') && sources.get('inline') !== canonical) return null;
                sources.set('inline', canonical);
            } else sources.set('unverified-' + key, value);
        } else if (URL.canParse(value)) sources.set(key, new URL(value).href);
    }
    return sources;
}

function compareAttachment(input, output) {
    const sent = attachmentSources(input), received = attachmentSources(output);
    if (!sent || !received) return 'mismatch';
    let shared = false;
    for (const [key, value] of sent) {
        if (!received.has(key)) continue;
        if (received.get(key) !== value) return 'mismatch';
        if (!key.startsWith('unverified-')) shared = true;
    }
    return shared ? 'verified' : 'partial';
}

function compareConversationContent(input, output) {
    const text = conversationText(input);
    if (text !== undefined) return text === conversationText(output) ? 'verified' : 'mismatch';
    if (!Array.isArray(input) || !Array.isArray(output) || input.length !== output.length) return 'mismatch';
    let verification = 'verified';
    for (const [index, part] of input.entries()) {
        const received = output[index];
        if (!plainObject(part) || !plainObject(received)) return 'mismatch';
        if (isConversationText(part)) {
            if (part.text !== received.text) return 'mismatch';
        } else {
            if (part.type !== received.type) return 'mismatch';
            if (part.type === 'refusal') {
                if (part.refusal !== received.refusal) return 'mismatch';
            } else {
                const match = compareAttachment(part, received);
                if (match === 'mismatch') return match;
                if (match === 'partial') verification = match;
            }
        }
    }
    return verification;
}

function compareConversationInput(input, output) {
    if (!plainObject(input)) return 'mismatch';
    if (input.type === 'item_reference' || (input.type == null && input.role == null && input.id != null)) {
        return identifier(input.id) && input.id === output.id ? 'verified' : 'mismatch';
    }
    const type = input.type ?? (typeof input.role === 'string' ? 'message' : undefined);
    if (type !== output.type || (input.id != null && input.id !== output.id)) return 'mismatch';
    if (type === 'message') {
        if (input.role !== output.role || (input.phase != null && output.phase != null && output.phase !== input.phase)) {
            return 'mismatch';
        }
        const content = compareConversationContent(input.content, output.content);
        return content === 'verified' && input.phase != null && output.phase == null ? 'partial' : content;
    }
    if (input.call_id != null && input.call_id !== output.call_id) return 'mismatch';
    if (['function_call', 'function_call_output'].includes(type) && ['name', 'namespace'].some(field =>
        input[field] != null && output[field] != null && input[field] !== output[field])) return 'mismatch';
    if (type === 'function_call') return compareJsonArguments(input.arguments, output.arguments);
    if (type === 'function_call_output') return compareConversationContent(input.output, output.output);
    return 'partial';
}

function describeConversationVerification(receipt, items, partial = false) {
    const uncheckedTypes = [...new Set(items.map(item => item.type))].filter(
        type => !['message', 'function_call', 'function_call_output'].includes(type));
    const outputsWithoutCallId = items.filter(item => item.type === 'function_call_output' && item.call_id === undefined).length;
    const uncheckedArguments = items.filter(item => item.type === 'function_call' &&
        compareJsonArguments(item.arguments, item.arguments) === 'partial').length;
    let uncheckedAttachments = 0;
    for (const item of items) {
        const content = item.type === 'message' ? item.content : item.type === 'function_call_output' ? item.output : undefined;
        if (!Array.isArray(content)) continue;
        for (const part of content) {
            if (!['input_file', 'input_image', 'computer_screenshot'].includes(part.type)) continue;
            const sources = attachmentSources(part);
            if (!sources || [...sources.keys()].some(key => key.startsWith('unverified-'))) uncheckedAttachments++;
        }
    }
    receipt.conversationItems = { verification: partial || uncheckedTypes.length || outputsWithoutCallId || uncheckedArguments ||
        uncheckedAttachments ? 'partial' : 'verified',
        ...(partial ? { correlation: 'partial' } : {}), ...(uncheckedArguments ? { uncheckedArguments } : {}),
        ...(uncheckedAttachments ? { uncheckedAttachments } : {}),
        ...(uncheckedTypes.length ? { uncheckedTypes } : {}), ...(outputsWithoutCallId ? { outputsWithoutCallId } : {}) };
}

function moderationProfile(model) {
    return model?.startsWith('text-moderation-') ? 'legacy' :
        model?.startsWith('omni-moderation-csam-') ? 'image-only' :
        model?.startsWith('omni-moderation-') ? 'omni' : undefined;
}

function moderationIssue(result, params) {
    const count = Array.isArray(params.input) && params.input.every(value => typeof value === 'string') ? params.input.length : 1;
    if (!identifier(result?.id) || !safeToken(result.model) || !Array.isArray(result.results) ||
        !count || result.results.length !== count) return 'result-envelope-or-count';
    const expectedProfile = moderationProfile(safeToken(params.model));
    const observedProfile = moderationProfile(result.model);
    if (expectedProfile && expectedProfile !== observedProfile) return 'model-profile-mismatch';
    const legacy = observedProfile === 'legacy';
    const imageOnly = observedProfile === 'image-only';
    const categoriesRequired = legacy ? moderationCategories : imageOnly ? imageOnlyModerationCategories : omniModerationCategories;
    const inputModes = Array.isArray(params.input) && params.input.every(value => typeof value !== 'string')
        ? new Set(params.input.map(value => value?.type === 'image_url' ? 'image' : value?.type === 'text' ? 'text' : undefined))
        : new Set(['text']);
    for (const entry of result.results) {
        if (!plainObject(entry)) return 'result-item';
        const { categories, category_scores: scores, category_applied_input_types: modalities, flagged } = entry;
        if (typeof flagged !== 'boolean' || !plainObject(categories) || !plainObject(scores) ||
            (!legacy || modalities !== undefined) && !plainObject(modalities)) return 'category-maps';
        const keys = Object.keys(categories);
        if (categoriesRequired.some(key => !Object.hasOwn(categories, key)) ||
            keys.length !== Object.keys(scores).length || (modalities && keys.length !== Object.keys(modalities).length)) {
            return 'category-coverage';
        }
        let anyFlagged = false;
        for (const key of keys) {
            const value = categories[key];
            if (typeof value !== 'boolean' && !(value === null && ['illicit', 'illicit/violent'].includes(key))) return 'category-value';
            anyFlagged ||= value === true;
            if (!Object.hasOwn(scores, key) || !probability(scores[key])) return 'category-score';
            if (modalities) {
                const types = modalities[key];
                if (!Array.isArray(types) || new Set(types).size !== types.length ||
                    types.some(type => type !== 'text' && type !== 'image' || (imageOnly && type !== 'image') ||
                        (type === 'image' && (legacy || categoriesRequired.includes(key) && !imageModerationCategories.has(key))))) {
                    return 'category-modality';
                }
                if (types.some(type => !inputModes.has(type))) return 'input-modality-mismatch';
            }
        }
        if (flagged !== anyFlagged) return 'flag-contradiction';
    }
}

function provenanceIssue(data, mediaType) {
    if (data?.object !== 'content_provenance_check' || !Number.isSafeInteger(data.created_at) ||
        data.created_at < 0 || !Array.isArray(data.results) || !data.results.length) return 'provenance-envelope';
    const expected = mediaType?.startsWith('image/') ? ['c2pa', 'synthid'] :
        mediaType?.startsWith('audio/') ? ['synthid'] : mediaType === 'application/pdf' ? ['c2pa'] : undefined;
    const seen = new Set();
    for (const row of data.results) {
        if (!plainObject(row) || !['c2pa', 'synthid'].includes(row.type) || seen.has(row.type) ||
            !['detected', 'not_detected'].includes(row.outcome) || (row.model !== null && typeof row.model !== 'string') ||
            (row.generated_at !== null && (typeof row.generated_at !== 'string' ||
                !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/i.test(row.generated_at) ||
                !Number.isFinite(Date.parse(row.generated_at))))) return 'provenance-result';
        if (row.type === 'c2pa' && (!['trusted', 'valid', 'invalid', 'not_present'].includes(row.validation_state) ||
            (row.issuer !== null && typeof row.issuer !== 'string') ||
            (row.outcome === 'detected' && !(row.validation_state === 'trusted' ||
                (mediaType !== 'application/pdf' && row.validation_state === 'valid'))))) return 'c2pa-validation';
        seen.add(row.type);
    }
    if (expected && (seen.size !== expected.length || expected.some(type => !seen.has(type)))) return 'provenance-signal-coverage';
}

function verifyResult(action, id, params, result, operation, receipt) {
    if (result === null) return; // The caller permits this only for the declared HTTP acknowledgement.
    if (adminActions.has(action)) {
        if (result?.object !== 'page' || typeof result.has_more !== 'boolean' || !Array.isArray(result.data) ||
            result.data.some(bucket => bucket?.object !== 'bucket' || !Number.isSafeInteger(bucket.start_time) ||
                !Number.isSafeInteger(bucket.end_time) || bucket.end_time <= bucket.start_time || !Array.isArray(bucket.results))) {
            throw Error('Expected an Admin API usage or costs page with dated buckets.');
        }
        return tokenPagination(result.has_more, result.next_page, params.page);
    }
    if (action === 'environments.files.list') {
        if (result?.object !== 'page' || typeof result.has_more !== 'boolean' || !Array.isArray(result.data)) {
            throw Error('Expected an environment files page.');
        }
        const directory = params.path == null ? '/' : path.posix.normalize(params.path).replace(/\/+$/, '') + '/';
        if (result.data.some(item => !plainObject(item) || item.object !== 'agent.environment.file' ||
            item.environment_id !== id || !absoluteWorkspacePath(item.path) || item.path.endsWith('/') ||
            !path.posix.normalize(item.path).startsWith(directory) ||
            !Number.isSafeInteger(item.size_bytes) || item.size_bytes < 0)) {
            throw Error('Environment files page contains a file outside the requested scope or invalid file metadata.');
        }
        return tokenPagination(result.has_more, result.next, params.page);
    }
    if (action === 'vectorstores.search') {
        if (result?.object !== 'vector_store.search_results.page' || typeof result.has_more !== 'boolean' ||
            !Array.isArray(result.data) || result.data.some(hit => !identifier(hit?.file_id) ||
                typeof hit.filename !== 'string' || !probability(hit.score) || !Array.isArray(hit.content) ||
                hit.content.some(part => part?.type !== 'text' || typeof part.text !== 'string'))) {
            throw Error('Expected a vector search page with scores and text excerpts.');
        }
        return result.has_more ? { state: 'cursor-unavailable', hasMore: true, reason: 'route-does-not-expose-continuation' }
            : { state: 'complete', hasMore: false };
    }
    if (action === 'conversations.items.retrieve') {
        if (!validConversationItem(result, params.conversation_id) || result.id !== id) {
            throw Error('API result does not identify a valid item in the requested conversation.');
        }
        describeConversationVerification(receipt, [result]);
        return;
    }
    const createsConversationItems = action === 'conversations.items.create';
    if (operation.method === 'list' || createsConversationItems) {
        const last = Array.isArray(result?.data) ? result.data.at(-1) : undefined;
        const explicitCursor = result?.next ?? result?.next_page ?? result?.last_id;
        if (!plainObject(result) || !Array.isArray(result.data) ||
            (result.object !== undefined && typeof result.object !== 'string') ||
            (result.has_more !== undefined && typeof result.has_more !== 'boolean')) {
            throw Error('Expected well-formed API list data.');
        }
        if (action === 'models.list' && (result.object !== 'list' ||
            result.data.some(model => model?.object !== 'model' || typeof model.id !== 'string' || !model.id))) {
            throw Error('Expected a list of Model objects.');
        }
        if (action === 'conversations.items.list' || createsConversationItems) {
            if (result.object !== 'list' || result.data.some(item => !validConversationItem(item, id))) {
                throw Error('Expected valid items and an acknowledgement of each submitted conversation item.');
            }
            let partial = false;
            if (createsConversationItems) {
                const unmatched = [...result.data];
                // Match references and explicit item IDs before less specific inputs of the same type.
                const submitted = [...params.items].sort((a, b) => Number(Boolean(b?.id)) - Number(Boolean(a?.id)));
                if (unmatched.length !== submitted.length || !submitted.every(item => {
                    let match = -1, verification = 'mismatch';
                    for (const [index, candidate] of unmatched.entries()) {
                        const comparison = compareConversationInput(item, candidate);
                        if (comparison === 'mismatch' || verification === 'verified') continue;
                        match = index;
                        verification = comparison;
                        if (comparison === 'verified') break;
                    }
                    if (match < 0) return false;
                    partial ||= verification === 'partial';
                    unmatched.splice(match, 1);
                    return true;
                })) {
                    receipt.conversationItems = { verification: 'mismatch' };
                    throw Error('Conversation write did not acknowledge the submitted items.');
                }
            }
            const anchors = verifyAnchors(result, params);
            describeConversationVerification(receipt, result.data, partial);
            if (createsConversationItems && partial) process.exitCode = 1;
            return anchors;
        }
        if (itemPages.has(action) || identifiedPages.has(action)) {
            const turnScoped = action.includes('.turns.');
            const itemResource = action.slice(0, -'.list'.length);
            const expectedObject = itemResource === 'containers' ? 'container' : identifiedResources[itemResource] ??
                ({ files: 'file', batches: 'batch' })[itemResource];
            if ((result.object !== undefined && result.object !== 'list') || result.data.some(item => !plainObject(item) ||
                (itemPages.has(action) && !safeToken(item.type)) ||
                ((identifiedPages.has(action) || item.id != null) && !identifier(item.id)) ||
                (identifiedPages.has(action) && item.object !== expectedObject) ||
                (turnScoped && item.turn_id !== id))) throw Error('Expected items in the requested list scope.');
            return verifyAnchors(result, params);
        }
        const scope = Object.hasOwn(listOwners, action) && listOwners[action];
        if (scope) {
            const [object, owner, outerOwner] = scope;
            const artifactList = action === 'sessions.artifacts.list';
            if (result.data.some(item => !plainObject(item) || item[owner] !== id ||
                (outerOwner && item[outerOwner] !== params[outerOwner]) ||
                (object ? item.object !== object : !safeToken(item.type)) ||
                (object && !identifier(item.id)) ||
                (artifactList && (!identifier(item.environment_id) ||
                    (params.environment_id != null && item.environment_id !== params.environment_id))))) {
                throw Error('API page contains a resource outside the requested result scope.');
            }
            if (result.object !== undefined && result.object !== 'list') throw Error('Expected a list envelope for this API page.');
            return verifyAnchors(result, params);
        }
        // The server can return a valid page with has_more=true and no next cursor.
        // Preserve the page, but do not imply that the result can be paginated.
        const cursor = [explicitCursor, last?.id]
            .find(token => typeof token === 'string' && token.trim());
        if (result.has_more === true && !cursor) {
            return { state: 'cursor-unavailable', hasMore: true };
        }
        return;
    }
    if (action === 'responses.compact') {
        if (result?.object !== 'response.compaction' || !identifier(result.id) ||
            !Array.isArray(result.output) || result.output.some(item => !plainObject(item) || typeof item.type !== 'string')) {
            throw Error('Expected a compacted Response and its output items.');
        }
        return;
    }
    if (action === 'audio.transcriptions.create') {
        const optionalArray = (rows, check) => rows === undefined || (Array.isArray(rows) && rows.every(check));
        // Allow one millisecond of independent rounding at the end of the media.
        const withinAudio = value => interval(value) && value.end <= result.duration + 0.001;
        const segmentIds = new Set();
        const segment = (value, validId) => {
            if (!withinAudio(value) || typeof value.text !== 'string' || !validId(value.id)) return false;
            if (value.id === undefined) return true;
            if (segmentIds.has(value.id)) return false;
            segmentIds.add(value.id);
            return true;
        };
        const word = value => withinAudio(value) && typeof value.word === 'string';
        if (typeof result?.text !== 'string' ||
            (params.response_format === 'verbose_json' && (typeof result.language !== 'string' || !duration(result.duration) ||
                !optionalArray(result.segments, item => segment(item, id => id === undefined ||
                    (Number.isSafeInteger(id) && id >= 0))) || !optionalArray(result.words, word))) ||
            (params.response_format === 'diarized_json' && (!duration(result.duration) ||
                !Array.isArray(result.segments) || !result.segments.every(item => segment(item, identifier) &&
                    item.type === 'transcript.text.segment' &&
                    typeof item.speaker === 'string' && item.speaker.trim())))) {
            throw Error('Expected a transcript in the requested JSON format.');
        }
        return;
    }
    if (imageActions.has(action)) {
        if (!Array.isArray(result?.data) || !result.data.length ||
            result.data.some(image => !validImageResult(image, params.response_format))) {
            throw Error('Expected generated image data or URLs.');
        }
        return;
    }
    const contract = operation.result;
    if (contract) {
        if (!identifier(result?.id) || (contract.object && result.object !== contract.object) ||
            (contract.identity && result[contract.identity] !== id) ||
            (contract.parentArgument && result[contract.parentArgument] !== id) ||
            (contract.deleted && result.deleted !== true) ||
            Object.entries(contract.parents).some(([field, parameter]) => result[field] !== params[parameter])) {
            throw Error('API result does not identify the expected resource.');
        }
        return;
    }
    if (action === 'responses.inputtokens') {
        if (!Number.isSafeInteger(result?.input_tokens) || result.input_tokens < 0) throw Error('Expected an exact input token count.');
        return;
    }
    if (action === 'decisions.create') {
        if (!Array.isArray(result?.answers) || result.answers.length !== params.questions.length ||
            !result.answers.every((answer, index) => {
                const question = params.questions[index];
                if (!answer || (question.name ?? null) !== (answer.name ?? null)) return false;
                if (answer.type === 'refusal') return true;
                if (answer.type !== question.type) return false;
                if (answer.type === 'predicate') return probability(answer.probability);
                if (answer.type === 'score') {
                    const levels = question.levels;
                    if (!Array.isArray(levels) || !levels.length || !Number.isFinite(answer.score) ||
                        answer.score < 0 || answer.score > levels.length - 1) return false;
                    if (answer.probabilities === undefined) return true;
                    if (!verifyDistribution(answer.probabilities, levels.map((_, index) => index),
                        entry => entry.label === levels[entry.value]?.label)) return false;
                    const mean = answer.probabilities.reduce((sum, entry) => sum + entry.value * entry.probability, 0);
                    return Math.abs(answer.score - mean) <= levels.length ** 2 * 1e-5;
                }
                return ['string', 'boolean'].includes(typeof answer.choice) &&
                    (!Array.isArray(question.choices) || (question.choices.some(choice => choice.value === answer.choice) &&
                        (answer.probabilities === undefined || verifyDistribution(answer.probabilities,
                            question.choices.map(choice => choice.value), () => true))));
            })) throw Error('Decisions answers do not match the requested questions.');
        return;
    }
    if (action === 'files.delete') {
        if (result?.object !== 'file' || result.id !== id || result.deleted !== true) {
            throw Error('Expected an explicit deletion receipt for the requested file.');
        }
        return;
    }
    if (action === 'embeddings.create') {
        const input = params.input;
        const count = Array.isArray(input) && typeof input[0] !== 'number' ? input.length : 1;
        let dimensions = params.dimensions;
        let encoding = params.encoding_format;
        if (result?.object !== 'list' || !safeToken(result.model) ||
            !Number.isSafeInteger(result.usage?.prompt_tokens) || result.usage.prompt_tokens < 0 ||
            !Number.isSafeInteger(result.usage?.total_tokens) || result.usage.total_tokens < result.usage.prompt_tokens ||
            !Array.isArray(result.data) || result.data.length === 0 ||
            result.data.length !== count ||
            result.data.some((item, index) => {
                if (item?.object !== 'embedding' || item.index !== index) return true;
                encoding ??= Array.isArray(item.embedding) ? 'float' : 'base64';
                const length = embeddingLength(item.embedding, encoding);
                dimensions ??= length;
                return !length || length !== dimensions;
            })) {
            throw Error('Expected ordered embeddings with model identity, consistent usage, encoding and dimensions.');
        }
        return;
    }
    const [resource, verb, child] = action.startsWith('responses.multiagent.')
        ? ['responses', action.split('.').at(-1)] : action.split('.');
    if (child ||
        !['batches', 'files', 'responses'].includes(resource) || !['create', 'retrieve', 'cancel'].includes(verb)) return;
    const objectPrefix = { batches: ['batch', 'batch_'], files: ['file', 'file-'], responses: ['response', 'resp_'] };
    const [object, prefix] = objectPrefix[resource];
    if (result?.object !== object || !identifier(result.id) ||
        (!result.id.startsWith(prefix) && !(resource === 'files' && result.id.startsWith('file_'))) ||
        (id && result.id !== id) || (resource !== 'files' && !safeToken(result.status))) {
        throw Error('API result does not identify the expected resource.');
    }
    if (action === 'batches.create') {
        receipt.batchId = result.id;
        const mismatch = ['input_file_id', 'endpoint', 'completion_window'].find(field => result[field] !== params[field] ||
            typeof result[field] !== 'string' || !result[field]);
        if (mismatch) {
            receipt.batchVerification = { state: 'mismatch', field: mismatch };
            throw Error('Batch result does not match the submitted ' + mismatch + '.');
        }
    }
    if (action === 'files.create') receipt.observedFileId = result.id;
}

function idsFor(action, id, params) {
    if (/^sessions\.(?:events|items|turns|artifacts|traces|subagents)\.list$/.test(action) ||
        /^sessions\.(?:events\.(?:create|stream)|retrieve|update|delete)$/.test(action)) return id;
    return identifier(params.session_id);
}

function eventIdentity(event, field, nested, key, allowNull = false) {
    const first = Object.hasOwn(event, field);
    const second = nested != null && Object.hasOwn(nested, key);
    const value = first ? event[field] : second ? nested[key] : undefined;
    const valid = candidate => (allowNull && candidate === null) || Boolean(identifier(candidate));
    if ((first && !valid(value)) || (second && !valid(nested[key])) ||
        (first && second && value !== nested[key])) throw Error('Event identity fields are malformed or contradictory.');
    return value;
}

function eventState(event) {
    const rootMarker = eventIdentity(event, 'subagent_id', event.turn, 'subagent_id', true);
    const lifecycleTurn = lifecycleTurnTypes.has(event.type);
    const turnId = eventIdentity(event, 'turn_id', event.turn, 'id', !lifecycleTurn);
    if (lifecycleTurn && !turnId) throw Error('Event has no lifecycle turn identity.');
    return {
        sessionId: eventIdentity(event, 'session_id', event.session, 'id'),
        turnId,
        subagentId: identifier(rootMarker),
        mainTurn: rootMarker === null,
        eventId: identifier(event.event_id),
        eventType: safeToken(event.type),
    };
}

function emitPreflight(action, error, emit) {
    process.exitCode = 1;
    return emit({ kind: 'error', stage: 'preflight', dispatch: 'not-attempted', outcomeUnconfirmed: false,
        ...(safeToken(action) ? { receipt: { action } } : {}),
        localCode: safeToken(error.code) ?? 'local_check_failed', message: error.message });
}

function recordCacheDiagnostics(receipt, result, requestedBaseline) {
    const diagnostic = result?.prompt_cache_diagnostics;
    if (!requestedBaseline && !diagnostic) return;
    const count = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
    const reportedBaseline = identifier(result?.prompt_cache_options?.comparison_response_id);
    receipt.promptCache = { comparisonResponseId: requestedBaseline ?? reportedBaseline,
        ...(reportedBaseline ? { reportedComparisonResponseId: reportedBaseline } : {}),
        state: requestedBaseline && reportedBaseline && requestedBaseline !== reportedBaseline ? 'baseline-mismatch'
            : safeToken(diagnostic?.type) ?? 'not-reported',
        reason: safeToken(diagnostic?.reason), inputTokens: count(result?.usage?.input_tokens),
        cachedInputTokens: count(result?.usage?.input_tokens_details?.cached_tokens),
        estimatedMissedTokens: count(diagnostic?.cache_missed_tokens),
        comparisonReusableTokens: count(diagnostic?.comparison_reusable_tokens) };
}

function recordSessionBudget(receipt, session, requested) {
    const control = session?.spend_control;
    if (!control && requested === undefined) return;
    const limit = control?.limit;
    const consumed = control?.consumed;
    const expected = requested?.limit ?? null;
    const reported = limit === null || (Number.isSafeInteger(limit) && limit > 0);
    receipt.sessionBudget = { currency: 'USD', unit: 'cents',
        ...(requested !== undefined ? { requestedLimit: expected,
            verification: reported ? (limit === expected ? 'matched' : 'mismatch') : 'not-reported' } : {}),
        ...(reported ? { limit } : {}),
        ...(consumed === null || (Number.isSafeInteger(consumed) && consumed >= 0) ? { consumed } : {}),
        consumption: 'provider-best-effort' };
}

async function preparedImage(client, filename, file, before, type, maximum, signal) {
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maximum)) {
        throw Error('Select a nonempty regular image within the local byte limit.');
    }
    const bytes = Buffer.alloc(Number(before.size));
    let read = 0;
    while (read < bytes.length) {
        signal.throwIfAborted();
        const { bytesRead } = await file.read(bytes, read, bytes.length - read, read);
        if (!bytesRead) break;
        read += bytesRead;
    }
    const after = await file.stat({ bigint: true });
    signal.throwIfAborted();
    if (read !== bytes.length || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
        throw Error('Image input changed during local validation.');
    }
    const format = type.slice('image/'.length);
    const validation = { format, level: 'raster-container-structure', ...verifyImageStructure(bytes, format) };
    const upload = await client.constructor.toFile(bytes, path.basename(filename), { type });
    return { upload, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), validation };
}

async function addImageMarkup(client, markupPath, params, signal) {
    requireOrdinaryWindowsPath(markupPath);
    const file = await open(markupPath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    try {
        const { upload, ...evidence } = await preparedImage(client, markupPath, file,
            await file.stat({ bigint: true }), 'image/png', maxMarkupBytes, signal);
        params.markup = upload;
        return evidence;
    } finally { await file.close(); }
}

async function closeLocalResources(warnings, resources) {
    for (const [resource, release] of resources) {
        try { await release(); }
        catch (error) { warnings.push({ resource, phase: 'close', ...errorDetails(error) }); }
    }
}

async function emitStdout(value) {
    await new Promise((resolve, reject) => {
        process.stdout.write(JSON.stringify(value) + '\n', error => error ? reject(error) : resolve());
    });
}

export async function runWorkspace(token, invocation, emit = emitStdout, fetcher = fetch) {
    let params;
    try {
        invocation = normalizeInvocation(invocation);
        params = requestBody(invocation);
    } catch (error) { return emitPreflight(invocation?.action, error, emit); }
    const { action, id, idempotencyKey, checkpointPath, timeoutSeconds } = invocation;
    if (!workspaceActions.has(action) || !/^agtch_[A-Za-z0-9_-]{1,240}$/.test(id ?? '') ||
        !plainObject(params) || invocation.inputFile || invocation.outputFile || invocation.eventFile ||
        invocation.outputDirectory || invocation.stopOnTurn || invocation.turnId || invocation.pollSeconds ||
        invocation.inputMediaType || invocation.stableInstructions) {
        return emitPreflight(action, Error('Workspace operations require the trigger channel ID and documented JSON parameters.'), emit);
    }
    if (!/^[A-Za-z0-9._~+/-]{12,4096}=*$/.test(token ?? '') || token.startsWith('sk-')) {
        return emitPreflight(action, Error('A separate Workspace Agents access token is required.'), emit);
    }
    const triggers = action === 'workspace.trigger';
    if (triggers) {
        if (typeof params.input !== 'string' || !params.input.trim() ||
            (params.conversation_key !== undefined && typeof params.conversation_key !== 'string') ||
            Object.keys(params).some(key => !['input', 'conversation_key'].includes(key)) ||
            (idempotencyKey && !identifier(idempotencyKey))) {
            return emitPreflight(action, Error('Expected input and optional conversation_key.'), emit);
        }
    } else if (idempotencyKey || Object.keys(params).length !== 1 ||
        !/^apirun_[A-Za-z0-9_-]{1,235}$/.test(params.run_id ?? '')) {
        return emitPreflight(action, Error('Workspace status requires exactly one valid run_id.'), emit);
    }
    const base = 'https://api.chatgpt.com/v1/workspace_agents/' + id;
    const receipt = { action, clientRequestId: randomUUID(), workspaceTriggerId: id,
        projectHint: safeToken(invocation.projectHint),
        workspaceRunId: triggers ? undefined : params.run_id,
        ...(triggers ? { idempotencyKey: idempotencyKey || randomUUID() } : {}) };
    const signal = AbortSignal.timeout(timeoutSeconds * 1000);
    let checkpoint;
    async function record(phase, data = {}) {
        if (!checkpoint) return;
        await checkpoint.writeFile(JSON.stringify({ ...receipt, phase, at: new Date().toISOString(), ...data }) + '\n');
        await checkpoint.sync();
    }
    let dispatched = false;
    let finalResult;
    const warnings = [];
    try {
        requireOrdinaryWindowsPath(checkpointPath);
        if (checkpointPath) checkpoint = await open(checkpointPath, 'wx', 0o600);
        const headers = { Authorization: 'Bearer ' + token, 'X-Client-Request-Id': receipt.clientRequestId };
        if (triggers) Object.assign(headers, { 'OpenAI-Beta': 'workspace_agent_runs=v1',
            'Idempotency-Key': receipt.idempotencyKey, 'Content-Type': 'application/json' });
        await record('dispatch_pending');
        dispatched = true;
        const response = await fetcher(base + (triggers ? '/trigger' : '/runs/' + params.run_id), {
            method: triggers ? 'POST' : 'GET', headers, signal, redirect: 'error',
            ...(triggers ? { body: JSON.stringify(params) } : {}),
        });
        receipt.httpStatus = response.status;
        receipt.headers = headersOf(response.headers);
        try { await record('http_received'); }
        catch (error) { warnings.push({ resource: 'checkpoint', phase: 'http_received', ...errorDetails(error) }); }
        if (response.status !== (triggers ? 202 : 200)) {
            let data;
            try { data = await readJsonResponse(response); } catch {}
            throw Object.assign(Error('Workspace Agents returned an unexpected HTTP status.'), {
                status: response.status, error: data?.error, code: data?.error?.code, headers: response.headers,
            });
        }
        const data = await readJsonResponse(response);
        if (triggers) {
            if (!/^apirun_[A-Za-z0-9_-]{1,235}$/.test(data?.agent_trigger_run_id ?? '')) throw Error('Accepted trigger has no valid run ID.');
            receipt.workspaceRunId = data.agent_trigger_run_id;
            receipt.resourceStatus = 'accepted';
            try { await record('workspace_run_observed'); }
            catch (error) { warnings.push({ resource: 'checkpoint', phase: 'workspace_run_observed', ...errorDetails(error) }); }
            if (typeof data.conversation_url !== 'string' || new URL(data.conversation_url).origin !== 'https://chatgpt.com') {
                throw Error('Accepted trigger has no valid ChatGPT conversation link.');
            }
        } else {
            if (data?.object !== 'workspace_agent.trigger_run' || data.id !== params.run_id ||
                data.api_trigger_id !== id || !safeToken(data.status)) throw Error('Workspace run identity is inconsistent.');
            if (workspaceStatuses.has(data.status)) receipt.resourceStatus = data.status;
            else {
                receipt.observedResourceStatus = data.status;
                receipt.resourceStatusClassification = 'unknown';
                process.exitCode = 1;
            }
        }
        try { await record(triggers ? 'accepted' : 'response_received'); }
        catch (error) { warnings.push({ resource: 'checkpoint', phase: 'record', ...errorDetails(error) }); }
        finalResult = { receipt, data };
    } catch (error) {
        const outcomeUnconfirmed = triggers && dispatched && !receipt.workspaceRunId &&
            (!receipt.httpStatus || (receipt.httpStatus >= 200 && receipt.httpStatus < 300) ||
                [408, 409, 425].includes(receipt.httpStatus) || receipt.httpStatus >= 500);
        await record('error', { outcomeUnconfirmed }).catch(() => {});
        finalResult = { kind: 'error', stage: 'workspace', receipt, outcomeUnconfirmed,
            dispatch: receipt.httpStatus ? 'response-received' : dispatched ? 'attempted' : 'not-attempted',
            ...(signal.aborted ? { localDeadlineReached: true } : {}),
            ...(invocation.includeApiMessage ? { apiMessage: apiMessage(error, token) } : {}),
            ...errorDetails(error) };
        process.exitCode = 1;
    } finally {
        await closeLocalResources(warnings, [['checkpoint', () => checkpoint?.close()]]);
        if (finalResult) await emit({ ...finalResult, ...(warnings.length ? { localWarnings: warnings } : {}) });
    }
}

export async function runInvocation(client, invocation, emit = emitStdout, receiveSteer) {
    try {
        invocation = normalizeInvocation(invocation);
        invocation.request = requestBody(invocation);
    } catch (error) { return emitPreflight(invocation?.action, error, emit); }
    const { action } = invocation;
    if (knownCommands.has(action)) {
        if (action === 'doctor') {
            for (const operation of operations.values()) resolveOperation(client, operation);
            if (typeof client.SaxesParser !== 'function') throw Error('The runtime is missing the required SVG XML parser.');
            checkSvgParser(client.SaxesParser);
        }
        await emit({ sdk: client.runtimeVersion, endpoint, ...(action === 'catalog' ? {
            actions: operationCatalog(), invocation: { allowedFields: Object.keys(invocationFields), types: invocationFields, requestField: 'request' },
        } : {
            ready: true, actionCount: Object.keys(operationCatalog()).length, node: process.version, nodeExecutable: process.execPath,
            liveWebSocket: Boolean(client.WebSocketTransport), responsesWebSocketPilot: Boolean(client.WebSocketTransport),
            daybreak: describeDaybreak(), scope: 'local contracts only',
        }) });
        return;
    }

    if (action === 'responses.steer') return runSteeredResponse(client, invocation, emit, receiveSteer);
    if (action === 'responses.pilot') {
        let dispatched = false;
        try { return await runResponsesPilot(client, client.apiKey, invocation, emit, () => { dispatched = true; }); }
        catch (error) {
            if (dispatched) throw error;
            return emitPreflight(action, error, emit);
        }
    }
    return runApiInvocation(client, invocation, emit);
}

export function operationCatalog() {
    const startsJob = new Set([...responseCreates, 'responses.steer', 'batches.create', 'sessions.create', 'sessions.events.create',
        'automations.invocations.create', 'workspace.trigger']);
    const catalog = Object.fromEntries([...operations].map(([name, { kind, id, params, required, requiredArrays = [] }]) =>
            [name, { kind, id, parameters: params, required: [...required, ...requiredArrays],
                ...(requiredArrays.length ? { requestTypes: Object.fromEntries(requiredArrays.map(field => [field, 'array'])) } : {}),
                usesNetwork: true, mutatesRemoteState: [write, 'transfer', 'voice'].includes(kind) &&
                    !['embeddings.create', 'moderations.create', 'decisions.create', 'images.generate', 'images.edit', 'audio.transcriptions.create',
                        'provenance.create'].includes(name), startsJob: startsJob.has(name),
                ...(inputActions.has(name) ? { inputFile: name === 'containers.files.create' ? 'or file_id' : true } : {}),
                ...(fileOutputKinds.has(kind) ? { outputFile: true } : {}),
                ...(streamCapableActions.has(name) ? { optionalStream: true } : {}),
                ...(name === 'models.list' ? { bufferedEquivalent: 'openai-api.ps1 -Operation Models' } : {}) }]));
    catalog['sessions.events.create'].localOptions = ['idempotencyKey'];
    catalog['workspace.trigger'] = { kind: write, id: true, parameters: true, required: ['input'],
        optional: ['conversation_key'], localOptions: ['idempotencyKey'], credential: 'workspace-access-token' };
    catalog['workspace.status'] = { kind: read, id: true, parameters: true, required: ['run_id'], credential: 'workspace-access-token' };
    catalog['responses.pilot'] = { kind: 'pilot', id: false, parameters: true, required: ['model'],
        optional: ['turns', 'order'], localOptions: pilotOptions, timeoutRangeSeconds: [1, 3600],
        syntheticOnly: true, syntheticInput: true, providerMetered: true };
    catalog['responses.steer'] = { kind: write, id: false, parameters: true, required: ['response'],
        optional: ['steer_input'], localOptions: steerOptions, transport: 'Responses WebSocket',
        interactive: 'Node entry with --interactive-steer and newline-delimited JSON input',
        mutatesRemoteState: true, persistsRemoteResponse: 'requested with response.store=true',
        unsupportedResponseFields: steeringUnsupportedFields,
        modelFamily: steeringModelFamily,
        incompatibleResponseOptions: ['bound conversation', 'automatic context compaction'],
        input: 'nonempty text or user messages with text, image or file content' };
    for (const action of ['responses.create', 'responses.multiagent.create']) {
        catalog[action].cacheDiagnostics = { request: 'prompt_cache_options.comparison_response_id', receipt: 'promptCache' };
    }
    for (const action of ['responses.multiagent.create', 'responses.multiagent.retrieve']) {
        catalog[action].beta = 'responses_multi_agent=v1';
    }
    for (const action of adminActions) {
        Object.assign(catalog[action], { credential: 'openai-admin-api-key', required: ['start_time'], page: 'receipt.pagination.nextPage' });
    }
    catalog['environments.files.list'].page = 'receipt.pagination.nextPage';
    for (const action of ['sessions.create', 'sessions.update', 'sessions.retrieve']) {
        catalog[action].spendControl = { unit: 'USD cents', receipt: 'sessionBudget',
            ...(action === 'sessions.retrieve' ? {} : { request: 'spend_control.limit' }) };
    }
    for (const action of ['images.generate', 'images.edit']) {
        catalog[action].currentModels = ['gpt-image-2.6-sunburst', 'gpt-image-2.6-flare'];
        catalog[action].outputFormats = Object.keys(imageOutputFormats);
        catalog[action].outputFile = 'optional, one image with explicit output_format';
    }
    for (const action of ['live.create', 'live.audio']) {
        catalog[action].currentModels = ['gpt-live-1.1', 'gpt-live-1'];
    }
    catalog['uploads.transfer'].required = ['purpose', 'mime_type'];
    catalog['decisions.create'].required = ['questions'];
    catalog['live.create'].required = ['transport'];
    catalog['live.create'].requestShape = { transport: { type: 'webrtc', sdp: 'string' },
        session: { model: 'string', wake_policy: { type: 'speech (optional)' }, idle_timeout_s: '5..60 (optional)' } };
    catalog['images.edit'].localOptions = ['inputFile', 'inputMediaType', 'markupFile'];
    catalog['images.edit'].localImageByteLimits = { inputFile: maxEditImageBytes, markupFile: maxMarkupBytes };
    catalog['batches.wait'].localOptions = ['outputDirectory', 'pollSeconds', 'verifyInputIds'];
    const daybreak = describeDaybreak();
    for (const action of daybreak.createActions) {
        catalog[action].daybreak = { field: daybreak.field, programs: daybreak.programs,
            projectAccess: daybreak.projectAccess, matrix: daybreak.matrix };
    }
    for (const [name, entry] of Object.entries(catalog)) {
        entry.usesNetwork ??= true;
        entry.mutatesRemoteState ??= name === 'workspace.trigger';
        entry.startsJob ??= startsJob.has(name);
        entry.credential ??= 'openai-project-api-key';
        entry.credentialSources = entry.credential === 'workspace-access-token'
            ? { node: 'OPENAI_WORKSPACE_AGENT_ACCESS_TOKEN', powershell: 'WorkspaceToken parameter, environment, or configured Windows store' }
            : entry.credential === 'openai-admin-api-key'
                ? { node: 'OPENAI_ADMIN_KEY', powershell: 'OPENAI_ADMIN_KEY process environment only' }
                : { node: 'OPENAI_API_KEY', powershell: 'environment or Windows Credential Manager according to CredentialSource' };
        entry.cost = 'provider-dependent';
    }
    return catalog;
}

async function runApiInvocation(client, invocation, emit) {
    const { action, id, inputFile, outputFile, checkpointPath, eventFile, stopOnTurn, turnId } = invocation;
    let parsed, method;
    try {
        parsed = parseInvocation(invocation);
        method = resolveOperation(client, parsed.operation);
    } catch (error) { return emitPreflight(action, error, emit); }
    const { operation, streaming, responseStream, params, daybreak } = parsed;
    const creatingSession = action === 'sessions.create';
    const trackedCreation = creatingSession && Boolean(daybreak);
    const startingAfter = params.starting_after;
    if (responseStream && startingAfter !== undefined && (!responseRetrieves.has(action) || !streaming ||
        !Number.isSafeInteger(startingAfter) || startingAfter < 0)) {
        return emitPreflight(action, Error('starting_after requires streamed responses.retrieve and a nonnegative sequence number.'), emit);
    }
    const transcript = responseStream && streaming ? trackResponseStream(startingAfter) : null;
    const suppliedClientId = invocation.clientRequestId;
    const clientRequestId = suppliedClientId || randomUUID();
    const sessionId = idsFor(action, id, params);
    const idempotencyKey = action === 'sessions.events.create' ? invocation.idempotencyKey || randomUUID() : undefined;
    const receipt = { action, clientRequestId, sessionId, idempotencyKey, requestedId: id || undefined,
        projectHint: safeToken(invocation.projectHint), credentialRoute: adminActions.has(action) ? 'openai-admin-api-key' : 'openai-project-api-key',
        sourceMethod: operation.kind === 'wait' || adminActions.has(action) ||
            (operation.kind === read && ['list', 'retrieve'].includes(operation.method))
            ? 'GET' : (responseCreates.has(action) || ['sessions.create', 'responses.inputtokens'].includes(action)) ? 'POST' : undefined,
        ...(adminActions.has(action) ? { usageQuery: { startTime: params.start_time, endTime: params.end_time,
            bucketWidth: params.bucket_width ?? '1d',
            groupedBy: params.group_by, projectIds: params.project_ids } } : {}),
        ...(responseCreates.has(action) ? { requestedModel: safeToken(params.model), requestedEffort: safeToken(params.reasoning?.effort),
            inputCoverage: describeFileInputs(params.input) } : {}),
        ...(trackedCreation ? { requestedModel: safeToken(params.agent?.model), requestedEffort: safeToken(params.agent?.reasoning?.effort) } : {}),
        ...(daybreak ? { daybreak } : {}),
        inputFileId: action === 'batches.create' ? identifier(params.input_file_id) : undefined,
        containerId: identifier(params.container_id) || (action.startsWith('containers.') &&
            !operation.required.includes('container_id') ? id || undefined : undefined),
        uploadId: action.startsWith('uploads.') ? id || undefined : undefined };
    const signal = AbortSignal.timeout(invocation.timeoutSeconds * 1000);
    const options = { headers: { 'X-Client-Request-Id': clientRequestId }, signal, maxRetries: 0 };
    if (idempotencyKey) params['Idempotency-Key'] = idempotencyKey;

    let checkpoint;
    let dispatch = 'not-attempted';
    let upload;
    let uploadEvidence;
    let inputHandle;
    let eventOutput;
    let eventOutputFailed = false;
    let stage = 'prepare';
    let finalResult;
    const warnings = [];
    let eventsSinceSync = 0;
    async function record(phase, fields = {}) {
        if (!checkpoint) return;
        await checkpoint.writeFile(JSON.stringify({ ...receipt, ...fields, phase, at: new Date().toISOString() }) + '\n');
        await checkpoint.sync();
    }
    async function recordResult(phase, fields) {
        try { await record(phase, fields); }
        catch (error) { warnings.push({ resource: 'checkpoint', phase, ...errorDetails(error) }); }
    }
    async function emitEvent(event, terminal, observation) {
        const withheld = observation?.deliver === false;
        const disposition = observation?.disposition;
        const eventRecord = { kind: withheld ? 'stream-observation' : 'event', event,
            ...(disposition && disposition !== 'in-order' ? { streamDisposition: disposition } : {}) };
        if (!eventOutput) {
            if (!withheld) await emit(eventRecord);
            return !withheld;
        }
        if (eventOutputFailed) return false;
        try {
            await eventOutput.writeFile(JSON.stringify(eventRecord) + '\n');
            if (terminal) await eventOutput.sync();
            return !withheld;
        } catch (error) {
            eventOutputFailed = true;
            warnings.push({ resource: 'events', phase: 'append', ...errorDetails(error) });
            return false;
        }
    }

    async function syncResponseEvents() {
        if (!eventOutput || eventOutputFailed || !transcript || !eventsSinceSync) return;
        try {
            await eventOutput.sync();
            transcript.synced();
            eventsSinceSync = 0;
        } catch (error) {
            eventOutputFailed = true;
            warnings.push({ resource: 'events', phase: 'sync', ...errorDetails(error) });
        }
    }

    try {
        const batchOutput = operation.kind === 'wait' ? invocation.outputDirectory : undefined;
        requireOrdinaryWindowsPath(batchOutput);
        const artifacts = [outputFile, ...batchDestinations(batchOutput).map(file => file.path)].filter(Boolean);
        if (inputFile) {
            requireOrdinaryWindowsPath(inputFile);
            inputHandle = await open(inputFile, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
            const uploadField = uploadFields.get(action);
            if (uploadField) {
                if (Object.hasOwn(params, uploadField)) throw Error('Supply local upload data through -InputFile.');
                const inputInfo = await inputHandle.stat({ bigint: true });
                const byteLimit = action === 'provenance.create' ? 50 * 1024 * 1024
                    : action === 'uploads.parts.create' ? uploadPartBytes : maxUploadBytes;
                if (!inputInfo.isFile() || inputInfo.size < 1n || inputInfo.size > BigInt(byteLimit)) {
                    throw Error('Select a nonempty regular file within the operation’s local byte limit.');
                }
                const type = invocation.inputMediaType || (['provenance.create', 'images.edit'].includes(action)
                    ? provenanceMedia.get(path.extname(inputFile).toLowerCase()) : undefined);
                if (action === 'images.edit' && !['image/png', 'image/jpeg', 'image/webp'].includes(type)) {
                    throw Error('Image editing accepts a PNG, JPEG or WebP input file.');
                }
                if (action === 'provenance.create' && !type) throw Error('Specify -InputMediaType for this provenance file.');
                if (action === 'images.edit') {
                    const image = await preparedImage(client, inputFile, inputHandle, inputInfo, type, maxEditImageBytes, signal);
                    params[uploadField] = image.upload;
                    uploadEvidence = { sourceBytes: image.bytes, sourceSha256: image.sha256, imageInput: image.validation };
                } else {
                    const expectedBytes = Number(inputInfo.size);
                    upload = inputHandle.createReadStream({ start: 0, end: expectedBytes - 1, autoClose: false });
                    async function* observedUpload() {
                        const hash = createHash('sha256');
                        let bytes = 0;
                        for await (const chunk of upload) {
                            bytes += chunk.length;
                            hash.update(chunk);
                            yield chunk;
                        }
                        const current = await inputHandle.stat({ bigint: true });
                        if (bytes !== expectedBytes || current.size !== inputInfo.size ||
                            current.mtimeNs !== inputInfo.mtimeNs || current.ctimeNs !== inputInfo.ctimeNs) {
                            throw Error('Upload input changed or was incomplete during transfer.');
                        }
                        uploadEvidence = { sourceBytes: bytes, sourceSha256: hash.digest('hex') };
                    }
                    const file = client.constructor.toStreamingFile(observedUpload(), path.basename(inputFile), type ? { type } : undefined);
                    params[uploadField] = uploadField === 'files' ? [file] : file;
                }
            }
        }
        if (invocation.markupFile) receipt.markup = await addImageMarkup(client, invocation.markupFile, params, signal);
        [checkpoint, eventOutput] = await preflightLocalOutputs(checkpointPath, eventFile, artifacts, warnings);
        if (operation.kind === 'transfer') {
            const data = await transferUpload(client, inputHandle, inputFile, params, options, async (name, makeRequest) => {
                stage = name;
                dispatch = 'attempted';
                delete receipt.httpStatus;
                delete receipt.headers;
                const response = await makeRequest.asResponse();
                dispatch = 'response-received';
                receipt.httpStatus = response.status;
                receipt.headers = headersOf(response.headers);
                await recordResult('http_received');
                return readJsonResponse(response);
            }, receipt, (phase, extra) => phase === 'upload_completed' ? recordResult(phase, extra) : record(phase, extra));
            finalResult = { receipt, data };
            return;
        }
        if (operation.kind === 'voice') {
            stage = 'live-audio';
            const data = await runLiveAudio(client.WebSocketTransport, client.apiKey, inputHandle, outputFile,
                params, signal, receipt, async (phase, extra) => {
                    if (phase === 'live_connection_attempted') { dispatch = 'attempted'; return; }
                    if (phase === 'live_closed') return recordResult(phase, extra);
                    await record(phase, extra);
                });
            finalResult = { receipt, data };
            if (!data.sessionClosed) {
                receipt.outcomeUnconfirmed = true;
                process.exitCode = 1;
            }
            if (!data.inputComplete || !data.outputComplete) process.exitCode = 1;
            return;
        }
        if (operation.kind === 'wait') {
            await record('wait_started');
            const result = await waitForBatch(client, invocation, options, receipt, (phase, fields) =>
                phase === 'downloaded' ? record(phase, fields) : recordResult(phase, fields), state => {
                stage = 'batch-wait';
                dispatch = state;
            }, warnings);
            await recordResult('batch_wait_ended', { outcome: result.outcome, artifactVerification: result.artifactVerification?.state });
            finalResult = { receipt, data: result };
            if (result.outcome !== 'completed') process.exitCode = 1;
            return;
        }
        const args = [...(operation.id ? [id] : []), ...(operation.params ? [params] : []), options];
        stage = 'request';
        await record('dispatch_pending');
        dispatch = 'attempted';
        if (daybreak) daybreak.acceptanceState = 'unconfirmed';
        const request = method(...args);
        const response = await request.asResponse();
        dispatch = 'response-received';
        Object.assign(receipt, {
            httpStatus: response.status, headers: headersOf(response.headers),
            headerObservedAt: new Date().toISOString(), headerScope: 'response-observation',
        });
        if (daybreak && response.ok) daybreak.acceptanceState = 'accepted';
        await recordResult('http_received');
        if ([download, render].includes(operation.kind)) {
            stage = 'download';
            const speech = action === 'audio.speech.create' ? speechOutput(response, params) : undefined;
            const saved = await saveDownload(response, outputFile, signal, speech);
            if (saved.media?.format === 'opus') {
                receipt.mediaCompletion = saved.media.completion;
                if (saved.media.completion !== 'ogg-eos-verified') process.exitCode = 1;
            }
            await recordResult('downloaded', { bytes: saved.bytes });
            finalResult = { receipt, data: saved };
            return;
        }

        if (!streaming) {
            stage = 'response-body';
            if (action === 'sessions.events.create') {
                receipt.eventAcceptance = 'unverified';
                if (response.status !== operation.emptyStatus) throw Error('Expected HTTP 202 for session event acceptance.');
            }
            const result = await readJsonResponse(response, response.status === operation.emptyStatus);
            if (action === 'sessions.events.create') {
                if (result !== null) throw Error('Session event acceptance returned an unexpected body.');
                receipt.eventAcceptance = 'accepted';
            }
            const pagination = verifyResult(action, id, params, result, operation, receipt);
            if (pagination) receipt.pagination = pagination;
            if (action === 'moderations.create') {
                const reason = moderationIssue(result, params);
                receipt.moderationVerification = reason ? { state: 'unverified', reason } : { state: 'verified' };
                if (reason) process.exitCode = 1;
            }
            if (trackedCreation) verifyDaybreakSession(daybreak, result);
            if (action !== 'files.create') Object.assign(receipt, safeState(result));
            if (receipt.resourceStatusClassification === 'unknown') process.exitCode = 1;
            const outputIssue = result?.object === 'response' ? responseOutputIssue(result) : undefined;
            if (outputIssue) {
                receipt.responseOutputVerification = { state: 'unverified', reason: outputIssue };
                process.exitCode = 1;
            }
            if (['sessions.create', 'sessions.retrieve'].includes(action) || responseStream) {
                observeDaybreak(receipt, result, 'api-resource');
                if (receipt.daybreak && action.startsWith('sessions.')) {
                    if (safeToken(result?.agent?.model)) receipt.reportedModel = result.agent.model;
                    if (safeToken(result?.agent?.reasoning?.effort)) receipt.reportedEffort = result.agent.reasoning.effort;
                }
                if (responseStream) {
                    const safetyOutcome = responseSafetyOutcome(result);
                    if (safetyOutcome) receipt.safetyOutcome = safetyOutcome;
                }
            }
            if (upload) {
                if (!uploadEvidence) throw Error('The SDK did not establish a complete local upload source.');
                Object.assign(receipt, uploadEvidence);
                if (action === 'files.create') {
                    receipt.fileId = checkUploadedFile(result, receipt, uploadEvidence.sourceBytes,
                        { filename: path.basename(inputFile), purpose: params.purpose });
                    Object.assign(receipt, safeState(result));
                }
            }
            if (responseStream) recordCacheDiagnostics(receipt, result, params.prompt_cache_options?.comparison_response_id);
            if (['sessions.create', 'sessions.update', 'sessions.retrieve'].includes(action)) {
                recordSessionBudget(receipt, result, params.spend_control);
                if (['mismatch', 'not-reported'].includes(receipt.sessionBudget?.verification)) process.exitCode = 1;
            }
            if (safeToken(result?.model)) receipt.reportedModel = result.model;
            if (safeToken(result?.reasoning?.effort)) receipt.reportedEffort = result.reasoning.effort;
            if (action === 'sessions.create') {
                receipt.sessionId = identifier(result?.id);
                if (!receipt.sessionId) throw Error('Session identity missing from create response.');
            }
            if (imageActions.has(action)) {
                const requestedCount = params.n ?? 1;
                const completion = result.data.length === requestedCount ? 'complete' :
                    result.data.length < requestedCount ? 'partial' : 'count-mismatch';
                receipt.imageOutput = { requestedModel: safeToken(params.model), requestedFormat: safeToken(params.output_format),
                    reportedFormat: safeToken(result.output_format), requestedCount, count: result.data.length, completion };
                const expectedFormat = params.output_format ?? result.output_format;
                const knownFormat = typeof expectedFormat === 'string' && Object.hasOwn(imageOutputFormats, expectedFormat);
                let formatVerification = 'unverified';
                if (params.output_format != null && result.output_format != null && params.output_format !== result.output_format) {
                    formatVerification = 'mismatch';
                } else if (knownFormat && !outputFile) {
                    try {
                        for (const image of result.data) {
                            if (image.b64_json) verifyImageStructure(Buffer.from(image.b64_json, 'base64'), expectedFormat, client.SaxesParser);
                        }
                        if (result.data.every(image => image.b64_json)) formatVerification = 'verified';
                    } catch (error) {
                        formatVerification = 'mismatch';
                        receipt.imageOutput.formatDiagnostic = error.message;
                    }
                }
                receipt.imageOutput.formatVerification = formatVerification;
                if (completion !== 'complete' || formatVerification === 'mismatch') process.exitCode = 1;
            }
            if (action === 'live.create') {
                receipt.requestedModel = safeToken(params.session?.model);
                receipt.reportedModel = safeToken(result?.session?.model);
                receipt.liveSessionId = identifier(result?.session?.id);
                if (!receipt.liveSessionId || result?.transport?.type !== 'webrtc' ||
                    typeof result.transport.sdp !== 'string' || !result.transport.sdp) {
                    throw Error('Live creation did not return a session and WebRTC answer.');
                }
                receipt.resourceStatus = 'negotiated';
            }
            if (action === 'uploads.create' || action === 'uploads.complete' || action === 'uploads.cancel') {
                const state = { 'uploads.create': 'pending', 'uploads.complete': 'completed', 'uploads.cancel': 'cancelled' }[action];
                checkUpload(result, id, action === 'uploads.create' ? params.bytes : undefined, state);
                receipt.uploadId = result.id;
                if (action === 'uploads.complete') receipt.fileId = checkCompletedFile(result, receipt);
                else checkUploadMetadata(result, action === 'uploads.create' ? params : undefined);
            }
            if (action === 'uploads.parts.create') {
                if (result?.object !== 'upload.part' || result.upload_id !== id || !identifier(result.id)) {
                    throw Error('Upload part did not identify the expected upload.');
                }
                receipt.partId = result.id;
            }
            if (action === 'provenance.create') {
                const mediaType = (invocation.inputMediaType ?? provenanceMedia.get(path.extname(inputFile).toLowerCase()))?.toLowerCase();
                const reason = provenanceIssue(result, mediaType);
                receipt.provenanceVerification = reason ? { state: 'unverified', reason } : { state: 'verified' };
                if (reason) process.exitCode = 1;
            }
            if (action === 'containers.create') receipt.containerId = identifier(result?.id);
            if (action === 'containers.files.create') receipt.containerFileId = identifier(result?.id);
            stage = 'output';
            if (imageActions.has(action) && outputFile) {
                const image = await saveImage(result, params.output_format, outputFile, signal, client.SaxesParser);
                receipt.imageOutput.formatVerification = 'verified';
                await recordResult('image_saved', { bytes: image.bytes, format: image.format, sha256: image.sha256 });
                finalResult = { receipt, data: { image, usage: result.usage, svg_usage: result.svg_usage } };
                return;
            }
            await recordResult(response.status === 202 ? 'accepted' : 'response_received');
            finalResult = { receipt, data: result ?? null };
            if (['mismatch', 'not-reported'].includes(receipt.sessionBudget?.verification)) finalResult.kind = 'result';
            return;
        }

        stage = 'stream';
        if (!streamMedia.test(response.headers.get('content-type') ?? '')) {
            throw Error('API returned an unexpected content type for an event stream.');
        }
        const data = await request;
        await recordResult('stream_open');
        await emit({ kind: 'receipt', receipt });
        let end = 'stream-ended';
        let outcome;
        let lastTerminalTurn;
        let selectedTurnId = turnId;
        let createdSessionObserved = false;
        for await (const event of data) {
            if (responseStream) {
                if (event.response !== undefined && event.response?.object !== 'response') {
                    throw Error('Stream event did not identify a Response object.');
                }
                const state = { ...safeState(event.response), eventType: safeToken(event.type),
                    sequenceNumber: event.type !== 'keepalive' && Number.isSafeInteger(event.sequence_number)
                        && event.sequence_number >= 0 ? event.sequence_number : undefined };
                if (state.resourceId && (!state.resourceId.startsWith('resp_') || (id && state.resourceId !== id) ||
                    (receipt.resourceId && state.resourceId !== receipt.resourceId))) {
                    throw Error('Event response identity changed.');
                }
                if (state.resourceId && !receipt.resourceId) {
                    receipt.resourceId = state.resourceId;
                    await recordResult('response_observed', { resourceId: state.resourceId });
                }
                const previousCursor = receipt.streamIntegrity?.lastDurableContiguousSequence;
                const observation = transcript.observe(event);
                const latest = transcript.latest;
                if (latest !== undefined) receipt.sequenceNumber = latest;
                if (!observation.deliver) {
                    receipt.streamIntegrity = transcript.snapshot();
                    if (previousCursor !== receipt.streamIntegrity.lastDurableContiguousSequence) {
                        await recordResult('stream_progress', { cursorRetracted: true });
                    }
                    await emitEvent(event, false, observation);
                    if (eventOutput && ++eventsSinceSync >= 64) await syncResponseEvents();
                    continue;
                }
                const terminal = responseTerminal.has(event.type);
                if (terminal) {
                    if (event.type !== 'error' &&
                        (!state.resourceId?.startsWith('resp_') || state.resourceStatus !== event.type.slice('response.'.length))) {
                        throw Error('Terminal event did not identify the expected response and status.');
                    }
                }
                if (state.resourceStatus) receipt.resourceStatus = state.resourceStatus;
                if (terminal && event.response?.object === 'response' && state.resourceId) {
                    const reason = responseOutputIssue(event.response);
                    if (reason) receipt.responseOutputVerification = { state: 'unverified', reason };
                    recordCacheDiagnostics(receipt, event.response, params.prompt_cache_options?.comparison_response_id);
                    observeDaybreak(receipt, event.response, 'response-terminal-event');
                    const safetyOutcome = responseSafetyOutcome(event.response);
                    if (safetyOutcome) receipt.safetyOutcome = safetyOutcome;
                }
                if (event.type === 'error' && (event.code === 'cyber_policy' || event.error?.code === 'cyber_policy')) {
                    receipt.safetyOutcome = 'provider-cyber-policy';
                }
                if (await emitEvent(event, false, observation)) transcript.delivered(observation.cursor);
                if (eventOutput) eventsSinceSync++;
                if (terminal || eventsSinceSync >= 64) {
                    await syncResponseEvents();
                    receipt.streamIntegrity = transcript.snapshot();
                    if (!terminal && receipt.streamIntegrity.lastDurableContiguousSequence !== undefined) {
                        await recordResult('stream_progress');
                    }
                }
                if (terminal) {
                    await recordResult('terminal_event', state);
                    outcome = event.type;
                    end = 'terminal-event';
                    if (event.response?.usage) receipt.usage = event.response.usage;
                    if (safeToken(event.response?.model)) receipt.reportedModel = event.response.model;
                    if (safeToken(event.response?.reasoning?.effort)) receipt.reportedEffort = event.response.reasoning.effort;
                    break;
                }
                continue;
            }
            let state;
            try { state = eventState(event); }
            catch (error) {
                await emitEvent(event, false);
                throw error;
            }
            const knownSession = receipt.sessionId;
            const turnSession = event.turn?.session_id;
            if ((state.sessionId && knownSession && state.sessionId !== knownSession) ||
                (turnSession !== undefined && (!identifier(turnSession) || turnSession !== (state.sessionId ?? knownSession)))) {
                throw Error('Event session identity changed.');
            }
            if (creatingSession && event.type === 'agent.session.created') {
                if (!state.sessionId || event.session?.object !== 'agent.session' || event.session.id !== state.sessionId) {
                    throw Error('The created event did not identify a session resource.');
                }
                if (trackedCreation) {
                    verifyDaybreakSession(daybreak, event.session);
                    observeDaybreak(receipt, event.session, 'session-created-event');
                }
                if (safeToken(event.session.agent?.model)) receipt.reportedModel = event.session.agent.model;
                if (safeToken(event.session.agent?.reasoning?.effort)) receipt.reportedEffort = event.session.agent.reasoning.effort;
                createdSessionObserved = true;
            }
            if (event.session && (event.session.spend_control !== undefined ||
                (creatingSession && event.type === 'agent.session.created' && params.spend_control !== undefined))) {
                recordSessionBudget(receipt, event.session, params.spend_control);
            }
            if (state.sessionId && !knownSession) {
                receipt.sessionId = state.sessionId;
                await recordResult('session_observed', state);
            } else if (creatingSession && event.type === 'agent.session.created') {
                await recordResult('session_observed', state);
            }
            if (creatingSession && createdSessionObserved && state.sessionId === receipt.sessionId && state.mainTurn &&
                state.turnId && !selectedTurnId &&
                ['agent.session.turn.created', 'agent.session.turn.in_progress'].includes(event.type)) {
                selectedTurnId = state.turnId;
                receipt.turnId = state.turnId;
                await recordResult('turn_selected', state);
            }
            const selectedTurn = creatingSession
                ? createdSessionObserved && state.sessionId === receipt.sessionId && state.mainTurn &&
                    Boolean(selectedTurnId && state.turnId === selectedTurnId)
                : Boolean(state.turnId && (state.sessionId || knownSession) &&
                    (turnId ? state.turnId === turnId : state.mainTurn));
            if (state.eventId) receipt.eventId = state.eventId;
            const terminalTurn = terminalTurnTypes.has(event.type);
            if (terminalTurn && event.turn?.status !== event.type.split('.').at(-1)) {
                throw Error('Event turn identity or status contradicts its terminal outcome.');
            }
            const terminalSession = terminalSessionTypes.has(event.type);
            if ((event.type === 'error' && (event.code === 'cyber_policy' || event.error?.code === 'cyber_policy')) ||
                (terminalTurn && selectedTurn && event.turn?.error?.code === 'cyber_policy')) {
                receipt.safetyOutcome = 'provider-cyber-policy';
            }
            if (terminalTurn && selectedTurn) {
                receipt.turnId = state.turnId;
                lastTerminalTurn = { turnId: state.turnId, eventType: event.type };
            }
            if (terminalTurn || terminalSession) {
                if (terminalTurn && !selectedTurn) {
                    const { turnId: observedTurnId, ...observed } = state;
                    await recordResult('other_turn_observed', { ...observed, observedTurnId });
                } else await recordResult('terminal_event', state);
            }
            await emitEvent(event, terminalTurn || terminalSession);
            if (creatingSession && event.type === 'agent.session.created' &&
                ['mismatch', 'not-reported'].includes(receipt.sessionBudget?.verification)) {
                outcome = 'session-budget-unconfirmed';
                end = 'budget-verification';
                break;
            }
            if (terminalSession || (terminalTurn && selectedTurn && (stopOnTurn || action === 'sessions.create'))) {
                outcome = event.type;
                end = 'terminal-event';
                break;
            }
        }
        if (end === 'stream-ended' && signal.aborted) end = 'timeout';
        await syncResponseEvents();
        if (transcript) receipt.streamIntegrity = transcript.snapshot();
        await recordResult('stream_ended', { end, outcome });
        if (receipt.responseOutputVerification?.state === 'unverified') receipt.observedResponseOutcome = outcome;
        finalResult = { kind: 'result', receipt, end, outcome: receipt.observedResponseOutcome
            ? 'response-output-unverified' : outcome ?? 'unconfirmed',
            lastTerminalTurn, eventFile: eventFile || undefined,
            ...(eventOutput ? { observedEventsSaved: !eventOutputFailed } : {}) };
        if (eventOutputFailed || receipt.responseOutputVerification?.state === 'unverified' ||
            ['mismatch', 'not-reported'].includes(receipt.sessionBudget?.verification) || (responseStream && (outcome !== 'response.completed' ||
                receipt.streamIntegrity?.state === 'incomplete-history')) ||
            terminalSessionTypes.has(outcome) ||
            ((stopOnTurn || action === 'sessions.create') && outcome !== 'agent.session.turn.completed')) process.exitCode = 1;
    } catch (error) {
        await syncResponseEvents();
        if (transcript) receipt.streamIntegrity = transcript.snapshot();
        const details = errorDetails(error);
        const retainedBatchHttp = operation.kind === 'wait' && !details.httpStatus && receipt.batchReadError;
        if (retainedBatchHttp) {
            Object.assign(details, receipt.batchReadError, { httpStatus: receipt.httpStatus, headers: receipt.headers });
        }
        const observedHttp = details.httpStatus ?? (operation.kind === 'wait' && dispatch !== 'response-received'
            ? undefined : receipt.httpStatus);
        const mayHaveEffect = [write, render, 'transfer', 'voice'].includes(operation.kind) && dispatch !== 'not-attempted' &&
            !(operation.kind === 'voice' && receipt.resourceStatus === 'closed') &&
            (dispatch === 'response-received' || !observedHttp || observedHttp >= 500 || [408, 409, 425].includes(observedHttp) ||
                Boolean(receipt.uploadId && operation.kind === 'transfer'));
        const errorHeaderTime = Object.keys(details.headers).length
            ? (retainedBatchHttp ? receipt.headerObservedAt : new Date().toISOString()) : undefined;
        if (errorHeaderTime && !receipt.headerObservedAt) {
            receipt.headers = details.headers;
            receipt.headerObservedAt = errorHeaderTime;
            receipt.headerScope = 'failure-observation';
        }
        const failureCategory = classifyOpenAiFailure({ ...details, httpStatus: observedHttp }, { unconfirmed: mayHaveEffect });
        if (daybreak && dispatch === 'attempted' && !mayHaveEffect &&
            Number.isInteger(observedHttp) && observedHttp >= 400) daybreak.acceptanceState = 'rejected';
        if (daybreak) receipt.daybreak = { ...receipt.daybreak, acceptanceState: daybreak.acceptanceState, failureCategory };
        if (failureCategory === 'provider-cyber-policy') receipt.safetyOutcome = 'provider-cyber-policy';
        const next = ['model-program-mismatch', 'program-unsupported'].includes(failureCategory)
            ? 'Check the selected model and program in the current Daybreak API matrix.'
            : failureCategory === 'project-access-not-enabled'
                ? 'Check approval, the named API project setting and the credential used for this request.'
                : undefined;
        const failure = { kind: 'error', receipt, stage, dispatch, outcomeUnconfirmed: mayHaveEffect,
            ...(operation.kind === 'wait' ? { readOnly: true } : {}),
            ...(daybreak || failureCategory !== 'other' ? { failureCategory } : {}),
            ...(next ? { next } : {}),
            ...(errorHeaderTime ? { headerObservedAt: errorHeaderTime, headerScope: 'failure-observation' } : {}),
            ...(invocation.includeApiMessage ? { apiMessage: apiMessage(error) } : {}),
            ...(stage === 'download' ? { localArtifact: { state: 'not-confirmed', publication: error.publication,
                next: operation.kind === download ? 'Recover the requested artifact by ID' : 'Inspect the provider and local outcome before repeating' } } : {}),
            ...(signal.aborted ? { localDeadlineReached: true } : {}),
            ...(eventOutput ? { eventFile, observedEventsSaved: false } : {}),
            ...(streaming && dispatch !== 'not-attempted'
                ? { [responseStream ? 'responseOutcome' : 'turnOutcome']: 'unconfirmed' } : {}), ...details };
        const localCode = safeToken(error.code);
        if (localCode === 'daybreak_correlation_mismatch') failure.localCode = localCode;
        else if (stage === 'prepare' || (stage === 'stream' && error.message === 'Event session identity changed.')) {
            failure.localCode = localCode ?? 'local_check_failed';
        }
        await record('error', { stage, dispatch, httpStatus: observedHttp, apiCode: details.apiCode,
            apiType: details.apiType, outcomeUnconfirmed: mayHaveEffect,
            ...(daybreak || failureCategory !== 'other' ? { failureCategory } : {}),
            ...(errorHeaderTime ? { headers: details.headers, headerObservedAt: errorHeaderTime, headerScope: 'failure-observation' } : {}),
        }).catch(() => {});
        finalResult = failure;
        process.exitCode = 1;
    } finally {
        await closeLocalResources(warnings, [
            ['upload', () => upload?.destroy()], ['input', () => inputHandle?.close()],
            ['events', () => eventOutput?.close()], ['checkpoint', () => checkpoint?.close()],
        ]);
        if (finalResult?.kind === 'result' && eventOutput && warnings.some(warning => warning.resource === 'events')) {
            finalResult.observedEventsSaved = false;
            process.exitCode = 1;
        }
        if (finalResult) await emit({ ...finalResult, ...(warnings.length ? { localWarnings: warnings } : {}) });
    }
}

async function resolveRuntimePackage(root, lockfile, name, resolver, requests) {
    const directory = path.join(root, 'node_modules', name);
    const expected = lockfile.packages?.['node_modules/' + name]?.version;
    const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    if (!expected || expected !== metadata.version || metadata.name !== name ||
        path.relative(directory, await realpath(directory))) {
        throw Error('Installed ' + name + ' does not match the runtime lock.');
    }
    return Promise.all(requests.map(async specifier => {
        const entry = await realpath(resolver.resolve(specifier));
        const relative = path.relative(directory, entry);
        if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
            throw Error('Resolved ' + name + ' is outside its locked runtime directory.');
        }
        return entry;
    }));
}

export async function buildClient(apiKey, sdkRoot, fetcher = fetch, adminAPIKey = null) {
    const root = await realpath(sdkRoot);
    const localRequire = createRequire(path.join(root, 'package.json'));
    const lockfile = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
    const [sdk, version] = await resolveRuntimePackage(root, lockfile, 'openai', localRequire, ['openai', 'openai/version']);
    const [parser] = await resolveRuntimePackage(root, lockfile, 'saxes', localRequire, ['saxes']);
    await resolveRuntimePackage(root, lockfile, 'xmlchars', createRequire(parser),
        ['xmlchars/xml/1.0/ed5', 'xmlchars/xml/1.1/ed2', 'xmlchars/xmlns/1.0/ed3']);
    const installed = localRequire(version).VERSION;
    if (installed !== lockfile.packages['node_modules/openai'].version) throw Error('Installed SDK version does not match its lock.');
    const { OpenAI } = localRequire(sdk);
    const { SaxesParser } = localRequire(parser);
    if (typeof SaxesParser !== 'function') throw Error('The runtime is missing the required SVG XML parser.');
    const client = new OpenAI({
        apiKey, baseURL: endpoint, adminAPIKey, organization: null, project: null, webhookSecret: null,
        maxRetries: 0, logLevel: 'off', fetch: async (url, init) => {
            const target = new URL(url);
            if (target.origin !== 'https://api.openai.com' || !target.pathname.startsWith('/v1/')) {
                throw Error('Unexpected API destination.');
            }
            const response = await fetcher(url, { ...init, redirect: 'error' });
            if (!response.body || (response.ok && !streamMedia.test(response.headers.get('content-type') ?? ''))) return response;
            let bytes = 0;
            const bounded = response.body.pipeThrough(new TransformStream({ transform(chunk, controller) {
                bytes += chunk.byteLength;
                if (bytes > maxResponseBytes) throw Error('API stream or error exceeded the 64 MiB local output budget.');
                controller.enqueue(chunk);
            } }));
            return new Response(bounded, { status: response.status, statusText: response.statusText, headers: response.headers });
        },
    });
    client.runtimeVersion = installed;
    client.SaxesParser = SaxesParser;
    client.WebSocketTransport = globalThis.WebSocket;
    return client;
}

async function readStdin() {
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
        size += chunk.length;
        if (size > 36 * 1024 * 1024) throw Error('Local invocation exceeded its byte budget.');
        chunks.push(chunk);
    }
    return parseApiJson(Buffer.concat(chunks));
}

// Read at most one bounded NDJSON frame at a time for a duplex steering client.
async function* interactiveInput() {
    let pending = Buffer.alloc(0);
    for await (const bytes of process.stdin) {
        pending = Buffer.concat([pending, bytes]);
        let end;
        while ((end = pending.indexOf(10)) >= 0) {
            if (end > 18 * 1024 * 1024) throw Error('Interactive JSON frame exceeds 18 MiB.');
            const line = pending.subarray(0, end);
            pending = pending.subarray(end + 1);
            if (line.length) yield parseApiJson(line);
        }
        if (pending.length > 18 * 1024 * 1024) throw Error('Interactive JSON frame exceeds 18 MiB.');
    }
    if (pending.length) throw Error('End interactive input frames with a newline.');
}

const entry = process.argv[1];
const isMain = import.meta.main ?? (entry && existsSync(entry) && realpathSync(entry) === fileURLToPath(import.meta.url));
if (isMain) {
    let invocationStarted = false;
    const interactive = process.argv.at(-1) === '--interactive-steer';
    try {
        const selected = process.argv[2] === '--interactive-steer' ? undefined : process.argv[2];
        const quickCheck = process.argv.length === 3 && knownCommands.has(selected);
        const frames = interactive ? interactiveInput() : null;
        const invocation = normalizeInvocation(quickCheck ? { action: selected } :
            interactive ? (await frames.next()).value : await readStdin());
        if (interactive && invocation.action !== 'responses.steer') throw Error('Interactive input is only for responses.steer.');
        const receiveSteer = interactive ? async () => {
            const { value } = await frames.next();
            if (!plainObject(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'steer_input')) {
                throw Object.assign(Error('Expected a steer_input frame.'), { code: 'invalid_interactive_steer' });
            }
            return value.steer_input;
        } : undefined;
        const sdkRoot = path.resolve((quickCheck ? undefined : selected) || fileURLToPath(new URL('./agents-sdk/', import.meta.url)));
        const apiKey = process.env.OPENAI_API_KEY;
        const adminKey = process.env.OPENAI_ADMIN_KEY;
        delete process.env.OPENAI_ADMIN_KEY;
        const workspaceToken = process.env.OPENAI_WORKSPACE_AGENT_ACCESS_TOKEN;
        delete process.env.OPENAI_API_KEY;
        delete process.env.OPENAI_WORKSPACE_AGENT_ACCESS_TOKEN;
        if (workspaceActions.has(invocation.action)) {
            invocationStarted = true;
            await runWorkspace(workspaceToken, invocation);
        } else if (!knownCommands.has(invocation.action) && !['responses.pilot', 'responses.steer'].includes(invocation.action) && !operations.has(invocation.action)) {
            await emitPreflight(invocation.action, Error('Unknown action. Use catalog for the local operation list.'), emitStdout);
        } else {
            const admin = adminActions.has(invocation.action);
            if (admin && !/^sk-[A-Za-z0-9_-]{16,}$/.test(adminKey ?? '')) {
                throw Error('A separate OPENAI_ADMIN_KEY is required in the process environment.');
            }
            if (!admin && !knownCommands.has(invocation.action) && !/^sk-[A-Za-z0-9_-]{16,}$/.test(apiKey ?? '')) {
                throw Error('A usable OPENAI_API_KEY is required in the process environment.');
            }
            const client = await buildClient(admin ? null : (apiKey || 'offline-check'), sdkRoot, fetch, admin ? adminKey : null);
            invocationStarted = !knownCommands.has(invocation.action);
            if (invocation.action === 'qualify') {
                await emitStdout({sdk:client.runtimeVersion, ...await qualifyRuntime(buildClient,sdkRoot,runInvocation)});
            } else {
                await runInvocation(client, invocation, emitStdout, receiveSteer);
            }
        }
    } catch (error) {
        const localMessage = error instanceof SyntaxError ? 'Invalid JSON invocation.' : error.message;
        await emitStdout({ kind: 'error', stage: invocationStarted ? 'invocation' : 'preflight',
            dispatch: invocationStarted ? 'unknown' : 'not-attempted',
            outcomeUnconfirmed: invocationStarted, message: localMessage });
        process.exitCode = 1;
    } finally {
        if (interactive) process.stdin.destroy();
    }
}
