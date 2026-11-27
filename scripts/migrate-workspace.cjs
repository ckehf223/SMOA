'use strict';
// One-off migration utility; not an application server dependency.
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const assert = require('node:assert/strict');
const milestones = require('../../Three Area/src/ui/person-milestones.js');
const hash = x => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
function seal(value, key, aad) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm',key,iv);
  c.setAAD(Buffer.from(aad));
  const body = Buffer.concat([c.update(JSON.stringify(value)),c.final()]);
  return JSON.stringify({version:1,keyVersion:'v1',aad,iv:iv.toString('base64'),tag:c.getAuthTag().toString('base64'),body:body.toString('base64')});
}
function open(text,key,aad) {
  const e=JSON.parse(text); assert.equal(e.aad,aad);
  const d=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(e.iv,'base64'));
  d.setAAD(Buffer.from(aad)); d.setAuthTag(Buffer.from(e.tag,'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(e.body,'base64')),d.final()]).toString());
}
const nullable = v => v === '' || v === undefined ? null : v;
const day = v => v ? String(v).slice(0,10) : null;
const clock = v => v ? String(v).length===5 ? v+':00' : v : null;
const stamp = v => {if(!v)return null;const s=String(v).replace('T',' ').replace(/Z$/,'').slice(0,19);return s.length===16?s+':00':s.length===10?s+' 00:00:00':s;};
function planner(ws,key) {
  const lib=ws.id, rows=[], identities=new Set(), phones=ws.people.map(p=>String(p.phone||'')).filter(Boolean);
  const maskPhones=[...new Set(phones)].filter(p=>p.replace(/\D/g,'').length>=7);
  const phonePattern=maskPhones.length?new RegExp(maskPhones.map(p=>p.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|'),'g'):null;
  const clean = value => {
    if(typeof value==='string') {
      if(phonePattern)value=value.replace(phonePattern,'[연락처 비공개]');
      return value.replace(/(?:\+82[- .]?)?0?1[016789][- .]?\d{3,4}[- .]?\d{4}/g,'[연락처 비공개]');
    }
    if(Array.isArray(value)) return value.map(clean);
    if(value&&typeof value==='object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,/phone|password|token|secret/i.test(k)?'[비공개]':clean(v)]));
    return value;
  };
  const aad=(table,id,col)=>`SMOA:v1:${lib}:${table}:${id}:${col}`;
  function add(table,id,row,raw=row,pk=null) {
    id=String(id);assert(!identities.has(table+':'+id),'duplicate source identity');identities.add(table+':'+id);
    row=Object.fromEntries(Object.entries(row).map(([k,v])=>[k,v&&typeof v==='object'&&v.ref?v:/(?:_ID|_CODE|_HASH|_ENC)$/.test(k)||k==='CONFIG_VALUE'?v:clean(v)])); rows.push({table,id,row,raw,pk,sourceHash:hash(raw)}); return row;
  }
  const nodes=ws.organization.nodes, byId=new Map(nodes.map(n=>[n.id,n]));
  const root=nodes.find(n=>n.type==='지역'); assert(root,'region missing');
  const areaByName=new Map(nodes.filter(n=>n.type==='구역').map(n=>[n.name,n]));
  const region = {ORG_MSTR_CODE:root.id};
  const scope = name => ({...region,ORG_CODE:areaByName.get(name)?.id||null});
  add('LIBMSTR',lib,{LIB_ID:lib,LIB_NAME:ws.name,LEGACY_LIB_ID:lib,USE_IND:'Y'}, {id:lib,name:ws.name},'LIB_ID');
  add('ORGMSTR',root.id,{ORG_MSTR_CODE:root.id,ORG_MSTR_NAME_HAN:root.name,USE_IND:'Y'},root,'ORG_MSTR_CODE');
  for(const [i,n] of nodes.filter(n=>n.type==='구역').entries()) add('ORGDTL',n.id,{...region,ORG_CODE:n.id,ORG_NAME_HAN:n.name,SORT_NO:i,USE_IND:n.active===false?'N':'Y'},n,'ORG_CODE');
  for(const m of ws.organization.members) {
    const n=byId.get(m.unitId); add('PSMSTR',m.id,{EMPL_ID:m.id,EMPL_CODE:nullable(m.code),EMPL_NAME_HAN:m.name,...region,ORG_CODE:n?.type==='구역'?n.id:null,TITLE_CODE:nullable(m.position),BAN_CODE:nullable(m.className),JOB_CODE:nullable(m.employment),STATUS_CODE:nullable(m.status),USE_IND:'Y'},m,'EMPL_ID');
  }
  const memberIds=new Set(ws.organization.members.map(m=>m.id));
  const targetRef=id=>id&&ws.people.some(p=>p.id===id)?{ref:id}:null;
  const milestoneColumns=['MANPIK_DATE','FIND_A_DATE','HAB_B_DATE','HAB_A_DATE','YOUNG_TTA_DATE','BOKSHIN_DATE','CARD_RECEIVED_DATE','CENTER_REGISTERED_DATE'];
  for(const p of ws.people) {
    const r=add('TGMSTR',p.id,{LIB_ID:lib,LEGACY_ID:p.id,TGT_CODE:nullable(p.code),TGT_NAME_HAN:p.name,PHONE_LAST4:p.phone?String(p.phone).replace(/\D/g,'').slice(-4):null,PHONE_KEY_VER:p.phone?'v1':null,SEX_CODE:nullable(p.gender),AGE:nullable(p.age),AGE_BASE_DATE:day(p.ageAsOf),FOUND_DATE:day(p.date),FOUND_TIME:clock(p.time),DATE_UNKNOWN_IND:p.dateUnknown?'Y':'N',CLASS1_CODE:nullable(p.classification1),CLASS2_CODE:nullable(p.classification2),PLACE_NAME:nullable(p.place),TOOL_NAME:nullable(p.tool),RESIDENCE:nullable(p.residence),TEACHER_NAME:nullable(p.teacher),REASON:nullable(p.reason),WORKER_NAME:nullable(p.worker),EMPL_ID:memberIds.has(p.introducerId)?p.introducerId:null,INTRO_EMPL_CODE:nullable(p.introducerSnapshot?.code),INTRO_NAME:nullable(p.introducerSnapshot?.name),INTRO_ORG_SNAPSHOT:nullable(p.introducerSnapshot?.unitPath||p.introducerSnapshot?.region),...scope(p.region),BAN_CODE:nullable(p.className),JOB_CODE:nullable(p.employment),STAGE_CODE:nullable(p.stage),STATUS_CODE:nullable(p.status),APPOINTMENT_TEXT:nullable(p.appointment),NOTES:nullable(p.notes),CUSTOM_JSON:JSON.stringify(clean(p.custom||{}))},p,'TGT_ID');
    if(p.phone) r.PHONE_ENC=seal(p.phone,key,aad('TGMSTR',p.id,'PHONE_ENC'));
    r.SOURCE_ENC=seal(p,key,aad('TGMSTR',p.id,'SOURCE_ENC'));
    milestones.fields.forEach((f,i)=>r[milestoneColumns[i]]=day(milestones.value(p,f.field,ws)));
    for(const [i,e] of (p.transitions||[]).entries()) add('TGSTGLOG',`${p.id}:${i}`,{LIB_ID:lib,TGT_ID:targetRef(p.id),LEGACY_ID:e.id,SEQ_NO:i+1,FROM_STAGE:nullable(e.from),TO_STAGE:nullable(e.to),FROM_NAME:nullable(e.fromName),TO_NAME:nullable(e.toName),APPLY_DTTM:stamp(e.effectiveLocal),RECORDED_DTTM:stamp(e.recordedAt),TIME_UNKNOWN_IND:e.timeUnknown?'Y':'N',BASELINE_IND:e.baseline?'Y':'N',ACTOR_NAME:typeof e.actor==='string'?e.actor:null,REASON:nullable(e.reason),...scope(e.region),BAN_CODE:nullable(e.className),WORKER_NAME:nullable(e.worker),EMPL_ID:memberIds.has(e.memberId)?e.memberId:null,EMPL_CODE:nullable(e.workerId),JOB_CODE:nullable(e.employment)},e,'STG_LOG_ID');
    for(const [i,e] of (p.lifecycle||[]).entries()) add('TGSTATLOG',`${p.id}:${i}`,{LIB_ID:lib,TGT_ID:targetRef(p.id),LEGACY_ID:e.id,SEQ_NO:i+1,FROM_STATUS:nullable(e.from),TO_STATUS:nullable(e.to),APPLY_DTTM:stamp(e.effectiveLocal),RECORDED_DTTM:stamp(e.recordedAt),ACTOR_NAME:typeof e.actor==='string'?e.actor:null,REASON:nullable(e.reason),...scope(e.region)},e,'STAT_LOG_ID');
  }
  const activities=[...ws.activityLogs.map(a=>({a,p:null})),...ws.people.flatMap(p=>(p.activities||[]).map(a=>({a,p})))];
  for(const {a,p} of activities) { const id=p?`${p.id}:${a.id}`:a.id; const r=add('ACTMSTR',id,{LIB_ID:lib,LEGACY_ID:id,TGT_ID:targetRef(p?.id),ACT_CODE:nullable(a.code),ACT_DATE:day(a.date),START_TIME:clock(a.start),END_TIME:clock(a.end),ACT_MINUTES:Number(a.minutes||0),CLASS2_CODE:nullable(a.classification2),SESSION_KEY:nullable(a.sessionKey),EMPL_ID:memberIds.has(a.workerId)?a.workerId:null,EMPL_NAME:nullable(a.worker),...scope(a.region),BAN_CODE:nullable(a.className),PLACE_NAME:nullable(a.place),ACT_KIND_NAME:nullable(a.kind),MEMO:nullable(a.notes)},a,'ACT_ID');r.SOURCE_ENC=seal(a,key,aad('ACTMSTR',id,'SOURCE_ENC')); }
  for(const [i,a] of ws.regionalActivities.entries()) add('ORGACT',String(i),{LIB_ID:lib,EMPL_ID:a.memberId,EMPL_CODE:nullable(a.memberCode),EMPL_NAME:nullable(a.name),ACT_MONTH:a.month,ACT_DATE:day(a.date),PERIOD_KEY:a.date||a.month,ACT_STATUS_CODE:a.code,...scope(a.region)},a,'ORG_ACT_ID');
  for(const a of ws.callingRecords) add('CALLMSTR',a.id,{LIB_ID:lib,LEGACY_ID:a.id,TGT_ID:targetRef(a.personId),TGT_NAME_HAN:nullable(a.personName),TGT_CODE:nullable(a.personCode),INTRO_NAME:nullable(a.introducer),...scope(a.area),FOUND_DATE:day(a.findingDate),CALL_DATE:day(a.date),CALL_TIME:clock(a.time),CALLER_NAME:nullable(a.caller),ROUND_NO:Math.min(5,Number(a.round)||0),ROUND_NAME:nullable(a.roundName),RESULT_CODE:nullable(a.result),ORIGINAL_RESULT:nullable(a.originalResult||a.result),REPORTED_RESULT:nullable(a.reportedResult),NOTES:nullable(a.notes)},a,'CALL_ID');
  for(const a of ws.goals) add('GOALMSTR',a.id,{LIB_ID:lib,LEGACY_ID:a.id,...scope(a.region),BAN_CODE:nullable(a.className),FROM_DATE:day(a.from),TO_DATE:day(a.to),STAGE_CODE:nullable(a.stageId==='*'?null:a.stageId),PERIOD_CODE:a.periodUnit||'custom',TARGET_CNT:a.target},a,'GOAL_ID');
  for(const [i,a] of ws.history.entries()) {const r=add('CHGLOG',a.id,{LIB_ID:lib,LEGACY_ID:a.id,SEQ_NO:i+1,ACTION_NAME:a.action,TARGET_ID:typeof a.target==='string'?a.target:null,ACTOR_NAME:typeof a.actor==='string'?a.actor:null,ACT_DTTM:stamp(a.at),BEFORE_JSON:JSON.stringify(clean(a.before??null)),AFTER_JSON:JSON.stringify(clean(a.after??null)),PREV_HASH:a.previous||null,ENTRY_HASH:a.hash||null},a,'CHG_ID');r.SOURCE_ENC=seal(a,key,aad('CHGLOG',a.id,'SOURCE_ENC'));}
  const groups=[...(ws.commonCodes?.groups||[]),{id:'STAGE',label:'단계',items:ws.stages.map((s,i)=>({id:s,value:s,label:ws.stageNames[s]||s,order:i,active:!ws.inactiveStages.includes(s)}))}];
  for(const g of groups) {add('CODEMSTR',g.id,{LIB_ID:lib,GROUP_CODE:g.id,GROUP_NAME:g.label,USE_IND:g.active===false?'N':'Y'},g,'GROUP_CODE');for(const item of g.items||[])add('CODEDTL',`${g.id}:${item.id}`,{LIB_ID:lib,GROUP_CODE:g.id,ITEM_CODE:item.value||item.id,ITEM_NAME:item.label||item.value,ALIASES_JSON:JSON.stringify(item.aliases||[]),SORT_NO:item.order||0,USE_IND:item.active===false?'N':'Y'},item,'ITEM_CODE');}
  for(const p of ws.socialing.programs) add('SOCMSTR',p.id,{LIB_ID:lib,SOC_ID:p.id,SOC_NAME:p.name,USE_IND:'Y'},p,'SOC_ID');
  assert.equal(ws.socialing.pending.length,0,'pending socialing mapping required');
  assert.equal(ws.dailyReports.length+ws.findingReports.length,0,'daily report mapping required');
  // Complete source, including fields without dedicated business columns, stays encrypted.
  const raw=JSON.stringify(ws);for(let i=0;i<raw.length;i+=250000) {const id=`MIGRATION_SOURCE:${i/250000}`;add('SYSCFG',id,{LIB_ID:lib,CONFIG_CODE:id,CONFIG_NAME:'암호화 이관 원본',CONFIG_VALUE:seal(raw.slice(i,i+250000),key,aad('SYSCFG',id,'CONFIG_VALUE'))},{part:i/250000},'CONFIG_CODE');}
  return {lib,rows,sourceHash:hash(ws),aad,clean};
}
async function migrate(db,plan,key,mode='check') {
  const {lib,rows,sourceHash,aad}=plan; const job=`workspace-v1-${sourceHash.slice(0,32)}`;
  const [oldJobs]=await db.query("SELECT STATUS_CODE,SOURCE_SHA256 FROM MIGJOB WHERE JOB_ID=?",[job]);
  if(oldJobs.length) {assert.equal(oldJobs[0].STATUS_CODE,'DONE');await verify(db,plan,key);return {alreadyImported:true};}
  if(mode==='verify') throw Error('No completed migration');
  const [cols]=await db.query('SELECT TABLE_NAME,COLUMN_NAME,CHARACTER_MAXIMUM_LENGTH,IS_NULLABLE,DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()');
  const columnMap=new Map(cols.map(c=>[`${c.TABLE_NAME.toUpperCase()}.${c.COLUMN_NAME}`,c]));
  for(const [i,r] of rows.entries()) for(const [c,v] of Object.entries(r.row)) {const spec=columnMap.get(`${r.table}.${c}`);assert(spec,`column ${r.table}.${c}`);if(v==null)assert(spec.IS_NULLABLE==='YES',`null ${r.table}:${i}:${c}`);if(typeof v==='string'&&spec.CHARACTER_MAXIMUM_LENGTH!=null)assert([...v].length<=Number(spec.CHARACTER_MAXIMUM_LENGTH),`length ${r.table}:${i}:${c}`);}
  if(mode==='check')return {planned:rows.length,counts:countRows(rows)};
  assert.equal(mode,'apply'); await db.beginTransaction();const refs=new Map(), maps=[];
  try {
    const [existing]=await db.query('SELECT COUNT(*) n FROM MIGMAP WHERE LIB_ID=?',[lib]);assert.equal(Number(existing[0].n),0,'existing source mappings');
    await db.query('INSERT INTO MIGJOB (JOB_ID,LIB_ID,SOURCE_SHA256,MAPPING_VERSION,STATUS_CODE,START_DTTM) VALUES (?,?,?,?,?,UTC_TIMESTAMP())',[job,lib,sourceHash,'workspace-v1','RUNNING']);
    // Insert parents before child rows; source arrays may interleave parent/child definitions.
    const tables=[...new Set(rows.map(r=>r.table))];tables.sort((a,b)=>(a==='TGMSTR'?-1:b==='TGMSTR'?1:0));
    for(const table of tables) {
      console.log(JSON.stringify({stage:'insert',table}));
      const group=rows.filter(r=>r.table===table);
      if(table==='TGMSTR') {
        for(const r of group) {const [res]=await db.query('INSERT INTO `TGMSTR` SET ?',r.row);refs.set(r.id,String(res.insertId));maps.push({...r,target:String(res.insertId)});}
      } else {
        const columns=[...new Set(group.flatMap(r=>Object.keys(r.row)))];
        for(let offset=0;offset<group.length;offset+=100) {
          const batch=group.slice(offset,offset+100),values=batch.map(r=>columns.map(c=>{const v=r.row[c];return v&&typeof v==='object'&&v.ref?refs.get(v.ref):v??null;}));
          const [res]=await db.query(`INSERT INTO \`${table}\` (${columns.map(c=>'`'+c+'`').join(',')}) VALUES ?`,[values]);
          // Increment and offset are checked by caller. No concurrent writer can allocate inside this multi-row INSERT.
          const auto=columnMap.get(`${table}.${batch[0].pk}`)?.DATA_TYPE==='bigint';
          batch.forEach((r,i)=>maps.push({...r,target:auto?String(BigInt(res.insertId)+BigInt(i)):String(r.row[r.pk])}));
        }
      }
    }
    for(let i=0;i<maps.length;i+=100)await db.query('INSERT INTO MIGMAP (JOB_ID,LIB_ID,ENTITY_KIND,SOURCE_ID,TARGET_ID,SOURCE_ROW_HASH) VALUES ?',[maps.slice(i,i+100).map(r=>[job,lib,r.table,r.id,r.target,r.sourceHash])]);
    await verify(db,plan,key);
    await db.query("UPDATE MIGJOB SET STATUS_CODE='DONE',END_DTTM=UTC_TIMESTAMP(),TOTAL_CNT=?,LOADED_CNT=?,MESSAGE='Verified before commit' WHERE JOB_ID=?",[rows.length,rows.length,job]);
    await db.commit();return {inserted:rows.length,counts:countRows(rows)};
  }catch(e){await db.rollback();throw e;}
}
function countRows(rows){return rows.reduce((a,r)=>(a[r.table]=(a[r.table]||0)+1,a),{});}
async function verify(db,plan,key) {
  const [maps]=await db.query('SELECT ENTITY_KIND,SOURCE_ID,TARGET_ID,SOURCE_ROW_HASH FROM MIGMAP WHERE LIB_ID=?',[plan.lib]);assert.equal(maps.length,plan.rows.length,'mapping count');
  const lookup=new Map(maps.map(m=>[m.ENTITY_KIND+':'+m.SOURCE_ID,m]));const refs=new Map(maps.filter(m=>m.ENTITY_KIND==='TGMSTR').map(m=>[m.SOURCE_ID,m.TARGET_ID]));
  for(const table of [...new Set(plan.rows.map(r=>r.table))]) {
    const group=plan.rows.filter(r=>r.table===table), [actual]=await db.query('SELECT * FROM `'+table+'`');
    const rowKey=row=>table==='CODEDTL'?row.GROUP_CODE+':'+row.ITEM_CODE:String(row[group[0].pk]);
    const byPk=new Map(actual.map(row=>[rowKey(row),row]));
    for(const expected of group) {
      const mapping=lookup.get(table+':'+expected.id);assert(mapping,'mapping missing');assert.equal(mapping.SOURCE_ROW_HASH,expected.sourceHash,'source hash');const row=byPk.get(table==='CODEDTL'?expected.row.GROUP_CODE+':'+expected.row.ITEM_CODE:mapping.TARGET_ID);assert(row,'row missing');
      for(const [col,value] of Object.entries(expected.row)) {
        if(['PHONE_ENC','SOURCE_ENC','CONFIG_VALUE'].includes(col)&&value) {assert.deepEqual(open(row[col],key,plan.aad(table,expected.id,col)),open(value,key,plan.aad(table,expected.id,col)),`encrypted ${table}.${col}`);continue;}
        const v=value&&typeof value==='object'&&value.ref?refs.get(value.ref):value;
        assert.equal(row[col]==null?null:String(row[col]),v==null?null:String(v),`verify ${table}.${col}`);
      }
    }
  }
  return true;
}
async function main(){
  const args=Object.fromEntries(process.argv.slice(2).reduce((a,v,i,s)=>i%2?a:[...a,[v.replace(/^--/,''),s[i+1]]],[]));
  const key=await fs.readFile(args.key);assert.equal(key.length,32);
  const source=JSON.parse(await fs.readFile(args.source,'utf8'));const ws=open(JSON.stringify(source),key,'SMOA:Migration:Workspace:v1');
  const req=createRequire(args.modules+'/package.json'),env=Object.fromEntries((await fs.readFile(args.env,'utf8')).trim().split(/\r?\n/).map(s=>{const i=s.indexOf('=');return[s.slice(0,i).trim(),s.slice(i+1).trim()];}));
  const ssh=new(req('ssh2').Client)();let db;
  try{await new Promise((resolve,reject)=>ssh.once('ready',resolve).once('error',reject).connect({host:'165.140.21.214',username:'root',password:env.SMOA_SSH_PASSWORD,hostHash:'sha256',hostVerifier:h=>h===Buffer.from('8qlG8oTZ2ILUqwkQbffhwn6rE4th/lblgc4kUM8XZNo','base64').toString('hex')}));
    const stream=await new Promise((resolve,reject)=>ssh.forwardOut('127.0.0.1',0,'127.0.0.1',3306,(e,s)=>e?reject(e):resolve(s)));
    db=await req('mysql2/promise').createConnection({user:'root',password:env.SMOA_DB_PASSWORD,database:'smoa',stream,charset:'utf8mb4',dateStrings:true,supportBigNumbers:true,bigNumberStrings:true});
    const [[settings]]=await db.query('SELECT @@auto_increment_increment AS inc, @@auto_increment_offset AS off, @@innodb_autoinc_lock_mode AS lockmode');assert.equal(Number(settings.inc),1);assert.equal(Number(settings.off),1);assert(Number(settings.lockmode)<=1,'interleaved autoincrement unsupported');
    console.log(JSON.stringify(await migrate(db,planner(ws,key),key,args.mode||'check')));
  }finally{if(db)await db.end();ssh.end();key.fill(0);}
}
if(require.main===module)main().catch(e=>{console.error(JSON.stringify({error:e.code||'MIGRATION_VALIDATION_FAILED',column:e.sqlMessage?.match(/Column '([A-Z_]+)'/i)?.[1],detail:e.code&&e.code!=='ERR_ASSERTION'?undefined:String(e.message).split('\n')[0].slice(0,180)}));process.exitCode=1;});
module.exports={seal,open,planner,migrate,verify};
