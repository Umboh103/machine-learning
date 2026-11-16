import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
let driver;try{driver=await import('playwright');}catch{driver=await import('../../../.tooling/node_modules/playwright/index.mjs');}
const browser=await driver.chromium.launch({headless:true,executablePath:process.env.SIMPANG_CHROMIUM});
try{
  const page=await browser.newPage();await page.goto(process.env.SIMPANG_URL??'http://127.0.0.1:8000');
  const result=await page.evaluate(async()=>{
    const {FileHash}=await import('/file-hash.js');
    const hasher=new FileHash(),part=new Uint8Array(1024*1024).fill(97),file=new File(Array(9).fill(part),'nine-megabytes.fixture');
    const progress=[],sha256=await hasher.digest(file,value=>progress.push(value));
    const cancelled=hasher.digest(file).then(()=>null,error=>error.name);hasher.cancel();
    return {sha256,progress,bytes:file.size,cancelled:await cancelled};
  });
  assert.equal(result.sha256,createHash('sha256').update(Buffer.alloc(result.bytes,97)).digest('hex'));assert(result.progress.length>=3);assert.equal(result.progress.at(-1),1);assert.equal(result.cancelled,'AbortError');
  writeFileSync('validation/file-worker-check.json',JSON.stringify({pass:true,...result,scope:'Actual browser worker hashing a 9 MiB File, multiple bounded reads, SHA-256 agrees with Node crypto, cancellation verified'},null,2));
  console.log(JSON.stringify({pass:true,bytes:result.bytes,progress_messages:result.progress.length,cancelled:result.cancelled}));
}finally{await browser.close();}
