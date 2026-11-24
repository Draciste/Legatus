import { createHash, randomUUID } from 'node:crypto';

const programs = new Set(['standard', 'daybreak_blue', 'daybreak_red']);
const createActions = new Set(['sessions.create', 'responses.create']);
const billingCodes = new Set(['credit_balance_exhausted', 'insufficient_quota', 'billing_hard_limit_reached',
    'organization_spend_limit_exceeded', 'organization_usage_limit_exceeded']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => object(value) && Object.hasOwn(value, key);
const invalid = (code, message) => Object.assign(Error(message), { code });

export function describeDaybreak() {
    return {
        field: 'access_programs.cyber',
        createActions: [...createActions],
        programs: [...programs],
        projectAccess: 'not-checked',
        matrix: 'https://developers.openai.com/api/docs/guides/daybreak',
    };
}

export function prepareDaybreak(action, params) {
    if (action === 'sessions.create' || action === 'sessions.update') {
        if (own(params.agent, 'access_programs')) {
            throw invalid('daybreak_invalid_placement', 'Set access_programs at the root of the session create request.');
        }
    }
    if (action === 'sessions.events.create' && Array.isArray(params.events) &&
        params.events.some(event => own(event, 'access_programs'))) {
        throw invalid('daybreak_invalid_placement', 'Select the program when creating the session, before submitting input events.');
    }
    if (!Object.hasOwn(params, 'access_programs')) return undefined;
    const access = params.access_programs;
    if (!createActions.has(action)) {
        if (own(access, 'cyber')) {
            throw invalid('daybreak_unsupported_action', 'Use sessions.create or responses.create for an explicit cyber program.');
        }
        return undefined;
    }
    if (!object(access)) throw invalid('daybreak_invalid_program', 'access_programs must be a JSON object.');
    if (!Object.hasOwn(access, 'cyber')) return undefined;
    if (!programs.has(access.cyber)) {
        throw invalid('daybreak_invalid_program', 'Expected standard, daybreak_blue or daybreak_red in access_programs.cyber.');
    }
    const daybreak = {
        requestedProgram: access.cyber,
        acceptanceState: 'not-attempted',
        configurationState: 'unconfirmed',
    };
    if (action === 'sessions.create') {
        if (params.metadata != null && !object(params.metadata)) {
            throw invalid('daybreak_invalid_job_ref', 'Session metadata must be a JSON object.');
        }
        const existing = params.metadata?.job_ref;
        if (existing !== undefined && (typeof existing !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(existing))) {
            throw invalid('daybreak_invalid_job_ref', 'Use an opaque job_ref with letters, digits, underscores or hyphens.');
        }
        daybreak.jobRef = existing ?? randomUUID();
        params.metadata = { ...params.metadata, job_ref: daybreak.jobRef };
    }
    if (params.input !== undefined) {
        daybreak.inputSha256 = createHash('sha256').update(JSON.stringify(params.input), 'utf8').digest('hex');
    }
    return daybreak;
}

export function verifyDaybreakSession(daybreak, session) {
    if (daybreak?.jobRef && own(session?.metadata, 'job_ref') && session.metadata.job_ref !== daybreak.jobRef) {
        throw invalid('daybreak_correlation_mismatch', 'The session returned a different job_ref. Reconcile the original submission.');
    }
}

// Call only after checking the returned object's identity and attribution.
export function observeDaybreak(receipt, resource, source) {
    const access = resource?.access_programs;
    const requested = receipt.daybreak?.requestedProgram;
    const observed = programs.has(access?.cyber) ? access.cyber :
        resource?.object === 'response' && own(resource, 'access_programs') && access === null && requested
            ? 'standard' : undefined;
    if (!observed) return;
    receipt.daybreak = {
        ...receipt.daybreak,
        observedProgram: observed,
        observationSource: source,
        configurationState: requested ? (observed === requested ? 'confirmed' : 'mismatch') : 'observed',
    };
}

export function classifyOpenAiFailure({ httpStatus, apiCode, apiType }, { unconfirmed = false } = {}) {
    if (apiCode === 'cyber_policy' || apiType === 'cyber_policy') return 'provider-cyber-policy';
    if (httpStatus === 400 && apiCode === 'invalid_access_program') return 'model-program-mismatch';
    if (httpStatus === 400 && apiCode === 'unsupported_access_program') return 'program-unsupported';
    if (httpStatus === 403 && apiCode === 'access_program_not_enabled') return 'project-access-not-enabled';
    if (billingCodes.has(apiCode) || billingCodes.has(apiType)) return 'billing';
    if (apiCode === 'model_not_found' || apiCode === 'model_access_denied') return 'model-access';
    if (httpStatus === 401) return 'authentication';
    if (httpStatus === 403) return 'permission';
    if (httpStatus === 429) {
        return apiCode === 'rate_limit_exceeded' || ['rate_limit_exceeded', 'rate_limit_error'].includes(apiType)
            ? 'rate-limit' : 'quota-unconfirmed';
    }
    if (unconfirmed && (!httpStatus || httpStatus >= 500 || [408, 425].includes(httpStatus))) {
        return 'transport-unconfirmed';
    }
    return 'other';
}

export function responseSafetyOutcome(response) {
    if (response?.error?.code === 'cyber_policy') return 'provider-cyber-policy';
    if (response?.incomplete_details?.reason === 'content_filter') return 'content-filter';
    if (Array.isArray(response?.output) && response.output.some(item => item?.type === 'message' &&
        Array.isArray(item.content) && item.content.some(content => content?.type === 'refusal'))) return 'content-refusal';
    return undefined;
}
