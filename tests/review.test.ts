import test from 'node:test';
import assert from 'node:assert/strict';
import { SubBatonService,type CliExecutor } from '../server/service.js';
test('M1 abnormal mutation outcomes always require recovery',async()=>{
  for(const response of [
    {code:-1,stdout:'{"schemaVersion":1'},
    {code:0,stdout:'half-written'},
    {code:0,stdout:'x'.repeat(1024*1024+1)},
    {code:2,stdout:''},
    {code:2,stdout:JSON.stringify({schemaVersion:1,ok:false,error:{code:'other'}})},
    {code:137,stdout:JSON.stringify({schemaVersion:1,ok:true,result:{outcome:'switched'}})},
    {code:0,stdout:JSON.stringify({schemaVersion:1,ok:true})},
  ]){
    let calls=0;const cli:CliExecutor={async run(){calls++;return response;}};
    const service=new SubBatonService(cli,async()=>'/fixture/subbaton');
    const result=await service.strategy({provider:'claude',strategy:'best'});
    assert.equal(result.outcome,'uncertain');assert.match(result.message,/recovery/i);assert.equal(calls,1);
  }
});
test('M1 parsed refusal remains an error but a thrown crash is uncertain',async()=>{
  for(const crash of [false,true]){
    const service=new SubBatonService({async run(){if(crash)throw new Error('secret crash');return {code:1,stdout:JSON.stringify({schemaVersion:1,ok:false,error:{code:'busy'}})};}},async()=>'/fixture/subbaton');
    const result=await service.strategy({provider:'claude',strategy:'best'});assert.equal(result.outcome,crash?'uncertain':'error');assert.ok(!JSON.stringify(result).includes('secret'));
  }
});
test('M1 definite pre-spawn failure stays a configuration error',async()=>{
  const service=new SubBatonService({async run(){return {code:-1,notStarted:true,stdout:''};}},async()=>'/fixture/subbaton');
  assert.equal((await service.strategy({provider:'claude',strategy:'best'})).outcome,'error');
});
