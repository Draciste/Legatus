import { lstat, open } from 'node:fs/promises';
import { constants, existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseApiJson } from './openai-json.mjs';
import { operationCatalog } from './openai-agents.mjs';
import { parseBatchJson, planBatchRecovery } from './openai-batch-recovery.mjs';

const maxDocumentBytes = 16 * 1024 * 1024;

export class LocalTextError extends Error {
    constructor(code, message, details) {
        super(message);
        this.code = code;
        this.details = details;
    }
}

export async function localText(filename, maximum = maxDocumentBytes, expectedFile) {
    if (typeof filename !== 'string' || !filename) throw Error('Select a local file.');
    const noFollow = expectedFile ? (constants.O_NOFOLLOW ?? 0) : 0;
    const file = await open(filename, constants.O_RDONLY | noFollow);
    try {
        const initial = await file.stat({ bigint: true });
        const sameFile = info => info.isFile() && info.dev === initial.dev && info.ino !== 0n && info.ino === initial.ino;
        if (expectedFile && !sameFile(expectedFile)) {
            throw new LocalTextError('file_changed', 'Selected result file identity changed before reading.');
        }
        if (!initial.isFile()) throw new LocalTextError('not_regular_file', 'Select a regular result file.');
        if (initial.size > BigInt(maximum)) {
            throw new LocalTextError('file_too_large', 'File is outside the local size limit.', { limitBytes: maximum });
        }
        const size = Number(initial.size);
        const content = Buffer.alloc(size + 1);
        let bytesRead = 0;
        while (bytesRead < content.length) {
            const next = await file.read({ buffer: content, offset: bytesRead,
                length: content.length - bytesRead, position: bytesRead });
            if (!next.bytesRead) break;
            bytesRead += next.bytesRead;
        }
        const final = await file.stat({ bigint: true });
        if (bytesRead !== size || final.size !== initial.size || final.mtimeNs !== initial.mtimeNs || final.ctimeNs !== initial.ctimeNs ||
            (expectedFile && !sameFile(await lstat(filename, { bigint: true })))) {
            throw new LocalTextError('file_changed', 'File changed while reading.');
        }
        try {
            return new TextDecoder('utf-8', { fatal: true }).decode(content.subarray(0, bytesRead));
        } catch {
            throw new LocalTextError('invalid_utf8', 'The result file is not valid UTF-8.');
        }
    } finally {
        await file.close();
    }
}

const recipes = {
    'models.list': ['List models visible to the selected project key.', 'list models model availability seznam modelů'],
    'responses.inputtokens': ['Count input tokens with actual API framing.', 'token count tokens input count tokenizer spočítat počet tokenů'],
    'batches.retrieve': ['Check the current state of a known batch.', 'batch status resume recover verify dávka dávky stav ověř obnov'],
    'batches.cancel': ['Request cancellation of an existing Batch.', 'cancel stop zruš zastav dávku'],
    'batches.wait': ['Wait and collect results from an existing batch.', 'batch wait collect download resume recover dávka obnov čekat výsledky'],
    'batch.plan': ['Match downloaded Batch results to the original input and prepare confirmed expired rows.', 'batch partial retry resume recover dávka dávku obnov nedokončenou'],
    'jobs': ['Inspect local job checkpoints and suggested follow-up actions.', 'job checkpoint resume recover audit úloha stav obnov'],
    'files.content': ['Download original bytes using a confirmed File ID.', 'file evidence original download attachment artifact soubor stáhnout'],
    'responses.retrieve': ['Retrieve a known stored response.', 'resume recover stored response retrieve stav obnov odpověď'],
    'responses.cancel': ['Request cancellation of a background Response.', 'cancel stop zruš zastav odpověď'],
    'responses.create': ['Submit a fresh Responses task. Foreground and eligible Background use the same action.', 'audit inference background launch odloženě zadání prompt cache diagnostics comparison baseline prefix'],
    'responses.steer': ['Change the direction of an active Responses WebSocket and track the continuation.', 'steering direction live mid-turn websocket průběžná změna zadání'],
    'responses.multiagent.create': ['Start a remote Responses run with eligible subagents.', 'multiagent parallel delegation server-side remote rozdělení práce'],
    'responses.multiagent.retrieve': ['Read the stored result of a Multi-agent Responses run.', 'multiagent recovery retrieve remote obnovit'],
    'admin.usage.costs': ['Read recorded costs with a separate Admin API key.', 'billing costs charges organization project admin útrata náklady'],
    'admin.usage.completions': ['Read metered completion usage grouped by project, model or API source.', 'usage tokens organization project admin využití'],
    'sessions.update': ['Update an existing Agents session, including an explicitly requested spend limit.', 'agent budget spending limit USD cents rozpočet relace'],
    'images.edit': ['Edit an image, optionally guided by a local PNG overlay.', 'image edit markup gif svg obrázek'],
    'images.generate': ['Generate images, including supported SVG and GIF outputs.', 'image generation GIF SVG obrázek'],
    'live.create': ['Negotiate a Live WebRTC session, with optional standby.', 'voice Live WebRTC speech standby audio'],
    'live.audio': ['Run a bounded local PCM exchange with GPT-Live.', 'voice audio speech Live PCM'],
    'responses.delegate': ['Coordinate heavy background submissions and recover results from a shared local pool.', 'delegation quota tpm queue peak audit fronta limity delegace'],
    'sessions.retrieve': ['Check the recorded managed Agents session.', 'agent session status verify resume recover obnov ověř stav relace relaci'],
    'sessions.create': ['Start a managed Agents session, optionally streaming events.', 'start managed agent session stream založit relaci'],
    'sessions.events.stream': ['Watch an existing managed Agents session and optionally save events.', 'agent stream turn follow session čekat relace'],
    'vectorstores.search': ['Search an existing vector store.', 'vector store search vyhledej hledej hledat vyhledat'],
    'responses.pilot': ['Opt in to a metered synthetic HTTP/SSE and Responses WebSocket pilot.', 'websocket pilot benchmark latency comparison test'],
    'workspace.status': ['Look up an accepted Workspace Agent run.', 'workspace run status verify stav'],
    'decisions.create': ['Submit named predicate, choice or score questions.', 'decisions triage classify predicate choice score třídit'],
    'uploads.transfer': ['Upload a large file in ordered parts. Leave optional MD5 disabled until #597 is fixed and retested.', 'uploads large multipart file nahrát velký soubor'],
    'audit.schema': ['Return the structured audit finding schema.', 'audit schema structured findings schéma nálezy'],
    'audit.validate': ['Validate a saved audit report and its findings.', 'audit validate report findings zkontrolovat nálezy'],
    estimate: ['Estimate token cost and compare current capacity.', 'estimate cost costs token tokens capacity quota odhad cena náklady kapacita'],
    benchmark: ['Compare saved benchmark cases and observations.', 'benchmark evaluate tests měření případy'],
};

