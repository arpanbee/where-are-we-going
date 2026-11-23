// Where Are We Going? client. The server owns the puzzle, judges guesses and decides
// what the partner may see; this file renders and polls.
import { api } from './api.js';

// Destination list, shared with the server (api/wawg/destinations.json). Loaded at start.
let DEST=[],BY={};
async function loadDestinations(){const r=await fetch('/destinations.json');if(!r.ok)throw new Error('destinations '+r.status);DEST=await r.json();BY=Object.fromEntries(DEST.map(d=>[d.id,d]))}

const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ymd=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const localDate=()=>ymd(new Date());
const arrow=d=>['↑','↗','→','↘','↓','↙','←','↖'][Math.round(d/45)%8];
const SQ={g:'🟩',y:'🟨',o:'🟧',r:'🟥'};
const fmt=n=>Math.round(n).toLocaleString();
const ls={get(k,d){try{return JSON.parse(localStorage.getItem('wawg:'+k))??d}catch(e){return d}},set(k,v){try{localStorage.setItem('wawg:'+k,JSON.stringify(v))}catch(e){}}};
const POLL_MS=20000;

// today: the server's view of my daily play. state: couple, partner status, week scores.
// cur: which puzzle the Today tab shows (the daily one, or a partner round in `round`).
// list: bucket list from the server (my votes, trips we both want). rounds: inbox + sent.
const S={date:localDate(),tab:'play',today:null,state:null,cur:{kind:'daily'},round:null,rounds:null,list:null,
  make:{dest:null,note:'',clues:null,busy:false},err:'',ok:'',ready:false,busy:false,loadErr:'',lastN:0};
const couple=()=>S.state?.couple||null;
const paired=()=>Boolean(couple()?.paired);
const grid=tiers=>tiers.map(t=>SQ[t]).join('');
const myGrid=pl=>grid(pl.guesses.map(g=>g.tier));
const curPlay=()=>S.cur.kind==='round'?S.round:S.today;
const myVote=d=>S.list?.mine?.[d];

// --- Server calls -----------------------------------------------------------------

async function loadToday(){try{S.today=await api.today(S.date);S.loadErr=''}catch(e){S.loadErr=e.message}}
let stateBusy=false;
async function refreshState(){if(stateBusy)return;stateBusy=true;
  try{const s=await api.state(S.date);const changed=JSON.stringify(s)!==JSON.stringify(S.state);S.state=s;if(changed)render()}
  catch(e){/* keep the last good state; polling will retry */}
  finally{stateBusy=false}}

async function guess(id){const pl=curPlay();if(!pl||S.busy||pl.done||!BY[id]||pl.guesses.some(g=>g.destId===id))return;
  S.busy=true;
  try{if(S.cur.kind==='round'){S.round=await api.roundGuess(couple().code,S.cur.id,id);refreshRounds()}
      else{S.today=await api.guess(S.date,id);refreshState()}}
  catch(e){S.err=e.message;if(e.status===409)await(S.cur.kind==='round'?openRound(S.cur.id):loadToday())}
  S.busy=false;render();document.getElementById('gi')?.focus()}

// --- Partner rounds
async function refreshRounds(){if(!paired())return;try{S.rounds=await api.rounds(couple().code)}catch(e){}if(S.tab==='rounds')render()}
async function openRound(id){S.cur={kind:'round',id};S.round=null;S.tab='play';S.lastN=0;render();
  try{S.round=await api.round(couple().code,id)}catch(e){S.err=e.message;S.cur={kind:'daily'}}render()}
async function genClues(){const d=BY[S.make.dest];if(!d||S.make.busy)return;S.make.busy=true;render();
  try{S.make.clues=(await api.draftRound(couple().code,d.id,S.make.note.trim())).draft.clues}
  catch(e){S.err=e.message;S.make.clues=['','','','','','']}
  S.make.busy=false;render()}
async function sendRound(){render();const d=BY[S.make.dest],cl=(S.make.clues||[]).map(c=>c.trim());if(!d)return;
  if(cl.length<6||cl.some(c=>!c)){S.err='Fill in all 6 clues first.';return render()}
  try{await api.sendRound(couple().code,d.id,cl);S.make={dest:null,note:'',clues:null,busy:false};S.ok='Sent. It’s waiting in your partner’s Partner rounds.';await refreshRounds()}
  catch(e){S.err=e.message}render()}

