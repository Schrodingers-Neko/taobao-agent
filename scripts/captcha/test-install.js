'use strict';
const assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),crypto=require('crypto');
const asar=require('@electron/asar'),d=require('../declutter'),transforms=require('./transforms');
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const {spawnSync}=require('child_process');
async function pack(source,target){
  await asar.createPackageWithOptions(source,target,{unpackDir:'native'});
  const raw=asar.getRawHeader(target);function end(n){return Math.max(0,...Object.values(n.files||{}).map(x=>x.files?end(x):x.offset===undefined?0:Number(x.offset)+x.size));}
  while(fs.statSync(target).size<8+raw.headerSize+end(raw.header))await new Promise(r=>setTimeout(r,10));asar.uncache(target);
}
async function runFixtures(files,archive){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'taobao-captcha-fixture-'));
  try{
    const source=path.join(root,'source');
    const names=asar.listPackage(archive).map(p=>p.replace(/\\/g,'/').replace(/^\/+/,''));
    const menu=names.find(p=>/^out\/renderer\/assets\/js\/pages\/browserLikeWindow-[^/]+\.js$/.test(p));
    const css=names.find(p=>/^out\/renderer\/assets\/css\/browserLikeWindow-[^/]+\.css$/.test(p));
    const content={...files,[menu]:asar.extractFile(archive,path.join(...menu.split('/'))),[css]:asar.extractFile(archive,path.join(...css.split('/'))),
      'out/preload/css/home.css':'body{color:black}','out/preload/css/tbhome.css':'body{color:black}','native/sidecar.bin':Buffer.from([1,2,3])};
    for(const [p,v]of Object.entries(content)){const f=path.join(source,...p.split('/'));fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,v);}
    const o={asarPath:path.join(root,'app.asar'),userDataDir:path.join(root,'data'),restart:false},ctx=d.context(o);await pack(source,o.asarPath);
    const original=hash(ctx.archive);
    await d.applyDeclutter('toolbar',o);await d.restoreDeclutter('toolbar',o);
    let m=JSON.parse(fs.readFileSync(ctx.manifestPath));m.version=4;m.patchRevision=4;delete m.enabled['captcha-guard'];fs.writeFileSync(ctx.manifestPath,JSON.stringify(m));
    await d.applyDeclutter('toolbar',o);m=JSON.parse(fs.readFileSync(ctx.manifestPath));assert.equal(m.version,5);assert.equal(m.enabled['captcha-guard'],false);
    await d.restoreDeclutter('toolbar',o);m=JSON.parse(fs.readFileSync(ctx.manifestPath));
    for(let mask=0;mask<16;mask++){
      const enabled={...d.patches.empty(),'captcha-guard':true};d.patches.IDS.forEach((id,i)=>enabled[id]=!!(mask&(1<<i)));
      const output=d.desiredFiles(ctx,m,enabled);
      for(const p of transforms.FILES)assert(output[p].includes(p==='out/main/index.js'?'__taobaoCaptchaGuard':'__taobaoCaptchaRenderer'));
      assert.equal(output[menu].includes(d.patches.PREFIX+'main-menu'),enabled['main-menu']);assert.equal(output[menu].includes(d.patches.PREFIX+'toolbar:'),enabled.toolbar);
      assert.equal(output['out/preload/index.js'].includes(d.patches.PREFIX+'home-loader'),enabled['home-widgets']||enabled['search-promotions']);
    }
    await d.applyDeclutter('captcha-guard',o);await d.restoreDeclutter('all',o);assert.equal(JSON.parse(fs.readFileSync(ctx.manifestPath)).enabled['captcha-guard'],true);
    await d.restoreDeclutter('captcha-guard',o);assert.equal(hash(ctx.archive),original);
    const registry=fs.readFileSync(ctx.manifestPath),optionsFile=path.join(root,'options.json');fs.writeFileSync(optionsFile,JSON.stringify(o));
    const child=spawnSync(process.execPath,[path.join(__dirname,'../test-captcha.js'),'--interrupt-guard',optionsFile],{encoding:'utf8'});
    assert.equal(child.status,42,child.stderr);assert(JSON.parse(fs.readFileSync(ctx.manifestPath)).pending);
    await d.restoreDeclutter('captcha-guard',o);assert.equal(hash(ctx.archive),original);assert.equal(fs.readFileSync(ctx.manifestPath).toString(),registry.toString());
    const unsupported=path.join(root,'unsupported'),badSource=path.join(unsupported,'source');fs.mkdirSync(badSource,{recursive:true});
    for(const [p,v]of Object.entries(content)){const f=path.join(badSource,...p.split('/'));fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,p==='out/main/index.js'?String(v).replace('async function Dm(', 'async function unsupportedDm('):v);}
    const bad={asarPath:path.join(unsupported,'app.asar'),userDataDir:path.join(unsupported,'data'),restart:false};await pack(badSource,bad.asarPath);const before=hash(bad.asarPath);
    await assert.rejects(d.applyDeclutter('captcha-guard',bad),/Unsupported/);assert.equal(hash(bad.asarPath),before);assert.equal(fs.existsSync(d.context(bad).backupDir),false);
    console.log('PASS: v4 migration defaults guard off, all 16 UI combinations retain guard, all excludes guard, exact restore, real interrupted guard-install recovery and preflight rejection before writes.');
  }finally{if(path.dirname(root)!==os.tmpdir()||!path.basename(root).startsWith('taobao-captcha-fixture-'))throw Error('Unsafe cleanup');asar.uncacheAll();fs.rmSync(root,{recursive:true,force:true});}
}
function copyClient(root,live){
  const o={asarPath:path.join(root,'app.asar'),userDataDir:path.join(root,'data'),restart:false};
  const ctx=d.context(o),m=JSON.parse(fs.readFileSync(live.manifestPath));
  fs.mkdirSync(ctx.backupDir,{recursive:true});fs.mkdirSync(ctx.cssDir,{recursive:true});
  fs.copyFileSync(live.archive,ctx.archive);fs.cpSync(live.archive+'.unpacked',ctx.archive+'.unpacked',{recursive:true});
  const dir=path.join(ctx.backupDir,'baseline-copy');fs.mkdirSync(dir);
  m.archivePath=ctx.archive;m.cssDir=ctx.cssDir;m.baseline.root=dir;
  const sourceBaseline=m.baseline.archive.file;m.baseline.archive.file=path.join(dir,'app.asar.bak');fs.copyFileSync(sourceBaseline,m.baseline.archive.file);
  for(const r of m.baseline.css)if(r.existed){const source=r.file;r.file=path.join(dir,r.filename+'.bak');fs.copyFileSync(source,r.file);}
  for(const n of d.patches.HOME_FILES)if(fs.existsSync(path.join(live.cssDir,n)))fs.copyFileSync(path.join(live.cssDir,n),path.join(ctx.cssDir,n));
  fs.writeFileSync(ctx.manifestPath,JSON.stringify(m));return {o,ctx,m};
}
async function run(_files,_archive,smoke=false){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'taobao-captcha-check-'));
  try{
    const live=d.context(),{o,ctx,m}=copyClient(root,live);
    if(m.enabled?.['captcha-guard'])await d.restoreDeclutter('captcha-guard',o);
    const before=d.installedHashes(ctx);
    const originalManifest=fs.readFileSync(ctx.manifestPath),baselineHash=hash(m.baseline.archive.file);
    assert.deepEqual(d.patches.targets('all'),['home-widgets','search-promotions','main-menu','toolbar']);
    await d.applyDeclutter('captcha-guard',o);
    let current=JSON.parse(fs.readFileSync(ctx.manifestPath));assert.equal(current.version,5);assert.equal(current.enabled['captcha-guard'],true);
    assert.deepEqual(current.baseline,m.baseline);assert.deepEqual(current.expected.css,before.css);assert.equal(hash(m.baseline.archive.file),baselineHash);
    for(const p of transforms.FILES)assert(asar.extractFile(ctx.archive,path.join(...p.split('/'))).toString().includes(p==='out/main/index.js'?'__taobaoCaptchaGuard':'__taobaoCaptchaRenderer'));
    if(smoke){await d.restoreDeclutter('captcha-guard',o);assert.deepEqual(d.installedHashes(ctx),before);console.log('PASS: final guard payload on full disposable client, archive integrity, 543 sidecars, existing signatures/CSS and exact independent restore.');return;}
    // all does not disable the guard, and an unrelated UI operation composes it again.
    await d.restoreDeclutter('toolbar',o);await d.applyDeclutter('toolbar',o);await d.applyDeclutter('all',o);
    current=JSON.parse(fs.readFileSync(ctx.manifestPath));assert.equal(current.enabled['captcha-guard'],true);
    await d.restoreDeclutter('captcha-guard',o);assert.deepEqual(d.installedHashes(ctx),before);
    // A failed guard install restores the complete prior registry and bytes.
    const registry=fs.readFileSync(ctx.manifestPath);
    await assert.rejects(d.applyDeclutter('captcha-guard',{...o,hooks:{afterArchiveWrite(){throw new Error('fixture interruption');}}}),/fixture interruption/);
    assert.equal(fs.readFileSync(ctx.manifestPath).toString(),registry.toString());assert.deepEqual(d.installedHashes(ctx),before);
    // Unsupported anchors reject before the transaction hook or any installed-file mutation.
    const unsupported=path.join(root,'unsupported');fs.mkdirSync(unsupported);
    for(const [p,v]of Object.entries(_files))assert.throws(()=>{
      if(p==='out/main/index.js')transforms.main(v.replace('async function Dm(', 'async function unsupportedDm('));else transforms.renderer(v.replace(p==='out/preload/index.js'?'function k(e,t){':'!function(e,t){','/* changed anchor */'),p);
    },/Unsupported/);
    // Installed drift must be rejected, with no repair or overwrite.
    const fd=fs.openSync(ctx.archive,'r+'),byte=Buffer.alloc(1);fs.readSync(fd,byte,0,1,fs.statSync(ctx.archive).size-1);const last=Buffer.from(byte);byte[0]^=1;fs.writeSync(fd,byte,0,1,fs.statSync(ctx.archive).size-1);fs.closeSync(fd);
    const drift=hash(ctx.archive);await assert.rejects(d.applyDeclutter('captcha-guard',o),/changed outside/);assert.equal(hash(ctx.archive),drift);
    const repair=fs.openSync(ctx.archive,'r+');fs.writeSync(repair,last,0,1,fs.statSync(ctx.archive).size-1);fs.closeSync(repair);
    console.log('PASS: full disposable client, v4→v5 migration, independent guard apply/restore, UI interaction, exact rollback, immutable baseline and drift rejection.');
  }finally{
    if(path.dirname(path.resolve(root))!==path.resolve(os.tmpdir())||!path.basename(root).startsWith('taobao-captcha-check-'))throw Error('Unsafe fixture cleanup');
    asar.uncacheAll();fs.rmSync(root,{recursive:true,force:true});
  }
}
module.exports={run,runFixtures};
