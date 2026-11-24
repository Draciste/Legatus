import {lstat, mkdtemp, readFile, rmdir, unlink, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const responseId = 'resp_runtime_fixture';
const sessionId = 'sess_runtime_fixture';
const cyberProgram = 'daybreak_blue';
const model = 'fixture';
const bytes = Buffer.from([0, 104, 195, 169, 255]);
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><title>Fixture</title></svg>');

function check(ok, label) {
    if (!ok) throw Error('Offline runtime qualification failed: ' + label);
}

function eventStream(terminal) {
    const created = {type:'response.created',sequence_number:0,response:{id:responseId,object:'response',status:'in_progress'}};
    const delta = {type:'response.output_text.delta',sequence_number:1,delta:'žluťoučký'};
    const completed = {type:'response.completed',sequence_number:2,response:{id:responseId,object:'response',status:'completed',
        output:[{id:'msg_runtime_fixture',type:'message',role:'assistant',status:'completed',
            content:[{type:'output_text',text:'žluťoučký',annotations:[]}]}]}};
    const encoded = Buffer.from((terminal ? [created, delta, completed] : [created, delta])
        .map(event => 'event: '+event.type+'\r\ndata: '+JSON.stringify(event)+'\r\n\r\n').join(''));
    const body = new ReadableStream({start(controller) {
        for (let offset=0; offset<encoded.length; offset++) controller.enqueue(encoded.subarray(offset,offset+1));
        controller.close();
    }});
    return new Response(body,{headers:{'content-type':'text/event-stream'}});
}

export async function qualifyRuntime(buildClient, sdkRoot, runInvocation) {
    let mode = 'json', calls = 0;
    const client = await buildClient('sk-offline-fixture-no-network', sdkRoot, async (url, init) => {
        calls++;
        const request = new Request(url,init);
        if (mode === 'json') {
            check(request.method==='POST' && new URL(url).pathname==='/v1/responses','Responses route');
            const payload = await request.json();
            check(payload.model===model && payload.input==='Příliš žluťoučký','exact JSON input');
            return Response.json({object:'response',id:responseId,status:'completed',output:[]});
        }
        if (mode === 'daybreak') {
            check(request.method==='POST' && new URL(url).pathname==='/v1/agents/sessions','Daybreak session route');
            const payload = await request.json();
            check(payload.agent?.model===model && payload.environment?.type==='none' &&
                payload.access_programs?.cyber===cyberProgram && payload.metadata?.job_ref==='fixture-qualification',
                'Daybreak request shape');
            return Response.json({object:'agent.session',id:sessionId,status:'idle',
                metadata:{job_ref:'fixture-qualification'},access_programs:{cyber:cyberProgram}});
        }
        if (mode === 'multipart') {
            check(request.method==='POST' && new URL(url).pathname==='/v1/files','Files route');
            const body = await request.formData();
            check(body.get('purpose')==='batch','multipart purpose');
            check(Buffer.from(await body.get('file').arrayBuffer()).equals(bytes),'multipart bytes');
            return Response.json({object:'file',id:'file-runtime-fixture',filename:'fixture.jsonl',purpose:'batch',
                bytes:bytes.length});
        }
        if (mode === 'svg' || mode === 'invalid-svg') {
            check(request.method==='POST' && new URL(url).pathname==='/v1/images/generations','Images route');
            const data = mode === 'svg' ? svg : svg.subarray(0, -6);
            return Response.json({output_format:'svg',data:[{b64_json:data.toString('base64')}]});
        }
        if (mode === 'lost') throw Error('Synthetic loss after dispatch');
        check(request.method==='GET' && new URL(url).pathname==='/v1/responses/'+responseId,'Retrieve route');
        return eventStream(mode==='sse');
    });
    const priorExit = process.exitCode;
    async function invoke(action, request, fields={}) {
        process.exitCode=0;
        const rows=[];
        await runInvocation(client,{action,request,timeoutSeconds:8,...fields},row=>rows.push(row));
        return {rows,last:rows.at(-1),exit:process.exitCode};
    }

    const directory = await mkdtemp(join(tmpdir(),'legatus-runtime-'));
    const file = join(directory,'fixture.jsonl');
    const image = join(directory,'fixture.svg');
    const invalidImage = join(directory,'invalid.svg');
    try {
        const json = await invoke('responses.create',{model,input:'Příliš žluťoučký',background:true,store:true});
        check(json.exit===0 && json.last?.data?.id===responseId,'JSON receipt');
        await writeFile(file,bytes,{flag:'wx'});
        mode='multipart';
        const multipart = await invoke('files.create',{purpose:'batch'},{inputFile:file});
        check(multipart.exit===0 && multipart.last?.data?.id==='file-runtime-fixture' &&
            multipart.last.receipt?.fileId==='file-runtime-fixture' &&
            multipart.last.receipt?.sourceBytes===bytes.length &&
            multipart.last.receipt?.sourceSha256===createHash('sha256').update(bytes).digest('hex'),'multipart receipt');
        mode='sse';
        const stream = await invoke('responses.retrieve',{stream:true},{id:responseId});
        check(stream.exit===0 && stream.last?.outcome==='response.completed' &&
            stream.rows.some(row=>row.event?.delta==='žluťoučký'),'incremental UTF-8 and CRLF SSE');
        mode='partial';
        const partial = await invoke('responses.retrieve',{stream:true},{id:responseId});
        check(partial.exit===1 && partial.last?.outcome==='unconfirmed' &&
            partial.last?.receipt?.resourceId===responseId,'EOF retains accepted identity');
        mode='lost';
        const lost = await invoke('responses.create',{model,input:'fixture',background:true,store:true});
        check(lost.exit===1 && lost.last?.outcomeUnconfirmed===true && calls===5,'one write after loss');
        const blocked = await invoke('responses.create',{model,input:'fixture',background:true,store:true},
            {checkpointPath:file});
        check(blocked.exit===1 && blocked.last?.dispatch==='not-attempted' && calls===5,'preflight excludes effects');
        mode='daybreak';
        const daybreak = await invoke('sessions.create',{agent:{model},environment:{type:'none'},
            input:'Synthetic review fixture',metadata:{job_ref:'fixture-qualification'},access_programs:{cyber:cyberProgram}});
        check(daybreak.exit===0 && calls===6 && daybreak.last?.receipt?.sessionId===sessionId &&
            daybreak.last.receipt.daybreak?.configurationState==='confirmed','Daybreak serialization and receipt');
        const imageRequest = {model:'gpt-image-2.6-flare',prompt:'Fixture',output_format:'svg'};
        mode='svg';
        const saved = await invoke('images.generate',imageRequest,{outputFile:image});
        check(saved.exit===0 && saved.last?.data?.image?.validation==='well-formed-svg-xml' &&
            (await readFile(image)).equals(svg),'valid SVG publication');
        mode='invalid-svg';
        const rejected = await invoke('images.generate',imageRequest,{outputFile:invalidImage});
        const missing = await lstat(invalidImage).then(() => false, error => {
            if (error.code === 'ENOENT') return true;
            throw error;
        });
        check(rejected.exit===1 && rejected.last?.receipt?.httpStatus===200 && missing && calls===8,'invalid SVG rejection');
        return { passed: ['exact-json','multipart-bytes','split-utf8-sse','partial-sse','unknown-write-once','blocked-preflight',
            'daybreak-session-json','svg-validation'], syntheticRequests: calls, networkUsed: false };
    } finally {
        process.exitCode=priorExit;
        for (const filename of [file, image, invalidImage]) {
            await unlink(filename).catch(error=>{if(error.code!=='ENOENT')throw error;});
        }
        await rmdir(directory);
    }
}
