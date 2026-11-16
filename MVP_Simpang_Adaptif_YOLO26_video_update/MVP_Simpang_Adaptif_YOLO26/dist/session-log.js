// Retryable journal and finalization outbox. Keep operations until the server
// acknowledges them, including when a tab reload follows an ambiguous failure.
export class SessionLog {
  constructor({storage=globalThis.localStorage, request=globalThis.fetch?.bind(globalThis), onStatus=()=>{},onFailure=()=>{}}={}) {
    this.storage=storage; this.request=request; this.onStatus=onStatus;this.onFailure=onFailure;this.lastFailure=null;
    this.key='simpang-pending-events-v1'; this.pending=[]; this.busy=null;
    try { const restored=JSON.parse(storage?.getItem(this.key)||'[]');if(Array.isArray(restored))this.pending=restored; } catch {}
  }
  save() {
    try { this.storage?.setItem(this.key,JSON.stringify(this.pending));return true; }
    catch(error) { this.onStatus('Penyimpanan antrean lokal gagal; sesi harus dihentikan.');this.fail(error,{operation:'local-outbox'});return false; }
  }
  fail(error,context={}){this.lastFailure=error;this.onFailure(error,context);}
  async json(path,options={}) {
    const response=await this.request(path,{...options,headers:{'Content-Type':'application/json',...options.headers}});
    if(!response.ok) { let message; try {message=(await response.json()).detail;} catch {}
      throw Error(typeof message==='string'?message:`HTTP ${response.status}`); }
    return response.json();
  }
  async start(session) {
    await this.flush();
    await this.json('/api/sessions',{method:'POST',body:JSON.stringify(session)});
  }
  append(session_id,type,time,data={},extra={}) {
    if(!session_id)return;
    this.pending.push({session_id,event:{client_event_id:crypto.randomUUID(),type,time,data,...extra}});
    this.save();
  }
  async flush() {
    if(this.busy)return this.busy;
    this.busy=(async()=>{
      while(this.pending.length) {
        const first=this.pending[0],id=first.session_id;
        if(first.end) {
          await this.json(`/api/sessions/${encodeURIComponent(id)}/end`,{method:'POST',body:JSON.stringify(first.end)});
          this.pending=this.pending.filter(x=>x.operation_id!==first.operation_id);this.save();
          continue;
        }
        // Preserve FIFO ordering: never send events past a queued finalization.
        const batch=[];
        for(const item of this.pending){if(item.session_id!==id||!item.event||batch.length===100)break;batch.push(item);}
        if(!batch.length)throw Error('Antrean log tidak dapat dibaca; simpan data lokal sebelum mencoba ulang.');
        await this.json(`/api/sessions/${encodeURIComponent(id)}/events`,{method:'POST',body:JSON.stringify({events:batch.map(x=>x.event)})});
        const sent=new Set(batch.map(x=>x.event.client_event_id));
        this.pending=this.pending.filter(x=>!sent.has(x.event?.client_event_id)); this.save();
      }
      this.lastFailure=null;this.onStatus('Log tersimpan di SQLite lokal.');
    })();
    try {await this.busy;} catch(e){this.onStatus(`Log menunggu sinkron: ${e.message}`);this.fail(e,{operation:this.pending[0]?.end?'finalization':'events',session_id:this.pending[0]?.session_id});throw e;}
    finally {this.busy=null;}
  }
  async end(id,time,reason='user',status='ended') {
    if(!this.pending.some(x=>x.session_id===id&&x.end)){
      this.pending.push({session_id:id,operation_id:crypto.randomUUID(),end:{status,time,reason}});this.save();
    }
    await this.flush();
    return {session_id:id,status};
  }
}
