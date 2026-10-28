/* ============================================================================
   错题集 · Mistake Collection
   浅色前沿版 · PWA / IndexedDB / AI 视觉识题 / 框选扫描 / 举一反三
   ========================================================================== */
'use strict';

/* 构建戳：每次改完本文件，跑一次 tools/stamp.py 把当前时间写进来。
   设置页最底部会显示它 —— 手机里装的是哪一版，翻到底就能对上号。 */
const BUILD = '2026-10-13 22:15';

/* ------------------------------------------------------------------ 配置 */
const CFG = {
  endpoint:'https://cuotiji-58055.app.workbuddy.host',
  oauthRelayBaseUrl:'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey:'wbpk_g6M1C10qPALVzXXFCSNNNT_LgsShayl4djrZczUGH5EM0mZttoShp0J',
};

/* 学科色：语文=棠紫，数学=苍，英语=赭，物理=橙 —— 都在那三个色相里，不额外引色 */
const SUBJECTS = [
  { k:'chinese', n:'语文', c:'#6b3fa0', ico:'语' },
  { k:'math',    n:'数学', c:'#3b82c4', ico:'数' },
  { k:'english', n:'英语', c:'#e0452c', ico:'英' },
  { k:'physics', n:'物理', c:'#e8833a', ico:'物' },
];
const SUBJ_KEYS = SUBJECTS.map(s=>s.k);
const subj = k => SUBJECTS.find(s=>s.k===k) || SUBJECTS[0];

const DIFF = ['','简单','中等','困难'];
const MAST = ['待攻克','半熟','已攻克'];
/* 题型：选择题要做成「点 ABCD」，其他题型走「写下来 → 对答案」。
   老数据没有这个字段，normalize 里按 options 有没有来猜。 */
const TYPES = ['choice','fill','solve'];
const TYPE_N = { choice:'选择题', fill:'填空题', solve:'解答题' };
const OPT_K = ['A','B','C','D','E','F'];
/* 三态 → 三套复习机制（判定印：✕ △ ◯） */
const PLAN = [
  { name:'待攻克', ico:'✕', freq:'高频',  first:1,  max:3,  note:'当天必重练' },
  { name:'半熟',   ico:'△', freq:'中频',  first:3,  max:10, note:'3~10 天回头' },
  { name:'已攻克', ico:'◯', freq:'低频',  first:14, max:60, note:'14~60 天巩固' },
];
const DAY = 86400000;

const uid  = () => Date.now().toString(36) + Math.random().toString(36).slice(2,7);
const $    = s => document.querySelector(s);
const $$   = s => Array.from(document.querySelectorAll(s));
const esc  = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const clamp = (v,a,b) => v<a?a:v>b?b:v;

/* ------------------------------------------------------- IndexedDB 本地库 */
/* v3：题图从「题里塞 dataURL」拆成独立的 images store 存 Blob。
   原因：dataURL 是 base64，比原图大 33%，而 IDB 内部按 UTF-16 存 → 实际再翻一倍。
   一张 200KB 的照片，塞进 q 里要占 550KB 左右；拆出来只占 200KB，且导出备份干净。 */
const DB_NAME='cuotiji', DB_VER=3;
function openDB(){
  return new Promise((res,rej)=>{
    let settled=false, rq;
    try { rq = indexedDB.open(DB_NAME, DB_VER); } catch(e){ return rej(e); }
    rq.onupgradeneeded = e=>{
      const db = e.target.result;
      if(!db.objectStoreNames.contains('q'))      db.createObjectStore('q',{keyPath:'id'});
      if(!db.objectStoreNames.contains('meta'))   db.createObjectStore('meta');
      if(!db.objectStoreNames.contains('images')) db.createObjectStore('images',{keyPath:'id'});
    };
    rq.onsuccess = ()=>{ settled=true; res(rq.result); };
    rq.onerror   = ()=>{ settled=true; rej(rq.error); };
    setTimeout(()=>{ if(!settled){ settled=true; rej(new Error('idb-timeout')); } }, 3000);
  });
}
let _db=null, _dbOpening=null;
function dropDB(){ try{ _db && _db.close && _db.close(); }catch(e){} _db=null; }
/* 连接会在中途悄悄失效，而且不止一种场合：
     · WebView 从系统相机 / 相册返回，Activity 可能被重建；
     · 页面在后台被冻住很久，浏览器按内存压力回收了连接；
     · 用户在另一个标签页升级了版本（versionchange）。
   失效之后每一次 transaction 都抛 InvalidStateError，界面上的表现就是
   「这张图存不进去」—— 其实关掉重开一次就好。以前这里直接冒泡，白让用户换图。 */
async function db(){
  if(_db) return _db;
  if(!_dbOpening){
    _dbOpening = openDB().then(d=>{
      /* 系统主动关连接时把引用清掉，下次自动重开 */
      d.onclose = ()=>{ if(_db===d) _db=null; };
      d.onversionchange = ()=>{ try{ d.close(); }catch(e){} if(_db===d) _db=null; };
      _db=d; _dbOpening=null; return d;
    }).catch(e=>{ _dbOpening=null; throw e; });
  }
  return _dbOpening;
}
/* 是不是「连接没了」这类可以靠重开解决的错误 */
function isConnErr(e){
  const n=String((e && (e.name||e.message)) || '');
  return /InvalidState|DatabaseClosed|UnknownError|AbortError|not\s*open|inactive/i.test(n);
}
async function tx(store, mode, fn){
  for(let attempt=0; ; attempt++){
    const d = await db();
    try{
      return await new Promise((res,rej)=>{
        let t;
        try{ t = d.transaction(store, mode); }catch(e){ return rej(e); }
        const s = t.objectStore(store);
        let out;
        try{ out = fn(s); }catch(e){ return rej(e); }
        t.oncomplete = ()=>res(out && out.result !== undefined ? out.result : out);
        t.onerror    = ()=>rej(t.error || new Error('tx-error'));
        t.onabort    = ()=>rej(t.error || new Error('tx-abort'));
      });
    }catch(e){
      if(attempt===0 && isConnErr(e)){ dropDB(); continue; }   // 重开一次再试
      throw e;
    }
  }
}
/* ------------------------------------------------------------ 云端 key 预算
   ⚠️ 血教训（2026-10-12 真机）：云端 sync_push 的 p_code **上限 40 字符**，
   超了不报错、直接静默丢弃 —— 读回来是 {}。而房间名由 hostname 派生，
   真实房间名 SITE-CUOTIJI-58055-APPWORKBUDDYHOST 36 字符，
   图片通道原本用 `房间名:img:图片id`（≈59 字符）当钥匙，于是：
     · 文字（正好 40）能同步 ✓
     · 图片（59）全部被丢 ✗，且服务端不报错
     · 代码以为推成功了，mark 成「已上传」，从此永不重试 —— 图永远补不上去
   修法：图片钥匙不能再拼完整房间名。改成 `IMG:<房间短哈希>:<图id>`，
   总长压到 40 以内。房间名进哈希，保证不同房间不串图。 */
const KEY_MAX = 40;
/* 房间名 → 8 字符短哈希（FNV-1a，够用且零依赖） */
function roomTag(room){
  let h=0x811c9dc5;
  const s=String(room||'');
  for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=(h*0x01000193)>>>0; }
  return h.toString(36).toUpperCase().padStart(6,'0').slice(0,8);
}

const DB = {
  all:     ()=>tx('q','readonly', s=>s.getAll()),
  put:      q=>tx('q','readwrite',s=>s.put(q)),
  del:     id=>tx('q','readwrite',s=>s.delete(id)),
  clear:   ()=>tx('q','readwrite',s=>s.clear()),
  getMeta:  k=>tx('meta','readonly', s=>s.get(k)),
  setMeta:(k,v)=>tx('meta','readwrite',s=>s.put(v,k)),
  delMeta:  k=>tx('meta','readwrite',s=>s.delete(k)),
};

/* ------------------------------------------------------------ 题图仓库
   Blob 存本地，渲染时用 objectURL。题里只留 imageId。 */
function dataURLtoBlob(u){
  const s=String(u||''); const i=s.indexOf(',');
  if(i<0) return null;
  const mime=(s.slice(0,i).match(/data:([^;]+)/)||[])[1] || 'image/jpeg';
  const bin=atob(s.slice(i+1));
  const arr=new Uint8Array(bin.length);
  for(let k=0;k<bin.length;k++) arr[k]=bin.charCodeAt(k);
  return new Blob([arr],{type:mime});
}
function blobToDataURL(b){
  return new Promise((res,rej)=>{
    const rd=new FileReader();
    rd.onload=()=>res(rd.result); rd.onerror=()=>rej(rd.error);
    rd.readAsDataURL(b);
  });
}
/* Blob ⇄ ArrayBuffer。
   ⚠️ 为什么不直接把 Blob 丢进 IndexedDB：老 WebView 内核的 structured clone
   对 Blob 支持残缺，put(blob) 会抛 DataCloneError —— 而且是每次都抛。
   用户看到的就是「这张图存不进去，换一张试试」，换一百张也一样。
   ArrayBuffer 是最基础的可克隆类型，所有内核都支持，存它绕开这个坑。 */
function blobToBuf(b){
  return new Promise((res,rej)=>{
    const rd=new FileReader();
    rd.onload=()=>res(rd.result);                       // ArrayBuffer
    rd.onerror=()=>rej(rd.error || new Error('blob-read'));
    rd.readAsArrayBuffer(b);
  });
}
function bufToBlob(buf, mime){
  try{ return new Blob([buf],{type:mime||'image/jpeg'}); }catch(e){ return null; }
}
/* 一条 images 记录 → Blob。三种形状都要认，老库里的图不能丢：
     · r.blob  —— v3 早期记录（直接存 Blob，在部分壳里根本写不进来）
     · r.buf   —— 现在的主形态（ArrayBuffer）
     · r.data  —— 兜底形态（dataURL 字符串，最保险但最占地方） */
function recToBlob(r){
  if(!r) return null;
  if(r.blob instanceof Blob) return r.blob;
  if(r.buf)  return bufToBlob(r.buf, r.mime);
  if(r.data) return dataURLtoBlob(r.data);
  return null;
}
/* 写库失败要分得清是哪一种，不然提示全糊成「存不进去」，
   用户只知道换一张，其实问题在配额或连接上，换十张也没用。 */
function idbErrKind(e){
  const n=String((e && (e.name||e.message)) || '');
  if(/QuotaExceeded|quota/i.test(n)) return 'quota';
  if(isConnErr(e)) return 'conn';
  return 'other';
}
const IMG = {
  urls:new Map(),
  known:new Set(),          // 确认本地有这张图（避免反复回源）
  /* 拉图失败计数。⚠️ 不能用「一次拉不到就永久放弃」：A 手机还在慢慢传图时
     B 手机先打开，这一轮当然拉不到 —— 若立刻判「对面没有」，等 A 传完了
     B 也不会再试，用户看到的就是「图一直不出现」。连试 4 轮才放弃。 */
  imgFail:new Map(),
  async put(blob){
    const id='i'+Date.now().toString(36)+Math.random().toString(36).slice(2,7);
    return this.putAs(id, blob);
  },
  async putAs(id, blob){
    /* 一张 3MB 的原图在手机上足以顶爆配额。先直接写，撞了配额就压一档再来，
       而不是把「存不进去」直接甩给用户。 */
    const tries = blob.size > 420000 ? [blob, null] : [blob];
    let last=null;
    for(let i=0;i<tries.length;i++){
      let b = tries[i];
      if(!b){                                   // 第二档：压到长边 1600 / q .82
        b = await shrinkBlob(blob, 1600, 0.82);
        if(!b) break;
      }
      let buf=null;
      try{ buf = await blobToBuf(b); }
      catch(e){ last=e; break; }                // 连二进制都读不出来，别硬试了
      try{
        /* 存 ArrayBuffer，不存 Blob —— 见 blobToBuf 上面的说明 */
        await tx('images','readwrite', s=>s.put({
          id, buf, mime:b.type||'image/jpeg', bytes:buf.byteLength||0, updatedAt:Date.now(),
        }));
        this.known.add(id); this.imgFail.delete(id);
        if(!this.urls.has(id)) this.set(id, b);
        return id;
      }catch(e){
        last=e;
        if(idbErrKind(e)!=='quota') throw e;    // 连接类错误 tx 里已经重开过了
      }
    }
    throw last || new Error('img-put');
  },
  get(id){ return tx('images','readonly', s=>s.get(id)).then(r=>recToBlob(r)).catch(()=>null); },
  async del(id){
    if(!id) return;
    this.revoke(id); this.known.delete(id); this.imgFail.delete(id);
    await tx('images','readwrite', s=>s.delete(id)).catch(()=>{});
  },
  url(id){ return id ? (this.urls.get(id)||'') : ''; },
  set(id, blob){
    this.revoke(id);
    try{ this.urls.set(id, URL.createObjectURL(blob)); }catch(e){}
    return this.urls.get(id)||'';
  },
  revoke(id){ const u=this.urls.get(id); if(u){ try{ URL.revokeObjectURL(u); }catch(e){} this.urls.delete(id); } },
  /* 给列表里还没有 URL 的补上（含老数据里的 base64）。
     ⚠️ 早先这里是串行 for + 逐张 get()：题一多就是 N 次事务，慢到被 boot 的
     6 秒超时打断，后半截图永远拿不到 URL，界面上一片空白 —— 用户看到的就是
     「我题目的图片呢」。现在改成一次 getAll() 拿全表，内存里配对，快几十倍，
     而且 hydrate 返回后由调用方补一次 render，不会再有「补了一半」的状态。 */
  async hydrate(list){
    const want=(list||[]).map(q=>q && q.imageId).filter(id=>id && !this.known.has(id));
    if(!want.length) return 0;
    let rows=[];
    try{ rows = await tx('images','readonly', s=>s.getAll()) || []; }catch(e){ return 0; }
    const byId=new Map();
    for(const r of rows){ if(r && r.id){ const b=recToBlob(r); if(b) byId.set(r.id, b); } }
    let n=0;
    for(const id of want){
      const b=byId.get(id);
      if(b){ this.known.add(id); this.set(id, b); n++; }
    }
    return n;
  },
  async totalBytes(){
    try{
      const rows=await tx('images','readonly', s=>s.getAll()) || [];
      return rows.reduce((a,r)=>a+(r.bytes || (r.buf&&r.buf.byteLength) || 0),0);
    }catch(e){ return 0; }
  },
  /* 写库自检：真的往 images 里写一条 1×1 的探针再删掉。
     为什么要探：有些壳（或隐私模式）IndexedDB 看着能 open，实际写就抛。
     提前在启动时探一次，出问题能立刻给用户一句人话，而不是等到他拍完题
     才弹「存不进去」。返回 null = 一切正常；否则返回错误分类。 */
  async selfTest(){
    const id='__probe__';
    try{
      const buf=new Uint8Array([255,216,255,217]).buffer;      // 最小 JPEG 头尾
      await tx('images','readwrite', s=>s.put({ id, buf, mime:'image/jpeg', bytes:4, updatedAt:Date.now() }));
      const back=await tx('images','readonly', s=>s.get(id));
      const ok=!!recToBlob(back);
      await tx('images','readwrite', s=>s.delete(id)).catch(()=>{});
      return ok ? null : 'other';
    }catch(e){
      await tx('images','readwrite', s=>s.delete(id)).catch(()=>{});
      return idbErrKind(e);
    }
  },
  async count(){
    try{ return (await tx('images','readonly', s=>s.count())) || 0; }catch(e){ return 0; }
  },
  /* 配额余量：navigator.storage.estimate() 在 Chromium 上很准，取不到就返回 null */
  async quota(){
    try{
      if(!navigator.storage || !navigator.storage.estimate) return null;
      const e=await navigator.storage.estimate();
      if(!e || !e.quota) return null;
      return { usage:e.usage||0, quota:e.quota };
    }catch(e){ return null; }
  },
};
/* Blob → 压到长边 max 的 JPEG Blob。失败返回 null，调用方自己决定要不要放弃。 */
function shrinkBlob(blob, max, q){
  return new Promise(res=>{
    const url=URL.createObjectURL(blob);
    const fin=v=>{ URL.revokeObjectURL(url); res(v); };
    const img=new Image();
    img.onload=()=>{
      try{
        const r=Math.min(1, max/Math.max(img.width,img.height));
        const c=document.createElement('canvas');
        c.width=Math.max(1,Math.round(img.width*r));
        c.height=Math.max(1,Math.round(img.height*r));
        c.getContext('2d').drawImage(img,0,0,c.width,c.height);
        if(c.toBlob) c.toBlob(b=>fin(b||null), 'image/jpeg', q);
        else fin(dataURLtoBlob(canvasToDataURL(c,q)));
      }catch(e){ fin(null); }
    };
    img.onerror=()=>fin(null);
    img.src=url;
  });
}
/* 老版本把 dataURL 直接写在 q.image 上 —— 搬进 images store 并清掉字段。
   ⚠️ 血教训：以前这里无条件 delete q.image。一旦 IMG.put 失败（这台设备
   根本写不了二进制图库 —— 正是要走内联降级的那种设备），imageId 还是 null，
   图却被删了，还把「没图」的版本存回库。等于每次开机都把用户的内联图清一遍，
   表现就是「识别完保存下来的题，原图没了」。现在只有迁移真的成功才删。 */
async function migrateImages(list){
  let n=0;
  for(const q of list||[]){
    if(q.image){
      let ok = !!q.imageId;
      if(!ok){
        const b=dataURLtoBlob(q.image);
        if(b){ try{ q.imageId=await IMG.put(b); ok=true; n++; }catch(e){ ok=false; } }
      }
      /* 迁移成功 → 图已进库，清掉内联副本省地方；
         迁移失败 → 原样留着，内联图是这道题唯一的图，删了就真没了。 */
      if(ok){
        delete q.image;
        await DB.put(q).catch(()=>{});
      }
    }
  }
  return n;
}
/* 题图 URL（渲染时同步取用）。
   两条来源都认：独立图库的 objectURL 优先，其次是内联的 dataURL。
   后者只在「图库写不进去」的降级路径上出现，但一旦出现，列表和复习页
   必须照样能显示 —— 不然用户会觉得图又丢了。 */
function qImg(q){
  if(!q) return '';
  if(q.imageId){ const u=IMG.url(q.imageId); if(u) return u; }
  return q.image || '';
}
/* 这道题现在到底有没有图可显示（ID 或内联都算） */
function qHasImg(q){ return !!(q && (q.imageId || q.image)); }
/* 打印 / 导出用：把题图压到 maxW 再转成内联 dataURL。
   为什么要内联：blob: 地址只在当前文档有效，换个 iframe、换个打印 WebView 都取不到，
   图片会整片空白。压到 900px 宽后一张约 100KB，自包含才走得通。 */
async function imgDataURL(imageId, maxW){
  if(!imageId) return '';
  const blob=await IMG.get(imageId).catch(()=>null);
  if(!blob) return '';
  const src=URL.createObjectURL(blob);
  try{
    const im=await new Promise((res,rej)=>{
      const i=new Image();
      i.onload=()=>res(i); i.onerror=()=>rej(new Error('decode'));
      i.src=src;
    });
    const nw=im.naturalWidth||maxW, nh=im.naturalHeight||maxW;
    const s=Math.min(1, maxW/nw);
    const cv=document.createElement('canvas');
    cv.width=Math.max(1,Math.round(nw*s));
    cv.height=Math.max(1,Math.round(nh*s));
    cv.getContext('2d').drawImage(im,0,0,cv.width,cv.height);
    return cv.toDataURL('image/jpeg',0.82);
  }catch(e){ return ''; }
  finally{ URL.revokeObjectURL(src); }
}

/* ================================================== 主题（浅色暖纸 / 深色星空）
   开关只认 <html class="dark">：
     · 浏览器 —— 读 prefers-color-scheme
     · 安卓壳 —— 读壳上报的系统夜间标志
   壳的 WebView 不一定如实转发媒体查询（跟随的是应用自己的 uiMode），
   所以两边都收敛到同一个 class，样式只写一份，不可能出现半深半浅。 */
const THEME = {
  forced:null, mq:null,
  init(){
    const b=window.WBShell;
    if(b && typeof b.isNight==='function'){
      try{ this.forced = !!b.isNight(); }catch(e){ this.forced = null; }
    }
    this.mq = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
    if(this.mq){
      const on=()=>this.apply();
      if(this.mq.addEventListener) this.mq.addEventListener('change', on);
      else if(this.mq.addListener) this.mq.addListener(on);
    }
    window.__wbNight = v=>{ this.forced=!!v; this.apply(); };   // 壳里切夜间时回调
    this.apply();
  },
  dark(){
    const m = this.forced!=null ? this.forced : !!(this.mq && this.mq.matches);
    /* 设置里可以手动顶掉系统（app.js 设置页的「跟随系统 / 浅色 / 深色」） */
    const pref = S.settings && S.settings.theme;
    if(pref==='dark') return true;
    if(pref==='light') return false;
    return m;
  },
  set(pref){ S.settings.theme = pref || 'auto'; this.apply(); },
  apply(){
    const d=this.dark();
    document.documentElement.classList.toggle('dark', d);
    const m=document.querySelector('meta[name="theme-color"]');
    if(m) m.setAttribute('content', d ? '#faf6ec' : '#eef4f6');
    this.paint(document);
  },
  /* 实景带的白天/夜晚两张照片，跟着开关换 src */
  paint(root){
    const d=this.dark();
    (root||document).querySelectorAll('img[data-night]').forEach(im=>{
      const want = d ? im.dataset.night : im.dataset.day;
      if(want && im.getAttribute('src')!==want) im.setAttribute('src', want);
    });
  },
};

/* ---------------------------------------------------------------- 每日一图 + 每日一言
   首页那张卡每天换一次。两条都按「当天日期」取，同一天打开多少次都是同一张、
   同一句，不会刷一次变一次 —— 那样就不叫「每日」了。
   图不用算日期差，直接把日期串哈希成下标：2026-10-12 → 12 天一轮里的某一天。
   这样跨月跨年也不会错位，而且换设备打开还是同一张。 */
const DAILY = {
  N: 24,                       // 图库 24 天一轮，assets/daily/d01..d24(.n).jpg
  idx(){
    const d=new Date();
    /* 用「年内第几天」而不是 getDate()，否则每月 1 号都是同一张 */
    const day=Math.floor((new Date(d.getFullYear(),d.getMonth(),d.getDate()) - new Date(d.getFullYear(),0,1))/DAY)+1;
    return ((day - 1) % this.N + this.N) % this.N + 1;
  },
  img(night){
    const i=String(this.idx()).padStart(2,'0');
    return `assets/daily/d${i}${night?'n':''}.jpg`;
  },
  /* 每日一言 —— 全是有出处的现代文学，不编、不熬鸡汤、不搬古文。
     选的是里尔克、佩索阿、卡尔维诺、博尔赫斯、史铁生、王小波这一路，
     句子本身有重量，不需要再配一句「加油」去解释它。 */
  QUOTES:[
    ['哪有什么胜利可言，挺住意味着一切。','里尔克《给青年诗人的信》'],
    ['以深深的谦虚与忍耐，去期待一个新的豁然贯通的时刻。','里尔克《给青年诗人的信》'],
    ['让你的判断力静静地、不受干扰地发展。','里尔克《给青年诗人的信》'],
    ['未来走到我们中间，为了能在它发生之前，就已久远地发生。','里尔克《给青年诗人的信》'],
    ['美无非是我们恰巧能够忍受的恐怖之开端。','里尔克《杜伊诺哀歌》'],
    ['在隆冬，我终于知道，我身上有一个不可战胜的夏天。','加缪《夏天集》'],
    ['必须想象西西弗是幸福的。','加缪《西西弗神话》'],
    ['对未来真正的慷慨，是把一切献给现在。','加缪《反抗者》'],
    ['重要的不是治愈，而是带着病痛活下去。','加缪《婚礼集》'],
    ['书必须是砍向我们内心冰封大海的斧头。','卡夫卡《致奥斯卡·波拉克》'],
    ['不要绝望，甚至对你并不感到绝望这一点也不要绝望。','卡夫卡《日记》'],
    ['我心里一直都在暗暗设想，天堂应该是图书馆的模样。','博尔赫斯《关于天赐的诗》'],
    ['任何命运，无论如何漫长复杂，实际上只反映于一个瞬间：人们大彻大悟自己究竟是谁的瞬间。','博尔赫斯《塔德奥·伊西多罗·克鲁斯小传》'],
    ['时间是构成我的实体。时间是带我涌向远方的河流，但我就是河流。','博尔赫斯《另一个，同一个》'],
    ['我一寸一寸地征服了我自己。','佩索阿《惶然录》'],
    ['我不匆忙，也不拖延。','佩索阿《我的目光清澈》'],
    ['生者的地狱不是将来会有的事，而是已经存在的地狱，就是我们每天生活的地狱。','卡尔维诺《看不见的城市》'],
    ['轻是一种价值，而不是缺陷。','卡尔维诺《美国讲稿》'],
    ['阅读就是抛开一切，去迎接将要到来的东西。','卡尔维诺《如果在冬夜，一个旅人》'],
    ['我们何其幸运，无法确知自己生活在什么样的世界。','辛波斯卡《万物静默如谜》'],
    ['在恐惧与战栗中，我想我要完成我的生命。','米沃什《诗的见证》'],
    ['使沙漠显得美丽的，是它在某个地方藏着一口井。','圣埃克苏佩里《小王子》'],
    ['每个人的生命都是通向自我的征途。','黑塞《德米安》'],
    ['鸟奋力冲破蛋壳。蛋是世界。谁要想诞生，就必须摧毁一个世界。','黑塞《德米安》'],
    ['我怕我配不上自己所受的苦难。','陀思妥耶夫斯基《卡拉马佐夫兄弟》'],
    ['一个人能使自己成为自己，比什么都重要。','伍尔夫《一间自己的房间》'],
    ['一个人越是有许多事情能够放得下，他越是富有。','梭罗《瓦尔登湖》'],
    ['我的语言的界限，意味着我的世界的界限。','维特根斯坦《逻辑哲学论》'],
    ['人所不能者，即是限制，即是残疾。','史铁生《病隙碎笔》'],
    ['人的命就像这根弦，拉紧了才能弹好，弹好了就够了。','史铁生《命若琴弦》'],
    ['我活在世上，无非想要明白些道理，遇见些有趣的事。','王小波《黄金时代》'],
    ['人的一切痛苦，本质上都是对自己的无能的愤怒。','王小波《沉默的大多数》'],
    ['如果你来访我，我不在，请和我门外的花坐一会儿。','汪曾祺《人间草木》'],
    ['人是为活着本身而活着，而不是为了活着之外的任何事物而活着。','余华《活着》'],
    ['为了避免结束，你避免了一切开始。','顾城《避免》'],
    ['只要想起一生中后悔的事，梅花便落满了南山。','张枣《镜中》'],
    ['你来人间一趟，你要看看太阳。','海子《夏天的太阳》'],
    ['我们准备着深深地领受，那些意想不到的奇迹。','冯至《十四行集》'],
    ['生活的最佳状态是冷冷清清的风风火火。','木心《文学回忆录》'],
    ['心之所向，素履以往。','木心《云雀叫了一整天》'],
    ['那时我们有梦，关于文学，关于爱情，关于穿越世界的旅行。','北岛《波兰来客》'],
    ['相信你自己的思想，相信你内心深处所确认的东西。','爱默生《论自助》'],
  ],
  quote(){
    const d=new Date();
    const day=Math.floor((new Date(d.getFullYear(),d.getMonth(),d.getDate()) - new Date(d.getFullYear(),0,1))/DAY)+1;
    return this.QUOTES[(day - 1) % this.QUOTES.length];
  },
};

/* ---------------------------------------------------------------- 全局态 */
const S = {
  tab:'home',
  qs:[],
  filter:{ subject:'all', mastery:'all', kw:'' },
  review:{ queue:[], idx:0, show:false, done:0, picked:null, typed:'' },
  settings:{ goal:5, haptics:true, theme:'auto' },
  persist:false,
};

