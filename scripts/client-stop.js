#!/usr/bin/env node
require('./declutter').stopClient().then(()=>console.log('Taobao Desktop is closed.')).catch(e=>{console.error(e.message);process.exitCode=1;});
