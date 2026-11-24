import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { benchmark, discover, estimateWork, validateAudit } from '../openai-workbench.mjs';
import { parseBatchJson, planBatchRecovery } from '../openai-batch-recovery.mjs';
import { runResponsesPilot } from '../openai-responses-pilot.mjs';

const finding = id => ({ id, title: 'Test finding', evidence: ['fixture:1'], status: 'observed', uncertainty: '' });

async function fixture(work) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'openai-workbench-'));
    try {
        return await work(dir);
    } finally {
        for (const name of await readdir(dir)) await unlink(path.join(dir, name));
        await rmdir(dir);
    }
}

const mcpEntry = fileURLToPath(new URL('../openai-workbench-mcp.mjs', import.meta.url));
const mcpTestEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(OPENAI_|CODEX_API_KEY$|NODE_|LEGATUS_MCP_)/i.test(name)));

function mcpReplies(dir, requests, { isolatedPath = false, powerShell = '', envelopes = false, initialization = {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' },
} } = {}) {
    const messages = [
        ['initialize', initialization],
        ...requests,
    ].map((request, id) => JSON.stringify(Array.isArray(request) && typeof request[0] === 'string'
        ? { jsonrpc: '2.0', id, method: request[0], params: request[1] } : request)).join('\n') + '\n';
    const argv = [mcpEntry, dir, dir, powerShell];
    let env = mcpTestEnv;
    if (isolatedPath) {
        env = Object.fromEntries(Object.entries(env).filter(([name]) => !/^PATH$/i.test(name)));
        env.PATH = dir;
        if (process.platform === 'win32') {
            // Windows restores ProgramFiles when a new process starts.
            argv.unshift('--input-type=module', '-e', "import { pathToFileURL } from 'node:url'; " +
                'process.env.ProgramFiles = process.argv[2]; await import(pathToFileURL(process.argv[1]).href);');
        }
    }
    const result = spawnSync(process.execPath, argv,
        { input: messages, encoding: 'utf8', timeout: 20_000, env });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result.stdout.trim().split('\n').map(line => {
        const message = JSON.parse(line);
        return envelopes ? message : message.result;
    });
}