const examples = {
    'models.list': '& $api models.list',
    'responses.inputtokens': '& $api responses.inputtokens -RequestPath $requestJsonPath',
    'batch.plan': '& $node $workbench batch.plan $planJsonPath',
    jobs: '& $jobs $jobDirectory -WithNext',
    'batches.retrieve': '& $api batches.retrieve -Id $batchId',
    'batches.wait': '& $api batches.wait -Id $batchId -OutputDirectory $existingResultsDirectory',
    'files.content': '& $api files.content -Id $fileId -OutputFile $newFilePath',
    'responses.retrieve': '& $api responses.retrieve -Id $responseId',
    'responses.create': '& $api responses.create -RequestPath $requestJsonPath',
    'responses.steer': '& $api responses.steer -RequestPath $steerRequestJsonPath',
    'responses.multiagent.create': '& $api responses.multiagent.create -RequestPath $requestJsonPath',
    'responses.multiagent.retrieve': '& $api responses.multiagent.retrieve -Id $responseId',
    'admin.usage.costs': '& $api admin.usage.costs -RequestPath $adminQueryJsonPath',
    'admin.usage.completions': '& $api admin.usage.completions -RequestPath $adminQueryJsonPath',
    'responses.delegate': '& $delegate Submit -Request $request',
    'sessions.retrieve': '& $api sessions.retrieve -Id $sessionId',
    'sessions.events.stream': '& $api sessions.events.stream -Id $sessionId -StopOnTurn',
    'workspace.status': '& $api workspace.status -Id $triggerId -Request @{run_id=$runId}',
};

const localActions = {
    discover: { input: 'query and optional limit', run: (query, limit) => discover(query, limit === undefined ? undefined : Number(limit)) },
    'audit.schema': { input: 'none', run: () => ({ type: 'json_schema', name: 'audit_findings', strict: true, schema: auditSchema }) },
    'audit.validate': { input: 'report JSON path', run: async filename => validateAudit(await readJson(filename)) },
    estimate: { input: 'estimate JSON path', run: async filename => estimateWork(await readJson(filename)) },
    benchmark: { input: 'benchmark JSON path', run: async filename => benchmark(await readJson(filename)) },
    'batch.plan': { input: 'plan JSON path', run: async filename => {
        const input = await readBatchJson(filename);
        return planBatchRecovery({ wait: await readBatchJson(input.waitReceiptPath),
            input: await readBatchJson(input.inputReceiptPath), inputSourcePath: input.inputSourcePath,
            output: input.outputReceiptPath ? await readBatchJson(input.outputReceiptPath) : undefined,
            error: input.errorReceiptPath ? await readBatchJson(input.errorReceiptPath) : undefined, retryPath: input.retryPath });
    } },
};

