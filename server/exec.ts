import { execFile } from "node:child_process";
import type { CliExecutor } from "./service.js";
export const nativeCLI: CliExecutor = {
  run(binary, argv, timeout) {
    return new Promise((resolve) => {
      execFile(
        binary,
        argv,
        {
          encoding: "utf8",
          shell: false,
          timeout,
          killSignal: "SIGTERM",
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        },
        (error, stdout) => {
          resolve({...classifyExit(error),stdout:stdout??""});
        },
      );
    });
  },
};

export function classifyExit(error:{code?:string|number|null;killed?:boolean;signal?:string|null}|null):{code:number;notStarted:boolean}{
  if(!error)return {code:0,notStarted:false};
  if(error.killed||error.signal)return {code:-2,notStarted:false};
  if(typeof error.code==="number")return {code:error.code,notStarted:false};
  if(typeof error.code==="string"&&/^E(?!RR_)[A-Z0-9_]+$/.test(error.code))return {code:-1,notStarted:true};
  return {code:-2,notStarted:false};
}