test('MCP distinguishes rejected envelopes, missing tools, tool input errors and version fallback', () => fixture(dir => {
    const malformedIds = [null, true, 1.25, 9007199254740992].map(id => ({ jsonrpc: '2.0', id, method: 'ping' }));
    const [, unknown, unnamed, invalidArgs, toolError, unsupportedVersion, ...last] = mcpReplies(dir, [
        ['tools/call', { name: 'missing' }],
        ['tools/call', {}],
        ['tools/call', { name: 'find_action', arguments: [] }],
        ['tools/call', { name: 'find_action', arguments: { query: 'files.list', limit: 0 } }],
        ['tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } }],
        ...malformedIds,
        { jsonrpc: '2.0', id: 'valid', method: 'ping' },
    ], { envelopes: true });
    assert.ok([unknown, unnamed, invalidArgs].every(reply => reply.error.code === -32602 && !reply.result));
    assert.equal(toolError.result.structuredContent.code, 'invalid_tool_input');
    assert.match(toolError.result.structuredContent.message, /1 to 12/);
    assert.equal(unsupportedVersion.error.code, -32022);
    assert.ok(unsupportedVersion.error.data.supported.includes('2025-11-25'));
    assert.ok(last.slice(0, 4).every(reply => reply.error.code === -32600 && reply.id === null));
    assert.deepEqual(last[4], { jsonrpc: '2.0', id: 'valid', result: {} });
}));

test('MCP negotiates real batch support and can repair an incomplete handshake in place', () => fixture(dir => {
    const hello = { capabilities: {}, clientInfo: { name: 'fixture', version: '1' } };
    const ready = { jsonrpc: '2.0', method: 'notifications/initialized' };
    const batch = [{ jsonrpc: '2.0', id: 'first', method: 'ping' }, ready,
        { jsonrpc: '2.0', id: 'second', method: 'tools/list' }];
    for (const protocolVersion of ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']) {
        const [, reply, after] = mcpReplies(dir, [batch, ['ping']], {
            envelopes: true, initialization: { ...hello, protocolVersion },
        });
        if (protocolVersion === '2024-11-05' || protocolVersion === '2025-03-26') {
            assert.deepEqual(reply.map(row => row.id), ['first', 'second']);
            assert.ok(reply[1].result.tools.length);
        } else assert.equal(reply.error.code, -32600);
        assert.deepEqual(after.result, {});
    }
    const good = { ...hello, protocolVersion: '2025-11-25' };
    for (const field of ['clientInfo', 'capabilities', 'protocolVersion']) {
        const bad = { ...good, [field]: undefined };
        const [failure, correction, badCursor, firstPage] = mcpReplies(dir, [
            ['initialize', good], ['tools/list', { cursor: 'unused' }], ['tools/list'],
        ], { envelopes: true, initialization: bad });
        assert.equal(failure.error.code, -32602);
        assert.equal(correction.result.protocolVersion, good.protocolVersion);
        assert.equal(badCursor.error.code, -32602);
        assert.equal(firstPage.result.nextCursor, undefined);
    }
    const [, tooLarge, resumed] = mcpReplies(dir, [['ping', { payload: 'x'.repeat(128 * 1024) }], ['ping']],
        { envelopes: true });
    assert.equal(tooLarge.error.code, -32600);
    assert.deepEqual(resumed.result, {});
}));

test('discover chooses a scoped local recovery action', () => {
    const result = discover('obnov nedokončenou dávku', 3);
    assert.equal(result.matches.length, 3);
    assert.equal(result.matches[0].action, 'batch.plan');
    assert.equal(result.matches[0].startsRemoteWork, false);
    assert.equal(discover('ověř stav relace').matches[0].action, 'sessions.retrieve');
    assert.equal(discover('ověř stav dávky').matches[0].action, 'batches.retrieve');
    assert.equal(discover('responses.pilot').matches[0].syntheticOnly, true);
    assert.equal(discover('workspace.status').matches[0].credential, 'workspace-access-token');
    assert.equal(discover('responses.inputtokens').matches[0].usesNetwork, true);
    assert.equal(discover('vectorstores.delete').matches[0].mutatesRemoteState, true);
    assert.equal(discover('vectorstores.delete').matches[0].startsJob, false);
    assert.equal(discover('start live audio').matches[0].action, 'live.audio');
    assert.deepEqual(discover('get file bytes and metadata', 1).workflow.actions, ['files.retrieve', 'files.content']);
});

test('MCP discovery agrees with Czech and English intent and declines incompatible actions', () => fixture(async dir => {
    const cases = [
        ['zastav běžící relaci', undefined], ['zruš dávku', 'batches.cancel'],
        ['cancel a batch', 'batches.cancel'], ['get status of a batch', 'batches.retrieve'],
        ['vyhledat ve vektorovém úložišti', 'vectorstores.search'],
        ['do not cancel the batch', undefined], ['smaž nebo zruš dávku', undefined],
        ['batches.cancel', 'batches.cancel'], ['generate image', 'images.generate'],
        ['find models', 'models.list'], ['find batch status', 'batches.retrieve'],
        ['wait for batch status', 'batches.wait'], ['cancel batch status', undefined],
        ['start live audio', 'live.audio'],
    ];
    const [, ...replies] = mcpReplies(dir, cases.map(([query]) =>
        ['tools/call', { name: 'find_action', arguments: { query } }]));
    for (let index = 0; index < cases.length; index++) {
        const [query, expected] = cases[index];
        const actual = JSON.parse(replies[index].content[0].text);
        assert.equal(actual.matches[0]?.action, expected, query);
        if (!expected) assert.match(actual.guidance, /exact action name/);
    }
}));

test('estimates avoid intermediate overflow and label out-of-range monetary totals', () => {
    const forecast = { inputTokens: 2, outputTokens: 0 };
    const rates = { model: 'fixture', mode: 'standard', currency: 'USD', source: 'fixture',
        checkedAt: '2026-11-24', perMillion: { input: 1e308 } };
    const estimate = forecast => estimateWork({ model: 'fixture', mode: 'standard', pricing: rates, forecast });
    assert.ok(Math.abs(estimate(forecast).estimatedTokenCost / 2e302 - 1) < 1e-12);
    const over = JSON.parse(JSON.stringify(estimate({ ...forecast, inputTokens: 2_000_000 })));
    assert.equal(over.estimatedTokenCost, null);
    assert.deepEqual(over.outOfRange, ['estimatedTokenCost']);
    const profile = benchmark({ cases: [{ id: 'A', expected: [] }], runs: Array.from({ length: 2 }, () =>
        ({ caseId: 'A', profile: 'fixture', billedUsd: 1e308, report: { findings: [] } })) }).profiles[0];
    assert.equal(profile.billedUsd, null);
    assert.deepEqual(profile.outOfRange, ['billedUsd']);
    const tiny = estimateWork({ model: 'fixture', mode: 'standard',
        pricing: { ...rates, perMillion: { input: Number.MIN_VALUE } }, forecast });
    assert.equal(tiny.estimatedTokenCost, null);
    assert.deepEqual(tiny.outOfRange, ['estimatedTokenCost']);
});

test('benchmark distinguishes exact limits, absent metrics and out-of-range integer totals', () => {
    const summarize = second => benchmark({ cases: [{ id: 'A', expected: [] }], runs: [
        { caseId: 'A', profile: 'fixture', elapsedMs: Number.MAX_SAFE_INTEGER - 1,
            usage: { input_tokens: Number.MAX_SAFE_INTEGER }, report: { findings: [] } },
        { caseId: 'A', profile: 'fixture', elapsedMs: second, usage: { input_tokens: 2 },
            report: { findings: [] } },
    ] }).profiles[0];
    assert.equal(summarize(1).elapsedMs, Number.MAX_SAFE_INTEGER);
    const over = summarize(2);
    assert.equal(over.inputTokens, null);
    assert.equal(over.elapsedMs, null);
    assert.equal(over.outputTokens, null);
    assert.deepEqual(over.outOfRange, ['elapsedMs', 'inputTokens']);
});

test('forecast flags a crowded queue without generating limits or double-counting reasoning', () => {
    const input = { model: 'fixture', mode: 'batch',
        forecast: { inputTokens: 1000000, outputTokens: 500000, queuedInputTokens: 100 },
        pricing: { model: 'fixture', mode: 'batch', currency: 'USD', checkedAt: '2026-11-21', source: 'fixture',
            perMillion: { input: 2, cachedInput: 1, output: 6 } },
        capacity: { sharedQueueInputTokens: 1000, sharedQueueUsed: 950 },
        usage: { input_tokens: 1000000, output_tokens: 1000000, input_tokens_details: { cached_tokens: 500000 },
            output_tokens_details: { reasoning_tokens: 900000 } } };
    const result = estimateWork(input);
    assert.equal(result.estimatedTokenCost, 5);
    assert.equal(result.observedTokenCostAtGivenRates, 7.5);
    const queue = result.checks.find(check => check.kind === 'sharedQueueInputTokens');
    assert.equal(queue.numericalFit, false);
    assert.equal(queue.fitsEstimate, null);
    assert.equal(result.advisoryOnly, true);
    assert.equal(result.max_output_tokens, undefined);
    assert.equal(estimateWork({ ...input, mode: 'flex' }).estimatedTokenCost, null);
});

test('peak TPM uses the maximum supplied estimate and reports only fresh scoped fit', () => {
    const before = new Date(Date.now() - 60_000).toISOString();
    const after = new Date(Date.now() + 60_000).toISOString();
    const input = { model: 'fixture', mode: 'standard', scope: { organization: 'org_fixture', project: 'proj_fixture' },
        forecast: { inputTokens: 700, outputTokens: 100, multiStep: true, tpm: 250, tpmHeadroomTokens: 50,
            minuteWindows: [{ modelInputTokens: 500, modelOutputTokens: 100 }] },
        capacity: { tpm: 800, tpmUsed: 300, organization: 'org_fixture', project: 'proj_fixture', model: 'fixture',
            mode: 'standard', source: 'fixture quota observation', checkedAt: before, validUntil: after } };
    const predicted = estimateWork(input);
    assert.deepEqual(predicted.peakTpm, { explicit: 250, windowPeak: 600, base: 600, inputsDisagree: true, headroom: 50 });
    assert.deepEqual(predicted.checks[0], { kind: 'tpm', free: 500, need: 650, numericalFit: false, fitsEstimate: false });
    assert.equal(predicted.capacityEvidence.scopeMatches, true);
    assert.equal(predicted.capacityEvidence.fresh, true);

    for (const overrides of [{ project: 'different-project' }, { mode: 'batch' }, { model: 'another-model' },
        { limitGroup: 'unexpected-group' }, { validUntil: undefined }, { checkedAt: after }, { validUntil: before },
        { checkedAt: before.slice(0, -1) }, { sourceMethod: 'GET' }, { sourceAction: 'responses.retrieve' }, { source: '' }]) {
        const result = estimateWork({ ...input, capacity: { ...input.capacity, ...overrides } });
        assert.equal(result.checks[0].numericalFit, false);
        assert.equal(result.checks[0].fitsEstimate, null);
    }
    const scopedGet = estimateWork({ ...input, capacity: { ...input.capacity, sourceMethod: 'GET', scopeConfirmed: true } });
    assert.equal(scopedGet.checks[0].fitsEstimate, false);
    const group = estimateWork({ ...input, scope: { organization: 'org_fixture', project: null, limitGroup: 'shared' },
        capacity: { ...input.capacity, project: null, model: 'group-member', limitGroup: 'shared', tpm: 1100 } });
    assert.equal(group.checks[0].fitsEstimate, true);
    const badPeak = estimateWork({ ...input, forecast: { ...input.forecast, minuteWindows: [{ modelInputTokens: -1 }] } });
    assert.equal(badPeak.checks[0].need, null);
    assert.equal(badPeak.checks[0].fitsEstimate, null);
});

test('cache estimates use the Responses TTL breakdown and keep ambiguous writes unknown', () => {
    const usageDetails = { cached_tokens: 4000, cache_write_tokens: 7000,
        cache_write_tokens_details: { ttl_30m_tokens: 3000, ttl_12h_tokens: 4000 } };
    const input = { model: 'fixture', mode: 'standard',
        forecast: { inputTokens: 12000, outputTokens: 0, cachedInputTokens: 4000,
            cacheWriteTokensDetails: { ttl30mTokens: 3000, ttl12hTokens: 4000 } },
        pricing: { model: 'fixture', mode: 'standard', currency: 'USD', source: 'fixture', checkedAt: '2026-11-21',
            perMillion: { input: 8, cachedInput: 0.4, cacheWrite: 10, cacheWrite30m: 10, cacheWrite12h: 20, output: 40 } },
        usage: { input_tokens: 12000, output_tokens: 0, input_tokens_details: usageDetails } };
    const cost = estimateWork(input);
    assert.ok(Math.abs(cost.estimatedTokenCost - 0.1196) < 1e-12);
    assert.equal(cost.observedTokenCostAtGivenRates, cost.estimatedTokenCost);

    for (const input_tokens_details of [
        { ...usageDetails, cache_write_tokens_details: undefined },
        { ...usageDetails, cache_write_tokens: 8000 },
        { ...usageDetails, cached_tokens: 6000 },
    ]) {
        assert.equal(estimateWork({ ...input, usage: { ...input.usage, input_tokens_details } }).observedTokenCostAtGivenRates, null);
    }
    const perMillion = { ...input.pricing.perMillion, cacheWrite12h: undefined };
    assert.equal(estimateWork({ ...input, pricing: { ...input.pricing, perMillion } }).observedTokenCostAtGivenRates, null);
    const nullWrite = estimateWork({ ...input, usage: { ...input.usage, input_tokens_details: { cached_tokens: 4000,
        cache_write_tokens: 0 } } });
    assert.ok(Math.abs(nullWrite.observedTokenCostAtGivenRates - 0.0656) < 1e-12);
    const legacyWrite = estimateWork({ ...input,
        forecast: { ...input.forecast, cacheWriteTokensDetails: undefined, cacheWriteTokens: 7000 },
        usage: { ...input.usage, input_tokens_details: { cached_tokens: 4000 }, cacheWriteTokens: 7000 } });
    assert.ok(Math.abs(legacyWrite.estimatedTokenCost - 0.0796) < 1e-12);
    assert.equal(legacyWrite.observedTokenCostAtGivenRates, legacyWrite.estimatedTokenCost);
});

test('audit IDs are strings and score only matching reference IDs', () => {
    for (const invalid of [42, ['F1']]) assert.throws(() => validateAudit({ findings: [finding(invalid)] }));
    assert.throws(() => validateAudit({ findings: [finding('F1'), finding('F1')] }));
    const report = { findings: [finding('F1'), finding('extra')] };
    const result = benchmark({ cases: [{ id: 'A', expected: ['F1', 'F2'] }],
        runs: [{ caseId: 'A', profile: 'baseline', report, billedUsd: 0.5 }] });
    assert.equal(result.profiles[0].accepted, 1);
    assert.equal(result.profiles[0].missed, 1);
    assert.equal(result.profiles[0].falsePositives, 1);
    assert.equal(result.profiles[0].billedUsdPerAccepted, 0.5);
    assert.equal(result.profiles[0].inputTokens, null);
});

test('benchmark reports reference hits separately from evidence-backed findings', () => {
    const report = { findings: [
        { ...finding('F1'), status: 'unverified' },
        { ...finding('F2'), status: 'inferred', evidence: [] },
        { ...finding('F3'), status: 'inferred' },
        finding('extra'),
    ] };
    const result = benchmark({ cases: [{ id: 'A', expected: ['F1', 'F2', 'F3'] }],
        runs: [{ caseId: 'A', profile: 'fixture', report, billedUsd: 0.6 }] });
    for (const row of [result.samples[0], result.profiles[0]]) {
        assert.equal(row.referenceMatches, 3);
        assert.equal(row.accepted, 1);
        assert.equal(row.missed, 2);
        assert.equal(row.unsubstantiated, 2);
        assert.equal(row.falsePositives, 1);
    }
    assert.equal(result.profiles[0].billedUsdPerAccepted, 0.6);
    assert.deepEqual(result.profiles[0].repetitionsByCase, { A: 1 });
});

test('batch retry publishes only explicit unexecuted rows and verifies artifact integrity', () => fixture(async dir => {
    async function artifact(name, id, rows) {
        const target = path.join(dir, name);
        const text = rows.map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n') + '\n';
        await writeFile(target, text);
        return { path: target, fileId: id, bytes: Buffer.byteLength(text),
            sha256: createHash('sha256').update(text).digest('hex') };
    }
    const endpoint = '/v1/responses';
    const requests = ['Done', 'done'].map(custom_id => ({ custom_id, method: 'POST', url: endpoint,
        body: { model: 'fixture', temperature: 0.125 } }));
    const originalLine = JSON.stringify(requests[1]).replace('0.125', '0.125000000000000000000001');
    const original = await artifact('input.jsonl', 'file-in', [requests[0], originalLine]);
    const output = await artifact('output.jsonl', 'file-out',
        [{ custom_id: 'Done', response: { status_code: 200, body: { status: 'completed' } } }]);
    const errors = await artifact('error.jsonl', 'file-error',
        [{ custom_id: 'done', response: null, error: { code: 'batch_expired' } }]);
    const input = { receipt: { action: 'files.content', requestedId: 'file-in' }, data: original };
    const batch = { object: 'batch', id: 'batch_x', input_file_id: 'file-in', output_file_id: 'file-out',
        error_file_id: 'file-error', endpoint, status: 'expired', request_counts: { total: 2, completed: 1, failed: 1 } };
    const batchWait = { receipt: { action: 'batches.wait', requestedId: batch.id },
        data: { batch, files: [{ ...output, type: 'output' }, { ...errors, type: 'error' }] } };
    const retryPath = path.join(dir, 'retry.jsonl');
    const plan = await planBatchRecovery({ wait: batchWait, input, retryPath });
    assert.equal(plan.submitted, false);
    assert.equal(plan.tally.returned, 1);
    assert.deepEqual(JSON.parse(await readFile(retryPath, 'utf8')), requests[1]);
    assert.equal(await readFile(retryPath, 'utf8'), originalLine + '\n');
    assert.equal(plan.publication.sha256, createHash('sha256').update(originalLine + '\n').digest('hex'));
    const alternate = await artifact('alternate.jsonl', 'file-out',
        [{ custom_id: 'Done', response: { status_code: 200, body: { status: 'incomplete' } } }]);
    const supplied = { receipt: { action: 'files.content', requestedId: alternate.fileId }, data: alternate };
    await assert.rejects(() => planBatchRecovery({ wait: batchWait, input, output: supplied }), /receipts disagree/);
    const unavailable = { ...batchWait, data: { ...batchWait.data, files: [
        {fileId:'file-out',type:'output',error:{category:'synthetic_unavailable'}},{...errors,type:'error'},
    ] } };
    assert.equal((await planBatchRecovery({wait:unavailable,input,output:supplied})).canPublish,true);
    const roundedCounts = parseBatchJson('{"total":2.000000000000000001,"completed":1,"failed":1}');
    const rounding = await planBatchRecovery({ wait: { ...batchWait, data: { ...batchWait.data,
        batch: { ...batch, request_counts: roundedCounts } } }, input });
    assert.equal(rounding.countsMatch, false);
    assert.equal(rounding.canPublish, false);
    await assert.rejects(() => planBatchRecovery({ wait: { ...batchWait, receipt: { ...batchWait.receipt,
        resourceId: 'batch_other' } }, input }), /matching terminal Batch/);
    await assert.rejects(() => planBatchRecovery({ wait: { ...batchWait, data: { ...batchWait.data,
        batch: { ...batch, endpoint: '' } } }, input }), /valid endpoint/);
    assert.equal((await planBatchRecovery({ wait: { ...batchWait, data: { ...batchWait.data,
        batch: { ...batch, status: 'cancelled' } } }, input })).canPublish, false);
    await assert.rejects(() => planBatchRecovery({ wait: batchWait, input, retryPath }), /exists/i);
    const altered = (await readFile(output.path, 'utf8')).replace('completed', 'incomplet');
    await writeFile(output.path, altered);
    await assert.rejects(() => planBatchRecovery({ wait: batchWait, input }), /recorded download/);
}));

test('Batch evidence rejects duplicate members in receipts and all joined rows', () => fixture(async dir => {
    async function artifact(name, id, text) {
        const target = path.join(dir, name);
        await writeFile(target, text + '\n');
        return { path: target, fileId: id, bytes: Buffer.byteLength(text + '\n'),
            sha256: createHash('sha256').update(text + '\n').digest('hex') };
    }
    const endpoint = '/v1/responses';
    const request = '{"custom_id":"one","method":"POST","url":"/v1/responses","body":{"model":"fixture"}}';
    const response = '{"custom_id":"one","response":{"status_code":200,"body":{"status":"completed"}}}';
    const batch = { object: 'batch', id: 'batch_fixture', input_file_id: 'file-in', output_file_id: 'file-out',
        endpoint, status: 'completed', request_counts: { total: 1, completed: 1, failed: 0 } };
    const input = { receipt: { action: 'files.content', requestedId: 'file-in' }, data: await artifact('input.jsonl', 'file-in', request) };
    const output = await artifact('output.jsonl', 'file-out', response);
    const wait = { receipt: { action: 'batches.wait', requestedId: batch.id }, data: { batch, files: [{ ...output, type: 'output' }] } };
    assert.equal((await planBatchRecovery({ wait, input })).tally.returned, 1);
    const repeatedInput = request.replace('"model":"fixture"', '"model":"fixture","model":"fixture"');
    const badInput = { ...input, data: await artifact('input.jsonl', 'file-in', repeatedInput) };
    await assert.rejects(() => planBatchRecovery({ wait, input: badInput }), /Ambiguous duplicate JSON member/);
    input.data = await artifact('input.jsonl', 'file-in', request);

    const repeatedOutput = response.replace('"status":"completed"', '"status":"completed","status":"completed"');
    const badOutput = await artifact('output.jsonl', 'file-out', repeatedOutput);
    await assert.rejects(() => planBatchRecovery({ wait: { ...wait, data: { batch, files: [{ ...badOutput, type: 'output' }] } },
        input }), /Ambiguous duplicate JSON member/);

    const repeatedError = '{"custom_id":"one","response":null,"error":{"code":"fixture","code":"fixture"}}';
    const badError = await artifact('error.jsonl', 'file-error', repeatedError);
    await assert.rejects(() => planBatchRecovery({ wait: { ...wait, data: {
        batch: { ...batch, status: 'failed', output_file_id: null, error_file_id: 'file-error' },
        files: [{ ...badError, type: 'error' }],
    } }, input }), /Ambiguous duplicate JSON member/);
    assert.throws(() => parseBatchJson('{"receipt":{"action":"batches.wait","\\u0061ction":"batches.wait"}}'), /Ambiguous duplicate JSON member/);

    const planPath = path.join(dir, 'plan.json');
    await writeFile(planPath, '{"waitReceiptPath":"first.json","waitReceiptPath":"second.json"}');
    const entry = fileURLToPath(new URL('../openai-workbench.mjs', import.meta.url));
    const cli = spawnSync(process.execPath, [entry, 'batch.plan', planPath], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /Ambiguous duplicate JSON member/);
}));

test('MCP job hint preserves UTF-8 paths, resumes an interrupted wait and constrains result paths', ctx => fixture(async dir => {
    const windows = process.platform === 'win32';
    const candidates = windows
        ? [path.join(process.env.ProgramFiles || 'C:/Program Files', 'PowerShell/7/pwsh.exe'), 'pwsh.exe']
        : ['pwsh'];
    const installed = candidates.some(executable => spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive',
        '-Command', '[Console]::Write($PSVersionTable.PSVersion.Major)'],
        { cwd: dir, encoding: 'utf8', timeout: 10_000, env: mcpTestEnv }).stdout?.trim() === '7');
    if (!installed) {
        ctx.skip('PowerShell 7 is required for the checkpoint integration test.');
        return;
    }
    const checkpoint = path.join(dir, 'příliš žluťoučký.jsonl');
    const resultText = 'syntetický výsledek';
    await writeFile(checkpoint, JSON.stringify({ action: 'batches.wait', phase: 'wait_started',
        attemptId: 'attempt_a', requestedId: 'batch_known' }) + '\n{"phase":');
    const steerCheckpoint = 'steering.jsonl';
    await writeFile(path.join(dir, steerCheckpoint), JSON.stringify({ action: 'responses.steer', phase: 'steering_ended',
        clientRequestId: 'fixture-steering', storeRequested: true, originalResponseId: 'resp_original',
        continuationResponseId: 'resp_successor', originalStatus: 'incomplete', steerDispatch: 'accepted',
        providerErrorCode: 'fixture_error', pendingReason: 'waiting_for_required_input', pendingInputCount: 2,
        outcome: 'unconfirmed', outcomeUnconfirmed: true }) + '\n');
    const upload = { action: 'uploads.complete', phase: 'error', clientRequestId: 'fixture-upload',
        uploadId: 'upload_finished', observedFileId: 'file_observed', outcomeUnconfirmed: true };
    await writeFile(path.join(dir, 'upload.jsonl'), JSON.stringify(upload) + '\n');
    await writeFile(path.join(dir, 'upload-conflict.jsonl'), [upload, { ...upload, fileId: 'file_conflicting' }]
        .map(row => JSON.stringify(row)).join('\n') + '\n');
    await writeFile(path.join(dir, 'result.md'), resultText);
    const replies = mcpReplies(dir, [
        ['tools/list', {}],
        ['tools/call', { name: 'list_jobs' }],
        ['tools/call', { name: 'read_result', arguments: { name: 'result.md' } }],
        ['tools/call', { name: 'read_result', arguments: { name: '../result.md' } }],
    ]);
    assert.equal(replies[0].protocolVersion, '2025-11-25');
    assert.equal(replies[0].serverInfo.name, 'legatus-mcp');
    assert.deepEqual(replies[1].tools.map(tool => tool.name), ['find_action', 'list_jobs', 'read_result']);
    const jobs = JSON.parse(replies[2].content[0].text).jobs;
    const job = jobs.find(job => path.basename(job.checkpoint) === path.basename(checkpoint));
    assert.equal(path.basename(job.checkpoint), path.basename(checkpoint));
    assert.equal(job.next.action, 'batches.retrieve');
    assert.equal(job.next.id, 'batch_known');
    assert.equal(job.partialTail, true);
    assert.equal(job.serverStateVerified, false);
    const steering = jobs.find(job => path.basename(job.checkpoint) === steerCheckpoint);
    assert.equal(steering.originalStatus, 'incomplete');
    assert.equal(steering.providerErrorCode, 'fixture_error');
    assert.equal(steering.pendingReason, 'waiting_for_required_input');
    assert.equal(steering.pendingInputCount, 2);
    assert.equal(steering.outcomeUnconfirmed, true);
    assert.equal(steering.serverStateVerified, false);
    assert.equal(steering.next.action, 'responses.retrieve');
    assert.equal(steering.next.id, 'resp_successor');
    const observed = jobs.find(job => path.basename(job.checkpoint) === 'upload.jsonl');
    assert.equal(observed.fileId, undefined);
    assert.equal(observed.observedFileId, 'file_observed');
    assert.equal(observed.outcomeUnconfirmed, true);
    assert.equal(observed.next.action, 'files.retrieve');
    assert.equal(observed.next.id, 'file_observed');
    const conflict = jobs.find(job => path.basename(job.checkpoint) === 'upload-conflict.jsonl');
    assert.equal(conflict.state, 'conflicting_resource_ids');
    assert.deepEqual(conflict.conflictFields, ['fileId', 'observedFileId']);
    assert.equal(conflict.next.id, null);
    const resultFile = JSON.parse(replies[3].content[0].text);
    assert.equal(resultFile.trust, 'untrusted_local_result');
    assert.equal(resultFile.text, resultText);
    assert.equal(replies[4].isError, true);
}));