function tokensOf(text) {
    const normalized = text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
        .replace(/\bmulti[\s\p{Dash_Punctuation}]+agents?\b/gu, 'multiagent');
    return [...new Set(normalized.match(/[\p{L}\p{N}_]+/gu) ?? [])];
}

const intentWords = {
    read: 'get inspect retrieve list verify check read seznam over overit zobraz zobrazit',
    stop: 'stop cancel abort zastav zastavit zrus zrusit prerus prerusit',
    search: 'search find hledej hledat vyhledej vyhledat hledani vyhledavani',
    start: 'create start launch submit generate trigger delegate upload transfer zaloz zalozit spust spustit vytvor vytvorit deleguj nahraj nahrat',
    delete: 'delete remove smaz smazat odstran odstranit odeber odebrat',
    recover: 'recover resume obnov obnovit',
    monitor: 'watch stream follow wait cekej cekat sleduj sledovat',
    edit: 'edit update uprav upravit zmen zmenit',
    steer: 'steer preorientuj',
    count: 'count spocitej spocitat',
    estimate: 'estimate compare odhadni porovnej',
};
const subjectWords = {
    batches: 'batch batches davka davku davky davce davek',
    sessions: 'session sessions relace relaci relacich',
    responses: 'response responses odpoved odpovedi odpovedich',
    'responses.multiagent': 'multiagent multiagents multiagentni',
    vectorstores: 'vector vectorstore vectorstores vektorove vektorovem vektorovych',
    files: 'file files soubor souboru soubory',
    artifacts: 'artifact artifacts artefakt artefaktu artefakty',
    traces: 'trace traces tracing stopa stopy stopu trasovani',
    subagents: 'subagent subagents podagent podagenti podagentu',
    agents: 'agent agents agenti agenta agentu',
    turns: 'turn turns tah tahu tahy',
    live: 'live webrtc',
    images: 'image images obrazek obrazku obrazky gif svg',
    models: 'model models modely modelu',
    usage: 'usage spotreba spotrebu vyuziti',
    costs: 'cost costs naklady utratu utrata',
    uploads: 'upload uploads uploady',
    containers: 'container containers kontejner kontejneru kontejnery',
    conversations: 'conversation conversations konverzace konverzaci',
    workspace: 'workspace',
    skills: 'skill skills dovednost dovednosti',
    automations: 'automation automations automatizace',
    environments: 'environment environments prostredi',
    vaults: 'vault vaults',
    embeddings: 'embedding embeddings',
    moderations: 'moderation moderations moderace',
    decisions: 'decision decisions rozhodnuti',
    audio: 'audio zvuk',
};
const hierarchies = [
    [['live', 'sessions'], 'live'], [['live', 'audio'], 'live.audio'],
    [['sessions', 'subagents', 'turns'], 'sessions.subagents.turns'],
    [['sessions', 'subagents'], 'sessions.subagents'],
    [['sessions', 'traces'], 'sessions.traces'],
    [['sessions', 'artifacts'], 'sessions.artifacts'], [['sessions', 'turns'], 'sessions.turns'],
    [['vectorstores', 'files'], 'vectorstores.files'], [['containers', 'files'], 'containers.files'],
    [['usage', 'costs'], 'costs'],
];
const routeIntents = { retrieve: 'read', status: 'read', list: 'read', content: 'read', costs: 'read', completions: 'read',
    cancel: 'stop', search: 'search', create: 'start', delegate: 'start', generate: 'start', trigger: 'start', transfer: 'start',
    delete: 'delete', plan: 'recover', wait: 'monitor', stream: 'monitor', edit: 'edit', update: 'edit',
    steer: 'steer', inputtokens: 'count', estimate: 'estimate', benchmark: 'estimate' };
const matchesVocabulary = (words, vocabulary) => Object.entries(vocabulary)
    .filter(([, aliases]) => aliases.split(' ').some(word => words.includes(word))).map(([name]) => name);

function discoverSubjects(words) {
    let subjects = matchesVocabulary(words, subjectWords);
    const checkpoint = words.some(word => /^checkpoints?$/.test(word));
    const local = words.some(word => ['local', 'offline', 'mistni', 'lokalni', 'mistnich', 'lokalnich'].includes(word));
    const job = words.some(word => ['job', 'jobs', 'uloha', 'ulohu', 'ulohy', 'uloh', 'uloze'].includes(word));
    const remote = words.some(word => ['remote', 'server', 'vzdaleny', 'vzdalenou', 'vzdalenych'].includes(word));
    if (checkpoint && !remote || local && job) return ['jobs'];
    if (job && !subjects.length && !checkpoint) return ['unspecified-jobs'];
    if (checkpoint) subjects.push('jobs');
    if (subjects.includes('responses.multiagent') && !subjects.includes('sessions')) {
        subjects = subjects.filter(subject => !['responses', 'subagents'].includes(subject));
    }
    if (subjects.includes('sessions') && subjects.includes('agents')) {
        subjects = subjects.filter(subject => subject !== 'agents');
        const agentIndex = words.findIndex(word => subjectWords.agents.split(' ').includes(word));
        const sessionIndex = words.findIndex(word => subjectWords.sessions.split(' ').includes(word));
        if (!subjects.includes('subagents') && sessionIndex > agentIndex &&
            words.slice(agentIndex + 1, sessionIndex).some(word => ['in', 'inside', 'within', 'v', 've'].includes(word))) {
            subjects.push('subagents');
        }
    }
    for (const [parts, path] of hierarchies) {
        if (parts.every(part => subjects.includes(part))) {
            return [...subjects.filter(subject => !parts.includes(subject)), path];
        }
    }
    return subjects.map(subject => subject === 'artifacts' ? 'sessions.artifacts' : subject);
}