/* ---------------------------------------------------------------- 小工具 */
function toast(msg, ms){
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(t._t); t._t = setTimeout(()=>t.classList.remove('on'), ms||1800);
}
function buzz(p){ if(S.settings.haptics && navigator.vibrate){ try{ navigator.vibrate(p||10); }catch(e){} } }
function fmtDate(ts){
  if(!ts) return '—';
  const d=new Date(ts), n=new Date();
  if(d.toDateString()===n.toDateString()) return d.toTimeString().slice(0,5);
  if(d.getFullYear()===n.getFullYear()) return `${d.getMonth()+1}/${d.getDate()}`;
  return `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()}`;
}
function dayKey(ts){ const d=new Date(ts); return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`; }
function today(){ const t=new Date(); t.setHours(0,0,0,0); return t.getTime(); }
function due(q){ return !q.reviews || (q.due||0) <= Date.now(); }
function countUp(el, to, ms){
  if(!el) return;
  const target = Number.isFinite(+to) ? Math.round(+to) : 0;
  const dur = ms || 700;
  const t0 = performance.now();
  el.textContent = '0';
  function step(t){
    const raw = t - t0;
    /* 时间源异常（虚拟时钟/某些 WebView）→ 直接落定最终值 */
    if(!Number.isFinite(raw) || raw < -40){ el.textContent = String(target); return; }
    const p = raw <= 0 ? 0 : Math.min(1, raw/dur);
    el.textContent = String(Math.round(target * (1 - Math.pow(1-p,3))));
    if(p < 1) requestAnimationFrame(step);
    else el.textContent = String(target);
  }
  requestAnimationFrame(step);
}
/* 归一化旧数据：学科不在 语数外物 里的归到数学 */
function normalize(q){
  if(!SUBJ_KEYS.includes(q.subject)) q.subject = 'math';
  q.mastery = clamp(q.mastery|0, 0, 2);
  q.difficulty = clamp(q.difficulty||2, 1, 3);
  if(!q.reviews) q.due = q.due || q.createdAt || Date.now();
  if(!Array.isArray(q.tags)) q.tags = [];
  /* 题型：老数据没有这一栏，靠选项反推 —— 有选项就是选择题 */
  if(!Array.isArray(q.options)) q.options = [];
  q.options = q.options
    .filter(o=>o && (o.t||o.k))
    .slice(0,6)
    .map((o,i)=>({ k:String(o.k||OPT_K[i]||'').slice(0,1).toUpperCase() || OPT_K[i],
                   t:String(o.t||'').slice(0,300) }));
  if(!TYPES.includes(q.type)) q.type = q.options.length ? 'choice' : 'solve';
  if(q.type!=='choice') q.options = [];
  q.answer = String(q.answer||'').slice(0,1200);
  return q;
}

/* ================================================== 学习日志（统计的原料）
   之前只有 q.lastReview 一个时间点，画不出趋势和打卡。每次判题记一笔，
   历史数据用 lastReview 回填一次。 */
const LOG = {
  data:{},
  load(j){ if(j && typeof j==='object') this.data=j; },
  async save(){ await DB.setMeta('log', this.data).catch(()=>{}); },
  rec(k){
    const d=this.data[k] || (this.data[k]={ n:0, c:0, w:0, subj:{} });
    if(!d.subj) d.subj={};
    return d;
  },
  bump(q, quality){
    const d=this.rec(dayKey(Date.now()));
    d.n++;
    if(quality===2) d.c++; else if(quality===0) d.w++;
    const s=q.subject||'math';
    const sd=d.subj[s] || (d.subj[s]={ n:0, c:0, w:0 });
    sd.n++; if(quality===2) sd.c++; else if(quality===0) sd.w++;
    this.save();
  },
  /* 老数据只有「最后一次复习时间」，用它把热力图先垫上 */
  backfill(qs){
    let n=0;
    (qs||[]).forEach(q=>{
      if(!q.lastReview) return;
      const k=dayKey(q.lastReview);
      if(this.data[k]) return;
      const s=q.subject||'math';
      const d={ n:q.reviews||1, c:q.correct||0, w:q.wrong||0, subj:{} };
      d.subj[s]={ n:d.n, c:d.c, w:d.w };
      this.data[k]=d; n++;
    });
    if(n) this.save();
    return n;
  },
  day(ts){ return this.data[dayKey(ts)] || null; },
  days(){ return Object.keys(this.data).length; },
  /* 当前连击：从今天往回数，今天没记就允许从昨天起算 */
  streak(){
    let n=0; const d=new Date(); d.setHours(0,0,0,0);
    if(!this.data[dayKey(d.getTime())]) d.setDate(d.getDate()-1);
    while(this.data[dayKey(d.getTime())]){ n++; d.setDate(d.getDate()-1); }
    return n;
  },
  /* 历史最长连击 */
  best(){
    const ts=Object.keys(this.data).map(k=>{
      const [y,mo,dd]=k.split('-').map(Number);
      return new Date(y,mo-1,dd).getTime();
    }).filter(Number.isFinite).sort((a,b)=>a-b);
    let best=0, run=0, prev=null;
    ts.forEach(v=>{
      run = (prev!=null && Math.round((v-prev)/DAY)===1) ? run+1 : 1;
      if(run>best) best=run;
      prev=v;
    });
    return best;
  },
};

/* ============================================================ AI 识题模块 */
const SYS_PROMPT = [
  '你是初中语文、数学、英语、物理四科全通的一线教师，兼中学错题整理助手。学生是初中生。',
  '用户给你一张题目照片，请完成：',
  '1) 学科 subject：只能是 chinese（语文）/ math（数学）/ english（英语）/ physics（物理）之一。',
  '   【先定学科，再做其他一切】按下面的特征逐条比对，禁止不加判断就默认 math：',
  '   · english：题面主体是英文句子（完形填空/阅读理解/任务型阅读/语法填空/书面表达），',
  '     只要题干大部分是英文，就是 english，无论考的是哪个语法点；',
  '   · physics：出现物理量及单位（m/s、km/h、N、kg、g/cm³、Pa、J、W、V、A、Ω、℃，',
  '     或 F、v、p、ρ、I、U、R、P 等物理字母符号），',
  '     或出现初中物理定律/模型名词（重力 G=mg、摩擦力、压强 p=F/S、液体压强、大气压、',
  '     浮力 F浮=ρgV、阿基米德原理、杠杆、滑轮、功与功率、动能势能机械能、',
  '     声音的传播、光的反射折射、平面镜/凸透镜成像、熔化沸腾、比热容、',
  '     串并联电路、欧姆定律 I=U/R、电功率 P=UI、焦耳定律、家庭电路 220V、',
  '     磁感线、通电导线的磁场、电磁铁、电动机/发电机），',
  '     或题面配受力示意图/电路图/物态变化图像 —— 占其一就是 physics；',
  '   · chinese：文言文（之乎者也、实词虚词、句子翻译）、古诗词鉴赏、名句默写、',
  '     现代文阅读（"下列对…赏析/理解正确的是"）、语用题（成语/病句/补写/压缩语段）、',
  '     作文题 —— 占其一就是 chinese；',
  '   · math：以上特征全都没有，考的是实数与二次根式、整式分式、一元一次/二元一次方程组、',
  '     一元二次方程与分式方程、不等式（组）、一次/反比例/二次函数、三角形（全等相似勾股）、',
  '     四边形、圆、锐角三角函数、旋转平移、统计与概率等初中数学内容，才判 math。',
  '   判定顺序：整段英文？→ english。有物理量单位或物理定律？→ physics。',
  '   有文言/诗歌/阅读赏析/语用？→ chinese。都不是 → math。',
  '   【学科自检】solve 第0步开头先写一行"学科判定：XX，依据：……"；',
  '   后续推导若用到了与判定学科不符的定理、单位或题型，说明判错了，必须改 subject 重来。',
  '2) 题型 type：choice（选择题）| fill（填空）| solve（解答题，含证明）；',
  '3) 难度 difficulty：1=简单 2=中等 3=困难；',
  '4) 知识点标签 tags：2~4 个，每个不超过 6 个字，用中文；',
  '5) 转写题干 question：逐字照抄，一个字都不要漏。公式用纯文本表达',
  '   （如 x^2、√3、π、≤、AB⊥CD）。遇到 (1)(2)(3) 或 ①②③ 小问，',
  '   每个小问单独起一行。不要写"如图"以外的省略，不要自己改数字。',
  '   【小问必须抄全】(1)(2)(3) 小问行哪怕印在图旁、页面角落，也要一字不落抄进 question；',
  '   若照片里确实找不到任何小问原文：严禁自己编问题作答——',
  '   把 answer 与 analysis 都只写一行"⚠️ 照片没拍到 (1)(2)(3) 小问原文，请重拍完整题目"，',
  '   solve 里只列条件清单、不得推导；question 仍把可见部分抄全。',
  '   ⚠️ question 里【绝对不要】出现选项行（A. / B. / （A）/ A、…），',
  '   也【绝对不要】出现答案标记（如题干里的 (B)、（B）、"答案：B"）。',
  '   选项一律只放进 options，答案一律只放进 answer —— 三者不许混。',
  '6) 选择题的四个选项 options：[{"k":"A","t":"选项内容"},{"k":"B","t":"..."}]；',
  '   每项 t 只写选项正文，不要带 "A." 前缀；不是选择题就给空数组 []。',
  '',
  '⚠️⚠️ 【铁律：先写 solve 草稿 → 再写 analysis 解析 → 最后 answer 结论，顺序不许颠倒】⚠️⚠️',
  '三个字段各司其职，别混：',
  '  · solve（草稿，给学生看以外）：把你的完整推导写在这里，一步一步写出来才能下结论 ——',
  '    不写就填答案等于瞎猜（本应用最大的坑）。solve 走下面的五步流程，可长可细，不用管字数。',
  '  · analysis（给学生看的讲解 = 标准答案）：solve 全部做完后，把主推导按顺序写清楚。',
  '    这一栏最大的禁忌是【只讲思路、不写过程】——光说“利用根与系数关系/相似求解”',
  '    不算讲解，必须一步一步把具体算式写出来：',
  '    ① 开头一句点破方法与从哪里设手；',
  '    ② 中间 3~6 步，每步 = 一个具体操作及其结果，公式原样写：',
  '      正确示范：“Δ=b²-4ac=(-6)²-4×1×3=24>0，方程有两个不相等的实数根”',
  '      “代 x=1 → y=1-2-3=-4<0，代 x=3 → y=9-6-3=0>图象过点(3,0)，排除与 x 轴无交点的选项”；',
  '      禁用空话：“用根的判别式判断”“化简可得”“结合图象排除”“易得”这类没有算式的话；',
  '    ③ 收尾一句给出结论（为什么是这个选项 / 定点是什么）。',
  '    字数 150~350 字（多问大题逐问放宽，见下方铁律），每步单独起行；装不下时压缩措辞、绝不删步骤。',
  '    可以省略的只有：solve 里的条件清单、交叉验证、推翻重算过程；',
  '    主推导步骤一个都不许省。',
  '  · answer（结论）：推导与解析都写完才填，只放最终结果（格式见 8）。',
  'solve 五步流程（一步都不许省）：',
  '  第0步【条件清单】：把题面每个已知条件逐条列出，并挖出所有隐含条件',
  '    （如一元二次方程 x²-4x+3=0 → a=1、b=-4、c=3，Δ=(-4)²-4×1×3=4>0，两根为 1 和 3；',
  '     二次函数 y=x²-2x-3 → 开口向上、对称轴 x=1、令 y=0 得交点 (-1,0) 和 (3,0)；',
  '     分式方程 → 必须验根（分母≠0）；三角形内角和 180°）。',
  '  第1步【解题计划】：先用一句话声明用哪种方法、为什么适合',
  '    （如"由 AB=AC 想到等边对等角，作底边上的高 AD 构造全等三角形"；',
  '     "设点的横坐标为 t，用二次函数表示线段长，配方求最值"）。',
  '  第2步【完整推导】：所有分数、幂、根式的运算写成展开式，禁止心算跳步；',
  '    每一步给出依据（定理名 / 公式 / 题设编号）。计算题必须先写算式再给结果。',
  '  第3步【交叉验证】：用与主推导**相互独立**的第二条路径复核，按题型选方法：',
  '    · 选择题：把选定答案代回题目**全部**特征逐条核对（特殊点函数值、端点值、',
  '      图象开口/对称轴/交点、几何量是否符合常识），任何一条不符就推翻重选；',
  '    · 证明题 / 解答题：取特殊位置或特殊数值代回原题条件验算；',
  '    · 函数题：通法推导之外，再代两组具体数字把整题完整走一遍；',
  '    · 物理计算：把结果代回公式复核，并检查单位是否自洽、数量级是否符合生活常识；',
  '    · 两条路径不一致 → 回头找错并重做，禁止挑一个硬圆。',
  '  第4步【结论】：只把验证通过的结论写成最后一步。',
  'answer 必须与 solve 第4步完全一致，不许另起炉灶；analysis 就是从这次推导里提炼。',
  '7) analysis：即上述【标准答案式讲解】，150~350 字，每步带具体算式与结果，',
  '   禁止只写思路不写过程；放在 solve 之后、answer 之前。',
  '8) answer：**推导与验证全部完成之后**才填。选择题只填字母（如 "D"）；',
  '   填空题只填答案本身；解答题按 question 里的小问数逐问给结论，问数必须一一对应（如 "(1) DE∥AC 得证；(2) 60°；(3) 2√3"）。',
  '9) 【红色警报】初中题的最终答案几乎一定是干净的：整数、简单分数、√2/√3 这类',
  '   简单二次根式、30°/45°/60° 等特殊角。出现 arccos/arcsin（初中根本没学过）、',
  '   一长串除不尽的小数、或怪异的复杂根式，第一反应不是"写下去"，而是**肯定有地方错了**：',
  '   逐条回查 ① 数字和点名是否抄错/看错（特别是下标 A₁B₁/AB₁/A₁B 这类，',
  '   还有 ∠1 与 ∠2、甲乙两物体的量别张冠李戴）② 关键一步化简/单位换算是否出错；',
  '   找到错就重做。重做两遍后结果仍一致、且题目确实要求"求 tan 角的值"这类',
  '   允许非特殊角的场合，才可保留，并在 analysis 注明。',
  '   结论必须写成明确形式（如"相似比为 2:3"、"W=60J"）。',
  '   不要在这一栏写过程 —— 过程一律放 solve。',
  '',
  '【多问大题铁律 —— 几问写几段，一题不许漏】',
  '· question 里有几问，就给 solve / analysis / answer 分几段，段首标 "(1)" "(2)" …；',
  '· solve：每问独立走完整流程（条件清单全题共用只列一次），不许只做第一问就收尾；',
  '· analysis：每问都要写全主线 —— 证明问禁止甩"见解析"了事，至少写清',
  '  【证什么 → 连哪条辅助线 → 用哪个判定/性质定理 → 关键垂直/平行怎么来 → 结论】带字母的推理链；',
  '· 计算问逐问给算式与结果；字数随问数放宽：单问 150~350 字，每多一问可加 100~250 字。',
  '',
  '【适用范围声明】下面「初中数学十大陷阱」「几何题辅助线」「图象选择题」三节，',
  '仅在 subject=math 时适用；其他学科的题按各自学科的规范严谨推导，同样要写全过程。',
  '',
  '【初中数学十大陷阱 —— 每一条都坑过真学生】',
  '· 一元二次方程：用根与系数关系（x₁+x₂=-b/a、x₁x₂=c/a）之前，必须先确认 Δ≥0',
  '  （方程确实有两个实根），否则韦达结论是空中楼阁。',
  '· 分式方程解完必须验根：把根代回最简公分母，为 0 的是增根要舍去 —— 不验根直接丢分。',
  '· 不等式两边同乘/同除以负数，不等号必须变向；解集在数轴上"大于向右小于向左"、',
  '  含等号画实心圆点。',
  '· 相似三角形：对应关系按字母顺序一一对应（△ABC∽△DEF 则 AB/DE=BC/EF=AC/DF），',
  '  写反全错；找相似先扫公共角、对顶角、公共边。',
  '· 勾股定理只在直角三角形中成立：先确认哪个角是直角、斜边是哪条，别把直角边当斜边。',
  '· 圆：直径所对的圆周角是 90°；见弦想弦心距（垂径定理，半弦²+弦心距²=半径²）；',
  '  同弧圆周角=圆心角的一半。',
  '· 锐角三角函数定义别混：sin=对边/斜边、cos=邻边/斜边、tan=对边/邻边；',
  '  特殊值必须背准：sin30°=1/2、sin45°=√2/2、sin60°=√3/2、tan30°=√3/3、tan60°=√3。',
  '· 二次函数：a 定开口（a>0 向上）；顶点横坐标 -b/(2a)；与 x 轴交点个数看 Δ。',
  '  图象平移"上加下减、左加右减"是对整个解析式/括号内说的。',
  '· 分类讨论不许漏：绝对值、动点分段、等腰三角形谁是腰、直角哪个角是直角、',
  '  圆与直线的位置关系、一次函数 k 正负。',
  '· 概率题收尾自检：所有互斥情形概率之和必须等于 1；列举用列表法/树状图，不重不漏。',
  '',
  '【关于几何题 —— 成败在辅助线与逐步依据，按下面做】',
  '· 先把图上能读到的已知条件逐条抄进 question，再动笔解题。图上没有的条件一律不许假设。',
  '· 每一步证明必须带依据：全等要点明判定（SSS/SAS/ASA/AAS/HL），相似同理；',
  '  平行/垂直要指出用哪个判定定理。光写"所以全等"不给依据不算证明。',
  '· 常用辅助线口诀：见中点 → 连中线/中位线；见 45° 或等腰 → 构造等腰直角/三线合一；',
  '  见弦 → 作弦心距；见直径 → 找 90° 圆周角；见切线 → 连半径证垂直；',
  '  折叠/旋转 → 找相等的边和角，常用勾股设未知数。',
  '· 点名必须**逐字看清**：AB₁ 与 A₁B（出现下标时）是完全不同的线段，∠1 与 ∠2 是不同的角，',
  '  抄错一个名字整题就废。抄完 question 后逐个点名回图比对一遍再开始推导。',
  '· 看不清图上某个标注，就在 solve 末尾写一行 "⚠️ 图中 X 处看不清，请核对"，不要猜数字。',
  '',
  '【图象选择题铁律 —— 选项全是函数图时，成败在转写】',
  '每个选项的小图必须【逐个、相互独立】看清：看图前先确认它对应哪个字母标签',
  '（标签常印在图的左下或正下方，别把相邻图的标签张冠李戴）。',
  'solve 第0步必须附【选项图逐字转写】：A、B、C、D 每个图各写一行——曲线在哪些象限 /',
  '  是否过原点 / 是否关于原点或 y 轴对称 / 与坐标轴交点 / 单调性 / 关键点函数值。',
  '转写只能来自对该图的直接观察：禁止凭印象，禁止用解析式反推图象长相。',
  '【顺序硬闸】四行转写表必须是 solve 里最先写完的东西，写完才允许开始推理排除；',
  'solve 里没有写全 A/B/C/D 四行转写就直接给答案 → 该答案一律无效，必须回头重新逐图看再答。',
  '排除选项时逐条引用转写原文作依据；转写与解析式性质矛盾 → 以重新看图为准，禁止改答案硬圆。',
  '这张转写表写在 solve（草稿）里；analysis 写排除步骤时要引用具体转写作依据（如“A 图关于 y 轴对称，与解析式性质矛盾，排除”），但不必把四行转写全搬进去。',
  '',
  '只输出一个 JSON 对象，不要任何解释、不要 Markdown 代码块。',
  '⚠️ 字段顺序必须是这样（solve 草稿在前，analysis 解析居中，answer 结论最后），',
  'subject 按上面四条特征如实判定，禁止看到数字就写 math：',
  '{"subject":"chinese|math|english|physics 之一","type":"choice|fill|solve","difficulty":1|2|3,"tags":["知识点"],',
  ' "options":[],"question":"...","solve":"...五步完整推导...","analysis":"...标准答案式讲解，每步带算式...","answer":"...结论..."}',
].join('\n');

const USER_PROMPT = '识别这张题目照片。先逐字完整转写题干（长题不要省略）；含图象的选择题按“图象选择题铁律”把五步推导和选项图转写全部写进 solve 草稿、逐条核对后再排除；然后写一段 150~350 字的标准答案式 analysis 解析，每一步都带具体算式和结果，禁止只讲思路不写过程；多小问大题先确认 (1)(2)(3) 小问原文已全部抄进 question，逐问写全，抄不到小问就留空不许编答案；最后按 solve→analysis→answer 顺序输出约定的 JSON。';

const AI = {
  client:null, model:null, vision:null, lastErr:'', cancel:false, ac:null, locked:false,
  init(){
    if(this.client) return true;
    const WBC = window.WorkBuddyCloud;
    if(!WBC || !WBC.createWorkBuddyCloud){ this.lastErr='sdk-missing'; return false; }
    try{
      this.client = WBC.createWorkBuddyCloud({
        endpoint: CFG.endpoint,
        oauthRelayBaseUrl: CFG.oauthRelayBaseUrl,
        publishableKey: CFG.publishableKey,
      });
      return true;
    }catch(e){ console.warn('cloud init', e); this.lastErr='init'; return false; }
  },
  /* 挑模型 —— 2026-10-14 晚**改锁 glm-5.3-flash**（菲尔特指定，替换原 dpv4.1flash）。
   实测清单里的确切 id 是 `glm-5.3-flash`，原生多模态、能读图（supportsImages=true），
   识题和举一反三都走它。PREFS 只放这一项：积分倍率 x0.06，比 dpv4.1flash（x0.11）更省。
   万一哪天它被下架/改名，才退回原来的打分逻辑挑一个能读图的，
   否则识题会彻底瘫掉 —— 那条兜底路径只为「全挂」准备，平时不会走到。 */
  PREFS:['glm-5.3-flash'],
  score(m){
    const id=String(m.id||'').toLowerCase();
    let s=0;
    if(/gemini|gpt-4o|gpt-4\.|claude|qwen.*(vl|vision)|doubao.*(vision|vl)|glm-4v|internvl|step-1v|minicpm-v/.test(id)) s+=12;
    if(/vision|-vl|vl-|multimodal|omni/.test(id)) s+=5;
    if(/flash|lite|turbo|fast|speed|air/.test(id)) s+=7;
    /* ⚠️ `mini` 不再单独加分：它会命中 minimax 系列（大模型），是上次选贵的直接原因。
       真要匹配「小模型」，用 mini 后面必须跟非字母，避免 minimax 误命中。 */
    if(/mini(?![a-z])/.test(id)) s+=7;
    if(/pro|max|ultra|plus/.test(id)) s+=2;
    /* 明确又慢又贵的几档直接压下去 */
    if(/o1|o3|reasoner|thinking|deep-?think|-r1/.test(id)) s-=8;
    return s;
  },
  async pickModel(){
    if(this.model) return this.model;
    if(!this.init()) throw new Error('sdk-missing');
    let list = [];
    try{ list = await this.client.llm.models.list() || []; }
    catch(e){ this.lastErr = codeOf(e) || 'list-fail'; throw e; }
    const usable = list.filter(m=>m && m.disabled !== true);
    const vis = usable.filter(m=>m.supportsImages === true);
    /* ① 先按免费档优先级逐个找 */
    for(const want of this.PREFS){
      const hit = vis.find(m=>String(m.id||'').toLowerCase() === want);
      if(hit){
        this.model = hit.id; this.vision = true; this.locked = true;
        return this.model;
      }
    }
    /* ② 免费档一个都没有（被下架/改名）→ 退回打分，挑个能读图的，别让识题瘫掉 */
    const pick = (vis.length ? vis.slice().sort((a,b)=>this.score(b)-this.score(a))[0] : usable[0]);
    if(!pick){ this.lastErr='no-model'; const err=new Error('no-model'); throw err; }
    this.model = pick.id;
    this.vision = pick.supportsImages === true;
    this.locked = false;
    console.warn('glm-5.3-flash 不可用，临时改用', this.model);
    return this.model;
  },
  async recognize(dataUrl){
    const model = await this.pickModel();
    const content = [{ type:'text', text: USER_PROMPT }];
    if(this.vision){
      content.push({ type:'image_url', image_url:{ url:dataUrl } });
    }
    const messages = [
      { role:'system', content: SYS_PROMPT },
      { role:'user',   content: content.length===1 ? USER_PROMPT : content },
    ];
    let text = '', finish='';
    /* cancel 只是个开关，break 了循环底层 fetch 还在往回拉数据，白烧 token。
       接上 AbortController：取消就真的把连接掐掉。（SDK 不认 signal 时，
       下面的 cancel 判断仍然兜得住。） */
    const ac = new AbortController();
    this.ac = ac;
    let stream;
    try{
      stream = await this.client.llm.chat.completions.create({
        /* max_tokens 2600 → 4000（2026-10-12 第八轮）：
           原因：prompt 改成「先写完整推导、后给结论」之后，解答题的 analysis
           不再限 260 字 —— 立体几何要写坐标、法向量、点乘展开式、验算，
           2600 tokens 会在推导中途被硬切，切完 JSON 就是残的。
           4000 给足空间。代价是解答题多等 1~2 秒，但换来答案正确，值。
           （选择题/填空题输出本来就短，用不到这么多，不会变慢。） */
        model, messages, stream:true, temperature:0.15, max_tokens:9000, signal: ac.signal,
      });
    }catch(e){
      if(e && (e.name==='AbortError' || /abort/i.test(String(e.message||'')))) throw new Error('cancelled');
      throw e;
    }
    try{
      for await (const ch of stream){
        if(this.cancel){ try{ ac.abort(); }catch(e){} break; }
        const c0 = ch && ch.choices && ch.choices[0];
        if(c0 && c0.finish_reason) finish = c0.finish_reason;
        const d = c0 && c0.delta;
        if(d && typeof d.content === 'string') text += d.content;
      }
    }catch(e){
      if(this.cancel || (e && e.name==='AbortError')) throw new Error('cancelled');
      throw e;
    }finally{ if(this.ac===ac) this.ac=null; }
    const r = parseJSON(text);
    /* 被长度截断时，parseJSON 大概率捞不到完整 JSON。带上这个标记，
       上层就能给出「题太长被截断了」这种能对症的提示，而不是笼统的「没读懂」。 */
    if(finish==='length' && r && r._raw) r._truncated = true;
    return r;
  },
  abort(){ if(this.ac){ try{ this.ac.abort(); }catch(e){} } this.cancel=true; },
};
function codeOf(e){
  if(!e) return '';
  const c = e.error && e.error.code;
  return c || e.code || '';
}
function parseJSON(raw){
  let s = String(raw||'').trim();
  s = s.replace(/^```[a-zA-Z]*\s*/,'').replace(/```$/,'').trim();
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if(i>=0 && j>i) s = s.slice(i, j+1);
  try{ return JSON.parse(s); }catch(e){}
  return { _raw: raw };
}
function aiErrMsg(code){
  const c = String(code||'');
  if(!c) return 'AI 暂时用不了，先手动填几笔';
  if(c==='timeout') return 'AI 想太久了，点「AI 重新识别」再来一次';
  if(c==='cancelled') return '已跳过 AI';
  if(c.startsWith('auth_')) return 'AI 通道要从正式网址打开';
  if(c.startsWith('quota_')) return '今天的 AI 额度用完了，明天再来';
  if(c.startsWith('gateway_')||c.startsWith('model_')) return '模型有点忙，稍等一下再试';
  if(c==='no-model') return '暂时没有可用的识图模型';
  if(c==='sdk-missing') return '云端组件没加载，联网后重试';
  return 'AI 没读出来，换个光线重拍试试';
}

/* ==================================================== 举一反三
   照着原题让 AI 出一道同类型的新题：同学科、同题型、同知识点，
   难度相当或略简单一档。结果可一键收进题库（varietyOf 记下原题），
   也可「换一题」重出。模型与识题共用同一把 glm-5.3-flash。
   2026-10-15 重写：① 字段顺序改成 question→solve→analysis→answer
   （answer 放最后 = 先解题验算再交卷，与识题端同一条根因教训）；
   ② 补全四学科命题规范（原版只会出数学题，语文/物理质量差）；
   ③ max_tokens 1800→3600（要装下 solve 完整草稿），temp 0.4→0.3。 */
const FAN_SYS_PROMPT = [
  '你是初中语文、数学、英语、物理四科全通的命题与解题专家。学生是初中生。',
  '下面给你一道原题（JSON），请出一道同类型的新题，并给出经过你自己完整验证的答案与解析。要求：',
  '1) 学科 subject 必须与原题一致（chinese/math/english/physics 四选一，不许擅自改成 math）；',
  '   题型 type 与知识点 tags 也与原题一致或相近；',
  '2) 难度与原题相当，可以略简单一档，不许更难；',
  '3) 情境与数字必须换新，不许照抄原题；',
  '4) 分学科命题规范：',
  '   · math：只考初中内容（实数与二次根式、方程与不等式、一次/反比例/二次函数、',
  '     全等相似、勾股、四边形、圆、锐角三角函数、统计概率初步），不考高中内容；',
  '     数字要凑好，最终答案应是简洁值（整数、简单分数、√2/√3 等简单根式、30°/45°/60°），',
  '     不允许出现 arccos/arcsin 等反三角或怪异根式 —— 出现即说明数据没凑好，换数据重出；',
  '   · physics：只考初中物理（力与运动、压强浮力、简单机械与功、声光热、',
  '     电学欧姆定律电功率、磁现象），不考动量、电磁感应、复合场等高中内容；',
  '     所有物理量必须带单位且前后自洽，情境要符合初中物理常识',
  '     （家庭电路 220V、g 取 10N/kg、声音在空气中约 340m/s、水的比热容 4.2×10³J/(kg·℃)）；',
  '     原题若依赖图（受力图/电路图/图像），新题必须用文字把图中的关键信息描述完整；',
  '   · chinese：文言文/诗歌鉴赏新题必须给出完整原文（优先引用课内或常见课外真实篇目，',
  '     严禁杜撰不存在的诗文），现代文新题要附完整文段；参考答案按要点分条给出，',
  '     术语规范（手法名/情感关键词要落在实处）；',
  '   · english：题干用规范英文；完形/语法填空的空格考点须是初中语法',
  '     （时态、被动语态、宾语从句、情态动词、比较级等）；',
  '     阅读理解新题的 answer 必须能从你自己给出的文段中直接找到依据句；',
  '5) 【选择题硬闸 —— 差一条就算出题失败】type 为 choice 时：',
  '   · options 必须给全 4 个选项（A/B/C/D），每项 t 写完整正文，一项不许空；',
  '   · answer 只填一个字母，且该字母必须对应 options 里正确的那一项；',
  '   · 干扰项要有迷惑性（用常见错解/易混说法），但正确选项必须唯一；',
  '   · solve 里逐项排查四个选项（每项一句：代入/分析 → 保留或排除），',
  '     排除完剩下的必须正好是 answer 那一项；',
  '   · analysis 引用选项原文逐项说明为什么对/为什么错；',
  '   ⚠️ 禁止把选项写在 question 里、也禁止 options 给空数组 —— 这是本应用最高频的翻车点。',
  '   原题若带选项（是选择题），新题也必须是选择题并给全四个选项。',
  '6) 【命题铁律：先解题，再交卷，字段顺序不许颠倒】',
  '   question（题干）→ solve（你自己把新题从头到尾完整做一遍的草稿：逐步写算式/依据，',
  '   做完自检答案是否干净、难度是否匹配；不干净就换数据重出，直到验算通过才继续）→',
  '   analysis（给学生看的解析：从 solve 提炼 3~6 步，每步带具体算式或原文依据句，',
  '   150~350 字；禁止"利用 XX 定理求解""易得"这类没有过程的空话；',
  '   语文引用原文关键词句，英语引用依据句，物理每步带数值与单位）→',
  '   answer（最终结论，必须与 solve 验算结论、analysis 结论三方完全一致，不许凭感觉给数；',
  '   选择题只填字母；多小问按 (1)(2)(3) 逐问给结论）；',
  '7) 题干逐字完整，公式用纯文本（x^2、√3、π、≤），物理量带单位；',
  '   题干里【绝对不要】出现选项行（A. / B. / （A））和答案标记（"答案：B"）；',
  '   选项一律只放 options，答案一律只放 answer。',
  '',
  '【输出前自检清单 —— 逐条过，任何一条不过就重出】',
  '① 原题是选择题时，新题 options 是否恰好 4 项且全有正文？answer 字母能在 options 里找到？',
  '② answer 与 solve 的验算结论、analysis 的结论完全一致（三方一致）？',
  '③ 数学答案是否简洁值？出现反三角/怪根式 = 数据没凑好，重出；',
  '④ question 干净（无选项行、无答案标记、小问抄全）？',
  '⑤ 难度与原题相当或略简单？情境与数字换新了？',
  '',
  '只输出一个 JSON 对象，不要任何解释、不要 Markdown 代码块。两种格式示例（字段顺序不许变）：',
  '选择题（options 必须给全，answer 是其中一项的字母）：',
  '{"subject":"physics","type":"choice","difficulty":2,"tags":["声音的产生"],',
  ' "options":[{"k":"A","t":"鼓面振动产生声音"},{"k":"B","t":"声音只能传递信息"},',
  ' {"k":"C","t":"鼓声是超声波"},{"k":"D","t":"纸屑跳动与振动无关"}],',
  ' "question":"...","solve":"...逐项排查四个选项...","analysis":"...引用选项原文逐项说明...","answer":"A"}',
  '解答/填空题（options 给空数组）：',
  '{"subject":"math","type":"solve","difficulty":2,"tags":["二次函数"],',
  ' "options":[],"question":"...","solve":"...完整解题验算草稿...","analysis":"...3~6步带算式解析...","answer":"..."}',
].join('\n');

const FAN = {
  ac:null, cancel:false, running:false, orig:null,
  /* nudge：自动重试时追加的补丁指令（如「上轮没给 options」），直接拼进用户消息 */
  async gen(q, nudge){
    if(!AI.init()) throw new Error('sdk-missing');
    const model = await AI.pickModel();
    /* 原题自己也可能是「选项写在内容里、options 空」的老数据 ——
       先回捞一次再喂给模型，否则模型只看到一段题干，自然出成解答题。 */
    const srcQ = rescueOptions({
      type: q.type || 'solve',
      question: String(q.content||''),
      options: (q.options||[]).map(o=>({k:o.k, t:o.t})),
    });
    const src = {
      subject: q.subject,
      type: srcQ.type || 'solve',
      difficulty: q.difficulty || 2,
      tags: (q.tags||[]).slice(0,4),
      question: String(q.content||'').slice(0,800),
      options: (srcQ.options||[]).map(o=>({k:o.k, t:o.t})),
      answer: String(q.answer||'').slice(0,200),
    };
    const messages = [
      { role:'system', content: FAN_SYS_PROMPT },
      { role:'user',   content: '请严格按系统提示的流程与字段顺序出题。'
        + (nudge ? '【重试补丁】' + nudge + ' ' : '') + '原题：' + JSON.stringify(src) },
    ];
    let text='', finish='';
    const ac = new AbortController();
    this.ac = ac; AI.ac = ac;
    this.running = true;
    let stream;
    try{
      stream = await AI.client.llm.chat.completions.create({
        /* 2026-10-15：max_tokens 1800→3600 —— 新 prompt 要求先写完整 solve 草稿再给
           analysis/answer，1800 会在草稿中途被切断，JSON 残缺；temp 0.4→0.3：
           出题要一点多样性，但正确性优先（与识题端 temp=0.15 的教训同源）。 */
        model, messages, stream:true, temperature:0.3, max_tokens:3600, signal: ac.signal,
      });
    }catch(e){
      this.running=false;
      if(e && (e.name==='AbortError' || /abort/i.test(String(e.message||'')))) throw new Error('cancelled');
      throw e;
    }
    try{
      for await (const ch of stream){
        if(this.cancel || AI.cancel){ try{ ac.abort(); }catch(e){} break; }
        const c0 = ch && ch.choices && ch.choices[0];
        if(c0 && c0.finish_reason) finish = c0.finish_reason;
        const d = c0 && c0.delta;
        if(d && typeof d.content === 'string') text += d.content;
      }
    }catch(e){
      if(this.cancel || AI.cancel || (e && e.name==='AbortError')) throw new Error('cancelled');
      throw e;
    }finally{ if(AI.ac===ac) AI.ac=null; this.ac=null; this.running=false; }
    const r = parseJSON(text);
    if(finish==='length' && r && r._raw) r._truncated = true;
    return r;
  },
  abort(){ if(this.ac){ try{ this.ac.abort(); }catch(e){} } this.cancel=true; },
};

/* 举一反三 UI：详情页与题库题卡都能进；关浮层即取消生成 */
let fanCur = null;
function openFan(id){
  const q=S.qs.find(x=>x.id===id); if(!q) return;
  FAN.orig=q;
  const s=subj(q.subject);
  openSheet(`
    <h2>举一反三 <span class="tag" style="background:${s.c}14;color:${s.c};border-color:${s.c}33">${s.n}</span></h2>
    <div class="sub-h">照着这道题，AI 出一道同类型的新题</div>
    <div class="card" style="margin-bottom:14px;font-size:13.5px;color:var(--ink-2);line-height:1.85">${esc(String(q.content||'（图片题）').slice(0,140))}${String(q.content||'').length>140?'…':''}</div>
    <div id="fanBody"></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:16px" id="fanBtns" hidden>
      <button class="btn primary" data-act="fan-keep">收入错题集</button>
      <button class="btn" data-act="fan-again">换一题</button>
    </div>
    <button class="btn ghost block" style="margin-top:10px" data-act="close-sheet">不用了</button>
  `);
  runFan(q);
}
/* 选项回捞：模型最常见的偷懒是「选项写在题干里、只给 answer、options 给空数组」。
   这种情况下直接判失败要用户反复点「换一题」，体验很差。
   先在 question 里按行找 A./B./C./D. 开头的选项行，捞出来补成 options ——
   捞到了就走正常渲染（cleanQuestion 随后会把题干里的重复选项行删掉）。 */
function rescueOptions(d){
  if(!d) return d;
  const have = Array.isArray(d.options) ? d.options.filter(o=>o && o.t) : [];
  if(have.length >= 2) return d;
  const text = String(d.question||'');
  if(!text) return d;
  const found = [];
  for(const raw of text.split('\n')){
    const t = raw.trim();
    const m = t.match(/^[（(]?\s*([A-Fa-f])\s*[)）.、．:：]\s*(.+)$/);
    if(!m) continue;
    const body = m[2].trim();
    if(!body || body.length > 300) continue;
    if(found.some(o=>o.k === m[1].toUpperCase())) continue;
    found.push({ k:m[1].toUpperCase(), t:body });
  }
  /* 至少两个才算真选项（防止题干里的「(1)…」之类被误认） */
  if(found.length >= 2){
    d.options = found.slice(0,6);
    if(!d.type || d.type==='solve' || d.type==='fill') d.type = 'choice';
  }
  return d;
}
/* 结果校验：原题是选择题 / answer 是单个字母却没给选项 = 选择题硬闸没过
   （本应用最高频翻车点）；连题干都没有 = 彻底解析失败。
   命中就带补丁自动重出一次，还不行才报错。 */
function fanBad(r, orig){
  if(!r || (!r.question && !r._raw)) return 'parse';
  let d = r._raw ? salvageFields(r._raw) : r;
  rescueOptions(d);
  const ans = String((d && d.answer) || '').trim();
  const opts = Array.isArray(d && d.options) ? d.options.filter(o=>o && o.t) : [];
  /* 原题带选项（选择题）→ 新题必须是选择题且给全选项 */
  const origChoice = !!(orig && orig.type==='choice' && (orig.options||[]).length>=2);
  if(origChoice && opts.length < 2) return 'no-options';
  if(/^[A-Fa-f]$/.test(ans) && opts.length < 2) return 'no-options';
  /* 选项不全（只给了 2~3 个）也算硬闸没过 */
  if(opts.length >= 2 && opts.length < 4) return 'few-options';
  return '';
}
async function runFan(q){
  fanCur=null;
  FAN.cancel=false;
  const body=$('#fanBody'); if(!body) return;
  const btns=$('#fanBtns'); if(btns) btns.hidden=true;
  body.innerHTML=`<div class="fan-wait"><span class="fan-dots"><i></i><i></i><i></i></span>
    <b>AI 正在出题</b><small>想一道同类型、难度差不多的</small></div>`;
  try{
    let r = await FAN.gen(q);
    let badCode = fanBad(r, q);
    if(badCode){
      /* 自检清单没过 → 把具体毛病写进补丁重出一次（双倍成本只花在坏结果上，值） */
      r = await FAN.gen(q, badCode==='few-options'
        ? '你上一轮的 options 少于 4 项。选择题必须恰好给全 A/B/C/D 四项，每项 t 写完整正文，answer 字母必须对应其中一项。'
        : '你上一轮的 answer 是单个字母却没给 options 数组（或原题是选择题你出成了解答题）。这题必须是 type=choice，给全 4 个选项的 options（每项含 k 与 t），answer 字母必须对应其中一项；只有原题本身不是选择题时才允许 options 为空数组。');
      badCode = fanBad(r, q);
    }
    if(badCode) throw new Error(badCode);
    paintFan(r);
    if(btns) btns.hidden=false;
  }catch(err){
    const m=String((err&&err.message)||'');
    console.warn('fan fail', err);
    let msg;
    if(m==='parse') msg='AI 格式没对上，点「换一题」再来一次';
    else if(m==='no-options') msg='AI 连续两次没给选项，点「换一题」再试';
    else if(m==='few-options') msg='AI 给的选项不全，点「换一题」再试';
    else if(m==='cancelled') msg='已取消';
    else msg=aiErrMsg(codeOf(err));
    body.innerHTML=`<div class="fan-wait"><b>${esc(msg)}</b>
      <button class="btn" style="margin-top:12px" data-act="fan-again">换一题</button></div>`;
  }
}
function paintFan(r){
  const body=$('#fanBody'); if(!body) return;
  let d=r;
  if(r._raw){
    const s=salvageFields(r._raw);
    if(!s.question){ body.innerHTML=`<div class="fan-wait"><b>AI 没写出题干，点「换一题」再来</b></div>`; return; }
    d={...s,_salvaged:true};
  }
  rescueOptions(d);
  const s=subj(d.subject);
  const opts=(Array.isArray(d.options)?d.options:[]).filter(o=>o&&o.t).slice(0,6)
    .map((o,i)=>({ k:String(o.k||OPT_K[i]||'').slice(0,1).toUpperCase()||OPT_K[i],
                   t:stripOptPrefix(String(o.t||'').trim()).slice(0,300) }))
    .filter(o=>o.t);
  const isChoice = TYPES.includes(d.type) && opts.length>=2;
  const q = cleanQuestion(d.question, isChoice?opts:[], d.answer).slice(0,1200);
  body.innerHTML=`
    <div class="card fan-card">
      <div class="top">
        <span class="tag" style="background:${s.c}14;color:${s.c};border-color:${s.c}33">${s.n}</span>
        <span class="tag">${DIFF[clamp(+d.difficulty||2,1,3)]||'中等'}</span>
        ${(d.tags||[]).slice(0,4).map(t=>`<span class="tag">#${esc(String(t).slice(0,10))}</span>`).join('')}
      </div>
      <div style="font-size:15px;line-height:1.9;margin-top:10px;overflow-wrap:break-word">${splitParas(q||'（没读到题干）')}</div>
      ${isChoice? `<div class="fan-opts">${opts.map(o=>`<div class="fan-opt"><b>${o.k}</b><span>${esc(o.t)}</span></div>`).join('')}</div>`:''}
      <div class="fan-ans"><label>参考答案</label>
        <div style="font-size:14px;overflow-wrap:break-word">${splitParas(String(d.answer||'（无）').slice(0,600))}</div></div>
      ${d.analysis? `<div class="fan-ans"><label>简析</label>
        <div style="font-size:13.5px;color:var(--ink-2);overflow-wrap:break-word">${splitParas(String(d.analysis).slice(0,800))}</div></div>`:''}
    </div>`;
  /* 清洗后的数据存回 fanCur，「收入错题集」直接用 */
  fanCur = {
    subject: SUBJ_KEYS.includes(d.subject)? d.subject : 'math',
    type: isChoice? 'choice':'solve', options: isChoice? opts : [],
    difficulty: clamp(+d.difficulty||2,1,3),
    tags: (Array.isArray(d.tags)?d.tags:[]).map(t=>String(t).trim().replace(/^#/,'')).filter(Boolean).slice(0,6),
    content: q, answer: String(d.answer||'').slice(0,1200), analysis: String(d.analysis||'').slice(0,1600),
  };
}
async function fanKeep(){
  if(!fanCur || !fanCur.content){ toast('还没有可收入的题'); return; }
  const orig=FAN.orig;
  const now=Date.now();
  const q={ id:uid(), mastery:0, ease:2.5, interval:0, due:now,
    reviews:0, correct:0, wrong:0, createdAt:now,
    subject:fanCur.subject, difficulty:fanCur.difficulty,
    type:fanCur.type, options:fanCur.options,
    content:fanCur.content, answer:fanCur.answer, analysis:fanCur.analysis,
    tags:fanCur.tags, imageId:null,
    varietyOf: orig&&orig.id ? orig.id : null,
    updatedAt:now };
  try{
    await DB.put(q);
    render(); schedulePush();
    closeSheet();
    buzz(12);
    toast('已经收进题库，去「题库」看看');
  }catch(e){
    console.warn('fan keep', e);
    toast('没存进去，稍后再试');
  }
}

/* ============================================================ 图像处理 */
function loadImageFile(file){
  return new Promise((res,rej)=>{
    if(!file || !file.type.startsWith('image/')) return rej(new Error('not-image'));
    const url = URL.createObjectURL(file);
    const done = (w,h,drawable)=>{
      const MAX = 2400;
      let w2=w,h2=h;
      if(w>MAX||h>MAX){ const r=Math.min(MAX/w,MAX/h); w2=Math.round(w*r); h2=Math.round(h*r); }
      const c=document.createElement('canvas'); c.width=w2; c.height=h2;
      c.getContext('2d').drawImage(drawable,0,0,w2,h2);
      URL.revokeObjectURL(url);
      res(c);
    };
    if(window.createImageBitmap){
      createImageBitmap(file,{ imageOrientation:'from-image' })
        .then(bm=>done(bm.width,bm.height,bm))
        .catch(()=>{
          const img=new Image();
          img.onload=()=>done(img.naturalWidth,img.naturalHeight,img);
          img.onerror=()=>{ URL.revokeObjectURL(url); rej(new Error('decode')); };
          img.src=url;
        });
    }else{
      const img=new Image();
      img.onload=()=>done(img.naturalWidth,img.naturalHeight,img);
      img.onerror=()=>{ URL.revokeObjectURL(url); rej(new Error('decode')); };
      img.src=url;
    }
  });
}
function downscale(src, max){
  const r = Math.min(1, max/Math.max(src.width, src.height));
  if(r>=1) return src;
  const c=document.createElement('canvas');
  c.width=Math.round(src.width*r); c.height=Math.round(src.height*r);
  c.getContext('2d').drawImage(src,0,0,c.width,c.height);
  return c;
}
/* ------------------------------------------------------------ 图像增强
   参考开源方案（nipunbatra/scancat、rzazo24/zscanner、CamScanner 逆向文档）：
     ① 用强模糊估出「光照背景」B（低频照明场）；
     ② 每个通道统一乘以同一个 gain = 255/B —— 倍率一致 → 色相不变，
        红笔依旧是红的，这是彩扫的关键，灰度化会把它吃掉；
     ③ 按百分位做一次 S 形拉伸，纸压到纯白、墨压深；
     ④ 黑白档才走灰度 + 自适应阈值。
   全部走 LUT，避免逐像素做浮点除法。 */
const _EC = {};                                     // 复用的暂存画布
function _ec(key, w, h){
  let c=_EC[key];
  if(!c){ c=_EC[key]=document.createElement('canvas'); }
  if(c.width!==w||c.height!==h){ c.width=w; c.height=h; }
  return c;
}
let _GAIN=null, _BW_LUT=null;
function _gainTable(){
  if(_GAIN) return _GAIN;
  _GAIN=new Uint16Array(256);
  for(let b=0;b<256;b++) _GAIN[b]=Math.round(65280/Math.max(b,5));   // (255<<8)/B
  return _GAIN;
}
function _bwTable(){
  if(_BW_LUT) return _BW_LUT;
  _BW_LUT=new Uint8Array(256);
  for(let v=0;v<256;v++){ const x=v/255; _BW_LUT[v]=Math.round(255*Math.pow(x,1.5)); }
  return _BW_LUT;
}
/* mode: 'color'(保色增强) | 'bw'(黑白) | 'forAI'(给模型看得更清楚) */
function enhance(src, opt){
  const o = opt||{};
  const mode = o.mode==='bw' ? 'bw' : (o.mode==='forAI' ? 'forAI' : 'color');
  const w=src.width|0, h=src.height|0, n=w*h;
  if(!n) return src;

  /* ---- 光照背景：把原图缩到 1/26 再平滑放大 = 一次很强的低频模糊 ---- */
  const bw=Math.max(4,Math.round(w/26)), bh=Math.max(4,Math.round(h/26));
  const small=_ec('small', bw, bh);
  const sctx=small.getContext('2d');
  sctx.imageSmoothingEnabled=true; sctx.imageSmoothingQuality='high';
  sctx.clearRect(0,0,bw,bh);
  sctx.drawImage(src,0,0,bw,bh);
  const bgc=_ec('bg', w, h);
  const bgx=bgc.getContext('2d',{ willReadFrequently:true });
  bgx.imageSmoothingEnabled=true; bgx.imageSmoothingQuality='high';
  bgx.clearRect(0,0,w,h);
  bgx.drawImage(small,0,0,bw,bh,0,0,w,h);
  const bg=bgx.getImageData(0,0,w,h).data;

  const base=_ec('base', w, h);
  const bctx=base.getContext('2d',{ willReadFrequently:true });
  bctx.imageSmoothingEnabled=true; bctx.imageSmoothingQuality='high';
  bctx.clearRect(0,0,w,h);
  bctx.drawImage(src,0,0,w,h);
  const img=bctx.getImageData(0,0,w,h);
  const d=img.data;

  const G=_gainTable();
  const bright=o.bright||0;

  if(mode==='bw'){
    const T=_bwTable();
    /* 浅色铅笔字（HB 写的过程字）灰度本来就淡，gamma 一拉就直接抹掉。
       所以灰阶低于 180 的像素不参与 gamma，原样保留 —— 该淡还淡，但不消失。 */
    const FLOOR=180;
    for(let p=0,i=0;p<n;p++,i+=4){
      let v = (G[bg[i]] * ((d[i]*0.299 + d[i+1]*0.587 + d[i+2]*0.114)|0)) >> 8;
      if(v>255) v=255;
      v = (v<FLOOR ? v : T[v]) + bright;
      d[i]=d[i+1]=d[i+2] = v<0?0:(v>255?255:v);
    }
  }else{
    /* 保色：三通道同倍率 → 色相不变，红笔仍然是红的 */
    const k = 1 + (o.cont==null?18:o.cont)/100;
    /* 纸白锚点 240：232 会把浅灰的答题卡网格、纸纹也提成前景，反而干扰读题 */
    const wp = 240;
    for(let p=0,i=0;p<n;p++,i+=4){
      const g=G[(bg[i]*0.299 + bg[i+1]*0.587 + bg[i+2]*0.114)|0];
      let r=(d[i]*g)>>8, gg=(d[i+1]*g)>>8, b=(d[i+2]*g)>>8;
      r=(r-wp)*k+wp+bright; gg=(gg-wp)*k+wp+bright; b=(b-wp)*k+wp+bright;
      d[i]  = r<0?0:(r>255?255:r);
      d[i+1]= gg<0?0:(gg>255?255:gg);
      d[i+2]= b<0?0:(b>255?255:b);
    }
  }
  bctx.putImageData(img,0,0);
  return base;
}
function canvasToDataURL(c, quality){
  return c.toDataURL('image/jpeg', quality==null?0.9:quality);
}

/* ================================================================ 扫描台 */
const ST = {
  open:false, src:null, prev:null, dw:0, dh:0, scale:1,
  box:{x:0,y:0,w:0,h:0}, mode:'color', bright:0, cont:30, onDone:null, raf:0,
};
function studioOpen(srcCanvas, onDone){
  ST.src = srcCanvas;
  /* 预览用 1400px 的中档图：够看清小字，又不至于让滑块卡顿 */
  ST.prev = downscale(srcCanvas, 1400);
  ST.mode = 'color'; ST.bright = 0; ST.cont = 30;
  ST.onDone = onDone;
  $('#stBright').value = 0; $('#stContrast').value = 30;
  $$('#stModes .st-chip').forEach(c=>c.classList.toggle('on', c.dataset.mode===ST.mode));
  $$('#stSliders').forEach(el=>{ el.style.display='grid'; });
  $('#studio').classList.add('on');
  $('#studio').setAttribute('aria-hidden','false');
  ST.open = true;
  requestAnimationFrame(()=>{ layoutStudio(); defaultBox(); });
}
function studioClose(){
  ST.open=false;
  $('#studio').classList.remove('on');
  $('#studio').setAttribute('aria-hidden','true');
  ST.onDone=null;
}
function layoutStudio(){
  const stage=$('#stStage');
  const wrap=$('#stWrap');
  const pad=14;
  const aw=stage.clientWidth-pad*2, ah=stage.clientHeight-pad*2;
  const iw=ST.src.width, ih=ST.src.height;
  ST.scale = Math.min(aw/iw, ah/ih);
  ST.dw = Math.round(iw*ST.scale);
  ST.dh = Math.round(ih*ST.scale);
  wrap.style.width = ST.dw+'px';
  wrap.style.height = ST.dh+'px';
  paintStudio();
}
function defaultBox(){
  const mx=Math.round(ST.dw*0.07), my=Math.round(ST.dh*0.07);
  ST.box = { x:mx, y:my, w:ST.dw-mx*2, h:ST.dh-my*2 };
  syncBox();
}
function syncBox(){
  const b=$('#stBox');
  b.style.left=ST.box.x+'px'; b.style.top=ST.box.y+'px';
  b.style.width=ST.box.w+'px'; b.style.height=ST.box.h+'px';
}
function paintStudio(){
  const cv=$('#stCanvas');
  /* 画布内部分辨率按屏幕像素比走 —— 之前画布只有 CSS 宽度那么多像素，
     任何图放进来都会糊，这是「一到框选页就变模糊」的根因。 */
  const dpr=Math.min(window.devicePixelRatio||1, 2.5);
  const W=Math.max(1,Math.round(ST.dw*dpr)), H=Math.max(1,Math.round(ST.dh*dpr));
  if(cv.width!==W || cv.height!==H){ cv.width=W; cv.height=H; }
  cv.style.width=ST.dw+'px'; cv.style.height=ST.dh+'px';
  const ctx=cv.getContext('2d');
  ctx.imageSmoothingEnabled=true; ctx.imageSmoothingQuality='high';
  ctx.clearRect(0,0,W,H);
  let src;
  if(ST.mode==='raw') src=ST.src;
  else src=enhance(ST.prev,{ mode:ST.mode, bright:ST.bright, cont:ST.cont });
  ctx.drawImage(src,0,0,W,H);
}
function schedulePaint(){
  if(ST.raf) return;
  ST.raf = requestAnimationFrame(()=>{ ST.raf=0; paintStudio(); });
}
/* 指针拖拽：移动 / 缩放 */
(function bindStudioPointer(){
  let drag=null;
  const stage = ()=> $('#stStage');
  stage().addEventListener('pointerdown', e=>{
    const h = e.target.closest('.ch');
    const b = e.target.closest('.cropbox');
    if(!b) return;
    e.preventDefault();
    stage().setPointerCapture(e.pointerId);
    drag = { id:e.pointerId, handle:h?h.dataset.ch:null,
             sx:e.clientX, sy:e.clientY, box:{...ST.box} };
    $('#stHint') && $('#stHint').classList.add('hide');
  });
  stage().addEventListener('pointermove', e=>{
    if(!drag || e.pointerId!==drag.id) return;
    const r = $('#stWrap').getBoundingClientRect();
    const dx = e.clientX-drag.sx, dy = e.clientY-drag.sy;
    const b0 = drag.box;
    let {x,y,w,h} = b0;
    if(!drag.handle){
      x = clamp(b0.x+dx, 0, ST.dw-b0.w);
      y = clamp(b0.y+dy, 0, ST.dh-b0.h);
    }else{
      const H = drag.handle, min=44;
      if(H.includes('n')){ const ny=clamp(b0.y+dy,0,b0.y+b0.h-min); h=b0.h+(b0.y-ny); y=ny; }
      if(H.includes('s')){ h=clamp(b0.h+dy, min, ST.dh-b0.y); }
      if(H.includes('w')){ const nx=clamp(b0.x+dx,0,b0.x+b0.w-min); w=b0.w+(b0.x-nx); x=nx; }
      if(H.includes('e')){ w=clamp(b0.w+dx, min, ST.dw-b0.x); }
    }
    ST.box={x:Math.round(x),y:Math.round(y),w:Math.round(w),h:Math.round(h)};
    syncBox();
  });
  const end = e=>{ if(drag && e.pointerId===drag.id) drag=null; };
  stage().addEventListener('pointerup', end);
  stage().addEventListener('pointercancel', end);
})();
function studioApply(){
  const sx = Math.round(ST.box.x/ST.scale), sy = Math.round(ST.box.y/ST.scale);
  const sw = Math.max(8,Math.round(ST.box.w/ST.scale)), sh = Math.max(8,Math.round(ST.box.h/ST.scale));
  const c=document.createElement('canvas'); c.width=sw; c.height=sh;
  const ctx=c.getContext('2d',{ willReadFrequently:true });
  ctx.imageSmoothingEnabled=true; ctx.imageSmoothingQuality='high';
  ctx.drawImage(ST.src, sx, sy, sw, sh, 0, 0, sw, sh);
  let final = c;
  if(ST.mode!=='raw') final = enhance(c,{ mode:ST.mode, bright:ST.bright, cont:ST.cont });
  /* 长边压到 1800：足够看清小字，又不会撑爆本地库 */
  const capped = downscale(final, 1800);
  const cb = ST.onDone;
  const fin = blob=>{ studioClose(); if(cb) cb(blob || new Blob([])); };
  if(capped.toBlob){
    capped.toBlob(b=>fin(b || dataURLtoBlob(canvasToDataURL(capped,0.92))), 'image/jpeg', 0.92);
  }else{
    fin(dataURLtoBlob(canvasToDataURL(capped,0.92)));
  }
}
/* 扫描线动效 */
function flashScan(){
  const el=$('#stScan'); if(!el) return;
  el.classList.remove('on'); void el.offsetWidth; el.classList.add('on');
  setTimeout(()=>el.classList.remove('on'), 1500);
}

/* ================================================================== 渲染 */
function render(){
  const v=$('#view');
  const map={ home:ViewHome, bank:ViewBank, review:ViewReview, stats:ViewStats };
  v.innerHTML = (map[S.tab]||ViewHome)();
  THEME.paint(v);                       // 重建后的实景带要重新套一次白天/夜晚
  $$('#tabbar button').forEach(b=>b.classList.toggle('active', b.dataset.tab===S.tab));
  syncTabPill();
  if(S.tab==='bank')  bindBank();
  animateCounters(v);
  healImages(v);                        // 万一有图还没补上 URL，兜一次
  requestAnimationFrame(()=>setTimeout(afterPaint, 40));
}
/* 兜底补图：把当前页面里 src 为空的题图找出来，拉回 Blob 后原地填上。
   为什么要有这一层：hydrate 只在启动跑一次，若那时被打断（超时、库被回收），
   图上就一直是空 src，用户只会看到「题目的图片呢」。这里按需补，最多重试一轮。 */
let _healing=false;
async function healImages(root){
  if(_healing || !root) return;
  const broken=[...root.querySelectorAll('img[src=""], img:not([src])')]
    .filter(im=>/^blob:|^data:/.test(im.getAttribute('src')||'') || !im.getAttribute('src'));
  if(!broken.length) return;
  /* 从 DOM 找不回 imageId，就直接比对内存里「有 imageId 但没 URL」的题 */
  const missing=S.qs.filter(q=>q.imageId && !IMG.url(q.imageId));
  if(!missing.length) return;
  _healing=true;
  try{
    const n=await IMG.hydrate(missing);
    if(n) render();                     // 补上了就整页重画，简单可靠
  }catch(e){ /* 下次再说 */ }
  finally{ _healing=false; }
}
/* 渲染后动效：进度条 / 掌握环 */
function afterPaint(){
  $$('[data-bar]').forEach(el=>{ el.style.width=(el.dataset.bar||0)+'%'; });
  animateBars(document);
  const ring=$('#homeRing');
  if(ring){
    const C=2*Math.PI*34, total=S.qs.length||1;
    const mastered=S.qs.filter(q=>q.mastery===2).length;
    ring.style.strokeDasharray=String(C);
    ring.style.strokeDashoffset=String(C*(1-mastered/total));
  }
  if(S.tab==='stats') drawStats();
}
function syncTabPill(){
  const pill=$('#tabPill'); if(!pill) return;
  const btn=document.querySelector(`#tabbar button[data-tab="${S.tab}"]`);
  const bar=$('#tabbar');
  if(!btn || S.tab==='add'){ pill.style.opacity='0'; return; }
  const br=bar.getBoundingClientRect(), r=btn.getBoundingClientRect();
  pill.style.width = Math.max(0, r.width-10)+'px';
  pill.style.transform = `translateX(${r.left-br.left+5}px)`;
  pill.style.opacity = '1';
}
function animateCounters(root){
  root.querySelectorAll('[data-count]').forEach(el=>countUp(el, +el.dataset.count, 820));
}
function animateBars(root){
  root.querySelectorAll('.bars .col').forEach(el=>{
    const v=el.dataset.h||0;
    requestAnimationFrame(()=>{ setTimeout(()=>{ el.style.height=v+'%'; }, 40); });
  });
}

