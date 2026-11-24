import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { publishFile } from '../publish-openai-file.mjs';

const content = Buffer.from('test artifact – žluťoučký kůň\n');
const expected = { expectedBytes: content.length, expectedSha256: createHash('sha256').update(content).digest('hex') };

async function fixture(t) {
    const root = await fs.mkdtemp(join(tmpdir(), 'legatus-publication-'));
    const temporary = join(root, '.legatus-part-fixture');
    const destination = join(root, 'artifact');
    const replacement = join(root, 'another-artifact');
    await fs.writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    t.after(async () => {
        t.mock.restoreAll();
        syncBuiltinESMExports();
        for (const file of [temporary, destination, replacement]) await fs.unlink(file).catch(error => {
            if (error.code !== 'ENOENT') throw error;
        });
        await fs.rmdir(root);
    });
    return { temporary, destination, replacement };
}

function forceFallback(t) {
    t.mock.method(fs, 'link', async () => { throw Object.assign(new Error('Synthetic unsupported hard link'), { code: 'ENOTSUP' }); });
    syncBuiltinESMExports();
}

test('hard link publishes only the verified staging file', async t => {
    const { temporary, destination } = await fixture(t);
    assert.deepEqual(await publishFile(temporary, destination, expected), {
        mode: 'hard-link', atomic: true, bytes: content.length, sha256: expected.expectedSha256,
    });
    assert.deepEqual(await fs.readFile(destination), content);
    assert.equal((await fs.stat(destination, { bigint: true })).ino, (await fs.stat(temporary, { bigint: true })).ino);
});

test('mismatched staged length or SHA-256 never creates the destination', async t => {
    const { temporary, destination } = await fixture(t);
    await assert.rejects(publishFile(temporary, destination, { expectedBytes: 1 }), { code: 'ARTIFACT_STAGING_CHANGED' });
    await assert.rejects(publishFile(temporary, destination, { expectedSha256: '0'.repeat(64) }), { code: 'ARTIFACT_DIGEST_MISMATCH' });
    await assert.rejects(fs.lstat(destination), { code: 'ENOENT' });
});

test('competing publications create one destination and preserve its content', async t => {
    const { temporary, destination } = await fixture(t);
    const results = await Promise.allSettled([
        publishFile(temporary, destination),
        publishFile(temporary, destination),
    ]);
    assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
    assert.equal(results.find(value => value.status === 'rejected').reason.code, 'EEXIST');
    assert.deepEqual(await fs.readFile(destination), content);
});

test('exclusive fallback is distinguished and does not overwrite an existing file', async t => {
    const { temporary, destination } = await fixture(t);
    forceFallback(t);
    assert.deepEqual(await publishFile(temporary, destination, expected), {
        mode: 'exclusive-copy', atomic: false, bytes: content.length, sha256: expected.expectedSha256,
    });
    assert.deepEqual(await fs.readFile(destination), content);
    await assert.rejects(publishFile(temporary, destination, expected), { code: 'EEXIST' });
    assert.deepEqual(await fs.readFile(destination), content);
});

test('exclusive fallback retains its partial file for review when a write fails', async t => {
    const { temporary, destination } = await fixture(t);
    forceFallback(t);
    const open = fs.open;
    t.mock.method(fs, 'open', async (file, ...options) => {
        const handle = await open(file, ...options);
        if (file === destination) {
            const write = handle.writeFile.bind(handle);
            handle.writeFile = async chunk => {
                await write(chunk.subarray(0, 2));
                throw Object.assign(new Error('Synthetic destination write failure'), { code: 'ENOSPC' });
            };
        }
        return handle;
    });
    syncBuiltinESMExports();
    await assert.rejects(publishFile(temporary, destination), error => {
        assert.equal(error.code, 'ENOSPC');
        assert.deepEqual(error.publication, { mode: 'exclusive-copy', verified: false, cleanup: 'retained-for-review' });
        return true;
    });
    assert.deepEqual(await fs.readFile(temporary), content);
    assert.deepEqual(await fs.readFile(destination), content.subarray(0, 2));
});

test('post-link identity failure does not delete the destination or report success', async t => {
    const { temporary, destination } = await fixture(t);
    const lstat = fs.lstat;
    t.mock.method(fs, 'lstat', async (file, options) => {
        if (file === destination) throw Object.assign(new Error('Synthetic inaccessible destination'), { code: 'EACCES' });
        return lstat(file, options);
    });
    syncBuiltinESMExports();
    await assert.rejects(publishFile(temporary, destination), error => {
        assert.equal(error.code, 'ARTIFACT_PUBLICATION_UNVERIFIED');
        assert.deepEqual(error.publication, { mode: 'hard-link', verified: false });
        return true;
    });
    assert.deepEqual(await fs.readFile(destination), content);
});

test('the fallback verifies stored bytes and leaves a failed copy for reconciliation', async t => {
    const { temporary, destination } = await fixture(t);
    forceFallback(t);
    const open = fs.open;
    t.mock.method(fs, 'open', async (file, ...options) => {
        const handle = await open(file, ...options);
        if (file === destination) {
            const write = handle.writeFile.bind(handle);
            handle.writeFile = chunk => write(Buffer.alloc(chunk.length));
        }
        return handle;
    });
    syncBuiltinESMExports();
    await assert.rejects(publishFile(temporary, destination, expected), error => {
        assert.equal(error.code, 'ARTIFACT_DIGEST_MISMATCH');
        assert.equal(error.publication.cleanup, 'retained-for-review');
        return true;
    });
    assert.deepEqual(await fs.readFile(destination), Buffer.alloc(content.length));
});

test('fallback cancellation leaves a provisional output for review', async t => {
    const { temporary, destination } = await fixture(t);
    forceFallback(t);
    const stop = new AbortController();
    const open = fs.open;
    t.mock.method(fs, 'open', async (file, ...options) => {
        const handle = await open(file, ...options);
        if (file === destination) {
            const write = handle.writeFile.bind(handle);
            handle.writeFile = async chunk => {
                await write(chunk);
                stop.abort();
            };
        }
        return handle;
    });
    syncBuiltinESMExports();
    await assert.rejects(publishFile(temporary, destination, { signal: stop.signal }), error => {
        assert.equal(error.publication.cleanup, 'retained-for-review');
        return true;
    });
    assert.deepEqual(await fs.readFile(destination), content);
});

test('fallback never cleans a different identity observed at the output name', async t => {
    const { temporary, destination, replacement } = await fixture(t);
    forceFallback(t);
    await fs.writeFile(replacement, 'another process result', { flag: 'wx' });
    const lstat = fs.lstat;
    let replaced = false;
    t.mock.method(fs, 'lstat', async (file, options) => {
        if (file === destination && !replaced) {
            await fs.rename(replacement, destination);
            replaced = true;
        }
        return lstat(file, options);
    });
    syncBuiltinESMExports();
    await assert.rejects(publishFile(temporary, destination), error => {
        assert.equal(error.code, 'ARTIFACT_PUBLICATION_UNVERIFIED');
        assert.equal(error.publication.cleanup, 'different-file');
        return true;
    });
    assert.equal(await fs.readFile(destination, 'utf8'), 'another process result');
});