function routeFor(action) {
    if (action === 'jobs') return { resource: 'jobs', intent: 'read' };
    if (action === 'live.audio') return { resource: 'live.audio', intent: 'start' };
    const split = action.lastIndexOf('.');
    if (action === 'containers.files.content.retrieve') return { resource: 'containers.files', intent: 'read' };
    return { resource: action.slice(0, split).replace(/^batch$/, 'batches'), intent: routeIntents[action.slice(split + 1)] };
}

function subjectMatch(subject, action, resource, intent) {
    if (intent === 'estimate') return action === 'estimate' || action === 'benchmark';
    if (!subject) return true;
    if (subject === 'costs') return action === 'admin.usage.costs';
    if (subject === 'usage') return action === 'admin.usage.completions';
    if (subject === resource || subject === action) return true;
    if (intent === 'monitor' && ['sessions', 'sessions.turns'].includes(subject)) return action === 'sessions.events.stream';
    if (intent === 'search' && subject === 'vectorstores.files') return ['vectorstores.files.list', 'vectorstores.search'].includes(action);
    return false;
}

export function discover(query, limit = 5) {
    if (typeof query !== 'string' || !query.trim() || query.length > 512 ||
        !Number.isInteger(limit) || limit < 1 || limit > 12) throw Error('Supply a nonempty query and limit 1–12.');
    const words = tokensOf(query);
    const catalogue = { ...operationCatalog(),
        ...Object.fromEntries(Object.entries(localActions).map(([name, { input }]) =>
            [name, { kind: 'local', credential: 'none', interface: 'openai-workbench.mjs', input }])),
        jobs: { kind: 'local', credential: 'none', interface: 'openai-jobs.ps1', input: 'checkpoint directory, -WithNext',
            mcp: { tool: 'list_jobs', requires: 'configured checkpoint directory and PowerShell 7' } },
        'responses.delegate': { kind: 'write', interface: 'openai-delegate.ps1', usesNetwork: true,
            mutatesRemoteState: true, startsJob: true, cost: 'provider-dependent',
            input: 'Submit/Status; shared local pool; background=true and store=true for Submit' },
    };
    const exact = query.trim().toLowerCase();
    const intents = matchesVocabulary(words, intentWords);
    if (intents.includes('read') && words.includes('upload') && intents.includes('start') &&
        !words.some(word => word !== 'upload' && intentWords.start.split(' ').includes(word))) {
        intents.splice(intents.indexOf('start'), 1);
    }
    const mentionsStatus = words.includes('status') || words.includes('stav');
    if (mentionsStatus && intents.length === 1 && intents[0] === 'search') intents[0] = 'read';
    if (mentionsStatus && (!intents.length || intents.some(intent => ['start', 'stop', 'delete'].includes(intent)))) {
        if (!intents.includes('read')) intents.push('read');
    }
    const subjects = discoverSubjects(words.filter(word => word !== 'upload' || intents.includes('read')));
    const metadataRequested = words.includes('metadata');
    const contentRequested = words.some(word => ['content', 'contents', 'obsah', 'obsahu', 'bytes', 'bajty'].includes(word)) ||
        (!metadataRequested && words.some(word => ['download', 'stahni', 'stahnout'].includes(word)));
    const listRequested = words.some(word => ['list', 'seznam', 'vypis', 'vypsat'].includes(word));
    const contentActions = { files: 'files.content', 'sessions.artifacts': 'sessions.artifacts.content',
        'vectorstores.files': null, 'containers.files': 'containers.files.content.retrieve' };
    const negated = words.some(word => ['not', 'never', 'no', 'dont', 'don', 'nezrus', 'nezastav',
        'nespoustej', 'nemaz', 'nesmaz', 'neodstran'].includes(word));
    const ambiguous = intents.length > 1 || subjects.length > 1 || negated;
    const combined = !ambiguous && !listRequested && (!intents.length || intents[0] === 'read') &&
        contentRequested && metadataRequested && contentActions[subjects[0]];
    const candidates = Object.hasOwn(catalogue, exact) ? [[exact, catalogue[exact]]] : ambiguous ? [] :
        combined ? [combined, subjects[0] + '.retrieve'].map(action => [action, catalogue[action]]) :
            Object.entries(catalogue);
    const matches = candidates.flatMap(([action, meta]) => {
        const [summary, tags] = recipes[action] ?? [];
        const actionWords = tokensOf(action);
        const recipeWords = tags ? tokensOf(tags) : [];
        const exactMatch = action === exact;
        const { resource, intent: routeIntent } = routeFor(action);
        const intent = intents[0];
        const subject = subjects[0];
        const startsRemoteWork = ['write', 'transfer', 'voice', 'render', 'pilot'].includes(meta.kind);
        const affectsRemote = startsRemoteWork || meta.mutatesRemoteState || meta.startsJob;
        const sameIntent = Boolean(intent && intent === routeIntent);
        const sameResource = subject === resource || subject === action;
        const compatible = !intent || sameIntent ||
            (intent === 'recover' && ['read', 'monitor'].includes(routeIntent)) ||
            (intent === 'search' && (subject === 'vectorstores.files' && action === 'vectorstores.files.list' ||
                subject === 'models' && action === 'models.list' || action === 'jobs'));
        if (!exactMatch && (!compatible || !subjectMatch(subject, action, resource, intent) ||
            (affectsRemote && (!sameResource || !sameIntent)))) return [];
        const explicitContent = contentRequested && !metadataRequested && Object.hasOwn(contentActions, subject);
        if (!exactMatch && explicitContent && action !== contentActions[subject] && (!intent || intent === 'read')) return [];
        const itemRead = ['get', 'inspect', 'retrieve', 'read', 'over', 'overit'].some(word => words.includes(word));
        const specificRead = sameResource && (metadataRequested || itemRead) && !listRequested && action.endsWith('.retrieve') &&
            action !== contentActions[subject];
        const score = (exactMatch ? 100 : 0) + (sameResource ? 24 : 0) + (sameIntent && subject ? 12 : 0) +
            (specificRead || listRequested && sameResource && action.endsWith('.list') ? 8 : 0) + words.reduce(
            (sum, word) => sum + (actionWords.includes(word) ? 4 : 0) + (recipeWords.includes(word) ? 3 : 0), 0);
        return { action, score, summary, example: examples[action], interface: 'openai-agents.ps1',
            ...meta, credential: meta.credential ?? 'openai-project-api-key',
            usesNetwork: meta.usesNetwork ?? false, mutatesRemoteState: meta.mutatesRemoteState ?? false,
            startsJob: meta.startsJob ?? false,
            startsRemoteWork };
    }).filter(match => match.score > 0).sort((a, b) => b.score - a.score || a.action.localeCompare(b.action));
    return { query, matches: matches.slice(0, limit).map(({ score, ...match }) => match),
        otherMatches: Math.max(0, matches.length - limit), scope: 'local_catalog',
        ...(combined && matches.length === 2 ? { workflow: { actions: [subjects[0] + '.retrieve', combined],
            reason: 'Metadata and original bytes require separate reads with the same resource identity.' } } : {}),
        ...(!matches.length ? { guidance: ambiguous ? 'Use one affirmative intent and one subject or an exact action name.'
            : 'No action matched this intent and subject. Try an exact action name or the full catalog.' } : {}) };
}