test('MCP distinguishes a size limit, missing file and invalid encoding without exposing paths', () => fixture(async dir => {
    const maxBytes = 32 * 1024;
    await writeFile(path.join(dir, 'at-limit.txt'), Buffer.alloc(maxBytes, 32));
    await writeFile(path.join(dir, 'over-limit.txt'), Buffer.alloc(maxBytes + 1, 32));
    await writeFile(path.join(dir, 'invalid.txt'), Buffer.from([0xff]));
    const [, valid, oversized, missing, invalid] = mcpReplies(dir,
        ['at-limit.txt', 'over-limit.txt', 'missing.txt', 'invalid.txt'].map(name =>
            ['tools/call', { name: 'read_result', arguments: { name } }]));
    assert.equal(JSON.parse(valid.content[0].text).text.length, maxBytes);
    for (const [reply, code] of [[oversized, 'file_too_large'], [missing, 'file_not_found'], [invalid, 'invalid_utf8']]) {
        assert.equal(reply.isError, true);
        assert.equal(reply.structuredContent.code, code);
        assert.deepEqual(JSON.parse(reply.content[0].text), reply.structuredContent);
        assert.equal(reply.content[0].text.includes(dir), false);
    }
    assert.equal(oversized.structuredContent.limitBytes, maxBytes);
}));