// --- Bucket list (server-side, so it's shared with your partner)
async function refreshList(){try{S.list=await api.list(S.date)}catch(e){}}
async function vote(d,v){if(!BY[d])return;S.list={...(S.list||{}),mine:{...(S.list?.mine||{}),[d]:v}};render();
  try{await api.vote(d,v);await refreshList()}catch(e){S.err=e.message}render()}
// One-time move of votes saved in this browser (before the shared list existed) to the server.
async function migrateLocalVotes(){const old=Object.values(ls.get('votes',{})).filter(v=>v&&BY[v.dest]&&(v.v===0||v.v===1));if(!old.length)return;
  try{for(const v of old)await api.vote(v.dest,v.v);ls.set('votes',{})}catch(e){/* try again next visit */}}

async function createPair(){try{await api.createCouple();await refreshState()}catch(e){S.err=e.message}render()}
async function joinPair(raw){const code=raw.trim().toUpperCase();if(!/^[A-Z0-9]{6}$/.test(code)){S.err='Codes are 6 letters and numbers.';return render()}
  try{await api.joinCouple(code);await refreshState();S.tab='play';S.ok='Paired! Today’s puzzle is now shared.'}catch(e){S.err=e.message}render()}
async function unpair(){try{await api.leaveCouple();await refreshState()}catch(e){S.err=e.message}render()}


// --- Views ------------------------------------------------------------------------

function weekRows(){const w=[['You',S.state?.me?.week??0]];if(paired())w.push(['Your partner',S.state.partner?.week??0]);return w}

function shareText(pl){const round=S.cur.kind==='round';let s=(round?'Where are we going? · partner round':`Where are we going? #${pl.num}`)+`\n${myGrid(pl)} ${pl.solved?pl.guesses.length:'X'}/6`;
  if(paired()&&!round){const[[,me],[,them]]=weekRows();s+=`\nMe ${me} – Them ${them} this week ✈️`}return s}

function vPlay(){const round=S.cur.kind==='round';
  if(round&&!S.round)return'<p class="muted">Loading your round…</p>';
  if(!round&&!S.today)return S.loadErr?`<section><h2>Couldn’t load today’s puzzle</h2><p>${esc(S.loadErr)}</p><button class="btn" data-act="retry">Try again</button></section>`:'<p class="muted">Boarding…</p>';
  const pl=curPlay(),t=pl.answer?BY[pl.answer]:null,n=pl.clues.length;const fresh=n>S.lastN&&S.lastN>0;S.lastN=n;
  const clues=Array.from({length:pl.totalClues},(_,i)=>i<n?`<li class="clue${fresh&&i===n-1?' new':''}"><span class="cn">${i+1}</span><span>${esc(pl.clues[i])}</span></li>`:`<li class="clue locked"><span class="cn">${i+1}</span><span>Locked. Each wrong guess unlocks the next clue.</span></li>`).join('');
  const rows=pl.guesses.map(g=>{const d=BY[g.destId];if(!d)return'';return`<li class="g ${g.tier}"><span class="sq"></span><b>${esc(d.name)}</b><span class="ct">${esc(d.country)}</span>${g.tier==='g'?'<span class="km">Landed</span>':`<span class="km">${fmt(g.km)} km</span><span class="ar" aria-label="direction to target">${arrow(g.bearing)}</span>`}</li>`}).join('');
  const v=t?myVote(t.id):undefined;
  const foot=pl.done&&t?`<div class="result"><div class="stamp${pl.solved?'':' miss'}">${pl.solved?'Arrived':'Missed it'}: ${esc(t.name)}</div>
    <p>${pl.solved?`Solved in ${pl.guesses.length}/6 for <b>${pl.points} point${pl.points>1?'s':''}</b>.`:`It was ${esc(t.name)}, ${esc(t.country)}. No points this time.`}</p>
    <div class="row"><span>Would you go?</span><button class="btn ghost" data-act="vote" data-d="${t.id}" data-v="1" aria-pressed="${v===1}">We should go</button><button class="btn ghost" data-act="vote" data-d="${t.id}" data-v="0" aria-pressed="${v===0}">Not for me</button></div>
    <pre class="share" id="sharetxt">${esc(shareText(pl))}</pre><div class="row" style="margin-top:10px"><button class="btn coral" data-act="share">Copy result</button>${round?'<button class="btn ghost" data-act="today">Back to today’s puzzle</button>':''}</div></div>`
    :`<div class="ask"><label for="gi">Your guess (${pl.guesses.length}/6)</label><input type="text" id="gi" autocomplete="off" placeholder="Start typing a city, island or region"><div class="sug" id="sug-gi"></div></div>`;
  return`<div class="grid"><div><div class="pass"><div class="ph"><div><small>From</small><strong>Home</strong></div><svg class="plane" viewBox="0 0 120 24" preserveAspectRatio="none" aria-hidden="true"><path d="M2 12H104" stroke="currentColor" stroke-width="2" stroke-dasharray="4 6" fill="none"/><path d="M104 4l14 8-14 8 4-8z" fill="currentColor"/></svg><div><small>To</small><strong>${t?esc(t.name):'???'}</strong></div><div class="stub"><small>${round?'Round':'Flight'}</small><strong>${round?'From your partner':'#'+esc(pl.num)}</strong></div></div>
    <div class="pb"><ol class="clues">${clues}</ol><ul class="gs">${rows}</ul>${foot}</div></div>
    <p class="muted">Colours show how close a guess was: green is right, yellow under 500 km, orange under 2,000 km, red further. The arrow points toward the answer.</p></div>
    <aside>${round?`<div class="side"><h3>Set by your partner</h3><p>They picked this place for you. The clues were written for this round, and it doesn’t count toward the weekly score.</p>${pl.done?'':'<button class="btn ghost" data-act="today">Back to today’s puzzle</button>'}</div>`:vPartner()}${vWeek()}</aside></div>`}

