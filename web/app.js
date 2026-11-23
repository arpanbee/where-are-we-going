// Where Are We Going? client. The server owns the puzzle, judges guesses and decides
// what the partner may see; this file renders and polls.
import { api } from './api.js';

// Destination list, shared with the server (api/wawg/destinations.json). Loaded at start.
let DEST=[],BY={};
async function loadDestinations(){const r=await fetch('/destinations.json');if(!r.ok)throw new Error('destinations '+r.status);DEST=await r.json();BY=Object.fromEntries(DEST.map(d=>[d.id,d]))}

const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const seg=s=>String(s).replace(/[^A-Za-z0-9_\-.~:@+]/g,'_');
const ymd=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const localDate=()=>ymd(new Date());
const arrow=d=>['↑','↗','→','↘','↓','↙','←','↖'][Math.round(d/45)%8];
const SQ={g:'🟩',y:'🟨',o:'🟧',r:'🟥'};
const fmt=n=>Math.round(n).toLocaleString();
const ls={get(k,d){try{return JSON.parse(localStorage.getItem('wawg:'+k))??d}catch(e){return d}},set(k,v){try{localStorage.setItem('wawg:'+k,JSON.stringify(v))}catch(e){}}};
const POLL_MS=20000;

// today: the server's view of my play. state: couple, partner status, week scores.
const S={date:localDate(),tab:'play',today:null,state:null,votes:ls.get('votes',{}),err:'',ok:'',ready:false,busy:false,loadErr:'',lastN:0};
const couple=()=>S.state?.couple||null;
const paired=()=>Boolean(couple()?.paired);
const grid=tiers=>tiers.map(t=>SQ[t]).join('');
const myGrid=pl=>grid(pl.guesses.map(g=>g.tier));

// --- Server calls -----------------------------------------------------------------

async function loadToday(){try{S.today=await api.today(S.date);S.loadErr=''}catch(e){S.loadErr=e.message}}
let stateBusy=false;
async function refreshState(){if(stateBusy)return;stateBusy=true;
  try{const s=await api.state(S.date);const changed=JSON.stringify(s)!==JSON.stringify(S.state);S.state=s;if(changed)render()}
  catch(e){/* keep the last good state; polling will retry */}
  finally{stateBusy=false}}

async function guess(id){const pl=S.today;if(!pl||S.busy||pl.done||!BY[id]||pl.guesses.some(g=>g.destId===id))return;
  S.busy=true;
  try{S.today=await api.guess(S.date,id);refreshState()}
  catch(e){S.err=e.message;if(e.status===409)await loadToday()}
  S.busy=false;render();document.getElementById('gi')?.focus()}

async function createPair(){try{await api.createCouple();await refreshState()}catch(e){S.err=e.message}render()}
async function joinPair(raw){const code=raw.trim().toUpperCase();if(!/^[A-Z0-9]{6}$/.test(code)){S.err='Codes are 6 letters and numbers.';return render()}
  try{await api.joinCouple(code);await refreshState();S.tab='play';S.ok='Paired! Today’s puzzle is now shared.'}catch(e){S.err=e.message}render()}
async function unpair(){try{await api.leaveCouple();await refreshState()}catch(e){S.err=e.message}render()}

// Votes stay on this device until the shared list ships (step 4).
function vote(d,v){if(!BY[d])return;const id=seg(d)+'_local';S.votes[id]={dest:d,uid:'local',v};ls.set('votes',S.votes);render()}

// --- Views ------------------------------------------------------------------------

function weekRows(){const w=[['You',S.state?.me?.week??0]];if(paired())w.push(['Your partner',S.state.partner?.week??0]);return w}

function shareText(pl){let s=`Where are we going? #${pl.num}\n${myGrid(pl)} ${pl.solved?pl.guesses.length:'X'}/6`;
  if(paired()){const[[,me],[,them]]=weekRows();s+=`\nMe ${me} – Them ${them} this week ✈️`}return s}

