import {Controller,Simulation,schedule} from './core.js';

// The recording supplies observations. This world's telemetry is output only.
// Sharing the live controller applies its lights without calling it twice.
export class RecordedSimulator {
  constructor(config,mode='adaptive',horizon=7200){
    this.controller=new Controller(config,mode);
    this.world=new Simulation(config,mode,schedule(config,Math.max(1,horizon)));
    const signals=Object.create(this.controller);
    signals.tick=()=>{};
    this.world.controller=signals;
  }
  tick(dt,snapshot){this.world.tick(dt,true);this.controller.tick(dt,snapshot);return this;}
  get time(){return this.world.time;}
  get cars(){return this.world.cars;}
  get departed(){return this.world.departed;}
  sample(){return {time:this.time,phase:this.controller.phase,state:this.controller.state,remaining:this.controller.remaining,active_rois:this.controller.activeRois,vehicles:this.cars.map(({id,dir,pos,queued})=>({id,dir,pos,queued})),departed:this.departed.length,scope:'Synthetic traffic responding to recorded-CCTV signal decisions; not the traffic in the recording'};}
  metrics(){return {...this.world.metrics(0),scope:'Synthetic output simulator only; not recorded-traffic impact evaluation'};}
}
