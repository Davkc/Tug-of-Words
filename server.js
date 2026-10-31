const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 8;
const ROUND_MS = 90_000;
const TWIST_EVERY = 30_000;
const rooms = new Map();
const words = ['anchor','bright','canyon','drizzle','ember','feather','galaxy','harbor','island','jigsaw','kindle','lantern','meadow','nectar','orbit','puzzle','quartz','ripple','sprint','thunder','velvet','whisper','xylophone','yonder','zigzag','blossom','crystal','dolphin','eclipse','fortune','glimmer','horizon','journey','kingdom','liberty','midnight','nostalgia','parallel','quicksand','radiant','sapphire','tangerine','umbrella','velocity','wilderness','adventure','blueprint','champion','discovery','electricity','friendship','imagination','masterpiece','opportunity','revolution','extraordinary'];
const rareWords = new Set(['xylophone','quartz','quicksand','nostalgia','sapphire','tangerine','velocity','wilderness','blueprint','electricity','imagination','masterpiece','opportunity','revolution','extraordinary']);
const twists = ['REVERSED WORDS', 'EMOJI WORDS'];

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 2048 });

function code() { return Math.random().toString(36).slice(2, 6).toUpperCase(); }
function safeName(value) { return String(value || 'Player').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 18) || 'Player'; }
function makePlayer(id, name, team) { return { id, name, team, ready: false, connected: true, score: 0, correct: 0, streak: 0, bestStreak: 0, freezes: 0, latency: 0, lastWordAt: 0, frozenUntil: 0, bot: false }; }
function newRoom(host, practice = false) {
  let id = code(); while (rooms.has(id)) id = code();
  const room = { id, host, players: new Map(), phase: 'lobby', practice, createdAt: Date.now(), startedAt: 0, endsAt: 0, rope: 0, twist: null, twistEndsAt: 0, words: { red: '', blue: '' }, roundNo: 0, result: null, botTimers: [], eventLoop: null };
  rooms.set(id, room); return room;
}
function teamSize(room, team) { return [...room.players.values()].filter(p => p.team === team && p.connected).length; }
function chooseTeam(room) { return teamSize(room, 'red') <= teamSize(room, 'blue') ? 'red' : 'blue'; }
function assignWords(room) {
  const pick = () => words[Math.floor(Math.random() * words.length)];
  room.words = { red: pick(), blue: pick() };
}
function publicState(room, viewerTeam) {
  const now = Date.now();
  return {
    room: room.id, phase: room.phase, host: room.host, practice: room.practice,
    players: [...room.players.values()].map(({ id, name, team, ready, connected, score, correct, streak, bestStreak, freezes, latency, bot, powerReady }) => ({ id, name, team, ready, connected, score, correct, streak, bestStreak, freezes, latency, bot, powerReady: !!powerReady })),
    redCount: teamSize(room, 'red'), blueCount: teamSize(room, 'blue'), rope: room.rope,
    words: room.phase === 'playing' ? (viewerTeam ? { red: viewerTeam === 'red' ? room.words.red : null, blue: viewerTeam === 'blue' ? room.words.blue : null } : null) : null,
    timeLeft: room.phase === 'playing' ? Math.max(0, room.endsAt - now) : 0,
    twist: room.phase === 'playing' ? room.twist : null,
    twistLeft: room.twist ? Math.max(0, room.twistEndsAt - now) : 0,
    frozen: room.phase === 'playing' ? Object.fromEntries(['red','blue'].map(t => [t, [...room.players.values()].some(p => p.team === t && p.frozenUntil > now)])) : { red: false, blue: false },
    result: room.result,
  };
}
function broadcast(room, type = 'state', extra = {}) {
  for (const p of room.players.values()) if (p.ws?.readyState === WebSocket.OPEN) p.ws.send(JSON.stringify({ type, state: publicState(room, p.team), ...extra }));
}
function endRound(room, reason) {
  if (room.phase !== 'playing') return;
  room.phase = 'results'; clearInterval(room.eventLoop); room.eventLoop = null;
  for (const timer of room.botTimers) clearTimeout(timer); room.botTimers = [];
  const allPlayers = [...room.players.values()];
  const players = allPlayers.filter(p => !p.bot);
  const red = allPlayers.filter(p => p.team === 'red').reduce((sum, p) => sum + p.score, 0);
  const blue = allPlayers.filter(p => p.team === 'blue').reduce((sum, p) => sum + p.score, 0);
  const winner = Math.abs(room.rope) >= 100 ? (room.rope < 0 ? 'red' : 'blue') : red === blue ? 'draw' : red > blue ? 'red' : 'blue';
  const mvp = [...players].sort((a,b) => b.score - a.score || b.correct - a.correct)[0];
  room.result = { winner, reason, red, blue, mvp: mvp ? { id: mvp.id, name: mvp.name, score: mvp.score } : null, players: players.map(p => ({ id:p.id, name:p.name, team:p.team, score:p.score, correct:p.correct, bestStreak:p.bestStreak, freezes:p.freezes })).sort((a,b) => b.score-a.score) };
  broadcast(room, 'results');
}
function startRound(room) {
  if (room.phase === 'playing') return;
  const real = [...room.players.values()].filter(p => p.connected && !p.bot);
  if (!real.length) return;
  if (!room.practice && (teamSize(room,'red') === 0 || teamSize(room,'blue') === 0)) return;
  room.phase = 'playing'; room.roundNo++; room.startedAt = Date.now(); room.endsAt = room.startedAt + ROUND_MS; room.rope = 0; room.twist = null; room.result = null;
  for (const p of room.players.values()) { p.score=0; p.correct=0; p.streak=0; p.bestStreak=0; p.freezes=0; p.frozenUntil=0; p.lastWordAt=0; }
  assignWords(room); broadcast(room, 'started');
  room.eventLoop = setInterval(() => {
    const elapsed = Date.now() - room.startedAt;
    if (elapsed >= ROUND_MS) { endRound(room, 'time'); return; }
    const slot = Math.floor(elapsed / TWIST_EVERY);
    if (slot > 0 && elapsed % TWIST_EVERY < 1000 && room.twist === null) {
      room.twist = twists[(slot - 1) % twists.length]; room.twistEndsAt = Date.now() + 10_000;
      broadcast(room, 'twist');
      setTimeout(() => { if (room.phase === 'playing' && Date.now() >= room.twistEndsAt) { room.twist = null; broadcast(room); } }, 10_050);
    }
    broadcast(room);
  }, 250);
  if (room.practice) scheduleBots(room);
}
function scheduleBots(room) {
  const bots = [...room.players.values()].filter(p => p.bot);
  for (const bot of bots) {
    const think = () => {
      if (room.phase !== 'playing') return;
      const delay = 1300 + Math.random() * 2200;
      const timer = setTimeout(() => {
        if (room.phase !== 'playing') return;
        const target = room.words[bot.team];
        if (Math.random() > 0.12) applyWord(room, bot, target);
        think();
      }, delay);
      room.botTimers.push(timer);
    }; think();
  }
}
function applyWord(room, player, entered) {
  if (room.phase !== 'playing' || !player.connected || player.frozenUntil > Date.now()) return false;
  if (player.team !== 'red' && player.team !== 'blue') return false;
  const target = room.words[player.team].toLowerCase();
  const typed = String(entered).toLowerCase();
  const reversed = room.twist === 'REVERSED WORDS' && Date.now() < room.twistEndsAt;
  if (typed !== (reversed ? [...target].reverse().join('') : target)) return false;
  const now = Date.now(); if (now - player.lastWordAt < 140) return false;
  player.lastWordAt = now;
  const word = room.words[player.team];
  const strength = Math.min(15, Math.max(1, word.length - 2)) + (word.length >= 10 ? 3 : 0) + (rareWords.has(word) ? 4 : 0);
  player.score += strength; player.correct++; player.streak++; player.bestStreak = Math.max(player.bestStreak, player.streak);
  room.rope += player.team === 'blue' ? strength : -strength;
  if (player.streak >= 5 && player.freezes === 0) player.powerReady = true;
  assignWords(room);
  if (Math.abs(room.rope) >= 100) endRound(room, 'flag'); else broadcast(room, 'pull', { actor: player.id, strength });
  return true;
}
function leaveRoom(player) {
  const room = player.room; if (!room) return;
  room.players.delete(player.id); player.room = null;
  if (room.host === player.id) room.host = [...room.players.values()].find(p => !p.bot)?.id || [...room.players.keys()][0] || null;
  if (room.phase === 'playing' && (teamSize(room,'red') === 0 || teamSize(room,'blue') === 0) && !room.practice) {
    const present = [...room.players.values()].filter(p => p.connected && !p.bot);
    if (present.length) { room.phase = 'lobby'; clearInterval(room.eventLoop); room.eventLoop = null; room.result = null; broadcast(room, 'paused', { message: 'A team is empty. Round paused until both teams have players.' }); }
    else endRound(room, 'disconnect');
  }
  if (!room.players.size) { clearInterval(room.eventLoop); for(const t of room.botTimers) clearTimeout(t); rooms.delete(room.id); }
  else broadcast(room, 'state');
}
function send(ws, type, data = {}) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, ...data })); }
wss.on('connection', (ws, request) => {
  const player = { id: Math.random().toString(36).slice(2), ws, room: null };
  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return send(ws,'error',{message:'Invalid message.'}); }
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'create') {
      if (player.room) leaveRoom(player);
      const room = newRoom(player.id, false); const p = makePlayer(player.id, safeName(msg.name), 'red'); p.ws = ws; room.players.set(p.id,p); player.room=room;
      send(ws,'joined',{self:p.id, invite:`${origin(request)}/?room=${room.id}`}); broadcast(room); return;
    }
    if (msg.type === 'practice') {
      if (player.room) leaveRoom(player);
      const room = newRoom(player.id, true); const human = makePlayer(player.id, safeName(msg.name), 'red'); human.ws=ws; room.players.set(human.id,human); player.room=room;
      for(let i=0;i<3;i++){const bot=makePlayer(`bot${i}_${room.id}`,['Word Wizard','Captain Typo','Rope-a-Dope'][i], i===0?'blue':i===1?'red':'blue'); bot.bot=true; bot.connected=true; room.players.set(bot.id,bot);}
      send(ws,'joined',{self:player.id,invite:`${origin(request)}/?room=${room.id}`}); broadcast(room); return;
    }
    if (msg.type === 'join') {
      const room=rooms.get(String(msg.room||'').toUpperCase()); if(!room) return send(ws,'error',{message:'Room not found. Check the code and try again.'});
      if(room.phase==='playing') return send(ws,'error',{message:'That round is already in progress.'});
      if(room.players.size>=MAX_PLAYERS) return send(ws,'error',{message:'Room is full (8 players).'});
      if(player.room) leaveRoom(player);
      const p=makePlayer(player.id,safeName(msg.name),chooseTeam(room)); p.ws=ws; room.players.set(p.id,p); player.room=room;
      send(ws,'joined',{self:player.id,invite:`${origin(request)}/?room=${room.id}`}); broadcast(room); return;
    }
    const room=player.room; if(!room) return send(ws,'error',{message:'Create or join a room first.'});
    const p=room.players.get(player.id); if(!p) return;
    if(msg.type==='ready' && room.phase==='lobby') { p.ready=!!msg.value; broadcast(room); return; }
    if(msg.type==='swap' && room.phase==='lobby') {
      const sizes={red:teamSize(room,'red'),blue:teamSize(room,'blue')};
      if(Math.abs((p.team==='red'?sizes.red-1:sizes.red+1)-(p.team==='blue'?sizes.blue-1:sizes.blue+1))>1) return send(ws,'error',{message:'That swap would leave teams unbalanced.'});
      p.team=p.team==='red'?'blue':'red'; p.ready=false; broadcast(room); return;
    }
    if(msg.type==='start') { if(p.id!==room.host) return send(ws,'error',{message:'Only the host can start.'}); if(room.phase!=='lobby') return; if(![...room.players.values()].filter(x=>!x.bot).every(x=>x.ready)) return send(ws,'error',{message:'Everyone needs to ready up first.'}); startRound(room); return; }
    if(msg.type==='word') {
      if(typeof msg.word !== 'string' || msg.word.length>32) return;
      const accepted=applyWord(room,p,msg.word); if(!accepted){p.streak=0; send(ws,'miss'); broadcast(room);} return;
    }
    if(msg.type==='freeze') {
      if(room.phase!=='playing' || !p.powerReady || p.freezes>0) return send(ws,'error',{message:'Build a 5 word streak to unlock Freeze.'});
      const enemy=p.team==='red'?'blue':'red'; p.powerReady=false;p.freezes++; for(const other of room.players.values()) if(other.team===enemy) other.frozenUntil=Date.now()+2000;
      broadcast(room,'freeze',{team:enemy,by:p.id}); return;
    }
    if(msg.type==='rematch' && room.phase==='results') {
      room.phase='lobby';room.result=null;room.rope=0;room.twist=null;
      for(const x of room.players.values()){x.ready=x.id===p.id;x.score=0;x.correct=0;x.streak=0;x.bestStreak=0;x.freezes=0;x.powerReady=false;x.frozenUntil=0;}
      broadcast(room,'rematch');return;
    }
    if(msg.type==='ping') {p.latency=Math.max(0,Math.min(999,Date.now()-Number(msg.at||Date.now())));send(ws,'pong',{at:msg.at});}
  });
  ws.on('close',()=>{
    const room=player.room;if(!room)return;
    const p=room.players.get(player.id); if(p){p.connected=false;p.ws=null;}
    leaveRoom(player);
  });
});
function origin(request) { return process.env.PUBLIC_URL?.replace(/\/$/,'') || `${request.headers['x-forwarded-proto'] || 'http'}://${request.headers.host || 'localhost:'+PORT}`; }
server.listen(PORT,()=>console.log(`Tug of Words listening on ${PORT}`));
