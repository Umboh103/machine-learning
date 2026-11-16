import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';

export function iou(a,b){const w=Math.max(0,Math.min(a[2],b[2])-Math.max(a[0],b[0])),h=Math.max(0,Math.min(a[3],b[3])-Math.max(a[1],b[1]));const inter=w*h,union=(a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-inter;return union>0?inter/union:0;}
const validBox=box=>Array.isArray(box)&&box.length===4&&box.every(v=>Number.isFinite(v)&&v>=0&&v<=1)&&box[2]>box[0]&&box[3]>box[1];
const nonnegative=value=>Number.isFinite(value)&&value>=0;
const mean=values=>values.length?values.reduce((s,v)=>s+v,0)/values.length:null;
const percentile=(values,p)=>values.length?[...values].sort((a,b)=>a-b)[Math.ceil(p*values.length)-1]:null;

export function evaluateAnnotations(document,{iouThreshold=.5}={}){
  if(!Number.isFinite(iouThreshold)||iouThreshold<=0||iouThreshold>1)throw Error('Ambang IoU harus >0 dan <=1.');
  if(document?.schema!=='simpang-annotations-v1'||!Array.isArray(document.frames)||!document.frames.length)throw Error('Anotasi simpang-annotations-v1 dengan frames diperlukan.');
  const vehicleClasses=document.vehicle_classes??[2,3,5,7];
  if(!Array.isArray(vehicleClasses)||!vehicleClasses.length||new Set(vehicleClasses).size!==vehicleClasses.length||vehicleClasses.some(id=>!Number.isInteger(id)||id<0))throw Error('vehicle_classes harus memuat class ID unik nonnegatif sesuai profil sesi.');
  let tp=0,fp=0,fn=0,groundTruth=0,switches=0,invalidRoiSamples=0;
  const lastTimes=new Map(),identities=new Map(),truthIds=new Set(),matchedIds=new Set(),waitTruthIds=new Set(),waitMatchedIds=new Set();
  const queueErrors=Array.from({length:4},()=>[]),maxWaitErrors=[],trackWaitErrors=[],servedErrors=[];
  const defaultSource=document.source_id??document.source_name??'default';
  for(const frame of document.frames){
    const source=frame.source_id??defaultSource,lastTime=lastTimes.get(source)??-Infinity;
    if(!Number.isFinite(frame.media_time)||frame.media_time<0||frame.media_time<=lastTime)throw Error('Timestamp anotasi setiap sumber harus meningkat.');lastTimes.set(source,frame.media_time);
    if(!Array.isArray(frame.truth)||!Array.isArray(frame.detections))throw Error('Setiap frame memerlukan truth dan detections.');
    const gt=frame.truth.filter(d=>vehicleClasses.includes(d.class_id)),pred=frame.detections.filter(d=>vehicleClasses.includes(d.class_id));
    if([...gt,...pred].some(d=>d.id==null||!validBox(d.box)))throw Error('ID dan box ternormalisasi yang valid diperlukan.');
    if(new Set(gt.map(d=>d.id)).size!==gt.length||new Set(pred.map(d=>d.id)).size!==pred.length)throw Error('ID ganda dalam frame.');
    groundTruth+=gt.length;for(const g of gt)truthIds.add(`${source}:${g.id}`);
    const edges=[];for(let g=0;g<gt.length;g++)for(let p=0;p<pred.length;p++)if(gt[g].class_id===pred[p].class_id){const score=iou(gt[g].box,pred[p].box);if(score>=iouThreshold)edges.push({g,p,score});}
    edges.sort((a,b)=>b.score-a.score);const usedGT=new Set(),usedPred=new Set();
    for(const edge of edges){if(usedGT.has(edge.g)||usedPred.has(edge.p))continue;usedGT.add(edge.g);usedPred.add(edge.p);tp++;
      const g=gt[edge.g],p=pred[edge.p],key=`${source}:${g.id}`,prior=identities.get(key);matchedIds.add(key);if(prior!==undefined&&prior!==p.id)switches++;identities.set(key,p.id);
      if(!document.wait_tracks&&nonnegative(g.wait_s)&&nonnegative(p.wait_s)){waitTruthIds.add(key);waitMatchedIds.add(key);trackWaitErrors.push(Math.abs(g.wait_s-p.wait_s));}
    }
    if(!document.wait_tracks)for(const g of gt)if(nonnegative(g.wait_s))waitTruthIds.add(`${source}:${g.id}`);
    fn+=gt.length-usedGT.size;fp+=pred.length-usedPred.size;
    if(frame.truth_rows!==undefined||frame.observed_rows!==undefined){
      if(frame.truth_rows?.length!==4||frame.observed_rows?.length!==4)throw Error('truth_rows dan observed_rows harus memuat empat ROI.');
      for(let i=0;i<4;i++){const truth=frame.truth_rows[i],observed=frame.observed_rows[i];if(!observed.valid){invalidRoiSamples++;continue;}if(![truth.q,truth.w,observed.q,observed.w].every(nonnegative)||!Number.isInteger(truth.q)||!Number.isInteger(observed.q))throw Error('Metrik antrean/tunggu tidak valid.');queueErrors[i].push(Math.abs(observed.q-truth.q));maxWaitErrors.push(Math.abs(observed.w-truth.w));}
    }
    if(frame.truth_served!==undefined||frame.observed_served!==undefined){if(frame.truth_served?.length!==4||frame.observed_served?.length!==4)throw Error('Hitungan terlayani harus empat ROI.');for(let i=0;i<4;i++){if(![frame.truth_served[i],frame.observed_served[i]].every(v=>Number.isInteger(v)&&v>=0))throw Error('Hitungan terlayani tidak valid.');servedErrors.push(Math.abs(frame.truth_served[i]-frame.observed_served[i]));}}
  }
  if(document.wait_tracks!==undefined){
    if(!Array.isArray(document.wait_tracks))throw Error('wait_tracks harus array lintasan beranotasi.');
    const recordIds=new Set();
    for(const record of document.wait_tracks){const key=`${record.source_id??defaultSource}:${record.truth_id}`;if(record.truth_id==null||recordIds.has(key)||!nonnegative(record.truth_wait_s))throw Error('Anotasi lintasan tunggu tidak valid atau ganda.');recordIds.add(key);waitTruthIds.add(key);truthIds.add(key);
      if(record.matched_track_id!=null){if(!nonnegative(record.observed_wait_s))throw Error('Waktu tunggu track cocok harus tersedia.');waitMatchedIds.add(key);matchedIds.add(key);trackWaitErrors.push(Math.abs(record.observed_wait_s-record.truth_wait_s));}
    }
  }
  const served=Array.from({length:4},(_,direction)=>({direction,intervals:0,truth:0,observed:0,absolute_error:0,false_positive_when_truth_zero:0}));
  const intervalEnds=new Map(),intervalDurations=new Set();
  if(document.served_intervals!==undefined){if(!Array.isArray(document.served_intervals))throw Error('served_intervals harus array.');
    for(const row of document.served_intervals){if(!Number.isInteger(row.direction)||row.direction<0||row.direction>3||![row.start_s,row.end_s].every(nonnegative)||row.end_s<=row.start_s||![row.truth_count,row.observed_count].every(v=>Number.isInteger(v)&&v>=0))throw Error('Interval hitungan terlayani tidak valid.');
      const key=`${row.source_id??defaultSource}:${row.direction}`,previous=intervalEnds.get(key)??-Infinity;if(row.start_s<previous-1e-7)throw Error('Interval hitungan tumpang tindih atau tidak berurutan.');intervalEnds.set(key,row.end_s);intervalDurations.add(Math.round((row.end_s-row.start_s)*1e6)/1e6);
      const out=served[row.direction];out.intervals++;out.truth+=row.truth_count;out.observed+=row.observed_count;out.absolute_error+=Math.abs(row.observed_count-row.truth_count);if(row.truth_count===0)out.false_positive_when_truth_zero+=row.observed_count;
    }
  }
  if(intervalDurations.size>1)throw Error('Gunakan interval terlayani dengan durasi tetap.');
  for(const row of served){row.wape_pct=row.truth===0?null:100*row.absolute_error/row.truth;row.numerical_target_met=row.wape_pct===null?null:row.wape_pct<=10;row.zero_reference_note=row.truth===0?'WAPE undefined; inspect absolute error and false positives':null;}
  const perRoi=queueErrors.map((errors,roi)=>({roi,samples:errors.length,mae_vehicles:mean(errors),absolute_error_p95_vehicles:percentile(errors,.95),numerical_target_met:errors.length?mean(errors)<=2&&percentile(errors,.95)<=5:null}));
  const protocol=document.protocol??{},conditions=new Set(protocol.conditions??[]),calibration=new Set(protocol.calibration_sources??[]),testSources=protocol.test_sources??[...lastTimes.keys()];
  const sourceHashes=new Map((document.sources??[]).map(s=>[s.source_id,s.sha256]));if(document.source_sha256)sourceHashes.set(defaultSource,document.source_sha256);
  const validSamples=queueErrors.reduce((s,e)=>s+e.length,0);
  const checks={annotations_locked:protocol.annotations_locked===true,minimum_300_roi_timestamp_pairs:validSamples>=300,minimum_60_annotated_paths:truthIds.size>=60,two_reviewers:Array.isArray(protocol.reviewers)&&new Set(protocol.reviewers).size>=2,disagreements_resolved:protocol.disagreements_resolved===true,all_conditions:['empty','light','heavy','motorcycle','occlusion'].every(c=>conditions.has(c)),calibration_test_split:calibration.size>0&&testSources.length>0&&testSources.every(s=>!calibration.has(s)),source_checksums:testSources.every(s=>/^[a-f0-9]{64}$/i.test(sourceHashes.get(s)??''))};
  const protocolEligible=Object.values(checks).every(Boolean),queueTarget=perRoi.every(r=>r.numerical_target_met===true),waitMAE=mean(trackWaitErrors);
  const gate=(target,available=true)=>!available?'pending evidence':target===false?'failed numerical target':!protocolEligible?'pending locked annotation protocol':target===true?'numerical target met; requires independent annotation review':'pending zero-reference review';
  const report={schema:'simpang-annotation-evaluation-v1',source_name:document.source_name??null,source_sha256:document.source_sha256??null,annotator:document.annotator??null,frames:document.frames.length,iou_threshold:iouThreshold,matching:'greedy descending IoU, class-aware, one-to-one',detection:{true_positive:tp,false_positive:fp,false_negative:fn,precision:tp+fp?tp/(tp+fp):null,recall:tp+fn?tp/(tp+fn):null},tracking:{id_switches:switches,mota:groundTruth?1-(fp+fn+switches)/groundTruth:null,annotated_paths:truthIds.size,matched_paths:matchedIds.size,matched_path_fraction:truthIds.size?matchedIds.size/truthIds.size:null,scope:'ID switches across annotated observations per source+truth ID; not HOTA/IDF1'},measurement:{queue_mae_vehicles:mean(queueErrors.flat()),queue_absolute_error_p95_vehicles:percentile(queueErrors.flat(),.95),queue_per_roi:perRoi,max_wait_mae_s:mean(maxWaitErrors),matched_track_wait_mae_s:waitMAE,wait_annotated_paths:waitTruthIds.size,wait_matched_paths:waitMatchedIds.size,wait_matched_path_fraction:waitTruthIds.size?waitMatchedIds.size/waitTruthIds.size:null,served_cumulative_mae_vehicles:mean(servedErrors),served_intervals_per_direction:served,valid_roi_samples:validSamples,invalid_roi_samples:invalidRoiSamples},protocol:{eligible:protocolEligible,checks,supplied:protocol},srs_targets:{NFR01:{mae_max_vehicles:2,p95_abs_error_max_vehicles:5,status:gate(queueTarget,validSamples>0)},NFR02:{wape_max_pct:10,status:gate(served.some(s=>s.numerical_target_met===false)?false:served.every(s=>s.numerical_target_met===true)?true:null,served.every(s=>s.intervals>0))},NFR03:{matched_track_wait_mae_max_s:3,status:gate(waitMAE===null?null:waitMAE<=3,trackWaitErrors.length>0),match_fraction:waitTruthIds.size?waitMatchedIds.size/waitTruthIds.size:null}},acceptance_status:'metrics require independent annotation review; eligibility and numerical failures reported separately'};
  report.inference_profile={vehicle_classes:vehicleClasses,model_weights_sha256:document.model_weights_sha256??null,renderer:document.renderer??null};
  return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const [input,output='validation/annotation-evaluation.json']=process.argv.slice(2);if(!input)throw Error('Usage: node scripts/evaluate-annotations.mjs annotations.json [report.json]');
  const raw=readFileSync(input,'utf8'),result=evaluateAnnotations(JSON.parse(raw));result.annotations_file_sha256=createHash('sha256').update(raw).digest('hex');writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}
