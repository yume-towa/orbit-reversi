/* ---------- オンライン対戦（Firebase Realtime Database） ----------
   index.html の後に読み込む。盤面・手番・演出は index.html の処理をそのまま使い、ここでは部屋と着手のやり取りだけを行う。

   部屋のデータ: rooms/{部屋コード}
     host, guest  … 部屋を作った人・参加した人の匿名ユーザーID
     hostColor    … 部屋を作った人の色（1=黒 2=白）
     settings     … 旋回の設定 {rotType, rotCount, rotEvery}
     seed         … 旋回の抽選に使う乱数のタネ（両者の画面で同じ旋回にするため）
     moves/{n}    … n手目（0始まり）の着手 {r, c, by}
                    パスは記録しない（同じ盤面からは両者の画面で同じようにパスと判定されるため）
     presence/{uid} … 対局中に部屋にいる印（通信が切れるとサーバーが自動で消す）
*/
const FIREBASE_CONFIG={
  apiKey:'AIzaSyAF7A6RC5Ewf-1Mfwx-k_IZY9lvNbnAL48',
  authDomain:'orbit-reversi.firebaseapp.com',
  databaseURL:'https://orbit-reversi-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId:'orbit-reversi',
  storageBucket:'orbit-reversi.firebasestorage.app',
  messagingSenderId:'74076297407',
  appId:'1:74076297407:web:ada62dc408f8329fca0e0a'
};
const FIREBASE_SDK='https://www.gstatic.com/firebasejs/12.4.0/';
const CODE_CHARS='23456789ABCDEFGHJKLMNPQRSTUVWXYZ';   // 見間違えやすい 0/O・1/I は使わない
const CODE_LEN=5;

let fbReady=null;   // Firebase の読み込みと匿名ログイン（初回だけ行う）
let online=null;    // 参加中の部屋 {code, ref, uid, room, applied, pending, sent}
let connecting=false;   // 部屋の作成・参加の処理中（ボタンの連打で二重に動かさない）

