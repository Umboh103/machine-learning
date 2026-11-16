import {defaults, Simulation} from './core.js';

const EPS=1e-8;
const immutable=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(immutable);Object.freeze(value);}return value;};

// Independent example controller: presence-to-plan, never SRS queue-to-Mamdani.
export class EdgeController {
  constructor(config,configHash,sessionId){
    if(!Array.isArray(config.phase_order)||JSON.stringify([...config.phase_order].sort())!=='[0,1,2,3]'||!Array.isArray(config.phase_names)||config.phase_names.length!==4)throw Error('Empat fase eksklusif diperlukan');
    const timings=[config.green_min_s,config.green_max_s,config.fallback_green_s,config.yellow_s??3,config.all_red_s??1,config.snapshot_max_age_s];
    if(timings.some(value=>!Number.isFinite(value)||value<=0)||config.green_min_s>config.fallback_green_s||config.fallback_green_s>config.green_max_s)throw Error('Konfigurasi durasi tidak sah');
    this.config=immutable(structuredClone(config));this.hash=configHash;this.sessionId=sessionId;
    this.c=defaults();this.c.phaseOrder=[...config.phase_order];
    this.c.phases.forEach((phase,i)=>phase.name=config.phase_names[i]);
    this.phase=config.phase_order[0];this.state='HIJAU';this.time=0;
    this.remaining=this.duration=config.fallback_green_s;this.fallback=true;
    this.reason='Menunggu tiga pengamatan valid';this.latest=null;this.deadline=-Infinity;
    this.seq=0;this.epoch=0;this.streak=0;this.recoveryAt=null;this.lastCreated=-Infinity;this.lastFrame=-1;
    this.events=[];this.decisions=[];this.pending=null;
  }
  get activeRois(){return [this.phase];}
  get phaseName(){return this.config.phase_names[this.phase];}
  get nextPhase(){const order=this.config.phase_order;return order[(order.indexOf(this.phase)+1)%4];}
  get diagnostics(){return {scope:'Edge presence example',boundSeconds:3*this.config.green_max_s+4*((this.config.yellow_s??3)+(this.config.all_red_s??1))};}
  fresh(now){return this.latest?.valid===true&&now<this.deadline;}
  receive(packet,now,utcNow){
    const c=this.config;
    if(packet.session_id!==this.sessionId||packet.intersection_id!==c.intersection_id||packet.config_sha256!==this.hash||packet.output_scope!=='simulator-proposals-only'||packet.schema!=='traffic-plan-proposal-v1')throw Error('Identitas atau konfigurasi usulan tidak cocok');
    if(!Number.isSafeInteger(packet.seq)||packet.seq<1||!Number.isSafeInteger(packet.source_epoch)||packet.source_epoch<0||typeof packet.valid!=='boolean')throw Error('Sequence atau validitas tidak sah');
    if(packet.seq<=this.seq)return false;
    if(packet.source_epoch<this.epoch||packet.created_at_utc_ms<this.lastCreated)throw Error('Urutan sumber mundur');
    if(JSON.stringify(packet.phase_order)!==JSON.stringify(c.phase_order))throw Error('Urutan fase berubah');
    for(const key of ['green_min_s','green_max_s','fallback_green_s'])if(packet[key]!==c[key])throw Error('Batas durasi berubah');
    if(!Number.isFinite(packet.created_at_utc_ms)||!Number.isFinite(packet.valid_until_utc_ms)||packet.created_at_utc_ms>utcNow+250||packet.valid_until_utc_ms<packet.created_at_utc_ms||packet.valid_until_utc_ms-packet.created_at_utc_ms>c.snapshot_max_age_s*1000)throw Error('Timestamp tidak sah');
    if(packet.valid&&(!Array.isArray(packet.green_s)||packet.green_s.length!==4||packet.green_s.some(g=>!Number.isFinite(g)||g<c.green_min_s||g>c.green_max_s)))throw Error('Durasi tidak sah');
    if(!packet.valid&&(packet.rows!==null||packet.green_s!==null))throw Error('Data tidak valid membawa rencana');
    if(packet.valid&&(!Number.isSafeInteger(packet.frame_id)||packet.frame_id<0||packet.source_epoch===this.epoch&&packet.frame_id<=this.lastFrame))throw Error('Frame harus baru untuk memperbarui pengamatan');
    if(packet.source_epoch!==this.epoch||!this.fresh(now)){this.streak=0;this.recoveryAt=null;}
    this.lastFrame=packet.valid?packet.frame_id:packet.source_epoch!==this.epoch?-1:this.lastFrame;
    this.seq=packet.seq;this.epoch=packet.source_epoch;this.lastCreated=packet.created_at_utc_ms;
    this.latest=immutable(structuredClone(packet));this.deadline=now+Math.max(0,Math.min(c.snapshot_max_age_s*1000,packet.valid_until_utc_ms-utcNow));
    if(!this.fresh(now)){this.streak=0;this.recoveryAt=null;}
    else if(this.recoveryAt===null||packet.created_at_utc_ms-this.recoveryAt>1500){this.streak=1;this.recoveryAt=packet.created_at_utc_ms;}
    else if(packet.created_at_utc_ms-this.recoveryAt>=1000){this.streak++;this.recoveryAt=packet.created_at_utc_ms;}
    return true;
  }
  quality(now){
    const fallback=!this.fresh(now)||this.streak<3;
    const reason=!this.fresh(now)?this.latest?.reason??'Pengamatan kedaluwarsa atau belum tersedia':this.streak<3?'Menunggu tiga pengamatan valid':'Usulan presence berbobot';
    if(fallback!==this.fallback)this.events.push({type:'fault',data:{time:this.time,active:fallback,reason}});
    this.fallback=fallback;this.reason=reason;
    if(!this.fresh(now)){this.streak=0;this.recoveryAt=null;}
  }
  tick(dt,now){
    if(!Number.isFinite(dt)||dt<=0||!Number.isFinite(now))throw Error('Langkah waktu tidak sah');
    this.quality(now);let left=dt;
    while(left>EPS){
      const step=Math.min(left,this.remaining);this.time+=step;this.remaining-=step;left-=step;
      if(this.remaining>EPS)continue;
      if(this.state==='HIJAU'){
        this.pending={time:this.time,from:this.phase,to:this.nextPhase,green:this.fallback?this.config.fallback_green_s:this.latest.green_s[this.nextPhase],mode:this.fallback?'cadangan':'presence-adaptif',reason:this.reason,proposal_seq:this.fallback?null:this.latest.seq,source_epoch:this.epoch};
        this.decisions.push(immutable(structuredClone(this.pending)));
        this.events.push({type:'decision',data:structuredClone(this.pending)});
        this.state='KUNING';this.remaining=this.config.yellow_s??3;
      }else if(this.state==='KUNING'){
        this.state='SEMUA MERAH';this.remaining=this.config.all_red_s??1;
      }else{
        // Freeze the chosen duration; newer packets only establish source health.
        // Missing/invalid input or a changed source epoch during clearance cancels it.
        if(this.pending.mode==='presence-adaptif'&&(this.fallback||this.pending.source_epoch!==this.epoch))this.pending={...this.pending,green:this.config.fallback_green_s,mode:'cadangan',reason:'Sumber tidak sehat saat penerapan',proposal_seq:null};
        this.phase=this.pending.to;this.state='HIJAU';this.remaining=this.duration=this.pending.green;
        this.events.push({type:'application_ack',data:{...this.pending,applied_at:this.time,applied:true,output_scope:'simulator-only'}});
      }
      this.events.push({type:'transition',data:{time:this.time,state:this.state,phase:this.phase,duration:this.remaining}});
    }
    return this;
  }
}

export class EdgeSimulator {
  constructor(config,hash,sessionId){
    this.controller=new EdgeController(config,hash,sessionId);
    this.world=new Simulation(this.controller.c,'fixed');
    const signals=Object.create(this.controller);signals.tick=()=>{};this.world.controller=signals;
  }
  tick(dt,now){this.world.tick(dt,true);this.controller.tick(dt,now);}
  sample(){return {time:this.controller.time,phase:this.controller.phase,state:this.controller.state,remaining:this.controller.remaining,mode:this.controller.fallback?'cadangan':'presence-adaptif',vehicles:this.world.cars.map(({id,dir,pos,queued})=>({id,dir,pos,queued})),departed:this.world.departed.length,source_seq:this.controller.seq,scope:'Synthetic output only; telemetry is never perception input'};}
}
