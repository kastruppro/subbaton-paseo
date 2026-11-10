import { realpath,stat,access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname,isAbsolute,delimiter,normalize } from 'node:path';
import { nativeCLI } from './exec.js';
import type { CliExecutor } from './service.js';
export const defaultBinary='/Users/Shared/subbaton/subbaton';
export const codeRequirement='=anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = "5W98EXLE44" and identifier "dk.kastruppro.subbaton"';
export interface BinarySystem {
  uid:number;
  path:string;
  realpath(path:string):Promise<string>;
  stat(path:string):Promise<{uid:number;mode:number;kind:'file'|'directory'|'other';executable:boolean}>;
  verify(path:string):Promise<boolean>;
}
export class BinaryTrustError extends Error {
  constructor(readonly reason:'missing'|'permissions'|'signature'|'path'){
    super({missing:'SubBaton binary is missing. Install the signed binary or explicitly enable verified PATH lookup.',permissions:'SubBaton binary or a parent directory has an untrusted owner or writable permissions.',signature:'SubBaton needs a valid Developer ID signature for team 5W98EXLE44 and identifier dk.kastruppro.subbaton.',path:'Choose an absolute signed binary path. PATH lookup requires explicit opt-in.'}[reason]);
  }
}
export async function verifySignature(path:string,runner:CliExecutor=nativeCLI):Promise<boolean>{
  try{return (await runner.run('/usr/bin/codesign',['--verify','--strict','-R',codeRequirement,path],5000)).code===0;}catch{return false;}
}
const nativeSystem:BinarySystem={
  uid:process.getuid?.()??-1,path:process.env.PATH??'',realpath,
  async stat(path){const value=await stat(path);let executable=false;try{await access(path,constants.X_OK);executable=true;}catch{}return {uid:value.uid,mode:value.mode,kind:value.isFile()?'file':value.isDirectory()?'directory':'other',executable};},
  verify:verifySignature,
};
function absent(error:unknown){return !!error&&typeof error==='object'&&'code'in error&&['ENOENT','ENOTDIR'].includes(String(error.code));}
export async function resolveBinary(path:string,allowPathLookup=false,system:BinarySystem=nativeSystem):Promise<string>{
  if(!path||path.length>4096||/[\u0000-\u001f]/.test(path)||system.uid<0||!isAbsolute(path)&&!(path==='subbaton'&&allowPathLookup))throw new BinaryTrustError('path');
  let canonical:string|undefined;
  if(isAbsolute(path)){
    try{canonical=await system.realpath(path);}catch(error){if(!absent(error))throw new BinaryTrustError('permissions');if(path!==defaultBinary||!allowPathLookup)throw new BinaryTrustError('missing');}
  }
  if(!canonical&&allowPathLookup){
    for(const entry of system.path.split(delimiter).filter(p=>isAbsolute(p)&&!/[\u0000-\u001f]/.test(p))){
      try{canonical=await system.realpath(entry+'/subbaton');break;}catch(error){if(!absent(error))throw new BinaryTrustError('permissions');}
    }
  }
  if(!canonical)throw new BinaryTrustError('missing');
  if(!isAbsolute(canonical)||normalize(canonical)!==canonical)throw new BinaryTrustError('path');
  try{
    const file=await system.stat(canonical);
    if(file.kind!=='file'||!file.executable||![0,system.uid].includes(file.uid)||(file.mode&0o022)!==0)throw new BinaryTrustError('permissions');
    const directParent=dirname(canonical);
    for(let parent=directParent;;parent=dirname(parent)){
      const value=await system.stat(parent);
      const shared=parent==='/Users/Shared'&&parent!==directParent&&value.uid===0&&(value.mode&0o1000)!==0;
      if(value.kind!=='directory'||![0,system.uid].includes(value.uid)||!shared&&(value.mode&0o022)!==0)throw new BinaryTrustError('permissions');
      if(parent==='/')break;
    }
  }catch(error){if(error instanceof BinaryTrustError)throw error;throw new BinaryTrustError('permissions');}
  if(!await system.verify(canonical))throw new BinaryTrustError('signature');
  return canonical;
}