function vPartner(){const c=couple();
  if(!c)return`<div class="side"><h3>Play it together</h3><p>Pair up to see each other’s results, keep a weekly score and build a shared bucket list.</p><button class="btn" data-tab="pair">Pair up</button></div>`;
  if(!c.paired)return`<div class="side"><h3>Waiting for your partner</h3><p>Give them your code: <span class="code">${esc(c.code)}</span></p></div>`;
  const p=S.state.partner||{},r=p.result,who='Your partner';
  const body=p.status==='guessing'?`<p>${who} is still guessing.</p>`:p.status!=='finished'?`<p>${who} hasn’t played today’s puzzle yet.</p>`:!r?`<p>${who} has finished. Finish yours to see how they did.</p>`
    :`<p style="font-size:22px;margin:0">${grid(r.tiers)}</p><p>${r.solved?`${r.tiers.length}/6 · ${r.points} pts`:'Missed it'}</p>`;
  return`<div class="side"><h3>${who}</h3>${body}</div>`}

function vWeek(){const w=weekRows(),max=Math.max(1,...w.map(x=>x[1])),top=Math.max(...w.map(x=>x[1]));const lead=w.filter(x=>x[1]===top).length===1&&top>0;
  return`<div class="side"><h3>This week</h3>${w.map(([who,v])=>`<div class="bar${lead&&v===top?' lead':''}"><span>${esc(who)}</span><span class="t"><i style="width:${Math.round(v/max*100)}%"></i></span><b>${v}</b></div>`).join('')}
  <p class="muted">Up to 6 points a day. Resets Monday. ${paired()?'Whoever leads on Sunday picks date night.':''}</p></div>`}

function vRounds(){
  if(!paired())return`<section><h2>Partner rounds</h2><p>Pick a place that means something to the two of you, and your partner has to guess it from six clues. Pair up first.</p><button class="btn" data-tab="pair">Pair up</button></section>`;
  const st=r=>r.status==='not-started'?'Not played yet':r.status==='guessing'?'In progress':r.status==='solved'?`Solved in ${r.guessCount}/6`:'Missed it';
  const when=r=>new Date(r.created).toLocaleDateString();
  const list=(arr,mine)=>!S.rounds?'<p class="muted">Loading…</p>':arr.length?`<div class="cards">${arr.map(r=>`<div class="item"><div><b>${r.destId&&BY[r.destId]?esc(BY[r.destId].name):'Mystery destination'}</b><span class="muted">${when(r)} · ${mine?'Your partner: ':''}${st(r)}</span></div>${mine?'':`<button class="btn${r.status==='solved'||r.status==='missed'?' ghost':''}" data-act="playc" data-id="${esc(r.id)}">${r.status==='solved'||r.status==='missed'?'View':r.status==='guessing'?'Resume':'Play'}</button>`}</div>`).join('')}</div>`:`<p class="muted">${mine?'Nothing sent yet.':'Nothing waiting for you yet.'}</p>`;
  const m=S.make,d=BY[m.dest];
  const clueIns=m.clues?`<div style="margin-top:14px"><label>Clues, vaguest first. Edit anything.</label>${m.clues.map((c,i)=>`<div class="cluein"><span class="cn">${i+1}</span><input type="text" id="mkc${i}" maxlength="160" value="${esc(c)}"></div>`).join('')}<button class="btn coral" data-act="send">Send to your partner</button></div>`:'';
  const make=`<div class="side"><h3>Make one for your partner</h3>${d?`<div class="chip">${esc(d.name)}, ${esc(d.country)}<button data-act="unpick" aria-label="Change destination">×</button></div>`:`<label for="mk">Destination</label><input type="text" id="mk" autocomplete="off" placeholder="Honeymoon spot, first trip, dream trip"><div class="sug" id="sug-mk"></div>`}
    <div style="margin-top:12px"><label for="mknote">A private hint for the clue writer (optional)</label><textarea id="mknote" maxlength="240" placeholder="e.g. where we got engaged, the trip with the missed ferry">${esc(m.note)}</textarea></div>
    ${d&&!m.clues?`<div class="row" style="margin-top:12px"><button class="btn" data-act="gen" ${m.busy?'disabled':''}>${m.busy?'Writing clues…':'Write the clues for me'}</button><button class="btn ghost" data-act="selfwrite">I’ll write them</button></div>`:''}${clueIns}</div>`;
  return`<div class="grid"><div><section><h2>For you</h2>${list(S.rounds?.inbox||[],false)}</section><section><h2>You sent</h2>${list(S.rounds?.sent||[],true)}</section></div><aside>${make}</aside></div>`}

