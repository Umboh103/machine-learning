import {Sha256} from './sha256.js';
self.onmessage=async({data:file})=>{
  try{
    const hash=new Sha256(),chunk=4*1024*1024;
    for(let offset=0;offset<file.size;offset+=chunk){hash.update(new Uint8Array(await file.slice(offset,offset+chunk).arrayBuffer()));self.postMessage({progress:Math.min(1,(offset+chunk)/file.size)});}
    self.postMessage({sha256:hash.digest()});
  }catch{self.postMessage({error:'Berkas tidak dapat dibaca untuk checksum.'});}
};
