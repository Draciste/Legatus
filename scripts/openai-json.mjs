const utf8 = new TextDecoder('utf-8', { fatal: true });

export function assertUniqueJsonMembers(text) {
    // Call after grammar validation, so a string followed by a colon is a key.
    const stack = [];
    const tokens = /"(?:[^"\\]|\\.)*"\s*:?|[{}\[\]]/g;
    for (const [token] of text.matchAll(tokens)) {
        if (token === '{') stack.push(new Set());
        else if (token === '[') stack.push(null);
        else if (token === '}' || token === ']') stack.pop();
        else if (token.endsWith(':')) {
            const keys = stack.at(-1);
            const name = JSON.parse(token.slice(0, -1));
            if (!keys || keys.has(name)) throw Object.assign(Error('Ambiguous duplicate JSON member.'), { code: 'ambiguous_json' });
            keys.add(name);
        }
    }
}

function normalizedNumber(text) {
    const [, sign, whole, fraction = '', power = '0'] = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(text);
    const digits = (whole + fraction).replace(/^0+/, '');
    if (!digits) return sign + '0';
    const significant = digits.replace(/0+$/, '');
    const exponent = Number(power) - fraction.length + digits.length - significant.length;
    return Number.isSafeInteger(exponent) ? sign + significant + 'e' + exponent : null;
}

export function parseApiJson(input, { preserveNumbers = false } = {}) {
    const text = typeof input === 'string' ? input : utf8.decode(input);
    const value = JSON.parse(text, (key, value, context) => {
        if (typeof value !== 'number') return value;
        const encoded = JSON.stringify(value);
        const source = context.source;
        if (source === encoded || (Number.isFinite(value) &&
            normalizedNumber(source) === normalizedNumber(encoded))) return value;
        if (preserveNumbers) return JSON.rawJSON(source);
        throw Object.assign(Error('This JSON contains a number the SDK cannot represent exactly. Use the buffered HTTP route for lossless JSON.'), {
            code: 'json_precision',
        });
    });
    assertUniqueJsonMembers(text);
    return value;
}

export function compareJsonArguments(sent, received) {
    let left, right;
    try {
        left = parseApiJson(sent, { preserveNumbers: true });
        if (sent === received) return 'verified';
        right = parseApiJson(received, { preserveNumbers: true });
    } catch {
        return sent === received ? 'partial' : 'mismatch';
    }
    const number = value => JSON.isRawJSON(value) ? value.rawJSON :
        typeof value === 'number' ? JSON.stringify(value) : undefined;
    const pairs = [[left, right]];
    while (pairs.length) {
        const [a, b] = pairs.pop();
        const x = number(a), y = number(b);
        if (x !== undefined || y !== undefined) {
            if (x !== y && (x === undefined || y === undefined || normalizedNumber(x) === null ||
                normalizedNumber(x) !== normalizedNumber(y))) return 'mismatch';
        } else if (a !== b) {
            if (!a || !b || typeof a !== 'object' || typeof b !== 'object' ||
                Array.isArray(a) !== Array.isArray(b)) return 'mismatch';
            const keys = Object.keys(a);
            if (keys.length !== Object.keys(b).length) return 'mismatch';
            for (const key of keys) {
                if (!Object.hasOwn(b, key)) return 'mismatch';
                pairs.push([a[key], b[key]]);
            }
        }
    }
    return 'verified';
}