const idPattern = '^[A-Za-z0-9_.-]{1,128}$';
const findingStatuses = ['observed', 'inferred', 'unverified'];
const nonblank = { type: 'string', pattern: '\\S' };
const findingProperties = {
    id: { type: 'string', pattern: idPattern },
    title: nonblank,
    evidence: { type: 'array', items: nonblank },
    status: { type: 'string', enum: findingStatuses },
    uncertainty: { type: 'string' },
};

const requiredFindingFields = Object.keys(findingProperties);
const findingVariant = (statuses, evidence) => ({ type: 'object', additionalProperties: false,
    required: requiredFindingFields, properties: { ...findingProperties,
        status: { type: 'string', enum: statuses }, evidence } });
export const auditSchema = {
    type: 'object', additionalProperties: false, required: ['findings'],
    properties: { findings: { type: 'array', items: { anyOf: [
        findingVariant(['observed'], { ...findingProperties.evidence, minItems: 1 }),
        findingVariant(['inferred', 'unverified'], findingProperties.evidence),
    ] } } },
};

export function validateAudit(report) {
    if (!report || Object.keys(report).length !== 1 || !Array.isArray(report.findings)) {
        throw Error('An audit report must contain a findings array.');
    }
    const ids = new Set();
    for (const finding of report.findings) {
        if (!finding || Object.keys(finding).length !== requiredFindingFields.length ||
            typeof finding.id !== 'string' || !/^[\w.-]{1,128}$/.test(finding.id) ||
            typeof finding.title !== 'string' || !finding.title.trim() ||
            !Array.isArray(finding.evidence) || finding.evidence.some(value => typeof value !== 'string' || !value.trim()) ||
            !findingProperties.status.enum.includes(finding.status) || typeof finding.uncertainty !== 'string' ||
            (finding.status === 'observed' && !finding.evidence.length) || ids.has(finding.id)) {
            throw Error('Invalid or duplicate audit finding. Observed findings require evidence references.');
        }
        ids.add(finding.id);
    }
    return { findingCount: ids.size, ids: [...ids], scope: 'structure_only' };
}

