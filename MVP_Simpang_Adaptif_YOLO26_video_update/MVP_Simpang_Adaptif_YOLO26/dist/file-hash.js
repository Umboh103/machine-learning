export class FileHash {
  constructor(){this.worker=null;this.reject=null;}
  cancel(){this.worker?.terminate();this.worker=null;this.reject?.(new DOMException('Berkas diganti','AbortError'));this.reject=null;}
  digest(file,onProgress=()=>{}){
    this.cancel();
    return new Promise((resolve,reject)=>{
      const worker=new Worker(new URL('./hash-worker.js',import.meta.url),{type:'module'});this.worker=worker;this.reject=reject;
      const finish=(error,value)=>{worker.terminate();if(this.worker===worker){this.worker=null;this.reject=null;}error?reject(error):resolve(value);};
      worker.onmessage=({data})=>{if(data.error)finish(Error(data.error));else if(data.sha256)finish(null,data.sha256);else onProgress(data.progress);};
      worker.onerror=()=>finish(Error('Pemeriksaan checksum gagal. Muat ulang halaman lalu pilih berkas lagi.'));
      worker.postMessage(file);
    });
  }
}