function vList(){if(!S.list)return'<p class="muted">Loading your list…</p>';
  const ok=a=>(a||[]).filter(d=>BY[d]),both=ok(S.list.both),mine=ok(S.list.onlyMe),theirs=ok(S.list.partnerWants);
  const tags=(a,cl)=>`<div class="list">${a.map(d=>`<div class="tag ${cl}"><b>${esc(BY[d].name)}</b><span>${esc(BY[d].country)}</span></div>`).join('')}</div>`;
  return`<section><h2>Trips we both want</h2>${both.length?tags(both,''):`<p class="muted">${paired()?'When you both tap “We should go” on the same place, it lands here.':'Pair up and this fills with places you both said yes to.'}</p>`}</section>
  <section><h2>Only you so far</h2>${mine.length?tags(mine,'solo'):'<p class="muted">Finish a puzzle and tap “We should go”.</p>'}</section>
  ${theirs.length?`<section><h2>Your partner wants to go</h2><p class="muted">Play those puzzles to cast your vote.</p>${tags(theirs,'solo')}</section>`:''}`}

function vPair(){
  if(!S.ready)return'<p class="muted">Connecting…</p>';
  if(!S.state)return`<section><h2>Pairing isn’t available right now</h2><p>Couldn’t reach the game. You can still play today’s puzzle.</p><button class="btn" data-act="retry">Try again</button></section>`;
  const c=couple();
  if(c)return`<section><h2>${c.paired?'You’re paired':'Waiting for your partner'}</h2><p>Your couple code</p><p class="code">${esc(c.code)}</p>${c.paired?'<p>You + your partner</p>':'<p>Ask your partner to open this page, go to Pair up and enter the code.</p>'}<button class="btn ghost" data-act="unpair">Leave this pairing</button></section>`;
  return`<div class="grid"><section><h2>Start a pairing</h2><p>Get a code, then have your partner enter it on their side.</p><button class="btn" data-act="create">Create a couple code</button>
    <h2 style="margin-top:28px">Got a code?</h2><label for="jc">Enter your partner’s code</label><div class="row"><input type="text" id="jc" maxlength="6" placeholder="ABC123" style="max-width:12em;text-transform:uppercase"><button class="btn" data-act="join">Join</button></div></section>
    <aside class="side"><h3>How it works</h3><p>You both play the same daily puzzle. You won’t see each other’s results until you’ve each finished.</p><p class="muted">Your pairing is tied to this browser. If you clear its site data, you’ll need to pair again.</p></aside></div>`}

function refreshSug(id){const inp=document.getElementById(id),box=document.getElementById('sug-'+id);if(!inp||!box)return;const v=inp.value.trim().toLowerCase();if(!v){box.innerHTML='';return}
  const used=id==='gi'?(curPlay()?.guesses||[]).map(g=>g.destId):[];
  const r=DEST.filter(d=>!used.includes(d.id)&&(d.name.toLowerCase().includes(v)||d.country.toLowerCase().startsWith(v))).sort((a,b)=>b.name.toLowerCase().startsWith(v)-a.name.toLowerCase().startsWith(v)).slice(0,6);
  box.innerHTML=r.length?r.map(d=>`<button data-act="${id==='gi'?'guess':'pick'}" data-d="${d.id}">${esc(d.name)}<span>${esc(d.country)}</span></button>`).join(''):'<p class="none">Not on the destination list. Try a nearby city or region.</p>'}

