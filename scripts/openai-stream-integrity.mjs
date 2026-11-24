import {createHash} from 'node:crypto';

const historySize = 256;

function sortObjectMembers(_key, value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || JSON.isRawJSON(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
}

// Only an unbroken prefix can serve as a resume cursor. Older events outside
// the retained window remain unconfirmed rather than being applied again.
export function trackResponseStream(startingAfter) {
    const history = new Map();
    const counts = {duplicate: 0, conflict: 0, gap: 0, outOfOrder: 0, unsequenced: 0};
    let highest, firstSequence, contiguous = startingAfter, durable, hasAnomaly = false;
    let origin = startingAfter === undefined ? 'unconfirmed' : 'requested-cursor';

    function invalidatePrefix(sequence) {
        if (contiguous >= sequence) contiguous = sequence > firstSequence ? sequence - 1 : undefined;
        if (durable >= sequence) durable = contiguous;
    }

    function observe(event) {
        if (event.type === 'keepalive') return { disposition: 'keepalive', deliver: true };
        const sequence = event.sequence_number;
        if (!Number.isSafeInteger(sequence) || sequence < 0) {
            counts.unsequenced++;
            hasAnomaly = true;
            return { disposition: 'unsequenced', deliver: true };
        }
        // Padding is randomly generated transport metadata. Keep it on the
        // original event for capture and exclude only this documented field.
        const comparable = typeof event.obfuscation === 'string'
            ? Object.fromEntries(Object.entries(event).filter(([key]) => key !== 'obfuscation')) : event;
        const digest = createHash('sha256').update(JSON.stringify(comparable, sortObjectMembers)).digest('hex');
        const prior = history.get(sequence);
        if (prior === digest) {
            counts.duplicate++;
            return { disposition: 'duplicate', deliver: false };
        }
        if (prior != null) {
            counts.conflict++;
            hasAnomaly = true;
            invalidatePrefix(sequence);
            return { disposition: 'conflicting-sequence', deliver: false };
        }
        if (sequence <= (highest ?? startingAfter ?? -1)) {
            counts.outOfOrder++;
            hasAnomaly = true;
            invalidatePrefix(sequence);
            return { disposition: 'old-or-out-of-order', deliver: false };
        }
        const previous = highest ?? startingAfter;
        highest = sequence;
        if (firstSequence === undefined) {
            firstSequence = sequence;
            if (startingAfter === undefined && sequence === 0 && event.type === 'response.created' &&
                typeof event.response?.id === 'string' && /^resp_[A-Za-z0-9_-]+$/.test(event.response.id)) {
                origin = 'creation-observed';
            }
        }
        history.set(sequence, digest);
        if (history.size > historySize) history.delete(history.keys().next().value);
        if (previous !== undefined && sequence !== previous + 1) {
            counts.gap++;
            hasAnomaly = true;
            return { disposition: 'gap-before-event', deliver: true };
        }
        return { disposition: 'in-order', deliver: true, cursor: hasAnomaly ? undefined : sequence };
    }

    return {
        observe,
        get latest() { return highest; },
        delivered(cursor) { if (cursor !== undefined) contiguous = cursor; },
        synced() { if (origin !== 'unconfirmed' && contiguous !== startingAfter) durable = contiguous; },
        snapshot() {
            return {
                state: highest === undefined && !hasAnomaly ? 'no-sequence-observed' :
                    hasAnomaly || origin === 'unconfirmed' ? 'incomplete-history' : 'contiguous-observed',
                lastObservedSequence: highest,
                lastDeliveredContiguousSequence: contiguous === startingAfter ? undefined : contiguous,
                lastDurableContiguousSequence: durable,
                startingAfter, firstObservedSequence: firstSequence, origin,
                counts: {...counts},
            };
        },
    };
}
export function responseOutputIssue(response) {
    if (!response || (response.status !== 'completed' && response.output === undefined)) return;
    if (!Array.isArray(response.output)) return 'output-array';
    const typed = item => item !== null && typeof item === 'object' && !Array.isArray(item) &&
        typeof item.type === 'string' && item.type.trim().length > 0;
    for (const item of response.output) {
        if (!typed(item)) return 'output-item';
        if (item.type === 'message' && (!Array.isArray(item.content) || item.content.some(part => !typed(part) ||
            (part.type === 'output_text' && typeof part.text !== 'string') ||
            (part.type === 'refusal' && typeof part.refusal !== 'string')))) return 'output-message-content';
    }
}