test('MCP reports missing PowerShell and keeps JavaScript tools available', () => fixture(async dir => {
    await writeFile(path.join(dir, 'result.txt'), 'fixture result');
    const [, jobs, actions, result] = mcpReplies(dir, [
        ['tools/call', { name: 'list_jobs' }],
        ['tools/call', { name: 'find_action', arguments: { query: 'batch.plan', limit: 1 } }],
        ['tools/call', { name: 'read_result', arguments: { name: 'result.txt' } }],
    ], { isolatedPath: true });
    assert.equal(jobs.isError, true);
    assert.match(jobs.content[0].text, /PowerShell 7.*unavailable.*list_jobs.*PATH/);
    assert.equal(JSON.parse(actions.content[0].text).matches[0].action, 'batch.plan');
    assert.equal(JSON.parse(result.content[0].text).text, 'fixture result');

    const [, configuredJobs] = mcpReplies(dir, [['tools/call', { name: 'list_jobs' }]],
        { powerShell: path.join(dir, 'missing executable') });
    assert.equal(configuredJobs.isError, true);
    assert.match(configuredJobs.content[0].text, /configured PowerShell 7 executable.*absolute path/);
}));

test('WebSocket pilot distinguishes transport completion, content mismatch and incomplete transport', async () => {
    const pass = 'ORCHID-724';
    const noMatch = 'other code';
    const cases = [
        { output: pass, status: 'completed', transportCompleted: true, expectedOutputsMatched: true, exitCode: 0 },
        { output: noMatch, status: 'comparison_failed', transportCompleted: true, expectedOutputsMatched: false, exitCode: 1 },
        { output: null, status: 'partial', transportCompleted: false, expectedOutputsMatched: null, exitCode: 1 },
    ];
    const originalExitCode = process.exitCode;
    try {
        for (const expected of cases) {
            process.exitCode = 0;
            function terminal(id) {
                if (expected.output === null) return { type: 'response.incomplete', response: { id, object: 'response', status: 'incomplete' } };
                return { type: 'response.completed', response: { id, object: 'response', status: 'completed', output: [
                    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: expected.output }] },
                ] } };
            }
            class FixtureWebSocket extends EventTarget {
                readyState = 0;
                turns = 0;
                constructor() {
                    super();
                    queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); });
                }
                send() {
                    const data = JSON.stringify(terminal('resp_ws' + ++this.turns));
                    queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data })));
                }
                close() { this.readyState = 3; }
            }
            let httpTurns = 0;
            const client = { baseURL: 'https://api.openai.com/v1', WebSocketTransport: FixtureWebSocket, responses: {
                create: () => ({ withResponse: async () => ({
                    data: (async function* () { yield terminal('resp_http' + ++httpTurns); })(),
                    response: new Response('', { headers: { 'Content-Type': 'text/event-stream' } }),
                }) }),
            } };
            const results = [];
            await runResponsesPilot(client, 'sk-fixture_placeholder', { request: { model: 'fixture' } }, value => results.push(value));
            const { data } = results[0];
            assert.equal(data.status, expected.status);
            assert.equal(data.transportCompleted, expected.transportCompleted);
            assert.equal(data.expectedOutputsMatched, expected.expectedOutputsMatched);
            assert.equal(data.comparisonAvailable, expected.expectedOutputsMatched === true);
            assert.equal(process.exitCode, expected.exitCode);
        }
    } finally {
        process.exitCode = originalExitCode;
    }
});
