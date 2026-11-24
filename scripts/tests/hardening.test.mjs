import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rmdir, unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runInvocation} from '../openai-agents.mjs';
import {trackResponseStream} from '../openai-stream-integrity.mjs';

async function run(client, request) {
    const rows=[];
    const saved=process.exitCode;
    try {
        process.exitCode=0;
        await runInvocation(client,{timeoutSeconds:4,...request},row=>rows.push(structuredClone(row)));
        return {rows, final:rows.at(-1), exit:process.exitCode};
    } finally {process.exitCode=saved;}
}

test('only the Batch poller retries a positively identified rate limit',async()=>{
    const id='batch_backoff_fixture';
    const params={action:'batches.wait',id,request:{}};
    let calls=0;
    const make = (code,type) => ({batches:{retrieve:()=>({asResponse:async()=>{
        if (++calls===1) throw Object.assign(Error('fixture'),{status:429,code,type,headers:new Headers({'retry-after-ms':'0'})});
        return Response.json({object:'batch',id,status:'completed',request_counts:{total:1,completed:1,failed:0}});
    }})}});
    assert.equal((await run(make('rate_limit_exceeded'),params)).exit,0);
    assert.equal(calls,2);
    for (const code of ['credit_balance_exhausted','fixture_unclassified']) {
        calls=0;
        assert.equal((await run(make(code),params)).exit,1);
        assert.equal(calls,1);
    }
    calls=0;
    assert.equal((await run(make('rate_limit_exceeded','insufficient_quota'),params)).exit,1);
    assert.equal(calls,1);
});

const id='resp_hardening_fixture';
const delta=(seq, text=String(seq))=>({type:'response.output_text.delta',sequence_number:seq,delta:text});
const terminal=seq=>({type:'response.completed',sequence_number:seq,response:{id,object:'response',status:'completed',output:[]}});
const created={type:'response.created',sequence_number:0,response:{id,object:'response',status:'in_progress'}};
const clientFor = frames=>({responses:{retrieve:()=>Object.assign(Promise.resolve((async function*(){
    for(const frame of frames) yield frame;
})()), {asResponse:async()=>new Response('',{headers:{'content-type':'text/event-stream'}})})}});
const retrieve={action:'responses.retrieve',id,request:{stream:true}};

test('Responses separates remote completion from incomplete local sequence and emits no duplicate delta',async()=>{
    const {rows, final, exit}=await run(clientFor([delta(1),delta(2),delta(2),delta(4),delta(3),terminal(5)]),retrieve);
    assert.deepEqual(rows.filter(row=>row.kind==='event').map(row=>row.event.sequence_number),[1,2,4,5]);
    assert.equal(exit,1);
    assert.equal(final.receipt.resourceStatus,'completed');
    assert.equal(final.outcome,'response.completed');
    assert.equal(final.receipt.streamIntegrity.lastDeliveredContiguousSequence,2);
    assert.equal(final.receipt.streamIntegrity.lastDurableContiguousSequence,undefined);
    assert.deepEqual(final.receipt.streamIntegrity.counts,{duplicate:1,conflict:0,gap:1,outOfOrder:1,unsequenced:0});
});

test('a supported resume cursor and keepalive do not disrupt the stored sequence',async()=>{
    const {final,exit}=await run(clientFor([{type:'keepalive',sequence_number:1000},delta(8),delta(8),terminal(9)]),
        {...retrieve,request:{stream:true,starting_after:7}});
    assert.equal(exit,0);
    assert.equal(final.receipt.streamIntegrity.lastDeliveredContiguousSequence,9);
    assert.equal(final.receipt.streamIntegrity.counts.duplicate,1);
});

test('a withheld terminal replay cannot set the remote status',async()=>{
    const {rows,final,exit}=await run(clientFor([terminal(7)]),
        {...retrieve,request:{stream:true,starting_after:7}});
    assert.equal(exit,1);
    assert.equal(final.receipt.resourceId,id);
    assert.equal(final.receipt.resourceStatus,undefined);
    assert.equal(final.outcome,'unconfirmed');
    assert.equal(rows.some(row=>row.kind==='event'),false);
});

test('conflicting event retracts a previously synced cursor',()=>{
    const stream=trackResponseStream();
    stream.delivered(stream.observe(created).cursor);
    stream.delivered(stream.observe(delta(1)).cursor);
    stream.delivered(stream.observe(delta(2)).cursor);
    stream.synced();
    assert.equal(stream.snapshot().lastDurableContiguousSequence,2);
    assert.equal(stream.observe(delta(2,'different')).deliver,false);
    assert.equal(stream.snapshot().lastDurableContiguousSequence,1);
    assert.equal(stream.snapshot().state,'incomplete-history');
});