function vPlay(){
  if(!S.today)return S.loadErr?`<section><h2>Couldn’t load today’s puzzle</h2><p>${esc(S.loadErr)}</p><button class="btn" data-act="retry">Try again</button></section>`:'<p class="muted">Boarding…</p>';
  const pl=S.today,t=pl.answer?BY[pl.answer]:null,n=pl.clues.length;const fresh=n>S.lastN&&S.lastN>0;S.lastN=n;
  const clues=Array.from({length:pl.totalClues},(_,i)=>i<n?`<li class="clue${fresh&&i===n-1?' new':''}"><span class="cn">${i+1}</span><span>${esc(pl.clues[i])}</span></li>`:`<li class="clue locked"><span class="cn">${i+1}</span><span>Locked. Each wrong guess unlocks the next clue.</span></li>`).join('');
  const rows=pl.guesses.map(g=>{const d=BY[g.destId];if(!d)return'';return`<li class="g ${g.tier}"><span class="sq"></span><b>${esc(d.name)}</b><span class="ct">${esc(d.country)}</span>${g.tier==='g'?'<span class="km">Landed</span>':`<span class="km">${fmt(g.km)} km</span><span class="ar" aria-label="direction to target">${arrow(g.bearing)}</span>`}</li>`}).join('');
  const v=t?S.votes[seg(t.id)+'_local']?.v:undefined;
  const foot=pl.done&&t?`<div class="result"><div class="stamp${pl.solved?'':' miss'}">${pl.solved?'Arrived':'Missed it'}: ${esc(t.name)}</div>
    <p>${pl.solved?`Solved in ${pl.guesses.length}/6 for <b>${pl.points} point${pl.points>1?'s':''}</b>.`:`It was ${esc(t.name)}, ${esc(t.country)}. No points this time.`}</p>
    <div class="row"><span>Would you go?</span><button class="btn ghost" data-act="vote" data-d="${t.id}" data-v="1" aria-pressed="${v===1}">We should go</button><button class="btn ghost" data-act="vote" data-d="${t.id}" data-v="0" aria-pressed="${v===0}">Not for me</button></div>
    <pre class="share" id="sharetxt">${esc(shareText(pl))}</pre><div class="row" style="margin-top:10px"><button class="btn coral" data-act="share">Copy result</button></div></div>`
    :`<div class="ask"><label for="gi">Your guess (${pl.guesses.length}/6)</label><input type="text" id="gi" autocomplete="off" placeholder="Start typing a city, island or region"><div class="sug" id="sug-gi"></div></div>`;
  return`<div class="grid"><div><div class="pass"><div class="ph"><div><small>From</small><strong>Home</strong></div><svg class="plane" viewBox="0 0 120 24" preserveAspectRatio="none" aria-hidden="true"><path d="M2 12H104" stroke="currentColor" stroke-width="2" stroke-dasharray="4 6" fill="none"/><path d="M104 4l14 8-14 8 4-8z" fill="currentColor"/></svg><div><small>To</small><strong>${t?esc(t.name):'???'}</strong></div><div class="stub"><small>Flight</small><strong>#${esc(pl.num)}</strong></div></div>
    <div class="pb"><ol class="clues">${clues}</ol><ul class="gs">${rows}</ul>${foot}</div></div>
    <p class="muted">Colours show how close a guess was: green is right, yellow under 500 km, orange under 2,000 km, red further. The arrow points toward the answer.</p></div>
    <aside>${vPartner()}${vWeek()}</aside></div>`}

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
  return`<section><h2>Partner rounds</h2><p>Pick a place that means something to the two of you, and your partner has to guess it from six clues.</p>${paired()?'<p class="muted">Coming soon. We’re putting the finishing touches on it.</p>':'<p>Pair up first.</p><button class="btn" data-tab="pair">Pair up</button>'}</section>`}

function vList(){const by={};
  Object.values(S.votes).forEach(v=>{if(v&&BY[v.dest]&&v.uid==='local')by[v.dest]=v.v});
  const mine=Object.keys(by).filter(d=>by[d]===1);
  const tags=(a,cl)=>`<div class="list">${a.map(d=>`<div class="tag ${cl}"><b>${esc(BY[d].name)}</b><span>${esc(BY[d].country)}</span></div>`).join('')}</div>`;
  return`<section><h2>Trips we both want</h2><p class="muted">${paired()?'Your shared list is coming soon. For now, your yes votes are saved on this device.':'Pair up and this fills with places you both said yes to.'}</p></section>
  <section><h2>Only you so far</h2>${mine.length?tags(mine,'solo'):'<p class="muted">Finish a puzzle and tap “We should go”.</p>'}</section>`}

function vPair(){
  if(!S.ready)return'<p class="muted">Connecting…</p>';
  if(!S.state)return`<section><h2>Pairing isn’t available right now</h2><p>Couldn’t reach the game. You can still play today’s puzzle.</p><button class="btn" data-act="retry">Try again</button></section>`;
  const c=couple();
  if(c)return`<section><h2>${c.paired?'You’re paired':'Waiting for your partner'}</h2><p>Your couple code</p><p class="code">${esc(c.code)}</p>${c.paired?'<p>You + your partner</p>':'<p>Ask your partner to open this page, go to Pair up and enter the code.</p>'}<button class="btn ghost" data-act="unpair">Leave this pairing</button></section>`;
  return`<div class="grid"><section><h2>Start a pairing</h2><p>Get a code, then have your partner enter it on their side.</p><button class="btn" data-act="create">Create a couple code</button>
    <h2 style="margin-top:28px">Got a code?</h2><label for="jc">Enter your partner’s code</label><div class="row"><input type="text" id="jc" maxlength="6" placeholder="ABC123" style="max-width:12em;text-transform:uppercase"><button class="btn" data-act="join">Join</button></div></section>
    <aside class="side"><h3>How it works</h3><p>You both play the same daily puzzle. You won’t see each other’s results until you’ve each finished.</p><p class="muted">Your pairing is tied to this browser. If you clear its site data, you’ll need to pair again.</p></aside></div>`}

