#!/usr/bin/env node
'use strict';
// Metadata and the guard's pure local status only. Never launches or resumes the client.
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto');
const {execFileSync}=require('child_process');
const {callPipe}=require('../../taobao-mcp-bridge');
const {context}=require('../declutter');
async function main(){
  if(!process.argv.includes('--manual-confirmed'))throw new Error('仅在用户明确确认手动验证完成、并已恢复本地协调器后，使用 --manual-confirmed 运行采样。');
  const at=process.argv.indexOf('--seconds'),seconds=at<0?600:Number(process.argv[at+1]);
  if(!Number.isFinite(seconds)||seconds<=0)throw new Error('Invalid sampling duration.');
  const ctx=context(),m=JSON.parse(fs.readFileSync(ctx.manifestPath));
  if(m.version!==5||!m.enabled['captcha-guard']||m.pending)throw new Error('CAPTCHA guard is not installed or its transaction is unfinished.');
  if(crypto.createHash('sha256').update(fs.readFileSync(ctx.archive)).digest('hex')!==m.expected.archive)throw new Error('Installed archive drift; refusing to call the client.');
  const out=path.resolve(__dirname,'../../backup/captcha-investigation','profile-'+new Date().toISOString().replace(/[:.]/g,'-')+'.jsonl');fs.mkdirSync(path.dirname(out),{recursive:true});
  const script="[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); @(Get-Process -Name '淘宝桌面版' -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{Id=$_.Id;CPU=$_.CPU;WorkingSet=$_.WorkingSet64;PrivateBytes=$_.PrivateMemorySize64} }) | ConvertTo-Json -Compress";
  let previous=null;const deadline=Date.now()+seconds*1000;
  while(true){
    const raw=execFileSync('powershell.exe',['-NoProfile','-Command',script],{encoding:'utf8',windowsHide:true}).trim();
    const rows=raw?JSON.parse(raw):[],processes=Array.isArray(rows)?rows:[rows];
    if(!processes.length){console.log('Client is closed; sampling stopped.');break;}
    const response=await callPipe({tool:'get_verification_status',arguments:{}},5000);
    if(response.error)throw new Error(JSON.stringify(response.error));
    const status=response.result,now=Date.now();
    const comparable=previous&&processes.every(p=>p.CPU!==null&&previous.cpu.has(p.Id));
    const cpuPercent=comparable?processes.reduce((n,p)=>n+Math.max(0,p.CPU-previous.cpu.get(p.Id)),0)/((now-previous.time)/1000)/os.cpus().length*100:null;
    const row={timestamp:new Date(now).toISOString(),processes:processes.length,cpuPercent,
      workingSetBytes:processes.reduce((n,p)=>n+p.WorkingSet,0),privateBytes:processes.reduce((n,p)=>n+p.PrivateBytes,0),verification:status};
    fs.appendFileSync(out,JSON.stringify(row)+'\n');console.log(JSON.stringify(row));
    if(status.state!=='idle'){console.log('Verification is outstanding; sampling stopped immediately.');break;}
    if(now>=deadline)break;
    previous={time:now,cpu:new Map(processes.map(p=>[p.Id,p.CPU]))};
    await new Promise(resolve=>setTimeout(resolve,Math.min(5000,deadline-now)));
  }
  console.log('Saved '+out);
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
