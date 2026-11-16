import {defaults, paired} from '../dist/core.js';
import {baselinePlan, pairedSummary, impactAcceptance, validateBaselineLock} from '../dist/visual-simulator.js';
import {readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

const args=process.argv.slice(2);
const option=(name,fallback)=>args.includes(name)?args[args.indexOf(name)+1]:fallback;
const sha=value=>createHash('sha256').update(value).digest('hex');
const implementation={core_sha256:sha(readFileSync(new URL('../dist/core.js',import.meta.url))),renderer_sha256:sha(readFileSync(new URL('../dist/visual-simulator.js',import.meta.url)))};
let config=defaults(),baseline=null;
if(args.includes('--baseline')){
  baseline=validateBaselineLock(JSON.parse(readFileSync(option('--baseline'),'utf8')));
  if(sha(readFileSync(baseline.calibration_path))!==baseline.calibration_sha256)throw Error('Checksum kalibrasi berubah.');
  const calibration=JSON.parse(readFileSync(baseline.calibration_path,'utf8'));
  if(JSON.stringify(baseline.implementation)!==JSON.stringify(implementation))throw Error('Source berubah setelah baseline dikunci.');
  if(sha(JSON.stringify(baseline.config))!==baseline.config_sha256)throw Error('Konfigurasi baseline berubah.');
  if(baseline.fixed_green_s!==calibration.selected_fixed_green_s||JSON.stringify(baseline.fixed_phase_plan)!==JSON.stringify(calibration.candidates[0].fixed_phase_plan))throw Error('Rencana baseline berubah.');
  config=baselinePlan(baseline.config,baseline.fixed_green_s);
}
const results=[];
for(const level of ['ringan','sedang','padat'])for(const seed of [1,2,3,4,5]){
  const result=paired({...config,level,seed,horizon:1800,warmup:300});
  if([result.adaptive,result.fixed].some(metrics=>![metrics.meanWait,metrics.meanQueue,metrics.throughput].every(Number.isFinite)))throw Error('Hasil eksperimen tidak finite.');
  result.scenario.scenario_id=`${level}-seed-${seed}`;
  results.push(result);
  console.log(`Telemetry reference ${results.length}/15: ${level}, seed=${seed}`);
}
const report={generated_at:new Date().toISOString(),scope:'Calibrated telemetry reference only; NOT visual feedback acceptance. Ground truth is used as sensor in this reference.',acceptance_pass:false,implementation,baseline_lock:baseline,horizon_s:1800,warmup_s:300,measurement_s:1500,pairs:results.length,summary:pairedSummary(results),numerical_impact_only:impactAcceptance(results),results};
const output=option('--out','validation/paired-demonstration.json');
writeFileSync(output,JSON.stringify(report,null,2));
console.log(JSON.stringify({output,pairs:results.length,scope:report.scope,summary:report.summary.metrics}));