function validCount(value) { return Number.isSafeInteger(value) && value >= 0; }
function validMoney(value) { return Number.isFinite(value) && value >= 0; }
function zonedTime(value) {
    const match = typeof value === 'string' &&
        /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
    if (!match) return NaN;
    const [year, month, day] = match.slice(1, 4).map(Number);
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] ? Date.parse(value) : NaN;
}
function pricingDate(value) {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return zonedTime(value + 'T00:00:00Z');
    return zonedTime(value);
}

function remaining(limit, used) {
    return validCount(limit) && validCount(used) ? limit - used : null;
}

function cacheWriteCharges(total, split, requireSplit = false) {
    if (split) {
        const [short, long] = split;
        if (![short, long, short + long].every(validCount) || (total !== undefined && total !== short + long)) return null;
        return [[short, 'cacheWrite30m'], [long, 'cacheWrite12h']];
    }
    if (!validCount(total) || (requireSplit && total !== 0)) return null;
    return [[total, 'cacheWrite']];
}

export function estimateWork({ model, mode, pricing, scope, capacity = {}, forecast, usage }) {
    if (typeof model !== 'string' || !model || typeof mode !== 'string' || !mode || !forecast ||
        !validCount(forecast.inputTokens) || !validCount(forecast.outputTokens)) {
        throw Error('Supply model, mode and estimated input/output token counts. Include reasoning in output.');
    }
    const matchingPrice = pricing?.model === model && pricing?.mode === mode && typeof pricing.currency === 'string' &&
        /^[A-Z]{3}$/.test(pricing.currency) && typeof pricing.source === 'string' && Boolean(pricing.source) &&
        Number.isFinite(pricingDate(pricing.checkedAt));
    function tokenCost(input, output, cached, writes) {
        if (!writes || ![input, output, cached].every(validCount)) return null;
        const ordinary = input - cached - writes.reduce((sum, [count]) => sum + count, 0);
        if (ordinary < 0) return null;
        const bill = [[ordinary, 'input'], [cached, 'cachedInput'], ...writes, [output, 'output']];
        if (!matchingPrice || bill.some(([count, unit]) => count && !validMoney(pricing.perMillion?.[unit]))) return null;
        let total = 0;
        for (const [count, unit] of bill) {
            if (!count || !pricing.perMillion[unit]) continue;
            const rate = pricing.perMillion[unit];
            const product = count * rate;
            const amount = Number.isFinite(product) ? product / 1e6 : (count / 1e6) * rate;
            if (!amount) return NaN; // A nonzero charge fell below the representable range.
            total += amount;
        }
        return total;
    }
    const forecastSplit = forecast.cacheWriteTokensDetails;
    const forecastWrites = forecastSplit == null ? cacheWriteCharges(forecast.cacheWriteTokens ?? 0) :
        cacheWriteCharges(forecast.cacheWriteTokens, [forecastSplit.ttl30mTokens, forecastSplit.ttl12hTokens]);
    const estimatedAmount = tokenCost(forecast.inputTokens, forecast.outputTokens,
        forecast.cachedInputTokens ?? 0, forecastWrites);
    const usageDetails = usage?.input_tokens_details;
    const nativeWrites = usageDetails?.cache_write_tokens;
    const nativeSplit = usageDetails?.cache_write_tokens_details;
    const observedWrites = nativeWrites !== undefined || nativeSplit != null
        ? cacheWriteCharges(nativeWrites, nativeSplit == null ? undefined : [nativeSplit.ttl_30m_tokens, nativeSplit.ttl_12h_tokens], true)
        : cacheWriteCharges(usage?.cacheWriteTokens ?? 0);
    const observedAmount = usage ? tokenCost(usage.input_tokens, usage.output_tokens,
        usageDetails?.cached_tokens ?? usage.cachedInputTokens, observedWrites) : null;
    const estimate = validMoney(estimatedAmount) ? estimatedAmount : null;
    const observed = validMoney(observedAmount) ? observedAmount : null;
    const outOfRange = [estimatedAmount !== null && estimate === null && 'estimatedTokenCost',
        observedAmount !== null && observed === null && 'observedTokenCostAtGivenRates'].filter(Boolean);
    const windows = forecast.minuteWindows;
    const validWindows = Array.isArray(windows) && windows.length > 0 && windows.every(window =>
        validCount(window?.modelInputTokens) && validCount(window.modelOutputTokens) &&
        validCount(window.modelInputTokens + window.modelOutputTokens));
    const windowPeak = validWindows ? windows.reduce(
        (peak, window) => Math.max(peak, window.modelInputTokens + window.modelOutputTokens), 0) : null;
    const explicit = validCount(forecast.tpm) ? forecast.tpm : null;
    let baseTpm = null;
    if ((forecast.tpm == null || explicit !== null) && (windows === undefined || validWindows)) {
        if (explicit !== null || windowPeak !== null) baseTpm = Math.max(explicit ?? 0, windowPeak ?? 0);
        else if (mode === 'standard' && !forecast.multiStep) baseTpm = forecast.inputTokens + forecast.outputTokens;
    }
    const tpmHeadroom = forecast.tpmHeadroomTokens ?? 0;
    const tpmNeeded = validCount(baseTpm) && validCount(tpmHeadroom) ? baseTpm + tpmHeadroom : null;
    const label = value => typeof value === 'string' && Boolean(value.trim());
    const projectMatches = (scope?.project === null || label(scope?.project)) && capacity.project === scope.project;
    const modelMatches = scope?.limitGroup == null ? capacity.limitGroup == null && capacity.model === model :
        label(scope.limitGroup) && scope.limitGroup === capacity.limitGroup;
    const scopeMatches = label(scope?.organization) && scope.organization === capacity.organization &&
        projectMatches && modelMatches && mode === capacity.mode;
    const now = Date.now();
    const checkedAt = zonedTime(capacity.checkedAt);
    const validUntil = zonedTime(capacity.validUntil);
    const capacityExpired = Number.isFinite(validUntil) && validUntil < now;
    const method = typeof capacity.sourceMethod === 'string' ? capacity.sourceMethod.trim().toUpperCase() : undefined;
    const sourceAction = typeof capacity.sourceAction === 'string' ? capacity.sourceAction.trim().toLowerCase() : '';
    const sourceMetadata = operationCatalog()[sourceAction];
    const billingRead = sourceMetadata?.credential === 'openai-admin-api-key';
    const knownRead = ['read', 'download', 'watch', 'wait'].includes(sourceMetadata?.kind) ||
        /(?:\.(?:retrieve|list|search|inputtokens|content|downloadrecording|wait|status|stream)$|^retrieveresponse$|^models$)/.test(sourceAction);
    const sourceApplies = !billingRead &&
        (capacity.sourceMethod == null || ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) &&
        (!(knownRead || ['GET', 'HEAD'].includes(method)) || capacity.scopeConfirmed === true);
    const fresh = Boolean(sourceApplies && label(capacity.source) && checkedAt <= now && validUntil >= now && validUntil >= checkedAt);
    const priceCheckedAt = zonedTime(pricing?.checkedAt);
    const priceValidUntil = zonedTime(pricing?.validUntil);
    const checks = [
        ['tpm', remaining(capacity.tpm, capacity.tpmUsed), tpmNeeded],
        ['rpm', remaining(capacity.rpm, capacity.rpmUsed), forecast.rpm],
        ['sharedQueueInputTokens', remaining(capacity.sharedQueueInputTokens, capacity.sharedQueueUsed), forecast.queuedInputTokens],
    ].map(([kind, free, need]) => {
        const numericalFit = free !== null && validCount(need) ? need <= free : null;
        return { kind, free, need: validCount(need) ? need : null, numericalFit,
            fitsEstimate: scopeMatches && fresh ? numericalFit : null };
    });
    return { model, mode, currency: matchingPrice ? pricing.currency : null,
        estimatedTokenCost: estimate, observedTokenCostAtGivenRates: observed,
        estimateDelta: estimate !== null && observed !== null ? observed - estimate : null,
        ...(outOfRange.length ? { outOfRange } : {}),
        observedTokens: usage ? { input: usage.input_tokens, output: usage.output_tokens,
            reasoning: usage.output_tokens_details?.reasoning_tokens } : null,
        pricingEvidence: matchingPrice ? { source: pricing.source, checkedAt: pricing.checkedAt, validUntil: pricing.validUntil,
            fresh: priceCheckedAt <= now && priceValidUntil >= now && priceValidUntil >= priceCheckedAt } : null,
        peakTpm: { explicit, windowPeak, base: validCount(baseTpm) ? baseTpm : null,
            inputsDisagree: explicit !== null && windowPeak !== null && explicit !== windowPeak,
            headroom: validCount(tpmHeadroom) ? tpmHeadroom : null },
        capacityEvidence: Object.keys(capacity).length ? { source: capacity.source, sourceAction: capacity.sourceAction,
            sourceMethod: capacity.sourceMethod,
            checkedAt: capacity.checkedAt, validUntil: capacity.validUntil, organization: capacity.organization,
            project: capacity.project, model: capacity.model, limitGroup: capacity.limitGroup, mode: capacity.mode,
            scopeMatches, fresh, expired: capacityExpired,
            ...(billingRead ? { sourceApplicability: 'billing-only' } : {}) } : null,
        checks, advisoryOnly: true,
        note: 'Plan for later model rounds and shared capacity. Scoped fit uses the supplied source and its validity window. Both comparisons are advisory. Token cost excludes separate tool charges.' };
}

