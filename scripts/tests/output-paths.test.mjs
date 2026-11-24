import assert from 'node:assert/strict';
import filesystem, { mkdtemp, readdir, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { runInvocation } from '../openai-agents.mjs';

async function invokeWithOutputs(invocation) {
    const previousExit = process.exitCode;
    const rows = [];
    let calls = 0;
    try {
        process.exitCode = 0;
        const request = () => {
            calls++;
            return { asResponse: async () => new Response('fixture download') };
        };
        const client = { files: { content: request }, responses: { retrieve: request } };
        await runInvocation(client, { timeoutSeconds: 10, ...invocation }, row => rows.push(row));
        assert.equal(rows.length, 1);
        return { row: rows[0], calls, exit: process.exitCode };
    } finally { process.exitCode = previousExit; }
}

function download(outputFile, checkpointPath) {
    return invokeWithOutputs({
        action: 'files.content', id: 'file_fixture', request: {}, outputFile, checkpointPath,
    });
}

function assertCollision({ row, calls, exit }) {
    assert.equal(calls, 0);
    assert.equal(exit, 1);
    assert.equal(row.localCode, 'output_paths_conflict');
    assert.equal(row.dispatch, 'not-attempted');
    assert.equal(row.outcomeUnconfirmed, false);
}

test('path reservation rejects filesystem aliases without leaving logs or dispatching', async () => {
    const folder = await realpath(await mkdtemp(join(tmpdir(), 'legatus-output-alias-')));
    const original = { open: filesystem.open, lstat: filesystem.lstat };
    const equivalent = name => name.normalize('NFC').toLowerCase();
    async function actual(file) {
        if (dirname(file) !== folder) return file;
        const alias = (await readdir(folder)).find(name => equivalent(name) === equivalent(basename(file)));
        return alias ? join(folder, alias) : file;
    }
    try {
        filesystem.open = async (file, flags, mode) => original.open(await actual(file), flags, mode);
        filesystem.lstat = async (file, options) => original.lstat(await actual(file), options);
        syncBuiltinESMExports();

        assertCollision(await download(join(folder, 'Caf\u00e9.bin'), join(folder, 'Cafe\u0301.bin')));
        assert.deepEqual(await readdir(folder), []);
        assertCollision(await invokeWithOutputs({
            action: 'responses.retrieve', id: 'resp_fixture', request: { stream: true },
            checkpointPath: join(folder, 'Track.jsonl'), eventFile: join(folder, 'track.jsonl'),
        }));
        assert.deepEqual(await readdir(folder), []);
    } finally {
        Object.assign(filesystem, original);
        syncBuiltinESMExports();
        await rm(folder, { recursive: true, force: true });
    }
});

test('macOS path preflight follows native case and normalization behavior', { skip: process.platform !== 'darwin' }, async () => {
    const folder = await mkdtemp(join(tmpdir(), 'legatus-output-volume-'));
    try {
        for (const [first, second] of [['Result.bin', 'result.bin'], ['Caf\u00e9.bin', 'Cafe\u0301.bin']]) {
            const outputFile = join(folder, first);
            const checkpointPath = join(folder, second);
            await writeFile(outputFile, 'native reference', { flag: 'wx' });
            const aliases = await filesystem.lstat(checkpointPath).then(() => true, error => {
                if (error.code === 'ENOENT') return false;
                throw error;
            });
            await unlink(outputFile);

            const result = await download(outputFile, checkpointPath);
            if (aliases) {
                assertCollision(result);
            } else {
                assert.equal(result.exit, 0);
                assert.equal(result.calls, 1);
                assert.equal(await readFile(outputFile, 'utf8'), 'fixture download');
                assert.match(await readFile(checkpointPath, 'utf8'), /"phase":"downloaded"/);
                await unlink(outputFile);
                await unlink(checkpointPath);
            }
            assert.deepEqual(await readdir(folder), []);
        }
    } finally { await rm(folder, { recursive: true, force: true }); }
});

test('preflight distinguishes file creation from directory creation and leaves no probe files', async () => {
    const folder = await realpath(await mkdtemp(join(tmpdir(), 'legatus-output-permissions-')));
    const original = { open: filesystem.open, mkdtemp: filesystem.mkdtemp };
    const denied = Object.assign(Error('Fixture ACL denies this operation'), { code: 'EPERM' });
    let directoryAttempted = false;
    try {
        filesystem.mkdtemp = async file => {
            if (dirname(file) === folder) {
                directoryAttempted = true;
                throw denied;
            }
            return original.mkdtemp(file);
        };
        syncBuiltinESMExports();
        const output = join(folder, 'output.bin');
        for (const name of ['Kontrola č. 1.jsonl', 'č' + 'a'.repeat(229) + '.jsonl',
            'č' + 'a'.repeat(247) + '.jsonl']) {
            const checkpoint = join(folder, name);
            await writeFile(checkpoint, 'native control', { flag: 'wx' });
            await unlink(checkpoint);
            const permitted = await download(output, checkpoint);
            assert.equal(permitted.exit, 0);
            assert.equal(permitted.calls, 1);
            assert.equal(directoryAttempted, false);
            assert.deepEqual((await readdir(folder)).sort(), [basename(checkpoint), basename(output)].sort());
            await unlink(output);
            await unlink(checkpoint);
        }

        filesystem.open = async (...args) => {
            if (dirname(args[0]) === folder && args[1] === 'wx') throw denied;
            return original.open(...args);
        };
        syncBuiltinESMExports();
        const refused = await download(output);
        assert.equal(refused.exit, 1);
        assert.equal(refused.calls, 0);
        assert.equal(refused.row.dispatch, 'not-attempted');
        assert.deepEqual(await readdir(folder), []);
    } finally {
        Object.assign(filesystem, original);
        syncBuiltinESMExports();
        await rm(folder, { recursive: true, force: true });
    }
});

test('final media name appears only at publication, including when scratch cleanup is denied', async () => {
    const folder = await realpath(await mkdtemp(join(tmpdir(), 'legatus-output-visibility-')));
    const output = join(folder, 'download.bin');
    const original = { open: filesystem.open, unlink: filesystem.unlink };
    const creates = [];
    let denyCleanup = false, calls = 0;
    try {
        filesystem.open = async (...args) => {
            if (args[0] === output && args[1] === 'wx') creates.push(calls);
            return original.open(...args);
        };
        filesystem.unlink = async (file) => {
            if (denyCleanup && dirname(file) === folder) {
                throw Object.assign(Error('Fixture denies deletion'), { code: 'EPERM' });
            }
            return original.unlink(file);
        };
        syncBuiltinESMExports();
        const rows = [];
        const client = { files: { content() {
            calls++;
            return { asResponse: async () => {
                await assert.rejects(filesystem.lstat(output), { code: 'ENOENT' });
                return new Response('content');
            } };
        } } };
        const previousExit = process.exitCode;
        try {
            const invocation = { action: 'files.content', id: 'file_fixture', request: {}, outputFile: output };
            await runInvocation(client, invocation, row => rows.push(row));
            assert.equal(await readFile(output, 'utf8'), 'content');
            assert.equal(calls, 1);
            const publication = rows.at(-1).data.publication;
            assert.deepEqual(creates, publication.atomic ? [] : [1]);
            await unlink(output);
            denyCleanup = true;
            process.exitCode = 0;
            await runInvocation(client, invocation, row => rows.push(row));
            assert.equal(calls, 1);
            assert.equal(process.exitCode, 1);
            assert.ok(rows.at(-1).localWarnings.some(warning => warning.phase === 'probe-cleanup'));
            await assert.rejects(filesystem.lstat(output), { code: 'ENOENT' });
        } finally { process.exitCode = previousExit; }
    } finally {
        Object.assign(filesystem, original);
        syncBuiltinESMExports();
        await rm(folder, { recursive: true, force: true });
    }
});

test('a volume-rejected final artifact name fails before dispatch, with or without a checkpoint', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'legatus-output-component-'));
    try {
        const allowed = join(folder, 'a'.repeat(251) + '.bin');
        const valid = await download(allowed, join(folder, 'valid.jsonl'));
        assert.equal(valid.exit, 0);
        assert.equal(valid.calls, 1);
        assert.equal(await readFile(allowed, 'utf8'), 'fixture download');
        await unlink(allowed);
        await unlink(join(folder, 'valid.jsonl'));

        const invalid = join(folder, 'a'.repeat(252) + '.bin');
        // This can vary by destination volume. Follow what the actual fs permits.
        const allows256 = await writeFile(invalid, 'control', { flag: 'wx' }).then(() => true, error => {
            if (['ENOENT', 'ENAMETOOLONG', 'EINVAL', 'EPERM'].includes(error.code)) return false;
            throw error;
        });
        if (allows256) await unlink(invalid);
        for (const checkpoint of [undefined, join(folder, 'draft.jsonl')]) {
            const result = await download(invalid, checkpoint);
            assert.equal(result.calls, allows256 ? 1 : 0);
            assert.equal(result.exit, allows256 ? 0 : 1);
            if (allows256) {
                await unlink(invalid);
                if (checkpoint) await unlink(checkpoint);
            } else assert.equal(result.row.dispatch, 'not-attempted');
            assert.deepEqual(await readdir(folder), []);
        }
    } finally { await rm(folder, { recursive: true, force: true }); }
});