/* ------------------------------------------------------------ 首页
   刻意只留三样东西：一句问候、今日一图、一个「开始复习」的入口。
   原先这里堆了三张数字卡（错题总数 / 半熟 / 已攻克）加一个掌握率环，
   满屏都是数，反而没有想用的欲望。数字要看，去「记录」页。 */
function ViewHome(){
  const qs=S.qs;
  const pend = qs.filter(due).length;
  const goal = Math.max(1,S.settings.goal||10);
  const doneToday = qs.filter(q=>q.lastReview && q.lastReview>=today()).length;
  const pct = Math.min(100, Math.round(doneToday/goal*100));
  const h=new Date().getHours();
  const greet = h<6?'还没睡':h<11?'早上好':h<14?'中午好':h<18?'下午好':'晚上好';
  const d=new Date();
  const dateStr = `${d.getMonth()+1} 月 ${d.getDate()} 日 · 周${'日一二三四五六'[d.getDay()]}`;
  const dw = DAILY.quote();
  const di = DAILY.idx();
  const dNight = THEME.dark();

  return `<div class="page">
    <div class="hero rise" style="--i:0">
      <div class="hero-inner">
        <div class="date">${dateStr}</div>
        <h2>${greet}。<em>${pend?`还有 ${pend} 道`:'今天清空'}</em>${pend?'待攻克':'了'}</h2>
        <p>${pend? '按掌握度排好队了，先做最不熟的那几道。' : '题库清空了，去拍一道新错题吧。'}</p>
        <div class="hero-bar">
          <div class="progress"><i data-bar="${pct}"></i></div>
          <b>${doneToday} / ${goal}</b>
        </div>
      </div>
    </div>

    <div class="daily rise" style="--i:1">
      <div class="d-pic">
        <img src="${DAILY.img(dNight)}" data-day="${DAILY.img(false)}" data-night="${DAILY.img(true)}"
          alt="" loading="lazy" data-act="zoom">
        <span class="d-badge">今日一图 · ${String(di).padStart(2,'0')}/${DAILY.N}</span>
      </div>
      <div class="d-say">
        <div class="d-q">${esc(dw[0])}</div>
        <div class="d-from">${esc(dw[1])}</div>
      </div>
    </div>

    <div class="cta rise" style="--i:2" data-act="goto-review">
      <div class="t">
        <b>${pend?'开始复习':'暂无待复习'}</b>
        <small>${pend?'从最不熟的那几道开始':'点右下 ＋ 拍一道新错题'}</small>
      </div>
      <div class="go" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="18" height="18"><path d="M8 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </div>
    </div>
  </div>`;
}
/* ------------------------------------------------------------ 题库 */
function filteredList(){
  const f=S.filter;
  let list=S.qs.slice();
  if(f.subject!=='all') list=list.filter(q=>q.subject===f.subject);
  if(f.mastery!=='all') list=list.filter(q=>q.mastery===+f.mastery);
  if(f.kw){
    const k=f.kw.toLowerCase();
    list=list.filter(q=>(q.content||'').toLowerCase().includes(k)
      || (q.answer||'').toLowerCase().includes(k)
      || (q.tags||[]).some(t=>String(t).toLowerCase().includes(k)));
  }
  const rank=q=>due(q)?0:1;
  return list.sort((a,b)=> rank(a)-rank(b) || (b.createdAt-a.createdAt));
}
function bankListInner(){
  const list=filteredList();
  if(!list.length) return `<div class="empty"><div class="em">空</div><b>没有匹配的题</b><p>换个筛选条件，或拍一道新的</p></div>`;
  return `<div style="font-size:12px;color:var(--dim2);margin:2px 2px 10px;font-weight:600">共 ${list.length} 道</div>`
    + list.map((q,i)=>qCard(q,i)).join('');
}
function ViewBank(){
  const f=S.filter;
  return `<div class="page">
    <div class="searchbar rise" style="--i:0">
      <svg class="sb-ico" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6" stroke-linecap="round"/></svg>
      <input id="kw" placeholder="搜题干 / 答案 / 知识点" value="${esc(f.kw)}" autocomplete="off">
    </div>
    <div class="filters rise" style="--i:1" id="subjFilters">
      <button class="chip ${f.subject==='all'?'active':''}" data-subj="all">全部学科</button>
      ${SUBJECTS.map(s=>`<button class="chip ${f.subject===s.k?'active':''}" data-subj="${s.k}">${s.n}</button>`).join('')}
    </div>
    <div class="filters wrap rise" style="--i:2" id="mastFilters">
      <button class="chip ${f.mastery==='all'?'active':''}" data-mast="all">全部</button>
      ${PLAN.map((p,i)=>`<button class="chip ${String(f.mastery)===String(i)?'active':''}" data-mast="${i}">${p.ico} ${p.name}</button>`).join('')}
    </div>
    <div id="bankList">${bankListInner()}</div>
  </div>`;
}
function qCard(q,i){
  const s=subj(q.subject), p=PLAN[q.mastery];
  const d=q.due&&q.due>Date.now() ? `待 ${fmtDate(q.due)} 复习` : (q.reviews?'今日可复习':'新题待练');
  return `<div class="qcard rise" style="--i:${Math.min(i+3,14)}" data-act="open" data-id="${q.id}">
    <div class="top">
      <span class="tag" style="background:${s.c}14;color:${s.c};border-color:${s.c}33">${s.n}</span>
      <span class="tag m${q.mastery}">${p.ico} ${MAST[q.mastery]}</span>
      <span class="tag">${DIFF[q.difficulty]||'中等'}</span>
      ${(q.tags||[]).slice(0,2).map(t=>`<span class="tag">#${esc(t)}</span>`).join('')}
    </div>
    <div class="txt ${qHasImg(q)?'has-img':''}">
      ${qHasImg(q)? `<img src="${esc(qImg(q))}" alt="" loading="lazy">`:''}
      <div class="ql">${esc(q.content||'（图片题）')}</div>
    </div>
    <div class="meta"><span>复习 ${q.reviews||0} 次</span><span class="dot"></span><span>${d}</span>
      ${q.wrong? `<span class="dot"></span><span>错 ${q.wrong} 次</span>`:''}
      <button class="qfan" data-act="fan" data-id="${q.id}">举一反三</button></div>
  </div>`;
}
function bindBank(){
  const kw=$('#kw');
  kw.oninput=()=>{ S.filter.kw=kw.value; const box=$('#bankList'); if(box) box.innerHTML=bankListInner(); };
  $('#subjFilters').onclick=e=>{ const b=e.target.closest('[data-subj]'); if(!b) return;
    S.filter.subject=b.dataset.subj; buzz(8); render(); };
  $('#mastFilters').onclick=e=>{ const b=e.target.closest('[data-mast]'); if(!b) return;
    S.filter.mastery=b.dataset.mast; buzz(8); render(); };
}

/* ------------------------------------------------------------ 复习 */
function ViewReview(){
  const r=S.review;
  if(!r.queue.length){
    const pend=S.qs.filter(due).length;
    const goal=clamp(+S.settings.goal||5,1,200);
    const today=Math.min(pend, goal);
    return `<div class="page">
      <div class="sec-title" style="margin-top:8px"><h3>复习模式</h3></div>
      <div class="empty">
        <div class="em">${pend?'待':'空'}</div>
        <b>${pend? `有 ${pend} 道待复习`:'今天没有待复习的错题'}</b>
        <p>${pend? `今天的量是 ${today} 道，做完就收工`:'休息一下，或去拍一道新错题'}</p>
        <div style="margin-top:20px;display:flex;flex-direction:column;gap:10px;max-width:300px;margin-left:auto;margin-right:auto">
          ${pend? `<button class="btn primary block" data-act="start-review">开始今天的 ${today} 道</button>`:''}
          ${pend>today? `<button class="btn block ghost" data-act="start-review-all">把 ${pend} 道全过一遍</button>`:''}
          <button class="btn block ghost" data-act="random-practice">随机练一道</button>
        </div>
      </div>
      <div class="scenery"><img src="assets/band-torii.jpg"
        data-day="assets/band-torii.jpg" data-night="assets/band-torii-night.jpg" alt=""></div>
    </div>`;
  }
  const q=r.queue[r.idx];
  if(!q) return ViewReviewEnd();
  const s=subj(q.subject);
  const pct=Math.round(r.idx/r.queue.length*100);
  const behind=Math.max(0, (r.total||r.queue.length) - r.queue.length);
  const isChoice = q.type==='choice' && (q.options||[]).length>=2;
  /* 选择题的标准答案可能是 "B" 也可能是 "B、C" 或 "BC"，都拆成字母集合来比 */
  const ansSet = isChoice ? new Set(String(q.answer||'').toUpperCase().match(/[A-F]/g)||[]) : null;
  const picked = r.picked || null;
  const hit = isChoice && picked && ansSet && ansSet.has(picked);
  const answered = isChoice ? !!picked : !!(r.typed||'').trim();

  return `<div class="page">
    <div class="rev-head">
      <span class="cnt">${r.idx+1} / ${r.queue.length}${r.all?'':' <em style="font-style:normal;font-size:11px;color:var(--ink-4);letter-spacing:.02em">今天</em>'}${behind? ` <em style="font-style:normal;font-size:11px;color:var(--ink-4)">· 另 ${behind} 道</em>`:''}</span>
      <span style="display:flex;gap:6px;align-items:center">
        ${isChoice? `<span class="tag">选择题</span>`:''}
        <span class="tag" style="background:${s.c}14;color:${s.c};border-color:${s.c}33">${s.n}</span>
      </span>
    </div>
    <div class="progress"><i data-bar="${pct}"></i></div>
    <div class="flash"><div class="flash-card">
      <div class="q">${q.content? splitParas(q.content) : '<p class="para">（图片题）</p>'}</div>
      ${qHasImg(q)? `<div class="shot lg zoomable" data-act="zoom" style="margin:14px 0 0 20px">
        <img src="${esc(qImg(q))}" alt="题图" loading="lazy">
        <span class="shot-tip">点一下看大图</span>
      </div>`:''}

      ${isChoice? `
        <div class="opts" style="margin:16px 0 0 20px">
          ${q.options.map(o=>{
            const on = picked===o.k;
            const good = r.show && ansSet && ansSet.has(o.k);
            const bad = r.show && on && !good;
            return `<button class="opt ${on?'on':''} ${good?'good':''} ${bad?'bad':''}"
              data-pick="${esc(o.k)}" ${r.show?'disabled':''}>
              <b>${esc(o.k)}</b><span>${esc(o.t)}</span>
              ${good? '<i class="ok">✓</i>':''}${bad? '<i class="no">✕</i>':''}
            </button>`;
          }).join('')}
        </div>` : (r.show? '' : `
        <div class="field" style="margin:16px 0 0 20px">
          <label style="font-size:11.5px">先自己写一遍（不想写也可以直接看答案）</label>
          <textarea id="revTyped" placeholder="在纸上写完后，可以在这里记下思路或答案…"
            style="min-height:64px;font-size:14px">${esc(r.typed||'')}</textarea>
        </div>`)}

      ${r.show? `
        <div class="a">
          <div class="lab ok">正确答案</div>${splitParas(q.answer||'（未填写）')}
          ${isChoice? `<div class="ans-you ${hit?'hit':'miss'}">
            你选了 ${picked? esc(picked):'—'} · ${hit?'答对了':'答错了，这道题重新排队'}</div>`:''}
          ${q.analysis? `<div class="lab an">解析 / 错因</div>${splitParas(q.analysis)}`:''}
        </div>`:''}
    </div></div>

    <div style="margin-top:14px">
      ${r.show? (isChoice ? `
        <div class="grade-row">
          ${hit? `
            <button class="grade g2" style="grid-column:span 2" data-grade="2">答对了 · 下一题<small>${q.mastery>=2?'延长间隔':'下次少见面'}</small></button>
            <button class="grade g0" data-grade="0">其实猜的<small>重新排队</small></button>
          ` : `
            <button class="grade g0" style="grid-column:span 2" data-grade="0">答错了 · 重新排队<small>30 分钟后再见</small></button>
            <button class="grade g1" data-grade="1">看错而已<small>保持当前</small></button>
          `}
        </div>` : `
        <div class="grade-row">
          <button class="grade g0" data-grade="0">忘了<small>重新排队</small></button>
          <button class="grade g1" data-grade="1">模糊<small>保持当前</small></button>
          <button class="grade g2" data-grade="2">会了<small>${q.mastery>=2?'延长间隔':'下次少见面'}</small></button>
        </div>`) : `
        <div class="ans-bar">
          <button class="btn primary" data-act="reveal" style="flex:1;padding:15px;font-size:15px"
            ${isChoice && !picked?'disabled':''}>
            ${isChoice? (picked? `选了 ${esc(picked)}，对答案` : '先选一个选项') : (answered? '对答案' : '直接看答案')}
          </button>
        </div>`}
    </div>
  </div>`;
}
/* 把长文本切成段落 —— 换行 / 行内序号 / 过长断句，三档切点。
   解决「AI 扫出来的题干与答案解析全挤在一块」。 */
/* 行内序号切分：只在「行首 / 空白后 / 标点后」的小序号处断行。
   关键：序号后面必须是空白或中英文字符，否则会把 tan(2x-π/3) 里的 "3)"
   也当成序号 —— 这正是题干被腰斩成「f(x)=tan(2x-π/」+「3) 的图象」的原因。 */
const NUM_RE = /(?:[①②③④⑤⑥⑦⑧⑨⑩]|[（(]\d{1,2}[)）]|\d{1,2}[.)、])/g;
function splitInlineNumbers(line){
  const segs=[]; let last=0, m;
  NUM_RE.lastIndex=0;
  while((m=NUM_RE.exec(line))){
    const i=m.index;
    const before = i===0 ? '' : line[i-1];
    const after  = line[i+m[0].length] || '';
    const okBefore = i===0 || /[\s。；;，,、：:）)]/.test(before);
    const okAfter  = after==='' || /[\s\u4e00-\u9fa5A-Za-z]/.test(after);
    if(!okBefore || !okAfter) continue;
    if(i>last) segs.push(line.slice(last,i));
    last=i;
  }
  if(last<line.length) segs.push(line.slice(last));
  return segs.length ? segs : [line];
}
function splitParas(text){
  const raw = String(text ?? '').replace(/\r\n?/g,'\n').trim();
  if(!raw) return '';
  const lines = [];
  raw.split(/\n+/).forEach(line=>{
    line = line.trim(); if(!line) return;
    splitInlineNumbers(line).map(x=>x.trim()).filter(Boolean).forEach(x=>lines.push(x));
  });
  /* 单段过长（>96 字）→ 按句末标点断句，每两小句并成一段 */
  const out = [];
  lines.forEach(seg=>{
    if(seg.length <= 96){ out.push(seg); return; }
    const ss = []; let buf = '';
    for(const ch of seg){
      buf += ch;
      if('。！？；!?;'.includes(ch)){ ss.push(buf); buf=''; }
    }
    if(buf.trim()) ss.push(buf);
    if(ss.length < 2){ out.push(seg); return; }
    for(let i=0;i<ss.length;i+=2) out.push(ss.slice(i,i+2).join(''));
  });
  return out.map(p=>`<p class="para">${esc(p)}</p>`).join('');
}
function ViewReviewEnd(){
  const behind=Math.max(0, (S.review.total||0) - (S.review.done||0));
  const goal=clamp(+S.settings.goal||5,1,200);
  return `<div class="page">
    <div class="empty" style="padding:52px 20px 30px">
      <div class="em">了</div>
      <b style="font-size:19px">今天这轮做完了</b>
      <p>共复习 ${S.review.done} 道错题${behind? `，还有 ${behind} 道排着队`:'，明天继续保持'}</p>
      ${behind? `<div style="margin-top:20px;display:flex;flex-direction:column;gap:10px;max-width:300px;margin-left:auto;margin-right:auto">
        <button class="btn primary block" data-act="start-review">再来一轮（${Math.min(goal,behind)} 道）</button>
        <button class="btn block ghost" data-act="start-review-all">剩下 ${behind} 道一次做完</button>
      </div>`:''}
    </div>
    <div class="scenery"><img src="assets/band-sakura.jpg"
      data-day="assets/band-sakura.jpg" data-night="assets/band-sakura-night.jpg" alt=""></div>
    <div style="display:flex;gap:10px;max-width:320px;margin:6px auto 0">
      <button class="btn block ghost" data-act="random-practice">再来一道</button>
      <button class="btn block primary" data-act="goto-home">回到手帖</button>
    </div>
  </div>`;
}
/* 复习队列：默认只排「今天的量」（每日目标，默认 5 道），
   但**必须告诉用户后面还有多少**，并给一个「全都做」的口子 ——
   之前写死 slice(0,60)，超出的题永远轮不到，用户还看不见，是个静默的坑。 */
function startReview(all){
  const list=S.qs.filter(due).sort((a,b)=> (a.mastery|0)-(b.mastery|0) || (a.due||0)-(b.due||0));
  if(!list.length){ toast('没有待复习的错题'); return; }
  const goal=clamp(+S.settings.goal||5, 1, 200);
  const queue = all ? list : list.slice(0, goal);
  S.review={ queue, idx:0, show:false, done:0, picked:null, typed:'', total:list.length, all:!!all, goal };
  S.tab='review'; buzz(12); render();
  if(!all && list.length>queue.length)
    toast(`今天先做 ${queue.length} 道，后面还排着 ${list.length-queue.length} 道`, 3000);
}
function randomPractice(){
  if(!S.qs.length){ toast('题库还是空的'); return; }
  const pick=S.qs[Math.floor(Math.random()*S.qs.length)];
  S.review={ queue:[pick], idx:0, show:false, done:0, picked:null, typed:'', total:1, all:true, goal:1 };
  S.tab='review'; render();
}
async function grade(quality){
  const q=S.review.queue[S.review.idx];
  if(!q) return;
  const before=q.mastery|0;
  q.reviews=(q.reviews||0)+1;
  q.lastReview=Date.now();
  let promoted=null, demoted=false;

  if(quality===0){
    q.wrong=(q.wrong||0)+1;
    q.ease=Math.max(1.3,(q.ease||2.5)-0.2);
    if(before!==0) demoted=true;
    q.mastery=0; q.interval=0;
  }else if(quality===1){
    q.ease=Math.max(1.3,(q.ease||2.5)-0.06);
    if(before===2){ q.mastery=1; demoted=true; }
    const p=PLAN[q.mastery|0];
    q.interval = clamp(Math.round((q.interval||p.first)*0.5) || p.first, 1, p.max);
  }else{
    q.correct=(q.correct||0)+1;
    q.ease=Math.min(2.9,(q.ease||2.5)+0.07);
    if(before===0){ q.mastery=1; promoted=1; }
    else if(before===1){ q.mastery=2; promoted=2; }
    const p=PLAN[q.mastery|0];
    const base = q.interval ? q.interval*2 : p.first;
    q.interval = clamp(Math.round(base), p.first, p.max);
  }
  const p=PLAN[q.mastery|0];
  q.due = Date.now() + (quality===0 ? 30*60000 : q.interval*DAY);
  q.updatedAt = Date.now();

  await DB.put(q).catch(()=>{});
  LOG.bump(q, quality);                    // 统计页的趋势/热力图全靠这一笔
  const i=S.qs.findIndex(x=>x.id===q.id); if(i>=0) S.qs[i]=q;

  S.review.done++;
  S.review.idx++;
  S.review.show=false;
  S.review.picked=null;
  S.review.typed='';
  if(S.review.idx>=S.review.queue.length) S.review.queue=[];

  buzz(quality===0?24:12);
  if(promoted===1) toast('判 △ 半熟 · 间隔 '+PLAN[1].first+' 天');
  if(promoted===2){ toast('判 ◯ 已攻克 · 间隔 '+q.interval+' 天', 2000); celebrate(); }
  if(demoted)      toast('判 ✕ 回到待攻克 · 30 分钟后再见', 2200);
  render();
  schedulePush();
}

/* ------------------------------------------------------------ 统计 */
/* 从 :root 读色值，整体换肤（浅色/深色）时图表自动跟着走，不用改两处 */
function cssv(n, dflt){
  const v=getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  return v || dflt || '#888';
}
/* 近 N 天，按学科拆出每天的正确率。当天没做题 → rate=null（断线，不画假数据） */
function trendData(days){
  const out={};
  SUBJ_KEYS.forEach(k=>out[k]=[]);
  for(let i=days-1;i>=0;i--){
    const ts=today()-i*DAY, d=LOG.data[dayKey(ts)];
    SUBJ_KEYS.forEach(k=>{
      const s=(d && d.subj) ? d.subj[k] : null;
      out[k].push({ n:(s&&s.n)||0, rate:(s && s.n) ? s.c/s.n : null, ts });
    });
  }
  return out;
}
function ViewStats(){
  const qs=S.qs, total=qs.length;
  const m=[0,0,0]; qs.forEach(q=>m[q.mastery|0]++);
  const t=total||1;

  /* —— 打卡热力图：13 周 × 7 天，周一打头 —— */
  const WEEKS=13, t0=today();
  const dow=(new Date(t0).getDay()+6)%7;
  const startOf=t0-(dow+(WEEKS-1)*7)*DAY;
  const heat=[], mon=[];
  for(let w=0;w<WEEKS;w++){
    const wkStart=startOf+w*7*DAY;
    /* 这一周里出现 1 号，就在那一列上标那个「1 号所在的月份」。
       早先写成取周一所在月，结果整排标签都差了一个月。 */
    let first=null;
    for(let k=0;k<7;k++){
      const d=new Date(wkStart+k*DAY);
      if(d.getDate()===1){ first=d; break; }
    }
    mon.push(first ? (first.getMonth()+1)+'月' : '');
    for(let k=0;k<7;k++){
      const ts=wkStart+k*DAY, d=LOG.data[dayKey(ts)];
      const n=d?d.n:0;
      heat.push({ ts, n, future: ts>t0 });
    }
  }
  /* 色阶按「当前这段时间里最忙的那天」归一化，不写死 3/6/10 这种绝对阈值 ——
     写死的话，一天复习 20 道的用户整张图全是黑洞，一天复习 2 道的用户全是浅绿，
     热力图就失去意义了。这里把最大值切成 4 档：1/4、2/4、3/4、满。 */
  const heatMax = heat.reduce((a,x)=> x.future? a : Math.max(a, x.n), 0);
  heat.forEach(x=>{
    if(!x.n){ x.lv=0; return; }
    x.lv = heatMax<=1 ? 4 : clamp(Math.ceil(x.n / heatMax * 4), 1, 4);
  });
  const streak=LOG.streak(), best=LOG.best(), logDays=LOG.days();

  /* —— 知识点错因归因：一道题有几个标签就在几个标签上各记一笔 —— */
  const tagMap={};
  qs.forEach(q=>{
    const names=(q.tags && q.tags.length) ? q.tags : ['未归类'];
    names.forEach(nm=>{
      const o=tagMap[nm] || (tagMap[nm]={ name:nm, wrong:0, rev:0, done:0 });
      o.wrong += q.wrong|0;
      o.rev   += q.reviews|0;
      if((q.mastery|0)===2) o.done++;
    });
  });
  const rank=Object.values(tagMap).filter(x=>x.wrong>0)
    .sort((a,b)=> b.wrong-a.wrong || b.rev-a.rev || b.done-a.done).slice(0,8);
  const maxWrong=rank.length ? rank[0].wrong : 1;

  /* —— 近 7 天复习量 —— */
  const last7=[];
  for(let i=6;i>=0;i--){
    const ts=today()-i*DAY, d=LOG.data[dayKey(ts)];
    last7.push({ label:`${new Date(ts).getMonth()+1}/${new Date(ts).getDate()}`, v: d?d.n:0 });
  }
  const maxV=Math.max(1,...last7.map(x=>x.v));
  const week=last7.reduce((a,b)=>a+b.v,0);

  return `<div class="page">
    <div class="sec-title" style="margin-top:8px"><h3>连续打卡</h3>
      <span class="hint">当前 ${streak} 天 · 最长 ${best} 天 · 共 ${logDays} 天</span></div>
    <div class="card rise" style="--i:0">
      ${logDays ? `
      <div class="heat-mon">${mon.map(x=>`<span>${x}</span>`).join('')}</div>
      <div class="heat">${heat.map(c=>`<i class="h${c.lv}${c.future?' f':''}${c.ts===t0?' td':''}" title="${c.n? dayKey(c.ts)+' · 复习 '+c.n+' 次' : dayKey(c.ts)+' · 无记录'}"></i>`).join('')}</div>
      <div class="heat-leg"><span>少</span><i class="h0"></i><i class="h1"></i><i class="h2"></i><i class="h3"></i><i class="h4"></i><span>多</span></div>`
      : `<div class="hint-line">还没有复习记录。做完今天那几道，这里就会一格格亮起来。</div>`}
    </div>

    <div class="sec-title"><h3>掌握度分布</h3></div>
    <div class="card rise" style="--i:1"><div class="chart-wrap">
      <canvas id="donut" width="150" height="150" style="width:132px;height:132px;flex:0 0 auto"></canvas>
      <div class="legend">
        <div><i style="background:var(--aka)"></i>待攻克 <b>${m[0]}</b> 道</div>
        <div><i style="background:var(--kari)"></i>半熟 <b>${m[1]}</b> 道</div>
        <div><i style="background:var(--shu)"></i>已攻克 <b>${m[2]}</b> 道</div>
        <div style="color:var(--ink-4);font-size:11.5px;margin-top:2px">掌握率 <b style="color:var(--shu)">${Math.round(m[2]/t*100)}%</b></div>
      </div>
    </div></div>

    <div class="sec-title"><h3>错得最多的知识点</h3>
      <span class="hint">按累计错题次数排序</span></div>
    <div class="card rise" style="--i:2">
      ${rank.length ? rank.map(r=>`<div class="rank-row">
        <div class="rk-top"><span class="rk-name">${esc(r.name)}</span><span class="rk-num"><b>${r.wrong}</b> 次</span></div>
        <div class="progress" style="margin:0"><i data-bar="${Math.round(r.wrong/maxWrong*100)}" style="background:var(--aka)"></i></div>
        <div class="rk-sub">共复习 ${r.rev} 次 · 其中 ${r.done} 道已攻克</div>
      </div>`).join('')
      : `<div class="hint-line">还没有带标签的错题被判过。AI 识题会自动打标签，之后再回来看这里。</div>`}
    </div>

    <div class="sec-title"><h3>近 14 天正确率</h3>
      <span class="hint">${SUBJECTS.map(s=>`<i class="lg-dot" style="background:${s.c}"></i>${s.n}`).join('')}</span></div>
    <div class="card rise" style="--i:3">
      <canvas id="trend" style="width:100%;height:158px;display:block"></canvas>
    </div>

    <div class="sec-title"><h3>近 7 天复习量</h3>
      <span class="hint">本周 ${week} 次</span></div>
    <div class="card rise" style="--i:4"><div class="bars">
      ${last7.map(x=>`<div class="b"><div class="col" data-h="${Math.max(5, x.v/maxV*100)}"><span>${x.v||''}</span></div><em>${x.label}</em></div>`).join('')}
    </div></div>

    <div class="sec-title"><h3>学科分布</h3>
      <span class="hint">共 ${total} 道</span></div>
    <div class="card rise" style="--i:5">
      ${SUBJECTS.map(s=>{
        const c=qs.filter(q=>q.subject===s.k).length;
        const p=Math.round(c/t*100);
        return `<div style="margin-bottom:13px">
          <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:6px">
            <span style="letter-spacing:.08em;font-weight:650">${s.n}</span>
            <span style="color:var(--ink-4)">${c} 道 · ${p}%</span></div>
          <div class="progress" style="margin:0"><i data-bar="${p}" style="background:${s.c}"></i></div>
        </div>`;
      }).join('')}
      <div style="display:flex;gap:9px;margin-top:16px">
        ${PLAN.map((p,i)=>`<div style="flex:1;text-align:center;padding:11px 6px;border:1px solid var(--line);border-radius:var(--r)">
          <div style="font-size:19px;font-weight:700;color:${['var(--aka)','var(--kari)','var(--shu)'][i]}">${m[i]}</div>
          <div style="font-size:10.5px;color:var(--ink-4);margin-top:3px;letter-spacing:.06em">${p.ico} ${p.name}</div>
        </div>`).join('')}
      </div>
    </div>
  </div>`;
}
function drawStats(){
  drawDonut();
  drawTrend();
}
function drawDonut(){
  const cv=$('#donut'); if(!cv) return;
  const dpr=window.devicePixelRatio||1, SZ=150;
  cv.width=SZ*dpr; cv.height=SZ*dpr;
  const c=cv.getContext('2d'); c.scale(dpr,dpr);
  const m=[0,0,0]; S.qs.forEach(q=>m[q.mastery|0]++);
  const tot=m[0]+m[1]+m[2];
  const cols=[cssv('--aka'),cssv('--kari'),cssv('--shu')];
  const cx=75, cy=75, R=60, w=16;
  const t0=performance.now();
  function frame(t){
    const p=Math.min(1,(t-t0)/900), e=1-Math.pow(1-p,3);
    c.clearRect(0,0,SZ,SZ);
    c.lineWidth=w; c.lineCap='butt';
    if(!tot){
      c.strokeStyle=cssv('--line-2','rgba(0,0,0,.10)'); c.beginPath(); c.arc(cx,cy,R,0,Math.PI*2); c.stroke();
      c.fillStyle=cssv('--ink-4'); c.font='500 11px sans-serif'; c.textAlign='center'; c.fillText('还没有错题',cx,cy+4);
      return;
    }
    let a=-Math.PI/2;
    m.forEach((v,i)=>{
      if(!v) return;
      const ang=(v/tot)*Math.PI*2*e;
      c.strokeStyle=cols[i]; c.beginPath(); c.arc(cx,cy,R,a+0.025,a+Math.max(0.025,ang-0.025)); c.stroke();
      a += (v/tot)*Math.PI*2*e;
    });
    c.fillStyle=cssv('--ink'); c.font='700 24px -apple-system,"PingFang SC",sans-serif'; c.textAlign='center';
    c.fillText(Math.round(tot*e), cx, cy+4);
    c.fillStyle=cssv('--ink-4'); c.font='500 10px sans-serif'; c.fillText('道错题', cx, cy+21);
    if(p<1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
function drawTrend(){
  const cv=$('#trend'); if(!cv) return;
  const dpr=Math.min(window.devicePixelRatio||1, 2);
  const W=Math.max(240, Math.round(cv.clientWidth||320)), H=158;
  const PADL=26, PADR=8, PADT=12, PADB=22;
  cv.width=Math.round(W*dpr); cv.height=Math.round(H*dpr);
  const c=cv.getContext('2d');
  c.setTransform(dpr,0,0,dpr,0,0);
  c.clearRect(0,0,W,H);

  const data=trendData(14);
  const days=data[SUBJ_KEYS[0]].length;
  const iw=W-PADL-PADR, ih=H-PADT-PADB;
  const X=i=> PADL + (days<=1 ? iw/2 : iw*i/(days-1));
  const Y=v=> PADT + ih*(1-v);

  const ink4=cssv('--ink-4'), line=cssv('--line-2','rgba(0,0,0,.1)');
  /* 网格：0 / 50 / 100% */
  c.lineWidth=1; c.font='500 9px -apple-system,"PingFang SC",sans-serif';
  c.textAlign='right'; c.textBaseline='middle';
  [0,.5,1].forEach(v=>{
    const y=Math.round(Y(v))+.5;
    c.strokeStyle=line; c.beginPath(); c.moveTo(PADL,y); c.lineTo(W-PADR,y); c.stroke();
    c.fillStyle=ink4; c.fillText(Math.round(v*100)+'%', PADL-5, y);
  });
  /* 横轴：首、中、末三天 */
  c.textAlign='center'; c.textBaseline='top'; c.fillStyle=ink4;
  [0, Math.floor((days-1)/2), days-1].forEach(i=>{
    const d=new Date(data[SUBJ_KEYS[0]][i].ts);
    c.fillText(`${d.getMonth()+1}/${d.getDate()}`, X(i), H-PADB+6);
  });

  /* 有没有数据？一个点都没有就直接给句话，别画空坐标系 */
  const hasAny=SUBJ_KEYS.some(k=>data[k].some(p=>p.rate!=null));
  if(!hasAny){
    c.fillStyle=ink4; c.font='500 11px -apple-system,"PingFang SC",sans-serif';
    c.textAlign='center'; c.textBaseline='middle';
    c.fillText('近两周还没有判题记录', W/2, PADT+ih/2);
    return;
  }

  SUBJECTS.forEach(s=>{
    const pts=data[s.k];
    const col=s.c;
    /* 折线：碰到「那天没做题」就断一段，不要连出假趋势 */
    c.lineWidth=2.2; c.lineJoin='round'; c.lineCap='round';
    c.strokeStyle=col;
    c.beginPath();
    let open=false;
    pts.forEach((p,i)=>{
      if(p.rate==null){ open=false; return; }
      const x=X(i), y=Y(p.rate);
      if(!open){ c.moveTo(x,y); open=true; } else c.lineTo(x,y);
    });
    c.stroke();
    /* 点：只在真做过题的那天画，半径随当天题量微涨 */
    pts.forEach((p,i)=>{
      if(p.rate==null) return;
      c.fillStyle=col;
      c.beginPath(); c.arc(X(i), Y(p.rate), p.n>=5?3.6:2.6, 0, Math.PI*2); c.fill();
    });
  });
}

/* ------------------------------------------------------------ 事件委托 */
document.addEventListener('click', async e=>{
  /* 底部 tab */
  const tab=e.target.closest('#tabbar button');
  if(tab){
    buzz();
    if(tab.dataset.tab==='add'){ openCaptureSheet(); return; }
    if(S.tab!==tab.dataset.tab){ S.tab=tab.dataset.tab; render(); }
    return;
  }
  /* 扫描台按钮 */
  const st=e.target.closest('[data-st]');
  if(st){
    const a=st.dataset.st;
    if(a==='cancel') studioClose();
    else if(a==='apply') studioApply();
    else if(a==='full'){ ST.box={x:0,y:0,w:ST.dw,h:ST.dh}; syncBox(); }
    else if(a==='rotate'){ rotateStudio(); }
    return;
  }
  const mode=e.target.closest('[data-mode]');
  if(mode){
    ST.mode=mode.dataset.mode; buzz(8);
    $$('#stModes .st-chip').forEach(c=>c.classList.toggle('on', c===mode));
    paintStudio();
    return;
  }

  const el=e.target.closest('[data-act]');
  if(!el) return;
  const act=el.dataset.act, id=el.dataset.id;

  switch(act){
    case 'goto-review': S.tab='review'; render(); break;
    case 'goto-bank':   S.tab='bank';   render(); break;
    case 'goto-home':   S.tab='home';   render(); break;
    case 'goto-stats':  S.tab='stats';  render(); break;
    case 'start-review': startReview(false); break;
    case 'start-review-all': startReview(true); break;
    case 'random-practice': randomPractice(); break;
    case 'reveal': {
      /* 输入框里的作答在 input 事件里已经存进 S.review.typed，
         这里再兜一次 —— WebView 里 blur 时机不一定稳。 */
      const ta=$('#revTyped'); if(ta) S.review.typed=ta.value;
      S.review.show=true; buzz(8); render(); break;
    }
    case 'open': openDetail(id); break;
    case 'close-sheet': closeSheet(); break;
    case 'edit': openEditor(id); break;
    case 'delete': confirmDelete(id); break;
    case 'toggle-mastery': cycleMastery(id); break;
    case 'fan': openFan(id); break;
    case 'fan-again': { const o=FAN.orig; if(o) runFan(o); break; }
    case 'fan-keep': fanKeep(); break;
    case 'save': saveEditor(); break;
    case 'export': exportData(false); break;
    case 'export-zip': exportData(true); break;
    case 'print-weekly': toast('正在排版…'); printWeekly(); break;
    case 'import': $('#importFile') && $('#importFile').click(); break;
    case 'clear-all': clearAll(); break;
    case 'persist': requestPersist(); break;
    case 'capture': pickImage('camera'); break;
    case 'album': pickImage('album'); break;
    case 'new': openEditor(null); break;
    case 'opt-add': addOpt(); break;
    case 'ai-retry': runAI(); break;
    case 'ai-cancel': {
      AI.abort(); aiBusy=false;
      const v=$('#aiVeil'); if(v) v.classList.remove('on');
      toast('已跳过，手动填几笔也一样');
      break;
    }
    case 'zoom': {
      const im = el.tagName==='IMG' ? el : el.querySelector('img');
      if(im && im.src) openLightbox(im.src);
      break;
    }
    case 'lb-close': closeLightbox(); break;
    /* 共享同步 */
    case 'sync-now': syncDown(); break;
    case 'sync-push': syncUp(); break;
    /* 自绘确认框（WebView 里 window.confirm 不可靠） */
    case 'confirm-yes': { const cb=confirmCb; confirmCb=null; closeSheet(); if(cb) cb(); break; }
    case 'confirm-no':  { confirmCb=null; closeSheet(); break; }
  }
});
document.addEventListener('click', e=>{
  /* 选择题：点一个选项就记下来（对答案前还能改） */
  const op=e.target.closest('[data-pick]');
  if(op && !op.disabled){
    S.review.picked = op.dataset.pick;
    buzz(10); render();
    return;
  }
  const g=e.target.closest('[data-grade]');
  if(g) grade(+g.dataset.grade);
});
/* 复习卡里「先写一遍」的作答，输入即存，切题/重建都不会丢 */
document.addEventListener('input', e=>{
  if(e.target.id==='revTyped') S.review.typed = e.target.value;
});
/* 扫描台滑块 */
document.addEventListener('input', e=>{
  if(e.target.id==='stBright'){ ST.bright=+e.target.value; schedulePaint(); }
  if(e.target.id==='stContrast'){ ST.cont=+e.target.value; schedulePaint(); }
});
window.addEventListener('resize', ()=>{ if(ST.open){ layoutStudio(); syncBox(); } });

function rotateStudio(){
  const src=ST.src;
  const c=document.createElement('canvas'); c.width=src.height; c.height=src.width;
  const ctx=c.getContext('2d');
  ctx.translate(c.width/2,c.height/2); ctx.rotate(Math.PI/2);
  ctx.drawImage(src,-src.width/2,-src.height/2);
  ST.src=c; ST.prev=downscale(c,1400);
  layoutStudio(); defaultBox(); flashScan();
}

/* ------------------------------------------------------------ 浮层 */
/* 每个浮层都必须有明确出口，三条路都通：
   ① 右上角 ×（由 openSheet 统一注入，各页面不必自己写）
   ② 点遮罩空白
   ③ 手机系统返回键（用 history 承接，不会直接退出应用） */
let sheetLayer=false, suppressPop=false;

function openSheet(html){
  const sh=$('#sheet');
  sh.innerHTML = `<div class="handle"></div>
    <div class="sheet-x"><button data-act="close-sheet" aria-label="关闭">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
      <span>关闭</span>
    </button></div>` + html;
  sh.scrollTop=0;
  $('#mask').classList.add('on'); sh.classList.add('on');
  if(!sheetLayer){ sheetLayer=true; try{ history.pushState({wbSheet:1},''); }catch(e){} }
}
function hideSheet(){ $('#mask').classList.remove('on'); $('#sheet').classList.remove('on'); }
function closeSheet(){
  hideSheet();
  try{ FAN.abort(); }catch(e){}
  if(sheetLayer){ sheetLayer=false; suppressPop=true; try{ history.back(); }catch(e){ suppressPop=false; } }
}
$('#mask').addEventListener('click', closeSheet);
window.addEventListener('popstate', ()=>{
  if(suppressPop){ suppressPop=false; return; }
  if(LB.open){ LB.layer=false; hideLightbox(); return; }
  if($('#sheet').classList.contains('on')){ sheetLayer=false; hideSheet(); return; }
});

/* ------------------------------------------------- 题图灯箱（点开放大看）
   拍照题图在详情页只占一小块，小字看不清。点开进全屏，支持捏合与双击。 */
const LB = { open:false, layer:false, scale:1, tx:0, ty:0, iw:0, ih:0,
  ptr:new Map(), base:{scale:1,tx:0,ty:0,sx:0,sy:0}, dist:0, moved:false, lastTap:0 };
function lbApply(){
  const img=$('#lbImg'); if(!img) return;
  LB.scale=clamp(LB.scale, 1, lbMaxScale());
  img.style.transform=`translate(${LB.tx}px,${LB.ty}px) scale(${LB.scale})`;
  $('#lightbox').classList.toggle('zoomed', LB.scale>1.02);
}
/* 放大上限按原图分辨率算：从相册选来的 600px 截图放大 2.6 倍只会更糊，
   所以最多放到「一个物理像素铺两个 CSS 像素」，再大纯属看马赛克。 */
function lbMaxScale(){
  const img=$('#lbImg'); if(!img) return 2.5;
  const nat=img.naturalWidth||0, shown=img.offsetWidth||0;
  if(!nat || !shown) return 2.5;
  return clamp(nat/shown*2, 1.4, 6);
}
function lbClamp(){
  const img=$('#lbImg'); if(!img) return;
  const bw=img.offsetWidth||1, bh=img.offsetHeight||1;
  const mx=Math.max(0, bw*(LB.scale-1)/2), my=Math.max(0, bh*(LB.scale-1)/2);
  LB.tx=clamp(LB.tx,-mx,mx); LB.ty=clamp(LB.ty,-my,my);
}
function openLightbox(src){
  const el=$('#lightbox'), img=$('#lbImg');
  if(!el||!img||!src) return;
  img.src=src;
  LB.scale=1; LB.tx=0; LB.ty=0; LB.ptr.clear(); LB.moved=false; LB.lastTap=0; LB.dist=0;
  img.style.transform='translate(0,0) scale(1)';
  el.classList.add('on'); el.classList.remove('zoomed');
  el.setAttribute('aria-hidden','false');
  LB.open=true;
  if(!LB.layer){ LB.layer=true; try{ history.pushState({wbLB:1},''); }catch(e){} }
}
function hideLightbox(){
  const el=$('#lightbox'); if(!el) return;
  el.classList.remove('on'); el.setAttribute('aria-hidden','true');
  LB.open=false; LB.scale=1; LB.tx=0; LB.ty=0; LB.ptr.clear();
}
function closeLightbox(){
  hideLightbox();
  if(LB.layer){ LB.layer=false; suppressPop=true; try{ history.back(); }catch(e){ suppressPop=false; } }
}
(function bindLightbox(){
  const el=$('#lightbox'), img=$('#lbImg');
  if(!el||!img) return;
  const mid=()=>{ let x=0,y=0,n=0; LB.ptr.forEach(p=>{x+=p.x;y+=p.y;n++;}); return {x:x/(n||1),y:y/(n||1)}; };
  const gap=()=>{ const a=Array.from(LB.ptr.values()); if(a.length<2) return 0;
    return Math.hypot(a[0].x-a[1].x, a[0].y-a[1].y); };
  el.addEventListener('pointerdown', e=>{
    if(!LB.open) return;
    el.setPointerCapture && el.setPointerCapture(e.pointerId);
    LB.ptr.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(LB.ptr.size===2){ LB.dist=gap(); LB.base={scale:LB.scale,tx:LB.tx,ty:LB.ty,sx:0,sy:0}; LB.moved=true; }
    else if(LB.ptr.size===1){ LB.base={scale:LB.scale,tx:LB.tx,ty:LB.ty,sx:e.clientX,sy:e.clientY}; LB.moved=false; }
    el.classList.add('dragging');
  });
  el.addEventListener('pointermove', e=>{
    const p=LB.ptr.get(e.pointerId); if(!p||!LB.open) return;
    p.x=e.clientX; p.y=e.clientY;
    if(LB.ptr.size>=2){
      if(LB.dist>1){ LB.scale=clamp(LB.base.scale*(gap()/LB.dist),1,lbMaxScale()); }
      lbClamp(); lbApply();
    }else if(LB.scale>1.01){
      LB.tx=LB.base.tx+(e.clientX-LB.base.sx);
      LB.ty=LB.base.ty+(e.clientY-LB.base.sy);
      if(Math.abs(e.clientX-LB.base.sx)>7||Math.abs(e.clientY-LB.base.sy)>7) LB.moved=true;
      lbClamp(); lbApply();
    }
  });
  /* 单/双击判定走标准做法：第一次抬手起 260ms 定时器，
     窗口内等来第二次就清掉定时器执行双击 —— 不靠两个时间戳互相追 */
  let tapTimer=0;
  const end=e=>{
    if(!LB.ptr.has(e.pointerId)) return;
    LB.ptr.delete(e.pointerId);
    if(LB.ptr.size<2) LB.dist=0;
    if(LB.ptr.size===1){ const q=Array.from(LB.ptr.values())[0];
      LB.base={scale:LB.scale,tx:LB.tx,ty:LB.ty,sx:q.x,sy:q.y}; }
    if(LB.ptr.size===0) el.classList.remove('dragging');
    if(LB.moved) return;
    if(e.target.closest && e.target.closest('.lb-x')) return;
    if(tapTimer){                       // 这就是第二下 → 双击
      clearTimeout(tapTimer); tapTimer=0;
      if(LB.scale>1.02){ LB.scale=1; LB.tx=0; LB.ty=0; }
      else { LB.scale=Math.min(lbMaxScale(), 2.6); }
      lbApply();
      return;
    }
    tapTimer=setTimeout(()=>{ tapTimer=0; if(LB.open) closeLightbox(); }, 260);
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  /* 桌面端滚轮缩放 */
  el.addEventListener('wheel', e=>{
    if(!LB.open) return;
    e.preventDefault();
    LB.scale=clamp(LB.scale*(e.deltaY<0?1.12:0.89), 1, lbMaxScale());
    lbClamp(); lbApply();
  }, { passive:false });
})();

/* 自绘确认框：WebView 里 window.confirm 常被忽略（返回 false），
   会让「删除 / 清空」这类操作静默失效，所以一律用页内确认。 */
let confirmCb=null;
function askConfirm(o){
  o = o || {};
  confirmCb = o.onOk || null;
  openSheet(`
    <h2>${esc(o.title||'确认')}</h2>
    ${o.body? `<div class="sub-h" style="margin-bottom:16px">${esc(o.body)}</div>`:''}
    <div class="row2">
      <button class="btn" data-act="confirm-no">取消</button>
      <button class="btn ${o.danger===false?'primary':'danger'}" data-act="confirm-yes">${esc(o.ok||'确定')}</button>
    </div>
  `);
}

/* ------------------------------------------------------------ 详情 */
function openDetail(id){
  const q=S.qs.find(x=>x.id===id); if(!q) return;
  const s=subj(q.subject), p=PLAN[q.mastery|0];
  openSheet(`
    <h2>${s.n} <span class="tag m${q.mastery}">${p.ico} ${MAST[q.mastery]}</span></h2>
    <div class="sub-h">${DIFF[q.difficulty]||'中等'} · 复习 ${q.reviews||0} 次 · 错 ${q.wrong||0} 次 · ${fmtDate(q.createdAt)} 捕获</div>

    <div class="card" style="margin-bottom:14px">
      <div style="font-size:15.5px;line-height:1.95;overflow-wrap:break-word">${splitParas(q.content||'（图片题）')}</div>
      ${qHasImg(q)? `<div class="shot zoomable" data-act="zoom" style="margin-top:12px">
        <img src="${esc(qImg(q))}" alt="题图">
        <span class="shot-tip">点一下看大图</span>
      </div>`:''}
    </div>

    ${q.answer? `<div class="field"><label>答案</label>
      <div class="card" style="font-size:14.5px;overflow-wrap:break-word">${splitParas(q.answer)}</div></div>`:''}
    ${q.analysis? `<div class="field"><label>解析 / 错因</label>
      <div class="card" style="font-size:14px;color:var(--ink-2);overflow-wrap:break-word">${splitParas(q.analysis)}</div></div>`:''}

    ${(q.tags||[]).length? `<div style="display:flex;gap:7px;flex-wrap:wrap;margin:2px 0 16px">
      ${q.tags.map(t=>`<span class="tag">#${esc(t)}</span>`).join('')}</div>`:''}

    <div class="rail" style="margin-top:2px">
      <div class="rail-lab"><b>掌握度</b><span>点一下可手动调整</span></div>
      <div class="mastery-rail">
        ${PLAN.map((pp,i)=>`
          <div class="mslot m${i} ${i===q.mastery?'on':''}" data-act="toggle-mastery" data-id="${q.id}" data-ms="${i}" style="cursor:pointer">
            <div class="mi ${i<(q.mastery|0)?'done':''}">${pp.ico}</div>
            <div class="mn">${pp.name}</div>
            <div class="md">${pp.note}</div>
          </div>`).join('')}
      </div>
      <div style="font-size:11.5px;color:var(--ink-3);margin-top:10px;line-height:1.6">
        下一道复习：${q.due&&q.due>Date.now()? fmtDate(q.due) : '现在'}。
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:16px">
      <button class="btn" data-act="edit" data-id="${q.id}">编辑</button>
      <button class="btn" data-act="goto-review">现在练</button>
    </div>
    <button class="btn block fan-entry" style="margin-top:10px" data-act="fan" data-id="${q.id}">举一反三 · 让 AI 出同类题</button>
    <button class="btn danger block" style="margin-top:10px" data-act="delete" data-id="${q.id}">删除这道错题</button>
  `);
  const rail=$('#sheet .mastery-rail');
  if(rail){
    rail.onclick=e=>{
      const slot=e.target.closest('[data-ms]'); if(!slot) return;
      setMastery(q.id, +slot.dataset.ms);
    };
  }
}
async function setMastery(id, ms){
  const q=S.qs.find(x=>x.id===id); if(!q) return;
  q.mastery=clamp(ms,0,2);
  q.interval = PLAN[q.mastery].first;
  q.due = Date.now();
  q.updatedAt=Date.now();
  await DB.put(q).catch(()=>{});
  buzz(12); render(); openDetail(id);
  toast('已设为「'+MAST[q.mastery]+'」');
  schedulePush();
}
async function cycleMastery(id){
  const q=S.qs.find(x=>x.id===id); if(!q) return;
  await setMastery(id, ((q.mastery|0)+1)%3);
}
function confirmDelete(id){
  askConfirm({
    title:'删除这道错题？',
    body:'删掉之后就找不回来了。',
    ok:'删除',
    onOk: async ()=>{
      const q=S.qs.find(x=>x.id===id);
      if(q && q.imageId) IMG.del(q.imageId);
      await DB.del(id).catch(()=>{});
      S.qs=S.qs.filter(x=>x.id!==id);
      render(); toast('已删除');
      schedulePush();
    },
  });
}

/* ------------------------------------------------------- 捕获 / 编辑器 */
let editing=null, editImg=null, editImgId=null, editTags=[], aiBusy=false;
/* 当独立图片库写不进去时的降级图：一张 dataURL，随题目记录一起存。
   正常路径下它恒为 null，只在老内核/配额极紧时才用上。 */
let editInlineImage=null;
let editType='solve', editOpts=[];
function defaultOpts(){
  return OPT_K.slice(0,4).map(k=>({ k, t:'' }));
}

function openCaptureSheet(){
  openSheet(`
    <h2>添加一道错题</h2>
    <div class="sub-h">拍下题目，AI 自动认学科、定难度、挑知识点。</div>
    <div class="shot-pair" style="margin-bottom:9px">
      <button class="btn primary" data-act="capture">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M3.6 8.6h3l1.6-2.4h7.6l1.6 2.4h3v10.2h-16.8z"/><circle cx="12" cy="13.5" r="3.3"/></svg>拍照
      </button>
      <button class="btn" data-act="album">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="14" rx="2.2"/><circle cx="8.7" cy="10" r="1.5"/><path d="M4.6 17.2l4.7-4.4 3.3 2.9 2.6-2.2 4.2 3.7"/></svg>从图库选
      </button>
    </div>
    <div class="sub-h" style="margin:0 0 15px">拍照直接开相机；从图库选适合用别处拍好的截图</div>
    <button class="btn block ghost" data-act="new">手动录入</button>
  `);
}
/* 两种取图方式各走各的 input：camera 带 capture，album 不带 */
function pickImage(kind){
  const keepId = (editing && editing.id) ? editing.id : null;
  const inp=document.createElement('input');
  inp.type='file'; inp.accept='image/*';
  if(kind==='camera') inp.setAttribute('capture','environment');
  inp.style.display='none';
  document.body.appendChild(inp);
  const cleanup=()=>{ try{ inp.remove(); }catch(e){} };
  inp.onchange=async ()=>{
    const f=inp.files && inp.files[0];
    if(!f){ cleanup(); return; }
    toast(kind==='camera'?'照片处理中…':'图片读取中…', 1200);
    try{
      const canvas=await Promise.race([
        loadImageFile(f),
        new Promise((_,rej)=>setTimeout(()=>rej(new Error('img-timeout')), 15000)),
      ]);
      cleanup(); closeSheet();
      studioOpen(canvas, async (blob)=>{
        let imgId=null, inline=null;
        try{ imgId = await IMG.put(blob); }
        catch(e){
          const k=idbErrKind(e);
          console.warn('img put', e);
          /* 写不进独立图片库时，退一步把图内联进题目记录。
             题目记录 q 是纯 JSON（字符串/数字/数组），任何内核都能写；
             内联图只是更占地方，但「拍完能存下来」比「省空间」重要得多。
             用户完全不必知道背后换了条路 —— 他只看到图进来了。 */
          try{
            inline = await blobToDataURL(blob);
          }catch(e2){ inline=null; }
          if(inline){
            openEditor(keepId, inline, null);
            editInlineImage = inline;          // saveEditor 会把它落进 q.image
            setTimeout(()=>runAI(), 280);
            if(k==='quota') toast('存储紧张，这张图先随题目一起存了', 3000);
            return;
          }
          if(k==='quota'){
            const q=await IMG.quota();
            const free=q? Math.max(0,(q.quota-q.usage)/1048576).toFixed(0) : null;
            toast(free!=null
              ? `本机存储满了（只剩 ${free} MB），去设置里「导出含图备份」后清掉几道老题`
              : '本机存储满了，先导出备份再清掉几道老题', 4200);
          }else if(k==='conn'){
            toast('本地库刚被系统回收，已经重开，再点一次就好', 3000);
          }else{
            toast('这台设备暂时存不了图，可以先把题干录进去', 3600);
          }
          return;
        }
        openEditor(keepId, IMG.url(imgId), imgId);
        setTimeout(()=>runAI(), 280);
      });
    }catch(err){
      cleanup();
      console.warn(err);
      const big = err && (err.message==='img-timeout' || err.message==='img-large');
      toast(big? '这张图太大了，换一张小一点的' : '这张图读不出来，换一张试试', 2400);
    }
  };
  inp.click();
}

function openEditor(id, presetUrl, presetId){
  const q = id ? S.qs.find(x=>x.id===id) : null;
  editing = q ? {...q} : null;
  editImgId = presetId || (q && q.imageId) || null;
  editImg = presetUrl || (editImgId ? IMG.url(editImgId) : '') || null;
  /* 没走「独立图库」这条路时，图上哪儿来？答：编辑态里已经带了内联图
     （pickImage 的降级分支刚设的），或者这是条老记录、图本来就在 q.image 里。
     两者都要认，否则一进编辑器图就没了 —— 那正是「图片存不进去」的观感。 */
  if(!editImgId && (editInlineImage || (q && q.image))) editImg = editInlineImage || (q && q.image);
  editTags = q ? [...(q.tags||[])].slice() : [];
  editType = q ? (q.type||'solve') : 'solve';
  editOpts = q && q.options && q.options.length ? q.options.map(o=>({...o})) : defaultOpts();
  const s = q? q.subject : 'math';
  const d = q? (q.difficulty||2) : 2;
  const m = q? (q.mastery|0) : 0;

  openSheet(`
    <h2>${q? '编辑错题':'添加错题'}</h2>
    <div class="sub-h">${q? '数据只存在这台设备上':'AI 已自动填好，你只需核对'}</div>
    <div class="ai-tutor" id="aiTutor" hidden>
      <b>AI 填好了，先核对再保存</b>
      <span>学科、题干、答案、解析都可能看错，对着原题改一遍；确认没问题，点最下面的「${q? '保存修改':'添加错题'}」就收进题库。</span>
    </div>

    <div class="field">
      <label>题图 <span class="ai-dot" id="aiBadge" style="display:none">AI 已识别</span></label>
      ${editImg? `
        <div class="shot zoomable" data-act="zoom">
          <img src="${editImg}" alt="题图">
          <span class="shot-tip">已添加 · 点开看大图</span>
        </div>
        <div class="shot-pair" style="margin-top:9px">
          <button class="btn" data-act="capture">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M3.6 8.6h3l1.6-2.4h7.6l1.6 2.4h3v10.2h-16.8z"/><circle cx="12" cy="13.5" r="3.3"/></svg>重新拍照
          </button>
          <button class="btn" data-act="album">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="14" rx="2.2"/><circle cx="8.7" cy="10" r="1.5"/><path d="M4.6 17.2l4.7-4.4 3.3 2.9 2.6-2.2 4.2 3.7"/></svg>从图库选
          </button>
        </div>`:`
        <div class="shot-empty"><b>还没有题图</b>用下面任一方式加一张</div>
        <div class="shot-pair" style="margin-top:9px">
          <button class="btn primary" data-act="capture">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M3.6 8.6h3l1.6-2.4h7.6l1.6 2.4h3v10.2h-16.8z"/><circle cx="12" cy="13.5" r="3.3"/></svg>拍照
          </button>
          <button class="btn" data-act="album">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="14" rx="2.2"/><circle cx="8.7" cy="10" r="1.5"/><path d="M4.6 17.2l4.7-4.4 3.3 2.9 2.6-2.2 4.2 3.7"/></svg>从图库选
          </button>
        </div>`}
    </div>

    <div class="field">
      <label>学科</label>
      <div class="seg sm" id="segSubj">
        <span class="seg-thumb"></span>
        ${SUBJECTS.map(x=>`<button data-v="${x.k}" class="${x.k===s?'on':''}">${x.n}</button>`).join('')}
      </div>
    </div>

    <div class="field"><label>题干</label>
      <textarea id="f_content" placeholder="AI 会自动转写，也可以自己写…">${esc(q?.content||'')}</textarea></div>

    <div class="field">
      <label>题型</label>
      <div class="seg sm" id="segType">
        <span class="seg-thumb"></span>
        ${[['choice','选择题'],['fill','填空题'],['solve','解答题']].map(([k,n])=>
          `<button data-v="${k}" class="${k===editType?'on':''}">${n}</button>`).join('')}
      </div>
    </div>

    <div class="field" id="optField" style="${editType==='choice'?'':'display:none'}">
      <label>选项 <span style="font-weight:400;color:var(--ink-4)">做选择题时能直接点 ABCD</span></label>
      <div id="optBox"></div>
      <button class="btn ghost block" style="margin-top:9px;font-size:13px" data-act="opt-add">＋ 加一个选项</button>
    </div>

    <div class="field"><label>正确答案</label>
      <textarea id="f_answer" placeholder="${editType==='choice'?'填字母，如 B':'标准答案…'}">${esc(q?.answer||'')}</textarea></div>

    <div class="field"><label>解析 / 错因（可选）</label>
      <textarea id="f_analysis" placeholder="为什么会错？正确思路是什么？">${esc(q?.analysis||'')}</textarea></div>

    <div class="field">
      <label>难度</label>
      <div class="seg sm" id="segDiff">
        <span class="seg-thumb"></span>
        <button data-v="1" class="${d===1?'on':''}">简单</button>
        <button data-v="2" class="${d===2?'on':''}">中等</button>
        <button data-v="3" class="${d===3?'on':''}">困难</button>
      </div>
    </div>

    <div class="field"><label>知识点标签</label>
      <div class="tags-box" id="tagsBox">
        ${editTags.map(t=>tagChip(t)).join('')}
        <input id="tagInput" placeholder="输入后回车" autocomplete="off">
      </div></div>

    <div class="rail" style="margin-top:20px">
      <div class="rail-lab"><b>当前掌握度</b><span>答对两次会自动升级</span></div>
      <div class="mastery-rail" id="edMast">
        ${PLAN.map((p,i)=>`
          <div class="mslot m${i} ${i===m?'on':''}" data-ms="${i}" style="cursor:pointer">
            <div class="mi">${p.ico}</div>
            <div class="mn">${p.name}</div>
            <div class="md">${p.note}</div>
          </div>`).join('')}
      </div>
    </div>

    <button class="btn primary block" data-act="save" style="margin-top:20px;padding:15px;font-size:15px">
      ${q? '保存修改':'添加错题'}
    </button>
    ${q? '<button class="btn danger block" style="margin-top:10px" data-act="delete" data-id="'+q.id+'">删除</button>':''}
    <button class="btn ghost block" style="margin-top:10px" id="btnReAI">AI 重新识别</button>
  `);

  segInit('#segSubj');
  segInit('#segDiff');
  segInit('#segType');
  paintOptEditor();
  /* 切题型：解答题不需要选项，切过去就把选项区收起来（数据留着，切回来还在） */
  $$('#segType button').forEach(b=> b.addEventListener('click', ()=>{
    editType = b.dataset.v;
    const f=$('#optField'); if(f) f.style.display = (editType==='choice') ? '' : 'none';
    const a=$('#f_answer');
    if(a) a.placeholder = editType==='choice' ? '填字母，如 B' : '标准答案…';
    if(editType==='choice' && !editOpts.length) { editOpts=defaultOpts(); paintOptEditor(); }
  }));
  $('#edMast').onclick=e=>{
    const sl=e.target.closest('[data-ms]'); if(!sl) return;
    $$('#edMast .mslot').forEach(x=>x.classList.toggle('on', x===sl));
    buzz(10);
  };
  bindOptEditor();
  bindTags();
  $('#btnReAI').onclick=()=>{ if(editImg) runAI(); else toast('先拍一张题图'); };
}
/* 选项录入：一行一个，左边字母固定，右边写内容，右侧 ✕ 删 */
function paintOptEditor(){
  const box=$('#optBox'); if(!box) return;
  box.innerHTML = editOpts.map((o,i)=>`
    <div class="opt-edit" data-oi="${i}">
      <b class="oe-k">${esc(o.k||OPT_K[i]||'')}</b>
      <input class="oe-t" data-oi="${i}" value="${esc(o.t||'')}" placeholder="选项内容">
      ${editOpts.length>2? `<button class="oe-x" data-opt-del="${i}" aria-label="删除">✕</button>`:''}
    </div>`).join('');
}
function bindOptEditor(){
  const box=$('#optBox'); if(!box) return;
  box.addEventListener('input', e=>{
    const inp=e.target.closest('.oe-t'); if(!inp) return;
    const i=+inp.dataset.oi; if(editOpts[i]) editOpts[i].t=inp.value;
  });
  box.addEventListener('click', e=>{
    const del=e.target.closest('[data-opt-del]'); if(!del) return;
    editOpts.splice(+del.dataset.optDel,1);
    editOpts.forEach((o,i)=>{ o.k=OPT_K[i]; });        // 删了中间一个，字母要重排
    paintOptEditor();
  });
}
function addOpt(){
  if(editOpts.length>=6){ toast('最多六个选项'); return; }
  editOpts.push({ k:OPT_K[editOpts.length], t:'' });
  paintOptEditor();
  const inp=$$('#optBox .oe-t').pop(); if(inp) inp.focus();
}
function tagChip(t){
  return `<span class="tg">#${esc(t)}<b data-tag-del="${esc(t)}">×</b></span>`;
}
function bindTags(){
  const box=$('#tagsBox'); if(!box) return;
  const inp=$('#tagInput');
  const add=v=>{
    v=String(v||'').trim().replace(/^#/,'').slice(0,10);
    if(!v || editTags.includes(v) || editTags.length>=6) return;
    editTags.push(v);
    const sp=document.createElement('span'); sp.className='tg';
    sp.innerHTML=`#${esc(v)}<b data-tag-del="${esc(v)}">×</b>`;
    box.insertBefore(sp, inp);
  };
  box.onclick=e=>{
    const del=e.target.closest('[data-tag-del]');
    if(del){ const t=del.dataset.tagDel; editTags=editTags.filter(x=>x!==t); del.parentNode.remove(); }
    else if(e.target===box) inp.focus();
  };
  inp.onkeydown=e=>{
    if(e.key==='Enter'||e.key===','||e.key==='，'){ e.preventDefault(); add(inp.value); inp.value=''; }
    else if(e.key==='Backspace' && !inp.value && editTags.length){
      const t=editTags.pop(); const el=box.querySelector(`[data-tag-del="${CSS.escape(t)}"]`); el && el.parentNode.remove();
    }
  };
  inp.onblur=()=>{ if(inp.value){ add(inp.value); inp.value=''; } };
}

/* 分段控件滑块 */
function segInit(sel){
  const seg=$(sel); if(!seg) return;
  const move=()=>{
    const on=seg.querySelector('button.on') || seg.querySelector('button');
    const th=seg.querySelector('.seg-thumb'); if(!on||!th) return;
    th.style.width=on.offsetWidth+'px';
    th.style.transform=`translateX(${on.offsetLeft-4}px)`;
  };
  seg.addEventListener('click', e=>{
    const b=e.target.closest('button'); if(!b) return;
    seg.querySelectorAll('button').forEach(x=>x.classList.toggle('on', x===b));
    buzz(8); move();
  });
  requestAnimationFrame(move);
  setTimeout(move, 60);
}
function segVal(sel){
  const on=$(sel) && $(sel).querySelector('button.on');
  return on? on.dataset.v : null;
}

/* ---------- AI 执行 ---------- */
async function runAI(){
  if(aiBusy) return;
  if(!editImg){ toast('先拍一张题图'); return; }
  aiBusy=true; AI.cancel=false;
  if(AI.ac){ try{ AI.ac.abort(); }catch(e){} AI.ac=null; }
  const veil=$('#aiVeil'), th=$('#aiThumb');
  if(th){
    th.width=280; th.height=132;
    const img=new Image();
    img.onload=()=>{
      const c=th.getContext('2d'); c.clearRect(0,0,th.width,th.height);
      const r=Math.min(th.width/img.width, th.height/img.height);
      const w=img.width*r, h=img.height*r;
      c.drawImage(img,(th.width-w)/2,(th.height-h)/2,w,h);
    };
    img.src=editImg;
  }
  setAiText('AI 正在读懂这道题…','认学科 · 定难度 · 挑知识点 · 转写题干');
  if(veil) veil.classList.add('on');
  const t1=setTimeout(()=>setAiText('正在提炼知识点…','整理标签与解题思路'),2400);
  const t2=setTimeout(()=>setAiText('快好了…','生成答案与解析'),5200);
  try{
    /* 送增强后的图：先去阴影、提对比、保留彩色，模型才看得清小字。
       分辨率 1600 降到 1280 —— 1280 长边足够看清中学试卷的正文小字，
       但像素量只有 1600 的 64%，本地增强与上传都明显更快；
       实测 1280 对识别准确率没有可见损失，1600 只是徒增等待。 */
    const small=await prepForAI(editImg, 1280, 0.86, true);
    if(!small) throw new Error('decode');
    const r=await Promise.race([
      AI.recognize(small),
      new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')), 38000)),
    ]);
    if(AI.cancel) return;
    if(!r || (!r.subject && !r.question && !r._raw)) throw new Error('parse');
    applyAI(r);
    toast('AI 已经填好了，核对一下', 1800);
  }catch(err){
    const m=String((err&&err.message)||'');
    if(AI.cancel) return;
    console.warn('AI fail', err);
    if(m==='decode') toast('这张图读不出来，换一张试试', 3000);
    else if(m==='parse') toast('AI 没读懂这张图，换个光线重拍，或手动补几笔', 3200);
    else if(m==='cancelled') toast('已跳过');
    else if(m==='timeout') toast('AI 想太久了，先按「AI 重新识别」再来一次', 3200);
    else toast(aiErrMsg(codeOf(err)), 2800);
  }finally{
    clearTimeout(t1); clearTimeout(t2);
    if(veil) veil.classList.remove('on');
    aiBusy=false;
  }
}
function setAiText(a,b){ const e1=$('#aiStat'), e2=$('#aiSub'); if(e1)e1.textContent=a; if(e2)e2.textContent=b; }
/* 压缩必须带超时：图片解码失败时 onload 永不触发，会把 AI 流程卡死。
   doEnhance=true 时顺带做一次保色增强，识别率明显好过原图。 */
function prepForAI(dataUrl, max, q, doEnhance){
  return new Promise(res=>{
    let done=false;
    const fin=v=>{ if(!done){ done=true; res(v); } };
    setTimeout(()=>fin(''), 9000);          // 解码失败时 onload 永不触发，别把流程吊死
    const img=new Image();
    img.crossOrigin='anonymous';
    img.onload=()=>{
      try{
        const r=Math.min(1, max/Math.max(img.width,img.height));
        let c=document.createElement('canvas');
        c.width=Math.max(1,Math.round(img.width*r)); c.height=Math.max(1,Math.round(img.height*r));
        const ctx=c.getContext('2d',{ willReadFrequently:!!doEnhance });
        ctx.imageSmoothingEnabled=true; ctx.imageSmoothingQuality='high';
        ctx.drawImage(img,0,0,c.width,c.height);
        if(doEnhance) c = enhance(c,{ mode:'forAI', cont:26 });
        /* 必须回 dataURL：blob: 地址模型侧取不到 */
        fin(c.toDataURL('image/jpeg', q));
      }catch(e){ fin(''); }
    };
    img.onerror=()=>fin('');
    img.src=dataUrl;
  });
}
/* 选项正文剥前缀：AI 有时把 "A. 10" 整串塞进 t，渲染时按钮里就成了「A  A. 10」。
   只在开头确实是「字母 + 分隔符」时才剥，正文里带字母的（如 "x 的取值"）不碰。 */
function stripOptPrefix(t){
  return String(t||'').replace(/^\s*[（(]?\s*[A-Fa-f]\s*[)）.、．:：]\s*/,'').trim();
}

/* ---------------------------------------------------- 题干清洗
   AI 有两个反复出现的毛病，必须在落库前拦掉，否则用户看到的就是
   「题干里自带 ABCD 选项」和「题干里直接印着答案 (B)」：
     ① 把选项行也抄进了 question —— 详情页/复习页又用 options 渲染一遍，
        于是同一道题出现两份选项（用户说的「有两份题干」）。
     ② 把答案字母带括号写进 question，比如题干末尾多一个「（B）」，
        复习时答案就提前暴露了（用户说的「答案都显示出来了」）。
   这里做保守清洗：只删「整行就是选项」和「独立成串的答案标记」，
   正文里正常出现的字母（如 sinx·cosx）一律不碰。 */
function cleanQuestion(text, opts, answer){
  let s = String(text||'').replace(/\r\n?/g,'\n');
  const keys = (opts||[]).map(o=>String(o.k||'').toUpperCase()).filter(Boolean);
  /* 只有选择题（有选项）才丢选项行 —— 解答题题干里的「(1) 求…」不能碰 */
  if(keys.length){
    const lines = s.split('\n');
    const keep = [];
    for(const ln of lines){
      const t = ln.trim();
      if(!t){ keep.push(ln); continue; }
      /* 整行就是选项：A. / A、 / A) / （A） / (A) / A． 后面跟正文 */
      const m = t.match(/^[（(]?\s*([A-Fa-f])\s*[)）.、．:：]\s*(.*)$/);
      if(m && keys.includes(m[1].toUpperCase())){
        const body = m[2].trim();
        if(body.length>0 && body.length<=300) continue;   // 丢掉整行选项
      }
      keep.push(ln);
    }
    s = keep.join('\n');
  }
  /* 独立成串的答案标记：题干里的「(B)」「（B）」「答案：B」「【答案】B」。
     必须成对括号 + 单个字母，或「答案」二字打头 —— 免得误伤正文。 */
  const A = String(answer||'').toUpperCase().match(/[A-F]/g);
  if(A && A.length){
    const set = [...new Set(A)].join('');
    s = s.replace(new RegExp('[（(]\\s*'+set+'\\s*[)）]','g'), '');       // (B) / （B）
    s = s.replace(new RegExp('(?:答案|正确答案|参考答案)\\s*[:：]?\\s*[（(]?\\s*'+set+'\\s*[)）]?','g'), '');
  }
  /* 清掉被掏空后残留的空行，别留下大段空白 */
  return s.replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}

/* AI 回复没解析成 JSON 时，别把用户扔在一个空表单前面。
   先把能捞的字段用正则刮一遍，剩下的一股脑塞进题干 —— 让他删几句就能用。 */
function salvageFields(raw){
  const s=String(raw||'');
  const pick=k=>{
    const m=s.match(new RegExp('"'+k+'"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"'));
    if(!m) return '';
    try{ return JSON.parse('"'+m[1].replace(/"/g,'\\"')+'"'); }catch(e){ return m[1]; }
  };
  const sub=pick('subject');
  const tags=(()=>{
    const m=s.match(/"tags"\s*:\s*\[([^\]]*)\]/);
    if(!m) return [];
    return m[1].split(',').map(x=>x.replace(/["'\s]/g,'')).filter(Boolean).slice(0,6);
  })();
  /* 选项也试着刮一遍：{"k":"A","t":"..."} 这种成对结构 */
  const options=(()=>{
    const m=s.match(/"options"\s*:\s*\[([\s\S]*?)\]\s*[,}]/);
    if(!m) return [];
    const out=[];
    const re=/"k"\s*:\s*"([A-F])"\s*,\s*"t"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
    let x;
    while((x=re.exec(m[1])) && out.length<8) out.push({ k:x[1], t:stripOptPrefix(x[2].replace(/\\"/g,'"')) });
    return out;
  })();
  /* 兜底语义：连 JSON 骨架都没有，就把整段话当题干（顺手清掉选项行/答案标记） */
  const rawQ = pick('question') || s.replace(/```[a-zA-Z]*/g,'').replace(/[{}\[\]]/g,'').trim();
  const q = cleanQuestion(rawQ, options, pick('answer')).slice(0,1200);
  return {
    subject: SUBJ_KEYS.includes(sub)? sub : '',
    type: TYPES.includes(pick('type')) ? pick('type') : '',
    difficulty: +pick('difficulty') || 0,
    tags, options,
    question: q,
    answer: pick('answer').slice(0,1200),
    analysis: pick('analysis').slice(0,1600),
  };
}
function applyAI(r){
  if(!r) return;
  if(r._raw){
    const s=salvageFields(r._raw);
    if(!s.question && !s.answer){
      toast(r._truncated
        ? '题太长了，AI 写到一半被截断 —— 再点一次「AI 重新识别」，或手动补几笔'
        : 'AI 没读出来，换个光线重拍试试', 3800);
      return;
    }
    applyAI({...s, _salvaged:true});
    toast(r._truncated
      ? '题太长被截断了，已把能认出来的填进去，请重点核对解析'
      : 'AI 格式没对上，原文已经填进题干，删几句就能用', 4000);
    return;
  }
  if(r.subject && SUBJ_KEYS.includes(r.subject)){
    $$('#segSubj button').forEach(b=>b.classList.toggle('on', b.dataset.v===r.subject));
    segInit('#segSubj');
  }
  if(r.difficulty && +r.difficulty>=1 && +r.difficulty<=3){
    $$('#segDiff button').forEach(b=>b.classList.toggle('on', String(b.dataset.v)===String(r.difficulty)));
    segInit('#segDiff');
  }
  /* 题型 + 选项：AI 认出来是选择题就直接把 ABCD 填进表单 */
  const opts = Array.isArray(r.options) ? r.options
    .filter(o=>o && (o.t||o.k)).slice(0,6)
    .map((o,i)=>({ k:String(o.k||OPT_K[i]||'').slice(0,1).toUpperCase() || OPT_K[i],
                   t:stripOptPrefix(String(o.t||'').trim()).slice(0,300) }))
    .filter(o=>o.t) : [];
  const ty = TYPES.includes(r.type) ? r.type : (opts.length ? 'choice' : '');
  if(ty){
    editType = ty;
    if(ty==='choice') editOpts = opts.length ? opts : defaultOpts();
    $$('#segType button').forEach(b=>b.classList.toggle('on', b.dataset.v===ty));
    segInit('#segType');
    paintOptEditor();
  }
  const cEl=$('#f_content'), aEl=$('#f_answer'), anEl=$('#f_analysis');
  /* 题干先清洗：去掉混进来的选项行与答案标记，避免「两份题干 / 答案提前泄露」 */
  const cleanQ = cleanQuestion(r.question, ty==='choice'?opts:[], r.answer);
  if(cleanQ && cEl && !cEl.value.trim()) cEl.value=String(cleanQ).slice(0,1200);
  if(r.answer && aEl && !aEl.value.trim()) aEl.value=String(r.answer).slice(0,1200);
  if(r.analysis && anEl && !anEl.value.trim()) anEl.value=String(r.analysis).slice(0,1600);
  if(Array.isArray(r.tags)){
    const box=$('#tagsBox'), inp=$('#tagInput');
    r.tags.slice(0,6).forEach(t=>{
      const v=String(t).trim().replace(/^#/,'').slice(0,10);
      if(!v || editTags.includes(v) || editTags.length>=6) return;
      editTags.push(v);
      if(box && inp){ const sp=document.createElement('span'); sp.className='tg';
        sp.innerHTML=`#${esc(v)}<b data-tag-del="${esc(v)}">×</b>`; box.insertBefore(sp, inp); }
    });
  }
  const badge=$('#aiBadge'); if(badge) badge.style.display='';
  const tutor=$('#aiTutor'); if(tutor) tutor.hidden=false;
  flashScan();
}
async function saveEditor(){
  const content=($('#f_content')||{}).value ? $('#f_content').value.trim() : '';
  const answer =($('#f_answer') ||{}).value ? $('#f_answer').value.trim()  : '';
  if(!content && !editImgId && !editInlineImage){ toast('至少写点题干或加一张题图'); return; }
  const subjV=segVal('#segSubj') || 'math';
  const diffV=+(segVal('#segDiff') || 2);
  const typeV=segVal('#segType') || editType || 'solve';
  const onSlot=$('#edMast .mslot.on');
  const mastV=onSlot? +onSlot.dataset.ms : 0;

  /* 选择题至少要两个有内容的选项，否则点了也没得选 */
  let opts=[];
  if(typeV==='choice'){
    opts=editOpts.map((o,i)=>({ k:o.k||OPT_K[i], t:String(o.t||'').trim() })).filter(o=>o.t);
    if(opts.length<2){ toast('选择题至少要有两个选项'); return; }
    opts.forEach((o,i)=>{ o.k=OPT_K[i]; });
    if(!answer){ toast('选择题还没填正确答案（填字母，如 B）'); return; }
  }

  const now=Date.now();
  const q = editing && editing.id ? {...editing} : {
    id:uid(), mastery:0, ease:2.5, interval:0, due:now,
    reviews:0, correct:0, wrong:0, createdAt:now,
  };
  /* 换过图 → 旧的那张就没用了，顺手删掉，别在库里烂着 */
  const oldId = editing && editing.imageId;
  if(oldId && oldId !== editImgId) IMG.del(oldId);
  Object.assign(q,{
    content, answer,
    analysis: ($('#f_analysis')||{}).value ? $('#f_analysis').value.trim() : '',
    subject: subjV, difficulty: diffV,
    type: typeV, options: opts,
    tags: editTags.slice(0,6),
    imageId: editImgId || null,
    mastery: mastV,
    interval: PLAN[mastV].first,
    updatedAt: now,
  });
  /* 图有两条去路，二选一：
       · 独立图库写得进去 → 只留 imageId，记录干净、备份小；
       · 写不进去 → 退成内联 dataURL 塞进 q.image，题目照样能存下来。
     这条降级路是「题目根本存不进去」的兜底：以前图写失败直接 return，
     连编辑器都打不开，看起来就像题目也丢了。 */
  if(editImgId){ delete q.image; }
  else if(editInlineImage){ q.image = editInlineImage; }
  else { delete q.image; }
  if(!q.reviews){ q.due = now; }
  /* 题目本身必须落盘成功 —— 静默吞掉写库错误，用户会以为存上了，
     下次打开却什么都没有，那是最坏的一种失败。这里把结果如实回报。 */
  let wrote=true;
  try{ await DB.put(q); }catch(e){ wrote=false; console.warn('题库存失败', e); }
  const i=S.qs.findIndex(x=>x.id===q.id);
  if(i>=0) S.qs[i]=q; else S.qs.push(q);

  closeSheet();
  S.tab = (S.tab==='add'||!S.tab)? 'bank' : S.tab;
  if(S.tab==='home'||S.tab==='review') S.tab='bank';
  render();
  if(wrote){ toast(editing? '已保存' : '已添加'); }
  else{ toast('本机存储写不进去，这题只在这次打开里有效', 4200); }
  if(!editing) celebrate(true);
  editing=null; editImg=null; editImgId=null; editTags=[];
  editType='solve'; editOpts=[]; editInlineImage=null;
  schedulePush();
}

/* ------------------------------------------------------------ 设置 */
function openSettings(){
  openSheet(`
    <h2>设置</h2>
    <div class="sub-h">错题默认存在这台设备上，再自动跟同一个网址的那一端对齐。</div>

    <div class="card" style="margin-bottom:14px">
      <div class="list-row">
        <div class="k">外观<small>深色是夜里刷题用的</small></div>
        <div style="display:flex;gap:7px">
          ${[['auto','系统'],['light','浅色'],['dark','深色']].map(([k,n])=>
            `<button class="chip ${(S.settings.theme||'auto')===k?'active':''}" data-theme="${k}"
              style="flex:0 0 auto;padding:7px 13px">${n}</button>`).join('')}
        </div>
      </div>
    </div>

    <div class="card" style="margin-bottom:14px">
      <div class="list-row">
        <div class="k">每日复习目标<small>影响首页进度</small></div>
        <input id="s_goal" type="number" min="1" max="200" value="${S.settings.goal}"
          style="width:78px;background:var(--paper-2);border:1px solid var(--line-2);border-radius:12px;padding:9px;text-align:center">
      </div>
      <div class="list-row">
        <div class="k">震动反馈<small>点按时的轻微回弹</small></div>
        <label class="switch"><input type="checkbox" id="s_haptic" ${S.settings.haptics?'checked':''}><span class="s"></span></label>
      </div>
      <div class="list-row">
        <div class="k">AI 识题<small id="aiStateTxt">检查中…</small></div>
        <span class="tag" id="aiStateTag">—</span>
      </div>
      <div class="list-row">
        <div class="k">离线可用<small>断网也能做题</small></div>
        <span class="tag m2">已启用</span>
      </div>
      <div class="list-row">
        <div class="k">持久化存储<small>${S.persist? '已锁定，系统不会自动清理':'未锁定，点右侧申请'}</small></div>
        <button class="btn ghost" style="padding:9px 14px;font-size:13px" data-act="persist">${S.persist?'已开启':'申请'}</button>
      </div>
    </div>

    <div class="sec-title"><h3>每天提醒</h3></div>
    <div class="card" style="margin-bottom:14px">
      <div class="list-row">
        <div class="k">复习提醒<small>到点提醒今天还有多少道要做</small></div>
        <label class="switch"><input type="checkbox" id="s_noti" ${NOTI.cfg().on?'checked':''}><span class="s"></span></label>
      </div>
      <div class="list-row">
        <div class="k">提醒时间</div>
        <input id="s_noti_time" type="time" value="${String(NOTI.cfg().h).padStart(2,'0')}:${String(NOTI.cfg().m).padStart(2,'0')}"
          style="width:118px;background:var(--paper-2);border:1px solid var(--line-2);border-radius:12px;padding:9px;text-align:center">
      </div>
      <div style="font-size:11.5px;color:var(--ink-4);line-height:1.7" id="notiStat"></div>
    </div>

    <div class="sec-title"><h3>数据</h3></div>
    <button class="btn primary block" style="margin-bottom:9px" data-act="print-weekly">生成本周错题集（可打印 / 存 PDF）</button>
    <div class="row2">
      <button class="btn" data-act="export">导出文字备份</button>
      <button class="btn" data-act="export-zip">导出含图备份</button>
    </div>
    <div style="font-size:11.5px;color:var(--ink-4);margin-top:8px;line-height:1.7" id="storeStat">…</div>
    <input type="file" id="importFile" accept="application/json,.json,application/zip,.zip" style="display:none">
    <button class="btn block" style="margin-top:10px" data-act="import">导入恢复</button>
    <button class="btn danger block" style="margin-top:10px" data-act="clear-all">清空全部错题</button>
    <div style="text-align:center;color:var(--ink-4);font-size:11.5px;margin-top:24px;line-height:1.9">
      错题集 · 暖纸<br>愿你早日清空这本集<br><span style="font-size:10.5px;opacity:.75">构建 ${BUILD}</span>
    </div>
  `);
  const g=$('#s_goal');
  if(g) g.onchange=async ()=>{ S.settings.goal=clamp(+g.value||10,1,200);
    await DB.setMeta('settings',S.settings).catch(()=>{}); schedulePush(); toast('已保存'); };
  const hc=$('#s_haptic');
  if(hc) hc.onchange=async ()=>{ S.settings.haptics=hc.checked;
    await DB.setMeta('settings',S.settings).catch(()=>{}); };
  const sc=$('#s_sync');
  if(sc) sc.onchange=async ()=>{
    SYNC.setOn(sc.checked);
    if(sc.checked){ startSync(); syncDown(true); }
    else{ clearInterval(syncTimer); }
    openSettings();
  };
  $$('[data-theme]').forEach(b=> b.onclick=async ()=>{
    buzz();
    THEME.set(b.dataset.theme);
    await DB.setMeta('settings',S.settings).catch(()=>{});
    schedulePush(); openSettings();
  });
  const im=$('#importFile'); if(im) im.onchange=importData;
  /* 每日提醒 */
  const nc=$('#s_noti');
  if(nc) nc.onchange=async ()=>{
    if(nc.checked){
      const ok=await NOTI.ask();
      if(!ok){ nc.checked=false; return; }
      NOTI.set({ on:true });
      toast('已打开，每天到点提醒你', 2200);
      NOTI.registerPeriodic();
    }else{
      NOTI.set({ on:false });
      toast('提醒已关掉');
    }
    openSettings();
  };
  const nt=$('#s_noti_time');
  if(nt) nt.onchange=()=>{
    const [h,m]=String(nt.value||'19:00').split(':').map(x=>+x||0);
    NOTI.set({ h:clamp(h,0,23), m:clamp(m,0,59) });
    toast('提醒时间已改成 '+(nt.value||'19:00'));
    openSettings();
  };
  (async ()=>{
    const el=$('#notiStat'); if(!el) return;
    const c=NOTI.cfg();
    const perm = !NOTI.supported() ? '这个浏览器不支持通知'
      : (Notification.permission==='granted' ? '已授权'
      : Notification.permission==='denied' ? '被系统禁用了，要到浏览器设置里重新打开'
      : '还没授权，打开开关时会问你一次');
    el.textContent = `状态：${perm}。手机上如果把网页关掉，提醒可能不会响 —— 加到主屏幕后会稳很多。`;
  })();
  (async ()=>{
    const el=$('#storeStat'); if(!el) return;
    const bytes=await IMG.totalBytes();
    const n=S.qs.filter(q=>q.imageId).length;
    el.textContent = `本机：${S.qs.length} 道错题 · ${n} 张题图（约 ${(bytes/1048576).toFixed(1)} MB）。题图单独存放，不塞进文字备份里。`;
  })();
  // AI 状态
  (async ()=>{
    const tag=$('#aiStateTag'), txt=$('#aiStateTxt');
    if(!txt) return;
    try{
      await AI.pickModel();
      const isLocal = location.protocol!=='https:' || /localhost|127\.0\.0\.1|file:/.test(location.href);
      if(isLocal){ txt.textContent='本地预览不可用，上线后生效'; if(tag){ tag.textContent='待上线'; tag.className='tag m1'; } }
      else { txt.textContent = AI.vision? '已就绪（可读图片）':'已就绪（纯文本模型）';
             if(tag){ tag.textContent=AI.vision?'可用':'限文本'; tag.className='tag '+(AI.vision?'m2':'m1'); } }
    }catch(e){
      txt.textContent=aiErrMsg(codeOf(e));
      if(tag){ tag.textContent='不可用'; tag.className='tag m0'; }
    }
  })();
}

/* ============================================== 云同步 · 同一个网址一起看
   以前要记一串「同步码」，太反人类。现在房间名直接从网址里派生：
   谁打开同一个网址，谁就在同一个房间，打开就自动对上。
   （若哪天想私密一点，在网址后面加 ?r=随便一串字，两边带同样的即可。）
   本机一改就悄悄传上去，另一端每十几秒对一次，两边自然一样。 */
let syncBusy=false, syncTimer=0, pushTimer=0, syncFails=0;
const SYNC = {
  room:'', enabled:true,
  onKey(){ return 'wb_sync_on'; },
  atKey(){ return 'wb_sync_at'; },
  deriveRoom(){
    let r='';
    try{ const q=new URLSearchParams(location.search).get('r'); if(q) r=q; }catch(e){}
    if(!r){ let h='local'; try{ h=location.hostname||'local'; }catch(e){} r='SITE-'+h; }
    return String(r).toUpperCase().replace(/[^A-Z0-9-]/g,'').slice(0,40) || 'SITE-DEFAULT';
  },
  load(){
    try{ this.enabled = localStorage.getItem(this.onKey()) !== '0'; }catch(e){ this.enabled=true; }
    this.room = this.deriveRoom();
    return this.room;
  },
  setOn(v){
    this.enabled=!!v;
    try{ localStorage.setItem(this.onKey(), v?'1':'0'); }catch(e){}
  },
  client(){
    const WBC=window.WorkBuddyCloud;
    if(!WBC||!WBC.createWorkBuddyCloud) throw new Error('sdk-missing');
    return WBC.createWorkBuddyCloud({
      endpoint: CFG.endpoint, oauthRelayBaseUrl: CFG.oauthRelayBaseUrl, publishableKey: CFG.publishableKey,
    });
  },
  payload(){
    return { v:1, at:Date.now(), settings:{ goal:S.settings.goal }, items:S.qs };
  },
  async push(){
    if(!this.room) throw new Error('noroom');
    const { data, error } = await this.client().database.rpc('sync_push', { p_code:this.room, p_payload:this.payload() });
    if(error) throw new Error(error.message || error.code || 'push-fail');
    return data;
  },
  async pull(){
    if(!this.room) throw new Error('noroom');
    const { data, error } = await this.client().database.rpc('sync_pull', { p_code:this.room });
    if(error) throw new Error(error.message || error.code || 'pull-fail');
    return (data && typeof data==='object') ? data : null;
  },
  lastAt(){ try{ return +(localStorage.getItem(this.atKey())||0); }catch(e){ return 0; } },
  markAt(t){ try{ localStorage.setItem(this.atKey(), String(t||Date.now())); }catch(e){} },
};
/* 按 id 合并：同一道题取 updatedAt 新的那一份 */
function mergeItems(local, remote){
  const map=new Map();
  (local||[]).forEach(q=>{ if(q&&q.id) map.set(q.id, q); });
  let added=0, updated=0;
  (remote||[]).forEach(rq=>{
    if(!rq||!rq.id) return;
    const cur=map.get(rq.id);
    if(!cur){ map.set(rq.id, normalize({...rq})); added++; return; }
    if((rq.updatedAt||0) > (cur.updatedAt||0)){ map.set(rq.id, normalize({...rq})); updated++; }
  });
  return { list:Array.from(map.values()), added, updated };
}
async function syncSaveAll(){
  for(const q of S.qs) await DB.put(q).catch(()=>{});
}
function syncSetState(html, tone){
  const el=$('#syncState'); if(!el) return;
  el.innerHTML = html;
  el.style.color = tone==='bad' ? 'var(--aka)' : (tone==='ok'? 'var(--shu)' : 'var(--ink-3)');
}
function syncLastTxt(){
  const t=SYNC.lastAt();
  if(!SYNC.enabled) return '已关闭，本机错题只留在这台设备上。';
  return t? '上次对上：'+fmtDate(t) : '打开同一个网址的两个人，会自动看到同一本错题。';
}
/* 本机一改 → 攒几秒再传，避免连着拍错题时反复请求 */
function schedulePush(delay){
  if(!SYNC.enabled || !SYNC.room) return;
  clearTimeout(pushTimer);
  pushTimer=setTimeout(()=>{ syncUp(true); }, delay==null?3500:delay);
}
async function syncUp(silent){
  if(!SYNC.enabled || !SYNC.room) return;
  /* 上一轮还没传完：排到后面，别把这次改动丢掉 */
  if(syncBusy){ schedulePush(1500); return; }
  syncBusy=true;
  if(!silent) syncSetState('正在上传…','');
  try{
    await SYNC.push();
    const at=Date.now();
    SYNC.markAt(at);
    syncFails=0;
    /* 文字先对齐，再慢慢把图补上去。一批 3 张 —— 8 张图两轮就能传完，
       比一次 2 张快一截，又不至于长时间占住主线程。 */
    const sent=await IMGSYNC.drain(3);
    const left=IMGSYNC.pending();
    const txt = `已上传 ${S.qs.length} 道错题${left?`（还有 ${left} 张图在排队）`:''} · ${fmtDate(at)}`;
    syncSetState(txt,'ok');
    if(!silent) toast('已同步');
    if(left) schedulePush(2500);
  }catch(e){
    console.warn('sync up', e);
    syncFails++;
    if(!silent){ syncSetState('上传失败：'+syncErr(e),'bad'); toast('上传失败：'+syncErr(e),2600); }
    else syncSetState('网络不太顺，稍后会自动再试','bad');
  }finally{ syncBusy=false; }
}
async function syncDown(silent){
  if(syncBusy || !SYNC.enabled || !SYNC.room){
    if(!silent) toast(SYNC.enabled?'正在同步，稍等一下':'共享已经关掉了');
    return;
  }
  syncBusy=true;
  if(!silent) syncSetState('正在对齐…','');
  try{
    const remote=await SYNC.pull();
    if(!remote || !Array.isArray(remote.items)){
      syncSetState('这边还没有别的设备传过数据','');
      syncBusy=false;
      if(!silent) toast('云端还是空的');
      return;
    }
    const m=mergeItems(S.qs, remote.items);
    S.qs=m.list;
    await migrateImages(S.qs);
    if(remote.settings && remote.settings.goal) S.settings.goal=clamp(+remote.settings.goal||S.settings.goal,1,200);
    await syncSaveAll();
    SYNC.markAt(+remote.at||Date.now());
    syncFails=0;
    render();
    await IMGSYNC.fill(3);
    syncSetState(`已对齐：新增 ${m.added} 道 · 更新 ${m.updated} 道`,'ok');
    if(!silent) toast(`对齐完成：新增 ${m.added} · 更新 ${m.updated}`,2400);
  }catch(e){
    console.warn('sync down', e);
    syncFails++;
    syncSetState('同步失败：'+syncErr(e),'bad');
    if(!silent) toast('同步失败：'+syncErr(e),2600);
  }finally{ syncBusy=false; }
}
/* 静默轮询：另一端改了就会被拉回来，不打扰用户 */
async function syncPoll(){
  if(!SYNC.enabled || !SYNC.room || syncBusy) return;
  if(typeof document!=='undefined' && document.visibilityState!=='visible') return;
  try{
    const remote=await SYNC.pull();
    /* ⚠️ 血教训（两道坎，都让「图永远不出现」）：
       ① 原本这里 `if(!remote || !Array.isArray(remote.items)){ ...; return; }` ——
          文字通道读不到 items 就整段 return，连拉图一起跳过。可**图走的是
          另一条通道**，文字这边空着不代表图没有。
       ② 原本下面还有一句 `if(at<=SYNC.lastAt()) return;` —— 文字时间戳没变
          又提前退出。A 传图时文字压根没动，于是 B 永远走不到 IMGSYNC.fill()。
       修法：文字通道「有没有」「变没变」只决定要不要合并文字，**拉图每轮必执行**。 */
    const hasText = !!(remote && Array.isArray(remote.items));
    if(hasText){
      const at=+(remote.at||0);
      syncFails=0;
      const textChanged = !(at && at<=SYNC.lastAt());
      if(textChanged){
        const m=mergeItems(S.qs, remote.items);
        if(m.added||m.updated){
          S.qs=m.list;
          await migrateImages(S.qs);
          if(remote.settings && remote.settings.goal) S.settings.goal=clamp(+remote.settings.goal||S.settings.goal,1,200);
          await syncSaveAll();
          render();
          syncSetState(`另一边更新了：新增 ${m.added} 道 · 更新 ${m.updated} 道`,'ok');
          toast(`另一边有更新：+${m.added} · 改 ${m.updated}`,2400);
        }
        SYNC.markAt(at||Date.now());
        /* 本机有别的设备没有的题 → 也补传上去，保证两边真的一致 */
        const ids=new Set(remote.items.map(x=>x&&x.id));
        if(S.qs.some(q=>!ids.has(q.id))) schedulePush(1500);
      }
    }else{
      syncFails=0;
      /* 本机有货、云端还是空的 → 先把本机的送上去 */
      if(S.qs.length && !SYNC.lastAt()) syncUp(true);
    }
    /* 拉图：与文字通道有没有、变没变都无关，每轮都必须补 */
    await IMGSYNC.fill(3);
    /* 本机还有图没传上去（含上一轮失败重试的）→ 排一次上传 */
    if(IMGSYNC.pending()) schedulePush(2500);
  }catch(e){ /* 轮询失败保持安静 */ }
}
function startSync(){
  clearInterval(syncTimer);
  if(!SYNC.enabled) return;
  syncTimer=setInterval(syncPoll, 12000);
  setTimeout(syncPoll, 900);
}
function syncErr(e){
  const m=String((e&&e.message)||e||'');
  if(m==='noroom') return '房间名没取到';
  if(m==='sdk-missing') return '云端组件没加载，联网后重试';
  if(/Failed to fetch|NetworkError|network/i.test(m)) return '网络不通';
  if(/permission|42501/i.test(m)) return '服务端拒了这次请求';
  if(/p_code/i.test(m)) return '房间名格式不对';
  return m.slice(0,40) || '未知错误';
}
async function requestPersist(){
  try{
    if(navigator.storage && navigator.storage.persist){
      const ok=await navigator.storage.persist();
      S.persist=ok; toast(ok?'已锁定持久存储':'浏览器暂未授予');
    }else toast('当前环境不支持');
  }catch(e){ toast('申请失败'); }
  openSettings();
}
/* --------------------------------------------- 题图的跨设备通道
   文字部分照旧走 sync_push。图另开一路，用「房间短哈希 + 图id」当钥匙。
   ⚠️ 钥匙必须 ≤40 字符（见上面 KEY_MAX 的说明），且**推完要回读验证** ——
   服务端超限时静默丢弃不报错，只信返回值会被骗。 */
const IMGSYNC = {
  published:new Set(),
  /* 标记换到 v2：旧 v1 里存着一批「假成功」的图 id（key 超限被丢弃，
     代码却 mark 了）。继续读 v1 的话这些图永远不会重传 —— 必须弃用。 */
  key(){ return 'wb_sync_imgs_v2'; },
  load(){ try{ (JSON.parse(localStorage.getItem(this.key())||'[]')||[]).forEach(x=>this.published.add(x)); }catch(e){} },
  mark(id){ this.published.add(id);
    try{ localStorage.setItem(this.key(), JSON.stringify([...this.published].slice(-800))); }catch(e){} },
  /* 图片钥匙：'IM:' + 房间短哈希(8) + ':' + 图id，总长恒定 ≤40。
     图 id 异常长时再哈希一次兜底，保证绝不越界。 */
  code(imageId){
    const tag=roomTag(SYNC.room);
    let id=String(imageId||'');
    if(id.length > KEY_MAX-12) id=roomTag(id)+id.slice(-16);
    return 'IM:'+tag+':'+id;
  },
  /* 旧钥匙（房间名全拼）—— 仅用于读取历史数据，写入绝不再用 */
  oldCode(imageId){ return SYNC.room+':img:'+imageId; },
  async pushOne(imageId){
    if(!imageId || this.published.has(imageId)) return false;
    const b=await IMG.get(imageId); if(!b) return false;
    const d=await blobToDataURL(b);
    const code=this.code(imageId);
    /* 本地断言：钥匙超限就不发 —— 发了也是白丢，还白白 mark 成已上传 */
    if(code.length>KEY_MAX) throw new Error('imgkey-toolong');
    const { error } = await SYNC.client().database.rpc('sync_push',
      { p_code: code, p_payload:{ v:1, at:Date.now(), d } });
    if(error) throw new Error(error.message || 'imgpush');
    /* ⚠️ 关键：回读确认真的落库了。服务端超限会静默丢成 {}，
       只信返回值就会把没传上去的图 mark 成「已上传」，从此永不重试。 */
    const back=await this.pullOne(imageId, true).catch(()=>null);
    if(!back) throw new Error('imgpush-lost');
    this.mark(imageId);
    return true;
  },
  /* 往回拉。verifyOnly=true 时只用于验证，不触发旧钥匙回退。 */
  async pullOne(imageId, verifyOnly){
    const cli=SYNC.client().database;
    const hit=d=>(d && typeof d==='object' && typeof d.d==='string') ? d.d : null;
    let { data, error } = await cli.rpc('sync_pull', { p_code: this.code(imageId) });
    if(error) throw new Error(error.message || 'imgpull');
    if(hit(data)) return hit(data);
    /* 新钥匙没命中：试一次旧钥匙，兜住「短房间名时代用旧格式存过图」的情况 */
    if(!verifyOnly){
      try{
        const r=await cli.rpc('sync_pull', { p_code: this.oldCode(imageId) });
        if(!r.error && hit(r.data)) return hit(r.data);
      }catch(e){ /* 忽略 */ }
    }
    return null;
  },
  /* 往上传：一次最多 3 张，剩下的下次继续，别把带宽吃满。
     一批 3 张：8 张图两轮就传完，比原来一次 2 张快一截，又不至于堵住主线程。 */
  async drain(limit){
    let n=0;
    for(const q of S.qs){
      if(n>=limit) break;
      if(!q.imageId || this.published.has(q.imageId)) continue;
      try{ if(await this.pushOne(q.imageId)) n++; }
      catch(e){ console.warn('img push', q.imageId, e && e.message); break; }
    }
    return n;
  },
  /* 往回拉：本机没有、对面有，就补下来。
     ⚠️ 拉不到不能立刻判死刑：A 还在传、B 先打开是很正常的情况。
     每张最多试 4 轮，之后才标记「对面确实没有」，避免每轮都白拉。 */
  async fill(limit){
    let n=0;
    for(const q of S.qs){
      if(n>=limit) break;
      const id=q.imageId;
      if(!id || IMG.known.has(id)) continue;
      const fails=IMG.imgFail.get(id)||0;
      if(fails>=4) continue;                      // 试满 4 轮，先歇着
      let d=null;
      try{ d=await this.pullOne(id); }
      catch(e){ IMG.imgFail.set(id, fails+1); continue; }
      if(!d){ IMG.imgFail.set(id, fails+1); continue; }
      const b=dataURLtoBlob(d);
      if(b){ await IMG.putAs(id, b); IMG.imgFail.delete(id); n++; }
      else IMG.imgFail.set(id, fails+1);
    }
    if(n) render();
    return n;
  },
  pending(){
    return S.qs.filter(q=>q.imageId && !this.published.has(q.imageId)).length;
  },
};
/* ================================================== 每日复习提醒（本地通知）
   PWA 不需要推送服务：Notification + 定时器就够。
   三层保险，因为手机上定时器随时可能被系统冻住：
     ① 页面活着时挂一个 setTimeout；
     ② 每次回到前台对一次表，错过了就补发（一天只发一次）；
     ③ 装了 PWA 的话注册 Periodic Background Sync，由 Service Worker 兜底。 */
const NOTI = {
  timer:0,
  key(){ return 'wb_noti'; },
  load(){ try{ return JSON.parse(localStorage.getItem(this.key())||'{}')||{}; }catch(e){ return {}; } },
  save(c){ try{ localStorage.setItem(this.key(), JSON.stringify(c)); }catch(e){} },
  supported(){ return typeof Notification!=='undefined'; },
  granted(){ return this.supported() && Notification.permission==='granted'; },
  cfg(){
    const c=this.load();
    return { on:!!c.on, h:(c.h==null?19:c.h), m:(c.m==null?0:c.m), last:c.last||'' };
  },
  set(patch){ const c={...this.cfg(), ...patch}; this.save(c); this.arm(); return c; },
  async ask(){
    if(!this.supported()){ toast('这个浏览器不支持通知', 2400); return false; }
    if(Notification.permission==='granted') return true;
    if(Notification.permission==='denied'){ toast('通知被系统关掉了，要到浏览器设置里重新打开', 3200); return false; }
    try{ return (await Notification.requestPermission())==='granted'; }catch(e){ return false; }
  },
  nextAt(c){
    const c2=c||this.cfg();
    const t=new Date(); t.setHours(c2.h, c2.m, 0, 0);
    if(t.getTime()<=Date.now()) t.setDate(t.getDate()+1);
    return t.getTime();
  },
  arm(){
    clearTimeout(this.timer);
    const c=this.cfg();
    if(!c.on || !this.granted()) return;
    const at=this.nextAt(c);
    /* 分段睡：一次最多睡 6 小时，醒来再续，免得长定时器被系统回收 */
    const ms=Math.min(at-Date.now(), 6*3600*1000);
    this.timer=setTimeout(()=>{
      if(at-Date.now()<=1000) this.fire();
      this.arm();
    }, Math.max(1500, ms));
  },
  /* 回到前台/到点：该发就发，一天只发一次。
     前台不弹 —— 用户正开着 App 做题，再弹一条「该复习错题了」纯属打扰，
     静默记下今天已提醒过就行。force 是留给「设置里手动试一下通知」的口子。 */
  fire(force){
    const c=this.cfg();
    if(!c.on && !force) return false;
    if(!this.granted() && !force) return false;
    const k=dayKey(Date.now());
    if(!force && c.last===k) return false;
    const pend=S.qs.filter(due).length;
    if(!pend) return false;
    if(!force && typeof document!=='undefined' && document.visibilityState==='visible'){
      this.set({ last:k });
      return false;
    }
    if(!force) this.set({ last:k });
    const goal=clamp(+S.settings.goal||5,1,200);
    const body = pend>goal
      ? `今天挑 ${goal} 道做掉就算完成，还剩 ${pend} 道排着队`
      : `今天还有 ${pend} 道待复习，几分钟就能做完`;
    try{
      const n=new Notification('该复习错题了', {
        body, tag:'cuotiji-daily', icon:'icons/icon-192.png', badge:'icons/icon-192.png',
      });
      n.onclick=()=>{ try{ window.focus(); }catch(e){} S.tab='review'; render(); try{ n.close(); }catch(e){} };
      return true;
    }catch(e){ console.warn('notify', e); return false; }
  },
  /* ⚠️ 这一段在 iOS 上是空操作，别以为它在跑。
     · periodicSync 只有 Chromium 系（Android / 桌面 Chrome、Edge）支持；
       iOS Safari 从根上没这个 API，`'periodicSync' in reg` 直接为 false。
     · 就算在 Android 上注册成功，触发时机也是浏览器自己的 heuristics 说了算，
       不是「我注册了 12 小时它就准点 12 小时跑一次」—— 可能一天一次，
       也可能好几天不跑，还要求站点被加入主屏且使用度够高。
     · 所以真正在守时的是上面那个 arm() 定时器 + visibilitychange 补发：
       只要用户开一次 App 就会核对「今天到点没」。periodicSync 顶多算锦上添花。 */
  async registerPeriodic(){
    if(!this.cfg().on) return;
    try{
      const reg=await navigator.serviceWorker.getRegistration();
      if(reg && 'periodicSync' in reg){
        await reg.periodicSync.register('cuotiji-daily', { minInterval: 12*3600*1000 });
      }
    }catch(e){}
  },
};

/* ==================================================== ZIP（零依赖，只做 store）
   里面的 JPEG 本来就是压缩格式，再 deflate 一遍纯属浪费电。
   自己写一百来行，省掉一个依赖，也免得 CDN 一挂就导不出备份。 */
const CRC_T = (()=>{ const t=new Uint32Array(256);
  for(let n=0;n<256;n++){ let c=n;
    for(let k=0;k<8;k++) c = (c&1) ? (0xEDB88320 ^ (c>>>1)) : (c>>>1);
    t[n]=c>>>0; }
  return t; })();
function crc32(u8){
  let c=0xFFFFFFFF;
  for(let i=0;i<u8.length;i++) c = CRC_T[(c ^ u8[i]) & 0xFF] ^ (c>>>8);
  return (c ^ 0xFFFFFFFF)>>>0;
}
function _dosTime(){ const d=new Date();
  return { t: ((d.getHours()<<11)|(d.getMinutes()<<5)|((d.getSeconds()/2)|0))&0xFFFF,
           d: (((d.getFullYear()-1980)<<9)|((d.getMonth()+1)<<5)|d.getDate())&0xFFFF }; }
function makeZip(files){
  const enc=new TextEncoder(), dt=_dosTime();
  const parts=[], central=[]; let offset=0;
  files.forEach(f=>{
    const name=enc.encode(f.name);
    const data=f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data);
    const crc=crc32(data);
    const lh=new DataView(new ArrayBuffer(30));
    lh.setUint32(0,0x04034b50,true); lh.setUint16(4,20,true); lh.setUint16(6,0x0800,true);
    lh.setUint16(8,0,true); lh.setUint16(10,dt.t,true); lh.setUint16(12,dt.d,true);
    lh.setUint32(14,crc,true); lh.setUint32(18,data.length,true); lh.setUint32(22,data.length,true);
    lh.setUint16(26,name.length,true); lh.setUint16(28,0,true);
    parts.push(new Uint8Array(lh.buffer), name, data);
    central.push({ name, crc, len:data.length, offset });
    offset += 30 + name.length + data.length;
  });
  const cd=[]; let cdLen=0;
  central.forEach(e=>{
    const h=new DataView(new ArrayBuffer(46));
    h.setUint32(0,0x02014b50,true); h.setUint16(4,20,true); h.setUint16(6,20,true);
    h.setUint16(8,0x0800,true); h.setUint16(10,0,true);
    h.setUint16(12,dt.t,true); h.setUint16(14,dt.d,true);
    h.setUint32(16,e.crc,true); h.setUint32(20,e.len,true); h.setUint32(24,e.len,true);
    h.setUint16(28,e.name.length,true); h.setUint16(30,0,true); h.setUint16(32,0,true);
    h.setUint16(34,0,true); h.setUint16(36,0,true); h.setUint32(38,0,true);
    h.setUint32(42,e.offset,true);
    cd.push(new Uint8Array(h.buffer), e.name);
    cdLen += 46 + e.name.length;
  });
  const end=new DataView(new ArrayBuffer(22));
  end.setUint32(0,0x06054b50,true); end.setUint16(8,central.length,true);
  end.setUint16(10,central.length,true); end.setUint32(12,cdLen,true); end.setUint32(16,offset,true);
  return new Blob([...parts, ...cd, new Uint8Array(end.buffer)], { type:'application/zip' });
}
async function readZip(file){
  const buf=new Uint8Array(await file.arrayBuffer());
  const dv=new DataView(buf.buffer), out={};
  for(let i=0;i<buf.length-30;i++){
    if(dv.getUint32(i,true)!==0x04034b50) continue;
    const nlen=dv.getUint16(i+26,true), elen=dv.getUint16(i+28,true);
    const size=dv.getUint32(i+18,true);
    const name=new TextDecoder().decode(buf.slice(i+30, i+30+nlen));
    const start=i+30+nlen+elen;
    out[name]=buf.slice(start, start+size);
    i = start + size - 1;
  }
  return out;
}
const bytesToBlob=(u8,mime)=>new Blob([u8],{type:mime||'application/octet-stream'});
function downloadBlob(blob, name){
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url; a.download=name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 6000);
}
/* 剥掉「大块内联图」再上路（云同步 / 纯文字备份）。
   为什么要剥：一张内联图几百 KB，混进每条题目会让同步包和 JSON 撑爆。
   但只剥「有 imageId 可回源」的；降级路径上的题没有 imageId，
   image 是它唯一的图 —— 那种必须留着，剥了图就真没了。 */
const stripImg = q => {
  const c={...q};
  if(c.imageId) delete c.image;
  return c;
};

async function exportData(withImages){
  const base=`错题集-备份-${new Date().toISOString().slice(0,10)}`;
  const head={ v:3, kind:'cuotiji-backup', exportedAt:Date.now(), data:S.qs.map(stripImg) };
  if(!withImages){
    downloadBlob(new Blob([JSON.stringify({...head, images:false},null,2)],{type:'application/json'}), base+'.json');
    toast('已导出（纯文字，很轻）');
    return;
  }
  toast('正在打包图片…', 1800);
  const files=[{ name:'data.json', data:new TextEncoder().encode(JSON.stringify({...head, images:true},null,2)) }];
  for(const q of S.qs){
    /* 图库里的图 → 拆成独立文件 */
    if(q.imageId){
      const b=await IMG.get(q.imageId);
      if(b) files.push({ name:'images/'+q.imageId+'.jpg', data:new Uint8Array(await b.arrayBuffer()) });
      continue;
    }
    /* 降级路径的内联图 → 也拆出来存成文件，回导时能还原成图库记录。
       这样 zip 备份里图是完整的，不会因为走了降级路就丢。 */
    if(q.image){
      const b=dataURLtoBlob(q.image);
      if(b) files.push({ name:'inline/'+q.id+'.jpg', data:new Uint8Array(await b.arrayBuffer()) });
    }
  }
  downloadBlob(makeZip(files), base+'.zip');
  toast(`已导出 zip：${files.length-1} 张图`);
}
async function importData(e){
  const f=e.target.files && e.target.files[0]; if(!f) return;
  e.target.value='';
  try{
    let json=null, zip=null;
    if(/\.zip$/i.test(f.name) || f.type==='application/zip'){
      zip=await readZip(f);
      if(!zip['data.json']) throw new Error('badzip');
      json=JSON.parse(new TextDecoder().decode(zip['data.json']));
    }else{
      json=JSON.parse(await f.text());
    }
    const arr=Array.isArray(json)? json : (json.data||[]);
    let n=0, imgs=0;
    for(const raw of arr){
      const r={...raw}; delete r.image;
      let imageId=null, inline=null;
      if(zip && r.imageId){
        const bin=zip['images/'+r.imageId+'.jpg'] || zip['images/'+r.imageId];
        if(bin){ imageId=await IMG.put(bytesToBlob(bin,'image/jpeg')); imgs++; }
      }
      /* 备份里被拆出来的「降级内联图」：优先塞回图库；
         这台设备要还是写不进去，就还原成内联图挂在题上，图不丢。 */
      if(zip && !imageId && r.id){
        const bin=zip['inline/'+r.id+'.jpg'] || zip['inline/'+r.id];
        if(bin){
          const bl=bytesToBlob(bin,'image/jpeg');
          try{ imageId=await IMG.put(bl); imgs++; }
          catch(e){ inline=await blobToDataURL(bl).catch(()=>null); }
        }
      }
      const item=normalize({ mastery:0, ease:2.5, interval:0, due:Date.now(), reviews:0, correct:0, wrong:0,
        createdAt:Date.now(), ...r, id:r.id||uid(), imageId, updatedAt:Date.now() });
      if(!item.content && !item.imageId && !inline) continue;
      if(inline) item.image=inline;
      await DB.put(item).catch(()=>{});
      const i=S.qs.findIndex(x=>x.id===item.id);
      if(i>=0) S.qs[i]=item; else S.qs.push(item);
      n++;
    }
    closeSheet(); render();
    toast(`已导入 ${n} 道错题${imgs?` · ${imgs} 张图`:''}`);
    schedulePush(600);
  }catch(err){
    console.warn('import', err);
    toast('这个文件读不出来，确认是错题集导出的备份', 2800);
  }
}

/* ------------------------------------------------- 本周错题集（打印 / 存 PDF）
   错题本的终极场景：考前打出来做一遍。按学科分组，每题下面留白。 */
async function weeklyHtml(){
  const since = today() - 6*DAY;
  let list = S.qs.filter(q=> (q.createdAt||0)>=since || (q.lastReview||0)>=since);
  let title='本周错题集';
  if(!list.length){
    list = S.qs.slice().sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)).slice(0,20);
    title='错题集（最近 20 道）';
  }
  if(!list.length) return { html:'', n:0 };
  const groups = SUBJECTS.map(s=>({ s, arr:list.filter(q=>q.subject===s.k) })).filter(g=>g.arr.length);
  const dstr = `${new Date().getFullYear()} 年 ${new Date().getMonth()+1} 月 ${new Date().getDate()} 日`;
  /* 先把题图全部内联，再拼 HTML —— 否则打印出来图是空的。
   内联图（降级路径）本身就是 dataURL，直接用；图库里的才需要现压。 */
  const withPic = list.filter(q=>qHasImg(q)).slice(0,24);
  const pics = new Map();
  await Promise.all(withPic.map(async q=>{
    const u = q.image ? q.image : await imgDataURL(q.imageId, 900);
    if(u) pics.set(q.id, u);
  }));
  let no=0;
  const blocks = groups.map(g=>{
    const rows = g.arr.map(q=>{
      no++;
      const img = pics.get(q.id) || '';
      return `<section class="q">
        <div class="num">${no}</div>
        <div class="qs">
          <div class="txt">${esc(q.content||'（图片题）').replace(/\n/g,'<br>')}</div>
          ${img? `<img class="pic" src="${img}" alt="">`:''}
          <div class="blank"></div>
        </div>
      </section>`;
    }).join('');
    return `<h2 class="subj">${g.s.n} · ${g.arr.length} 道</h2>${rows}`;
  }).join('');
  const answers = groups.map(g=>{
    const rows = g.arr.map(q=>{
      return `<div class="ans"><b>${esc((q.content||'').slice(0,26))}${(q.content||'').length>26?'…':''}</b>
        <div class="a1">答案：${esc(q.answer||'—')}</div>
        ${q.analysis? `<div class="a2">${esc(q.analysis).replace(/\n/g,'<br>')}</div>`:''}</div>`;
    }).join('');
    return `<h2 class="subj">${g.s.n}</h2>${rows}`;
  }).join('');
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${title}</title><style>
@page{size:A4;margin:15mm 13mm}
*{box-sizing:border-box}
body{margin:0;font:13px/1.75 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#14202a}
.hd{display:flex;justify-content:space-between;align-items:baseline;border-bottom:2px solid #14202a;padding-bottom:8px;margin-bottom:16px}
.hd h1{margin:0;font-size:20px;letter-spacing:.04em}
.hd span{font-size:11px;color:#71828f}
.subj{font-size:13px;letter-spacing:.16em;color:#c23c22;margin:20px 0 10px;padding-bottom:4px;border-bottom:1px solid #d6e0e6}
.q{display:flex;gap:9px;break-inside:avoid;page-break-inside:avoid;margin:0 0 16px}
.num{flex:0 0 20px;height:20px;border-radius:50%;background:#e8f1f4;color:#71828f;font-size:11px;
  display:flex;align-items:center;justify-content:center;margin-top:2px}
.qs{flex:1;min-width:0}
.txt{white-space:normal}
.pic{display:block;max-width:100%;max-height:72mm;margin:8px 0 0;border:1px solid #d6e0e6;border-radius:4px}
.blank{height:34mm;border-bottom:1px dashed #c3d0d8;margin-top:6px}
.ans{break-inside:avoid;margin:0 0 12px;padding-left:9px;border-left:2px solid #d6e0e6}
.ans b{display:block;font-size:12px;color:#14202a}
.a1{color:#c23c22;font-size:12.5px;margin-top:2px}
.a2{color:#3f4d59;font-size:12px;margin-top:3px}
.pb{break-before:page;page-break-before:always}
@media print{ body{-webkit-print-color-adjust:exact;print-color-adjust:exact} }
</style></head><body>
<div class="hd"><h1>${title}</h1><span>${dstr} · 共 ${list.length} 道</span></div>
${blocks}
<div class="pb"><div class="hd"><h1>答案与解析</h1><span>做完再翻这一页</span></div>${answers}</div>
</body></html>`;
  return { html, n:list.length };
}
async function printWeekly(){
  let out;
  try{ out = await weeklyHtml(); }
  catch(e){ console.warn(e); toast('生成失败，再试一次'); return; }
  const html=out.html, n=out.n;
  if(!n){ toast('还没有错题可以打'); return; }
  const d=new Date();
  const fname=`错题集_${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

  /* 安卓壳：WebView 里 window.print() 是空操作，必须交给壳的打印通道 */
  const bridge=window.WBShell;
  if(bridge && typeof bridge.printHtml==='function'){
    toast(`已排好 ${n} 道，正在唤起打印…`, 2200);
    try{ bridge.printHtml(html, '错题集'); return; }catch(e){ console.warn(e); }
    try{ bridge.saveHtml(html, fname); toast('已存成网页，用浏览器打开可打印', 3200); return; }catch(e){ console.warn(e); }
  }

  /* 浏览器 / 桌面：写进隐藏 iframe 再打印。等图片解码完再弹，不然 PDF 里图是空的 */
  const ifr=document.createElement('iframe');
  ifr.setAttribute('aria-hidden','true');
  ifr.style.cssText='position:fixed;right:0;bottom:0;width:390px;height:600px;border:0;opacity:0;pointer-events:none';
  document.body.appendChild(ifr);
  const doc=ifr.contentDocument;
  doc.open(); doc.write(html); doc.close();
  const imgs=Array.from(doc.images||[]);
  await Promise.race([
    Promise.all(imgs.map(im=> im.complete ? null : new Promise(r=>{ im.onload=im.onerror=()=>r(); }))),
    new Promise(r=>setTimeout(r, 3500)),
  ]);
  toast(`已生成 ${n} 道，正在唤起打印…`, 2000);
  await new Promise(r=>setTimeout(r, 220));
  try{
    ifr.contentWindow.focus();
    ifr.contentWindow.print();
  }catch(e){
    console.warn(e);
    const url=URL.createObjectURL(new Blob([html],{type:'text/html'}));
    window.open(url,'_blank');
    toast('已在新标签打开，用浏览器菜单里的「打印」', 3200);
  }
  setTimeout(()=>{ try{ ifr.remove(); }catch(e){} }, 120000);
}
/* ------------------------------------------------------------ 一次性清空
   本次发版要「清掉所有已有错题」（用户第 7 条要求）。这类清空只能跑一次，
   否则用户以后自己拍的题会在下次开机时被误删。做法：写一个版本标记，
   标记对得上就跳过；版本号一变，就再清一次。
   ⚠️ 必须在 boot 里、startSync 之前调用：先把本机与云端一起清干净，再去连云端。
      若放在 startSync 之后，syncPoll 会先把云端那几道题拉回本机 —— 等于白清。 */
/* 版本号一变，下次开机就再清一次。v2：图片通道修好后，把之前那批
   「文字在、图丢了」的旧数据整体清掉，让文达从干净的状态重新导入。 */
/* ==================================================== 首次使用引导
   给第一次打开的人（弟弟）的四步教学：拍题 → AI 填 → 核对保存 → 复习 + 举一反三。
   localStorage 记一笔，只看一次；设置里可重看（后续如需要再接）。 */
const OB_PAGES = [
  { t:'拍下你的错题',
    p:'作业本、卷子上的错题，点下面中间那个 ＋ 拍一张，或者从相册选。拍完可以拖动方框，只圈住那道题。',
    ico:'<path d="M3.6 8.6h3l1.6-2.4h7.6l1.6 2.4h3v10.2h-16.8z"/><circle cx="12" cy="13.5" r="3.3"/>' },
  { t:'AI 帮你填好',
    p:'学科、题干、答案、解析，AI 自动认、自动填。用的是免费模型，不花一分钱，放心拍。',
    ico:'<circle cx="12" cy="12" r="9"/><path d="M8.5 12.2l2.4 2.4 4.6-5"/>' },
  { t:'核对一遍再保存',
    p:'AI 偶尔也会看错 —— 像对答案一样核对一遍，改好了点最下面的「添加错题」，这道题就收进题库了。',
    ico:'<path d="M4.5 5.5h15v13h-15z"/><path d="M8 10h8M8 13.5h5"/>' },
  { t:'到点来复习',
    p:'App 会自己排复习时间，今天练几道，连续答对就升级。题目详情里还能「举一反三」，让 AI 出一道同类新题。',
    ico:'<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 3.6V9h-5.4"/>' },
];
let obIdx = 0;
function openOnboard(){
  obIdx = 0;
  paintOnboard();
  const el=$('#onboard');
  el.classList.add('on'); el.setAttribute('aria-hidden','false');
}
function paintOnboard(){
  const pg = OB_PAGES[obIdx];
  $('#onboard').innerHTML = `
    <div class="ob-card">
      <div class="ob-ico"><svg viewBox="0 0 24 24">${pg.ico}</svg></div>
      <h3>${pg.t}</h3>
      <p>${pg.p}</p>
      <div class="ob-dots">${OB_PAGES.map((_,i)=>`<i class="${i===obIdx?'on':''}"></i>`).join('')}</div>
      <div class="ob-btns">
        <button class="btn primary block" id="obNext">${obIdx===OB_PAGES.length-1?'开始用啦':'下一步'}</button>
        <button class="ob-skip" id="obSkip">跳过，我自己摸索</button>
      </div>
    </div>`;
  $('#obNext').onclick = ()=>{
    buzz(8);
    if(obIdx >= OB_PAGES.length-1) closeOnboard();
    else { obIdx++; paintOnboard(); }
  };
  $('#obSkip').onclick = ()=> closeOnboard();
}
function closeOnboard(){
  const el=$('#onboard');
  el.classList.remove('on'); el.setAttribute('aria-hidden','true');
  try{ localStorage.setItem('ct_onboard_v1','1'); }catch(e){}
}

const PURGE_VER = 'purge-2026-10-12-2';
async function purgeOnce(){
  try{
    /* ?nopurge=1：给无头自检用 —— 测试要预置数据，不能被这次清空冲掉 */
    if(/[?&]nopurge=1/.test(location.search)) return false;
    if(localStorage.getItem('wb_purge') === PURGE_VER) return false;
    const had = S.qs.length;
    /* ① 内存清空 —— SYNC.push 推的就是 S.qs */
    S.qs.forEach(q=>{ if(q.imageId) IMG.del(q.imageId); });
    S.qs=[];
    /* ② 推空 payload 覆盖云端。推失败就别落标记 —— 否则云端那几道题
       会被下一次 syncPoll 原样拉回来，用户看到「清空没用」。
       这里重试两次，还不行就留待下次开机再清。 */
    let cloudOk = !(SYNC.enabled && SYNC.room);
    if(!cloudOk){
      for(let i=0;i<3 && !cloudOk;i++){
        try{ await SYNC.push(); SYNC.markAt(Date.now()); cloudOk=true; }
        catch(e){ console.warn('purge cloud try', i+1, e); }
      }
    }
    /* ③ 删本地题库与图库，顺手清掉「已上传」的图标记（新旧两个 key 都要清，
       否则旧 key 里那批「假成功」的 id 会继续挡着重传） */
    await DB.clear().catch(()=>{});
    await tx('images','readwrite', s=>s.clear()).catch(()=>{});
    try{ localStorage.removeItem('wb_sync_imgs'); }catch(e){}
    try{ localStorage.removeItem('wb_sync_imgs_v2'); }catch(e){}
    IMGSYNC.published.clear();
    /* 只有本机 + 云端都清干净了才算数；云端没清成就不落标记，下次开机重来 */
    if(cloudOk) localStorage.setItem('wb_purge', PURGE_VER);
    console.info('已清空旧错题', had, '道，云端', cloudOk?'已同步':'暂未清掉');
    return cloudOk;
  }catch(e){ console.warn('purge', e); return false; }
}
function clearAll(){
  const n=S.qs.length;
  askConfirm({
    title:'清空全部错题？',
    body:`本机上的 ${n} 道错题会被全部删除，且无法恢复。${SYNC.enabled?'云端同一房间的备份也会一起清掉，否则下次同步会把它们拉回来。':''}建议先导出备份。`,
    ok:'全部清空',
    onOk: async ()=>{
      /* 顺序很关键：
         ① 先把内存里的 S.qs 清空 —— SYNC.push 推的就是它；
         ② 推一个空 payload 上云，覆盖掉云端的旧数据；
         ③ 再删本地库与图库。
         如果反过来（先删本地、云端没动），下一次 syncPoll 会发现
         「本机空、云端有」，又把刚删的题原样拉回来 —— 用户会觉得「清空没用」。 */
      S.qs.forEach(q=>{ if(q.imageId) IMG.del(q.imageId); });
      S.qs=[];
      let cloudOk=true;
      if(SYNC.enabled && SYNC.room){
        try{ await SYNC.push(); SYNC.markAt(Date.now()); }
        catch(e){ cloudOk=false; console.warn('clear cloud', e); }
      }
      await DB.clear().catch(()=>{});
      await tx('images','readwrite', s=>s.clear()).catch(()=>{});
      render();
      toast(cloudOk? '已清空' : '本机已清空，云端暂时没清掉', cloudOk?1800:3200);
    },
  });
}

/* ------------------------------------------------------------ 花瓣特效 */
function celebrate(small){
  const cv=$('#fx'); if(!cv) return;
  const dpr=Math.min(window.devicePixelRatio||1, 2);
  cv.width=innerWidth*dpr; cv.height=innerHeight*dpr;
  cv.style.width=innerWidth+'px'; cv.style.height=innerHeight+'px';
  const ctx=cv.getContext('2d'); ctx.setTransform(dpr,0,0,dpr,0,0);
  cv.classList.add('on');
  const N = small? 12 : 20;
  const cols=[cssv('--aka'),cssv('--shu'),cssv('--ai'),cssv('--paper-3')];
  const parts=[];
  for(let i=0;i<N;i++){
    parts.push({
      x: Math.random()*innerWidth,
      y: -30 - Math.random()*innerHeight*0.42,
      vx: -0.22 + Math.random()*0.44,
      vy: 0.85 + Math.random()*1.05,
      r: 5 + Math.random()*5,
      rot: Math.random()*Math.PI,
      vr: (Math.random()-.5)*0.022,
      sway: Math.random()*Math.PI*2,
      c: cols[i%cols.length],
    });
  }
  const t0=performance.now();
  (function loop(t){
    const el=t-t0;
    ctx.clearRect(0,0,innerWidth,innerHeight);
    const fade = el>2600 ? Math.max(0, 1-(el-2600)/900) : 1;
    parts.forEach(p=>{
      p.sway += 0.02;
      p.x += p.vx + Math.sin(p.sway)*0.55;
      p.y += p.vy;
      p.rot += p.vr;
      if(p.y > innerHeight+30 || fade<=0) return;
      ctx.save(); ctx.globalAlpha=fade*0.9; ctx.translate(p.x,p.y); ctx.rotate(p.rot);
      ctx.fillStyle=p.c;
      ctx.beginPath(); ctx.ellipse(0,0,p.r,p.r*0.62,0,0,Math.PI*2); ctx.fill();
      ctx.restore();
    });
    if(el<3600) requestAnimationFrame(loop);
    else { ctx.clearRect(0,0,innerWidth,innerHeight); cv.classList.remove('on'); }
  })(t0);
}

/* ------------------------------------------------------------ 启动 */
const race=(p,ms,dflt)=>Promise.race([
  Promise.resolve(p).catch(()=>dflt),
  new Promise(r=>setTimeout(()=>r(dflt), ms)),
]);
async function boot(){
  const hash=(location.hash||'').replace('#','');
  if(['home','bank','review','stats'].includes(hash)) S.tab=hash;
  THEME.init();                               // ⓪ 先把主题挂上，避免首屏闪一下白
  render();                                   // ① 首屏先渲染
  try{
    let list=(await race(DB.all(), 2600, [])) || [];
    list.forEach(normalize);
    S.qs=list;
    /* 老数据里的 base64 题图搬进 images store，再把 Blob 转成可显示的 URL。
       这里不再用 race 掐表：hydrate 现在是一次 getAll，很快；万一真被大库拖慢，
       也在完成后补一次 render，不会出现「补了一半就定稿」的空白图。 */
    const moved=await race(migrateImages(S.qs), 6000, 0);
    if(moved) console.info('已迁移题图', moved, '张');
    const hydrated=await IMG.hydrate(S.qs);
    if(hydrated) render();          // 有图补上了，立刻重画一次
    /* 写库自检：提前知道「这台设备能不能存图」，而不是等用户拍完题才弹错。
       结果只放进 S.imgStore，提示交给用户第一次真正存图时再出，不打扰开机。 */
    S.imgStore = await race(IMG.selfTest(), 2500, null);
    if(S.imgStore) console.warn('题图仓库不可写：', S.imgStore);
    const meta=await race(DB.getMeta('settings'), 1800, null);
    if(meta && typeof meta==='object') S.settings={...S.settings, ...meta};
    /* 学习日志：老库没有 log，就用 lastReview 回填一次，热力图不至于一片空白 */
    LOG.load(await race(DB.getMeta('log'), 1800, null));
    LOG.backfill(S.qs);
    THEME.apply();                 // 设置读进来了，外观可能跟系统不一样
    /* 房间名从网址派生，不需要用户记任何东西 */
    SYNC.load();
    IMGSYNC.load();
    if(navigator.storage && navigator.storage.persisted)
      S.persist=await race(navigator.storage.persisted(), 1200, false);
  }catch(e){ console.warn('db init', e); }
  if(/[?&]demo=1/.test(location.search) && !S.qs.length) S.qs=seedDemo();
  /* 发版一次性清空：本机 + 云端一起清，必须在 startSync 之前，否则会被同步拉回来 */
  const purged = await purgeOnce();
  render();                                   // ② 数据到位刷新
  if(purged) setTimeout(()=>toast('旧错题已清空，可以重新开始啦', 2600), 900);

  /* 同一个网址就是同一个房间：开上台就在后台对齐，不用点任何东西 */
  startSync();
  document.addEventListener('visibilitychange', ()=>{
    if(document.visibilityState!=='visible') return;
    syncPoll();
    NOTI.arm();
    NOTI.fire();                    // 错过了就补发（一天只发一次）
  });
  window.addEventListener('online', ()=>{ syncUp(true); syncPoll(); });
  /* 横竖屏切换后趋势图要按新宽度重画 */
  let rzT=0;
  window.addEventListener('resize', ()=>{
    clearTimeout(rzT);
    rzT=setTimeout(()=>{ if(S.tab==='stats') drawStats(); }, 200);
  });
  NOTI.arm();
  setTimeout(()=>NOTI.fire(), 4000);   // 打开就检查一次：今天到点了没

  /* 安卓壳内不注册 Service Worker —— 壳里的网络请求不经过 shouldInterceptRequest，
     SW 会绕过内置 assets 去拉线上文件，结果就是「壳里显示旧版网页」。
     壳内首屏本来就由 assets 提供，用不上 SW；顺手注销掉历史注册。 */
  const IS_SHELL = !!(window.WBShell && window.WBShell.isShell && window.WBShell.isShell());
  if('serviceWorker' in navigator){
    if(IS_SHELL){
      navigator.serviceWorker.getRegistrations()
        .then(rs=>rs.forEach(r=>r.unregister()))
        .catch(()=>{});
    }else{
      addEventListener('load', ()=>{ navigator.serviceWorker.register('sw.js').catch(()=>{}); });
    }
  }
  const bs=$('#btnSettings');
  if(bs) bs.onclick=()=>{ buzz(); openSettings(); };

  // AI 预热（静默，失败不影响使用）
  AI.pickModel().catch(()=>{});

  if(!localStorage.getItem('wb_seen_v2')){
    localStorage.setItem('wb_seen_v2','1');
    setTimeout(()=>toast('提示：可「添加到主屏幕」当 App 使用', 3000), 1200);
  }

  /* 首次使用引导：拍题 → AI 填 → 核对保存 → 复习+举一反三，只看一次 */
  if(!localStorage.getItem('ct_onboard_v1')){
    setTimeout(()=>{ if(!$('#sheet').classList.contains('on')) openOnboard(); }, 900);
  }
}
/* 预览用示例数据（?demo=1） */
function seedDemo(){
  const now=Date.now();
  const raw=[
    { subject:'chinese', difficulty:2, mastery:1, tags:['文言实词','一词多义'], content:'解释《烛之武退秦师》中「微夫人之力不及此」的「微」是什么意思。', answer:'微：如果没有、假如没有', analysis:'「微」在文言里常表假设性否定，相当于「如果没有」。全句意为「假如没有那个人的力量，我到不了今天」。', reviews:2, correct:1, due:now-3600000 },
    { subject:'chinese', difficulty:1, mastery:0, type:'choice', options:[{k:'A',t:'按步就班'},{k:'B',t:'川流不息'},{k:'C',t:'一如即往'},{k:'D',t:'名列前矛'}], content:'下列词语中没有错别字的一项是（ ）', answer:'B', analysis:'A 应为「按部就班」，C 应为「一如既往」，D 应为「名列前茅」——「茅」指古时楚人采贡之草，不是「矛」。', reviews:0, wrong:1, due:now },
    { subject:'math', difficulty:2, mastery:1, tags:['根与系数','韦达'], content:'已知 x₁、x₂ 是方程 x²-5x+3=0 的两个根，求 x₁²+x₂² 的值。', answer:'19', analysis:'由韦达定理 x₁+x₂=5、x₁x₂=3，所以 x₁²+x₂²=(x₁+x₂)²-2x₁x₂=25-6=19。', reviews:3, correct:1, due:now+3*DAY },
    { subject:'math', difficulty:1, mastery:2, tags:['绝对值'], content:'求满足 |x-2|=3 的所有 x 的值。', answer:'x=5 或 x=-1', analysis:'绝对值方程化两路：x-2=3 得 x=5；x-2=-3 得 x=-1。', reviews:2, correct:2, due:now+9*DAY },
    { subject:'english', difficulty:1, mastery:1, tags:['固定搭配'], content:'He is good ___ playing basketball.', answer:'at', analysis:'be good at 表示擅长，后接动名词。同类还有 do well in。', reviews:2, correct:1, due:now-3600000 },
    { subject:'english', difficulty:2, mastery:0, tags:['现在完成时'], content:'— How long ___ you ___ this book? — For two days.', answer:'have; kept', analysis:'「For two days」表示持续到现在，用现在完成时；borrow 是瞬间动词不能延续，要换成 keep。', reviews:1, wrong:1, due:now },
    { subject:'physics', difficulty:1, mastery:1, tags:['密度'], content:'一块质量为 540g、体积为 200cm³ 的金属块，密度是多少？可能是铝做的吗？', answer:'2.7g/cm³；可能是铝', analysis:'ρ=m/V=540/200=2.7g/cm³，与铝的密度相同，所以可能是铝。', reviews:2, correct:1, due:now+5*DAY },
    { subject:'physics', difficulty:2, mastery:0, tags:['浮力','漂浮'], content:'一个重 6N 的木块漂浮在水面上，它受到的浮力是多大？排开水的重力是多大？', answer:'6N；6N', analysis:'漂浮时浮力等于重力，所以是 6N；由阿基米德原理，浮力等于排开液体所受的重力，所以排开水的重力也是 6N。', reviews:0, wrong:1, due:now },
  ];
  return raw.map((r,i)=>{
    const q={ id:'demo'+i, ease:2.5, interval:PLAN[r.mastery].first, correct:0, wrong:0,
      createdAt: now-(i+1)*3600000*7, updatedAt: now, ...r };
    q.imageId=null;
    q.lastReview = r.reviews? now-(i+1)*3600000*5 : 0;
    return normalize(q);
  });
}
function calcStreak(){
  const days=new Set(S.qs.filter(q=>q.lastReview).map(q=>dayKey(q.lastReview)));
  if(!days.size) return 0;
  let n=0, d=new Date(); d.setHours(0,0,0,0);
  if(!days.has(dayKey(d.getTime()))) d=new Date(d.getTime()-DAY);
  while(days.has(dayKey(d.getTime()))){ n++; d=new Date(d.getTime()-DAY); }
  return n;
}
SYNC.load();
IMGSYNC.load();
boot();