function render(){
  if(document.getElementById('mkc0'))S.make.clues=[0,1,2,3,4,5].map(i=>document.getElementById('mkc'+i)?.value??'');
  const nt=document.getElementById('mknote');if(nt)S.make.note=nt.value;
  const a=document.activeElement,keep=a&&a.id&&a.tagName==='INPUT'?{id:a.id,v:a.value,s:a.selectionStart}:null;
  document.querySelectorAll('.tabs button').forEach(b=>b.setAttribute('aria-current',String(b.dataset.tab===S.tab)));
  const c=couple();$('#pairtab').textContent=c?(c.paired?'Paired':'Pair (waiting)'):'Pair up';
  const note=S.err?`<div class="note err"><span>${esc(S.err)}</span><button data-act="dismiss">Dismiss</button></div>`:S.ok?`<div class="note ok"><span>${esc(S.ok)}</span><button data-act="dismiss">OK</button></div>`:'';
  $('#app').innerHTML=note+({play:vPlay,rounds:vRounds,list:vList,pair:vPair}[S.tab])();
  if(keep){const e=document.getElementById(keep.id);if(e){e.value=keep.v;e.focus();try{e.setSelectionRange(keep.s,keep.s)}catch(x){}refreshSug(keep.id)}}}

function copyShare(){const t=$('#sharetxt')?.textContent||'';const done=()=>{S.ok='Copied. Paste it to your partner.';render()};
  try{navigator.clipboard.writeText(t).then(done,()=>{const r=document.createRange();r.selectNodeContents($('#sharetxt'));getSelection().removeAllRanges();getSelection().addRange(r)})}catch(e){}}

// --- Events -----------------------------------------------------------------------

document.addEventListener('input',e=>{if(e.target.id==='gi'||e.target.id==='mk')refreshSug(e.target.id)});
document.addEventListener('keydown',e=>{if(e.key!=='Enter')return;if(e.target.id==='gi'||e.target.id==='mk'){const f=document.querySelector(`#sug-${e.target.id} button`);if(f){e.preventDefault();f.click()}}else if(e.target.id==='jc'){e.preventDefault();joinPair(e.target.value)}});
document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;
  if(b.dataset.tab){S.tab=b.dataset.tab;S.err='';S.ok='';S.lastN=0;render();
    if(S.tab==='rounds')refreshRounds();else if(S.tab==='list')refreshList().then(render);return}
  const a=b.dataset.act;if(a!=='dismiss'&&a!=='share'){S.err='';S.ok=''}
  if(a==='guess')guess(b.dataset.d);
  else if(a==='vote')vote(b.dataset.d,+b.dataset.v);
  else if(a==='pick'){S.make.dest=b.dataset.d;render()}
  else if(a==='unpick'){S.make.dest=null;S.make.clues=null;render()}
  else if(a==='gen')genClues();
  else if(a==='selfwrite'){S.make.clues=['','','','','',''];render()}
  else if(a==='send')sendRound();
  else if(a==='playc')openRound(b.dataset.id);
  else if(a==='today'){S.cur={kind:'daily'};S.round=null;S.lastN=0;render()}
  else if(a==='share')copyShare();
  else if(a==='create')createPair();
  else if(a==='join')joinPair($('#jc')?.value||'');
  else if(a==='unpair')unpair();
  else if(a==='retry')start();
  else if(a==='dismiss'){S.err='';S.ok='';render()}});

// Poll while visible so partner progress and scores update; roll over at local midnight.
async function tick(){if(document.visibilityState!=='visible')return;
  if(localDate()!==S.date){S.date=localDate();S.today=null;S.lastN=0;await loadToday();render()}
  refreshState();if(S.tab==='rounds')refreshRounds()}
document.addEventListener('visibilitychange',tick);
setInterval(tick,POLL_MS);

async function start(){render();
  if(!DEST.length){try{await loadDestinations()}catch(e){S.loadErr="Couldn't load the game. Check your connection and try again.";S.ready=true;return render()}}
  await Promise.all([loadToday(),refreshState()]);S.ready=true;render();
  await migrateLocalVotes();await refreshList();render()}
start();