export function benchmark({ cases, runs }) {
    if (!Array.isArray(cases) || !cases.length || !Array.isArray(runs) || !runs.length) throw Error('Supply benchmark cases and runs.');
    const expected = new Map();
    for (const fixture of cases) {
        if (typeof fixture?.id !== 'string' || !fixture.id || expected.has(fixture.id) ||
            !Array.isArray(fixture.expected) || fixture.expected.some(id => typeof id !== 'string' || !id) ||
            new Set(fixture.expected).size !== fixture.expected.length) throw Error('Invalid benchmark case.');
        expected.set(fixture.id, new Set(fixture.expected));
    }
    const groups = new Map();
    const samples = [];
    for (const run of runs) {
        const truth = expected.get(run?.caseId);
        if (!truth || typeof run.profile !== 'string' || !run.profile.trim()) throw Error('Benchmark run needs a known caseId and profile.');
        validateAudit(run.report);
        const findings = run.report.findings;
        const matching = findings.filter(finding => truth.has(finding.id));
        const supported = findings.filter(finding => finding.status !== 'unverified' && finding.evidence.length);
        const referenceMatches = matching.length;
        const accepted = supported.filter(finding => truth.has(finding.id)).length;
        const row = { profile: run.profile, caseId: run.caseId, referenceMatches, accepted,
            unsubstantiated: findings.length - supported.length, falsePositives: findings.length - referenceMatches,
            missed: truth.size - accepted, elapsedMs: validCount(run.elapsedMs) ? run.elapsedMs : null,
            inputTokens: validCount(run.usage?.input_tokens) ? run.usage.input_tokens : null,
            cachedInputTokens: validCount(run.usage?.input_tokens_details?.cached_tokens) ? run.usage.input_tokens_details.cached_tokens : null,
            outputTokens: validCount(run.usage?.output_tokens) ? run.usage.output_tokens : null,
            billedUsd: validMoney(run.billedUsd) ? run.billedUsd : null };
        samples.push(row);
        if (!groups.has(run.profile)) groups.set(run.profile, []);
        groups.get(run.profile).push(row);
    }
    return { samples, profiles: [...groups].map(([profile, rows]) => {
        const outOfRange = [];
        const sum = key => {
            if (rows.some(row => row[key] === null)) return null;
            const total = rows.reduce((acc, row) => acc + row[key], 0);
            if (key === 'billedUsd' ? validMoney(total) : validCount(total)) return total;
            outOfRange.push(key);
            return null;
        };
        const cost = sum('billedUsd');
        const accepted = sum('accepted');
        return { profile, runs: rows.length, coveredCases: new Set(rows.map(row => row.caseId)).size,
            repetitionsByCase: Object.fromEntries([...expected.keys()].map(caseId =>
                [caseId, rows.filter(row => row.caseId === caseId).length])),
            referenceMatches: sum('referenceMatches'), accepted, unsubstantiated: sum('unsubstantiated'),
            missed: sum('missed'), falsePositives: sum('falsePositives'),
            elapsedMs: sum('elapsedMs'), inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'),
            cachedInputTokens: sum('cachedInputTokens'), billedUsd: cost,
            ...(outOfRange.length ? { outOfRange } : {}),
            billedUsdPerAccepted: cost !== null && accepted > 0 ? cost / accepted : null };
    }), scope: 'provided_results_only', note: 'Map equivalent findings to the same known IDs before grading. Compare profiles with the same cases and repetitions.' };
}

async function readJson(filename) { return parseApiJson(await localText(filename)); }
async function readBatchJson(filename) { return parseBatchJson(await localText(filename)); }

const entry = process.argv[1];
const isMain = import.meta.main ?? (entry && existsSync(entry) && realpathSync(entry) === fileURLToPath(import.meta.url));
if (isMain) {
    try {
        const [action, value, filter] = process.argv.slice(2);
        let result;
        if (action === 'discover') result = discover(value, filter === undefined ? undefined : Number(filter));
        else if (Object.hasOwn(localActions, action)) result = await localActions[action].run(value, filter);
        else throw Error('Choose one of ' + Object.keys(localActions).join(', ') + '.');
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } catch (error) {
        process.stderr.write(JSON.stringify({ error: error instanceof SyntaxError ? 'Invalid JSON or JSONL.' : error.message }) + '\n');
        process.exitCode = 1;
    }
}