test('event file carries raw withheld observations and checkpoint advances after sync',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'legatus-hardening-test-'));
    const eventFile=join(dir,'events.jsonl'), checkpointPath=join(dir,'checkpoint.jsonl');
    try {
        const {final,exit}=await run(clientFor([created,delta(1),delta(1),delta(3),terminal(4)]),{...retrieve,eventFile,checkpointPath});
        assert.equal(exit,1);
        const file=(await readFile(eventFile,'utf8')).trim().split('\n').map(JSON.parse);
        assert.deepEqual(file.map(row=>row.kind),['event','event','stream-observation','event','event']);
        const saved=(await readFile(checkpointPath,'utf8')).trim().split('\n').map(JSON.parse).at(-1);
        assert.equal(saved.resourceStatus,'completed');
        assert.equal(saved.streamIntegrity.lastDurableContiguousSequence,1);
        assert.equal(final.observedEventsSaved,true);
    } finally {
        await unlink(eventFile).catch(()=>{});
        await unlink(checkpointPath).catch(()=>{});
        await rmdir(dir);
    }
});

test('terminal event without an observed prefix keeps the known remote status without issuing a resume cursor',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'legatus-stream-origin-'));
    const eventFile=join(dir,'events.jsonl');
    try {
        const {final}=await run(clientFor([terminal(40)]),{...retrieve,eventFile});
        assert.equal(final.outcome,'response.completed');
        assert.equal(final.receipt.streamIntegrity.origin,'unconfirmed');
        assert.equal(final.receipt.streamIntegrity.firstObservedSequence,40);
        assert.equal(final.receipt.streamIntegrity.lastDurableContiguousSequence,undefined);
    } finally { await unlink(eventFile); await rmdir(dir); }
});

test('cursor retraction is journaled before a later event can arrive',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'legatus-cursor-retraction-'));
    const eventFile=join(dir,'events.jsonl'), checkpointPath=join(dir,'checkpoint.jsonl');
    const rows = async () => (await readFile(checkpointPath,'utf8')).trim().split('\n').map(JSON.parse);
    let during;
    const client={responses:{retrieve:()=>Object.assign(Promise.resolve((async function*(){
        yield created;
        for (let sequence=1; sequence<=63; sequence++) yield delta(sequence);
        yield delta(10,'second observation');
        during=(await rows()).at(-1);
        yield terminal(64);
    })()),{asResponse:async()=>new Response('',{headers:{'content-type':'text/event-stream'}})})}};
    try {
        await run(client,{...retrieve,eventFile,checkpointPath});
        assert.equal(during.cursorRetracted,true);
        assert.equal(during.streamIntegrity.lastDurableContiguousSequence,9);
    } finally { await unlink(eventFile); await unlink(checkpointPath); await rmdir(dir); }
});

test('receipts report file format coverage cues and scoped headers without including filenames or claiming project identity',async()=>{
    const create=()=>({asResponse:async()=>Response.json({
        object:'response',id,status:'completed',model:'reported-fixture',reasoning:{effort:'high'},output:[],
    },{headers:{'x-ratelimit-remaining-project-tokens':'18','openai-organization':'org-fixture','set-cookie':'do-not-record'}})});
    const {final,exit}=await run({responses:{create}},{action:'responses.create',projectHint:'proj_hint',request:{
        model:'requested-fixture',reasoning:{effort:'high'},
        input:[{role:'user',content:[
            {type:'input_file',filename:'private-slides.pptx',file_data:'fixture'},
            {type:'input_file',file_id:'file-opaque'},
            {type:'input_file',file_url:'https://fixture.invalid/rows.xlsx?token=do-not-record'},
        ]}],
    }});
    const receipt=final.receipt;
    assert.equal(exit,0);
    assert.equal(receipt.requestedModel,'requested-fixture');
    assert.equal(receipt.reportedModel,'reported-fixture');
    assert.equal(receipt.projectHint,'proj_hint');
    assert.equal(receipt.headers['x-ratelimit-remaining-project-tokens'],'18');
    assert.equal(receipt.headerScope,'response-observation');
    assert.deepEqual(receipt.inputCoverage.formats.map(item=>item.mode),
        ['document-text-only','unknown','spreadsheet-prefix-augmentation']);
    assert.doesNotMatch(JSON.stringify(receipt),/private-slides|do-not-record|fixture\.invalid/);
});