/* ---------- 接続 ---------- */
function loadScript(src){
  return new Promise((ok,ng)=>{
    const s=document.createElement('script');
    s.src=src; s.onload=ok; s.onerror=()=>ng(new Error('読み込みに失敗: '+src));
    document.head.appendChild(s);
  });
}
/* オンラインを使うときだけ Firebase を読み込む（対人・AI対戦は通信なしで動く） */
function fbInit(){
  if(!fbReady) fbReady=(async()=>{
    for(const m of ['app','auth','database']) await loadScript(FIREBASE_SDK+'firebase-'+m+'-compat.js');
    if(!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
    const auth=firebase.auth();
    await auth.setPersistence(firebase.auth.Auth.Persistence.SESSION);   // タブごとに別のユーザー（同じブラウザの2タブでも対戦できる）
    const cred=await auth.signInAnonymously();
    return {uid:cred.user.uid, db:firebase.database()};
  })().catch(e=>{ fbReady=null; throw e; });
  return fbReady;
}

/* ---------- 画面表示 ---------- */
function onlineMsg(t,err){
  const el=document.getElementById('online-msg');
  el.textContent=t||''; el.classList.toggle('err',!!err);
}
function onlineFail(e){
  console.error(e);
  const denied=/permission/i.test((e&&(e.code||e.message))||'');
  onlineMsg(denied? '部屋の操作がデータベースに拒否されました。' : 'オンラインに接続できませんでした。通信環境を確かめてください。', true);
}
function inviteUrl(code){ return location.href.split(/[?#]/)[0]+'?room='+code; }
function showWaiting(code){
  document.getElementById('wait-code').textContent=code;
  document.getElementById('wait-url').textContent=inviteUrl(code);
  document.getElementById('online-wait').style.display='';
  document.querySelector('.setup-panel').classList.add('waiting');
}
function hideWaiting(){
  document.getElementById('online-wait').style.display='none';
  document.querySelector('.setup-panel').classList.remove('waiting');
}
function onlineCopyUrl(){
  if(!online) return;
  const url=inviteUrl(online.code);
  (navigator.clipboard? navigator.clipboard.writeText(url) : Promise.reject())
    .then(()=>onlineMsg('招待URLをコピーしました。相手に送ってください。'),
          ()=>onlineMsg('コピーできませんでした。上のURLを選んでコピーしてください。',true));
}

/* ---------- 部屋を作る・参加する・抜ける ---------- */
function randomCode(){
  let s=''; for(let i=0;i<CODE_LEN;i++) s+=CODE_CHARS[(Math.random()*CODE_CHARS.length)|0];
  return s;
}
async function onlineCreateRoom(){
  if(online || connecting) return;
  connecting=true;
  onlineMsg('接続中…');
  try{
    const {uid,db}=await fbInit();
    const room={host:uid, hostColor:humanColor, settings:{rotType,rotCount,rotEvery},
                seed:(Math.random()*4294967296)>>>0, createdAt:firebase.database.ServerValue.TIMESTAMP};
    let code=null, ref=null;
    for(let i=0;i<5 && !code;i++){
      const c=randomCode(), r=db.ref('rooms/'+c);
      try{ await r.set(room); code=c; ref=r; }
      catch(e){ if(i===4) throw e; }   // 同じコードの部屋があると書き込みが拒否されるので、別のコードでやり直す
    }
    online={code, ref, uid, room, applied:0, pending:new Map(), sent:-1};
    onlineMsg('');
    showWaiting(code);
    ref.child('guest').on('value', s=>{
      if(!s.val() || !online || online.ref!==ref || onlineColor) return;
      online.room.guest=s.val();
      onlineBegin();
    });
  }catch(e){ onlineFail(e); }
  finally{ connecting=false; }
}
async function onlineJoin(){
  if(online || connecting) return;
  const code=document.getElementById('join-code').value.toUpperCase().replace(/[^0-9A-Z]/g,'');
  if(code.length!==CODE_LEN || [...code].some(ch=>!CODE_CHARS.includes(ch))){
    onlineMsg(`部屋コード（${CODE_LEN}文字）を入力してください。`,true); return;
  }
  connecting=true;
  onlineMsg('接続中…');
  try{
    const {uid,db}=await fbInit();
    const ref=db.ref('rooms/'+code);
    const room=(await ref.once('value')).val();
    if(!room){ onlineMsg('その部屋は見つかりませんでした。コードを確かめてください。',true); return; }
    if(room.host===uid){ onlineMsg('自分が作った部屋には参加できません。',true); return; }
    if(room.guest){ onlineMsg('その部屋はすでに対戦が始まっています。',true); return; }
    await ref.child('guest').set(uid);   // 同時に別の人が参加していたら、ここで拒否される
    room.guest=uid;
    online={code, ref, uid, room, applied:0, pending:new Map(), sent:-1};
    onlineBegin();
  }catch(e){ onlineFail(e); }
  finally{ connecting=false; }
}
/* 両者がそろったら、部屋の設定とタネで対局を始め、着手の受信を開始する */
function onlineBegin(){
  const {room,uid,ref}=online;
  hideWaiting(); onlineMsg('');
  setMode('online');
  setRotType(room.settings.rotType); setRotCount(room.settings.rotCount); setRotEvery(room.settings.rotEvery);
  onlineColor= uid===room.host? room.hostColor : opp(room.hostColor);
  document.body.classList.add('online');
  startGame(room.seed);
  ref.child('moves').on('child_added', s=>{
    if(!online || online.ref!==ref) return;
    online.pending.set(Number(s.key), s.val());
    onlinePump();
  });
  onlinePresence();
}
function onlineLeave(){
  if(!online) return;
  const {ref,room,uid}=online;
  ref.child('guest').off(); ref.child('moves').off();
  if(room.guest){   // 在室の印を消して、相手に退出を知らせる
    const me=ref.child('presence/'+uid);
    me.onDisconnect().cancel(); me.remove().catch(()=>{});
    ref.child('presence/'+(uid===room.host? room.guest : room.host)).off();
    if(online.connCb) firebase.database().ref('.info/connected').off('value', online.connCb);
  }
  if(uid===room.host && !room.guest) ref.remove().catch(()=>{});   // 相手が来る前なら部屋ごと消す
  online=null; onlineColor=0;
  document.body.classList.remove('online');
  hideWaiting(); onlineStatus();
}
function onlineCancel(){ onlineLeave(); onlineMsg(''); }

/* ---------- 接続状態（自分・相手の通信切れの表示） ---------- */
function onlinePresence(){
  const {ref,uid,room}=online;
  const me=ref.child('presence/'+uid);
  // 接続（再接続）のたびに、切れたら消える印を書き直す
  online.connCb=firebase.database().ref('.info/connected').on('value', s=>{
    if(!online || online.ref!==ref) return;
    online.connected=s.val()===true;
    if(online.connected){ online.wasConnected=true; me.onDisconnect().remove().catch(()=>{}); me.set(true).catch(()=>{}); }
    onlineStatus();
  });
  ref.child('presence/'+(uid===room.host? room.guest : room.host)).on('value', s=>{
    if(!online || online.ref!==ref) return;
    online.oppHere=s.val()===true;
    if(online.oppHere) online.oppSeen=true;   // 一度も来ていないうちは「切れた」と表示しない
    onlineStatus();
  });
}
function onlineStatus(){
  let t='';
  if(online && onlineColor){
    if(online.wasConnected && !online.connected) t='通信が切れています。再接続を待っています…';
    else if(online.oppSeen && !online.oppHere)
      t= over? '相手は部屋から抜けました。' : '相手との接続が切れました。戻ってくるのを待つか、「設定へ」で抜けてください。';
  }
  const el=document.getElementById('online-status');
  el.textContent=t; el.style.display= t? '' : 'none';
}

/* ---------- 着手のやり取り ---------- */
/* 自分の手を送る。書き込むと自分の画面にもすぐ「届いた手」として通知され、onlinePump で進む */
function onlineSend(r,c){
  if(!online || online.sent===online.applied) return;   // 送った手の反映待ちなら二重に送らない
  const n=online.applied;
  online.sent=n;
  online.ref.child('moves/'+n).set({r,c,by:online.uid})
    .catch(e=>{ console.error(e); log('通信エラー：手を送れませんでした。'); });
}
/* 届いた手を順番どおりに1手ずつ進める（演出中は待ち、endTurn から再び呼ばれる） */
function onlinePump(){
  if(!online || !onlineColor || busy || over) return;
  const mv=online.pending.get(online.applied);
  if(!mv) return;
  online.pending.delete(online.applied);
  online.applied++;
  const color= mv.by===online.room.host? online.room.hostColor : opp(online.room.hostColor);
  if(color!==player || !legalCells(player).includes(mv.r+','+mv.c)){
    log('受信した手が盤面と合わないため、対局を続けられません。'); return;
  }
  playPlacement(mv.r, mv.c, glyph(player)+(color===onlineColor?'(あなた)':'(相手)'));
}

/* 招待URL（?room=コード）で開いたときは、オンラインを選んでコードを入れておく */
(function(){
  const code=new URLSearchParams(location.search).get('room');
  if(!code) return;
  setMode('online');
  document.getElementById('join-code').value=code.toUpperCase();
  onlineMsg('招待された部屋のコードが入っています。「参加」を押してください。');
})();