function refreshSug(id){const inp=document.getElementById(id),box=document.getElementById('sug-'+id);if(!inp||!box)return;const v=inp.value.trim().toLowerCase();if(!v){box.innerHTML='';return}
  const used=(S.today?.guesses||[]).map(g=>g.destId);
  const r=DEST.filter(d=>!used.includes(d.id)&&(d.name.toLowerCase().includes(v)||d.country.toLowerCase().startsWith(v))).sort((a,b)=>b.name.toLowerCase().startsWith(v)-a.name.toLowerCase().startsWith(v)).slice(0,6);
  box.innerHTML=r.length?r.map(d=>`<button data-act="guess" data-d="${d.id}">${esc(d.name)}<span>${esc(d.country)}</span></button>`).join(''):'<p class="none">Not on the destination list. Try a nearby city or region.</p>'}

function render(){
  const a=document.activeElement,keep=a&&a.id&&a.tagName==='INPUT'?{id:a.id,v:a.value,s:a.selectionStart}:null;
  document.querySelectorAll('.tabs button').forEach(b=>b.setAttribute('aria-current',String(b.dataset.tab===S.tab)));
  const c=couple();$('#pairtab').textContent=c?(c.paired?'Paired':'Pair (waiting)'):'Pair up';
  const note=S.err?`<div class="note err"><span>${esc(S.err)}</span><button data-act="dismiss">Dismiss</button></div>`:S.ok?`<div class="note ok"><span>${esc(S.ok)}</span><button data-act="dismiss">OK</button></div>`:'';
  $('#app').innerHTML=note+({play:vPlay,rounds:vRounds,list:vList,pair:vPair}[S.tab])();
  if(keep){const e=document.getElementById(keep.id);if(e){e.value=keep.v;e.focus();try{e.setSelectionRange(keep.s,keep.s)}catch(x){}refreshSug(keep.id)}}}

function copyShare(){const t=$('#sharetxt')?.textContent||'';const done=()=>{S.ok='Copied. Paste it to your partner.';render()};
  try{navigator.clipboard.writeText(t).then(done,()=>{const r=document.createRange();r.selectNodeContents($('#sharetxt'));getSelection().removeAllRanges();getSelection().addRange(r)})}catch(e){}}

// --- Events -----------------------------------------------------------------------

document.addEventListener('input',e=>{if(e.target.id==='gi')refreshSug('gi')});
document.addEventListener('keydown',e=>{if(e.key!=='Enter')return;if(e.target.id==='gi'){const f=document.querySelector('#sug-gi button');if(f){e.preventDefault();f.click()}}else if(e.target.id==='jc'){e.preventDefault();joinPair(e.target.value)}});
document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;
  if(b.dataset.tab){S.tab=b.dataset.tab;S.err='';S.ok='';S.lastN=0;render();return}
  const a=b.dataset.act;if(a!=='dismiss'&&a!=='share'){S.err='';S.ok=''}
  if(a==='guess')guess(b.dataset.d);
  else if(a==='vote')vote(b.dataset.d,+b.dataset.v);
  else if(a==='share')copyShare();
  else if(a==='create')createPair();
  else if(a==='join')joinPair($('#jc')?.value||'');
  else if(a==='unpair')unpair();
  else if(a==='retry')start();
  else if(a==='dismiss'){S.err='';S.ok='';render()}});

// Poll while visible so partner progress and scores update; roll over at local midnight.
async function tick(){if(document.visibilityState!=='visible')return;
  if(localDate()!==S.date){S.date=localDate();S.today=null;S.lastN=0;await loadToday();render()}
  refreshState()}
document.addEventListener('visibilitychange',tick);
setInterval(tick,POLL_MS);

async function start(){render();
  if(!DEST.length){try{await loadDestinations()}catch(e){S.loadErr="Couldn't load the game. Check your connection and try again.";S.ready=true;return render()}}
  await Promise.all([loadToday(),refreshState()]);S.ready=true;render()}
start();
