(function () {
  'use strict';

  /* =========================================================
     ⚠️【需要手动修改】Vercel 备用服务器地址
     =========================================================
     把你部署好的 Vercel PeerJS 服务器域名填在这里（不要带 https://）。
     例如：'uno-peerjs-xyz.vercel.app'
     这个地址会作为 PeerJS 官方服务器连接失败后的自动兜底。
  */
  const DEFAULT_VERCEL_HOST = 'uno-server.vercel.app';  // 👈 改这里

  /* =========================================================
     1. 通用工具
     ========================================================= */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
  }
  function switchScreen(name) {
    document.querySelectorAll('.screen').forEach(el =>
      el.classList.toggle('active', el.id === name));
    const topBar = $('topBarLeft');
    if (name === 'room' || name === 'game') topBar.classList.add('show');
    else topBar.classList.remove('show');
  }
  function getName() {
    const n = ($('nameInput').value.trim() || '玩家').slice(0, 8);
    localStorage.setItem('uno_name', n);
    return n;
  }
  function showLoading(text, subtext) {
    $('loadingText').innerHTML = esc(text || '正在连接…') +
      (subtext ? '<strong>' + esc(subtext) + '</strong>' : '');
    $('loadingOverlay').classList.add('show');
  }
  function hideLoading() {
    $('loadingOverlay').classList.remove('show');
  }

  /* =========================================================
     2. 信令服务器配置
     ========================================================= */
  const TURN_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      {
        urls: [
          'turn:turn.evan-brass.net',
          'turn:turn.evan-brass.net?transport=tcp',
          'turns:turn.evan-brass.net:443?transport=tcp'
        ],
        username: 'user',
        credential: 'password'
      }
    ]
  };

  function getVercelHost() {
    return (localStorage.getItem('uno_vercel_host') || DEFAULT_VERCEL_HOST).trim();
  }

  const SERVERS = {
    peerjs: {
      id: 'peerjs',
      label: 'PeerJS 官方',
      prefix: 'P',
      buildOptions: () => ({
        debug: 0,
        config: TURN_CONFIG
      })
    },
    vercel: {
      id: 'vercel',
      label: 'Vercel 备用',
      prefix: 'V',
      buildOptions: () => {
        const host = getVercelHost();
        if (!host) return null;
        return {
          host: host,
          port: 443,
          path: '/',
          secure: true,
          key: 'peerjs',
          debug: 0,
          config: TURN_CONFIG
        };
      }
    }
  };

  // 创建 Peer 实例（不带超时，超时逻辑在外面控制）
  function createPeer(peerId, serverId) {
    const cfg = SERVERS[serverId];
    if (!cfg) return { error: new Error('未知服务器') };
    const opts = cfg.buildOptions();
    if (!opts) return { error: new Error('服务器未配置') };
    try {
      const peer = new Peer(peerId, opts);
      return { peer };
    } catch (e) {
      return { error: e };
    }
  }

  // 生成带前缀的房间号
  function genRoomId(serverId) {
    const prefix = SERVERS[serverId].prefix;
    let digits = '';
    for (let i = 0; i < 4; i++) digits += Math.floor(Math.random() * 10);
    return prefix + digits;
  }

  // 解析房间号，返回 { serverId, fullRoomId }
  function parseRoomId(input) {
    const str = String(input || '').trim().toUpperCase();
    if (!str) return null;
    if (str[0] === 'P') return { serverId: 'peerjs', fullRoomId: 'P' + str.slice(1) };
    if (str[0] === 'V') return { serverId: 'vercel', fullRoomId: 'V' + str.slice(1) };
    return null; // 无前缀无效
  }

  /* =========================================================
     3. 全局状态
     ========================================================= */
  const state = {
    peer: null,
    isHost: false,
    roomId: '',
    myPeerId: '',
    myPlayerId: '',
    hostConn: null,
    clientConns: {},
    room: null,
    S: null,
    currentRoomId: '',
    pendingWild: null,
    unreadCount: 0,
    lastChatLen: -1,
    chatInitialized: false,
    usedServer: 'peerjs'  // 记录当前房间实际使用的服务器
  };

  /* =========================================================
     4. 音效
     ========================================================= */
  let audioCtx = null;
  let globalVolume = parseFloat(localStorage.getItem('uno_volume') || '100') / 100;
  function initAudio() {
    if (!audioCtx) {
      try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
    }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  }
  function playTone(freq, dur, type, vol) {
    if (!audioCtx) return;
    try {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = type || 'sine';
      osc.frequency.value = freq;
      let finalVol = (vol || 0.1) * globalVolume;
      if (finalVol < 0.0001) finalVol = 0.0001;
      gain.gain.setValueAtTime(finalVol, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + dur);
    } catch (e) {}
  }
  const sfxClick = () => playTone(600, 0.06, 'square', 0.06);
  const sfxPlay  = () => { playTone(880, 0.1, 'sine', 0.1); setTimeout(() => playTone(1100, 0.1, 'sine', 0.08), 60); };
  const sfxDraw  = () => playTone(440, 0.08, 'sawtooth', 0.06);
  const sfxMsg   = () => { playTone(700, 0.05, 'sine', 0.08); setTimeout(() => playTone(900, 0.08, 'sine', 0.06), 50); };
  const sfxWin   = () => [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => playTone(f, 0.2, 'sine', 0.12), i * 120));
  const sfxLose  = () => [440, 330, 220].forEach((f, i) => setTimeout(() => playTone(f, 0.25, 'sawtooth', 0.1), i * 150));

  /* =========================================================
     5. 牌组
     ========================================================= */
  function makeDeck() {
    const colors = ['red', 'yellow', 'green', 'blue'];
    const deck = [];
    let id = 0;
    for (const color of colors) {
      deck.push({ id: id++, color, type: 'number', value: 0 });
      for (let n = 1; n <= 9; n++) {
        deck.push({ id: id++, color, type: 'number', value: n });
        deck.push({ id: id++, color, type: 'number', value: n });
      }
      for (const t of ['skip', 'reverse', 'draw2']) {
        deck.push({ id: id++, color, type: t, value: null });
        deck.push({ id: id++, color, type: t, value: null });
      }
    }
    for (let i = 0; i < 4; i++) {
      deck.push({ id: id++, color: 'wild', type: 'wild', value: null });
      deck.push({ id: id++, color: 'wild', type: 'wild4', value: null });
    }
    return deck;
  }
  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
  function cardScore(c) {
    if (c.type === 'number') return c.value;
    if (c.color === 'wild') return 50;
    return 20;
  }
  function cardLabel(c) {
    if (c.type === 'number') return c.value;
    if (c.type === 'skip') return '⊘';
    if (c.type === 'reverse') return '⇄';
    if (c.type === 'draw2') return '+2';
    if (c.type === 'wild') return '★';
    if (c.type === 'wild4') return '+4';
    return '?';
  }

  /* =========================================================
     6. 逻辑辅助
     ========================================================= */
  function myId() { return state.myPlayerId; }
  function myPlayer() {
    if (!state.S) return null;
    return state.S.players.find(p => p.isYou) || null;
  }
  function nameOf(id) {
    if (!state.S) return '';
    const p = state.S.players.find(x => x.id === id);
    return p ? p.name : '';
  }
  function isPlayable(card, me) {
    const S = state.S;
    if (!S || S.phase !== 'playing') return false;
    if (me.alive === false) return false;
    if (S.turnId !== me.id) return false;
    if (S.drawnCardId !== null && S.drawnCardId !== card.id) return false;
    if (S.rules.stacking && S.pendingDraw > 0) {
      if (S.pendingType === '+2' && card.type !== 'draw2') return false;
      if (S.pendingType === '+4' && card.type !== 'wild4') return false;
    }
    if (card.color === 'wild') return true;
    if (card.color === S.currentColor) return true;
    const top = S.topCard;
    if (!top) return true;
    if (card.type === 'number' && top.type === 'number' && card.value === top.value) return true;
    if (card.type !== 'number' && card.type === top.type) return true;
    return false;
  }
  function findPlayer(id) {
    return state.room ? state.room.players.find(p => p.id === id) : null;
  }
  function hasColor(player, color) {
    return player.hand.some(c => c.color === color);
  }
  function alivePlayers() {
    return state.room ? state.room.players.filter(p => p.alive !== false) : [];
  }
  function nextAliveIdx(step) {
    const room = state.room;
    const alive = alivePlayers();
    if (alive.length === 0) return room.turnIndex;
    const currentId = room.players[room.turnIndex].id;
    let ci = 0;
    for (let i = 0; i < alive.length; i++) if (alive[i].id === currentId) ci = i;
    const steps = step || 1;
    let ti = ci;
    for (let s = 0; s < steps; s++) ti = (ti + room.direction + alive.length * 10) % alive.length;
    const targetId = alive[ti].id;
    return room.players.findIndex(p => p.id === targetId);
  }

  /* =========================================================
     7. 游戏核心
     ========================================================= */
  function pushSystemMessage(text) {
    const room = state.room;
    if (!room) return;
    room.chatMessages.push({
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      sender: 'system', senderName: '', text, time: Date.now()
    });
    if (room.chatMessages.length > 100) room.chatMessages.shift();
  }
  function handleChatMessage(peerId, text) {
    const room = state.room;
    if (!room) return;
    const player = room.players.find(p => p.id === peerId);
    if (!player) return;
    const clean = String(text || '').slice(0, 100).trim();
    if (!clean) return;
    room.chatMessages.push({
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      sender: peerId, senderName: player.name, text: clean, time: Date.now()
    });
    if (room.chatMessages.length > 100) room.chatMessages.shift();
    broadcastState();
  }

  function startGame() {
    const room = state.room;
    if (!room) return;
    room.deck = shuffle(makeDeck());
    room.discard = [];
    room.players.forEach(p => {
      if (p.alive === false) { p.hand = []; p.unoCalled = false; return; }
      p.hand = room.deck.splice(0, 7);
      p.unoCalled = false;
    });
    let first = room.deck.shift();
    while (first.color === 'wild' || first.type !== 'number') {
      room.deck.push(first);
      room.deck = shuffle(room.deck);
      first = room.deck.shift();
    }
    room.topCard = first;
    room.currentColor = first.color;
    room.phase = 'playing';
    let firstIdx = 0;
    for (let i = 0; i < room.players.length; i++) {
      if (room.players[i].alive !== false) { firstIdx = i; break; }
    }
    room.turnIndex = firstIdx;
    room.direction = 1;
    room.drawnCardId = null;
    room.winnerId = null;
    room.winnerName = null;
    room.pendingDraw = 0;
    room.pendingType = null;
    room.pendingChallenge = null;
    room.pendingSwap = null;
    room.eliminatedId = null;
    room.eliminatedName = null;
    room.message = '游戏开始！';
    pushSystemMessage('游戏开始，' + room.players[firstIdx].name + ' 先出牌');
    broadcastState();
  }

  function checkWin(player) {
    const room = state.room;
    if (player.hand.length === 0) {
      if (room.rules.mode === 'elimination') {
        handleEliminationRound(player);
        return true;
      }
      room.phase = 'ended';
      room.winnerId = player.id;
      room.winnerName = player.name;
      room.message = player.name + ' 获胜！';
      if (room.rules.mode === 'score') {
        let total = 0;
        room.players.forEach(p => {
          if (p.id !== player.id) p.hand.forEach(c => { total += cardScore(c); });
        });
        player.score = (player.score || 0) + total;
      }
      pushSystemMessage('🏆 ' + player.name + ' 获胜！');
      broadcastState();
      return true;
    }
    return false;
  }

  function handleEliminationRound(winner) {
    const room = state.room;
    room.winnerId = winner.id;
    room.winnerName = winner.name;
    const others = alivePlayers().filter(p => p.id !== winner.id);
    if (others.length === 0) { finalizeElimination(winner); return; }
    let maxScore = -1, eliminated = null;
    others.forEach(p => {
      let s = 0;
      p.hand.forEach(c => { s += cardScore(c); });
      if (s > maxScore) { maxScore = s; eliminated = p; }
    });
    if (eliminated) {
      eliminated.alive = false;
      eliminated.hand = [];
      room.eliminatedId = eliminated.id;
      room.eliminatedName = eliminated.name;
      pushSystemMessage('💀 ' + eliminated.name + ' 被淘汰，进入观战');
    }
    const alive = alivePlayers();
    if (alive.length <= 1) { finalizeElimination(alive[0] || winner); return; }
    room.phase = 'roundEnd';
    room.message = winner.name + ' 赢得本局';
    broadcastState();
  }
  function finalizeElimination(winner) {
    const room = state.room;
    room.phase = 'ended';
    room.winnerId = winner.id;
    room.winnerName = winner.name;
    room.message = winner.name + ' 是最后的幸存者！';
    pushSystemMessage('🏆 ' + winner.name + ' 获得最终胜利！');
    broadcastState();
  }

  function drawCards(player, count) {
    const room = state.room;
    for (let i = 0; i < count; i++) {
      if (room.deck.length === 0) {
        if (room.discard.length > 1) {
          const top = room.discard.pop();
          room.deck = shuffle(room.discard);
          room.discard = [top];
        } else break;
      }
      player.hand.push(room.deck.shift());
    }
  }

  function nextTurn(step) {
    const room = state.room;
    const alive = alivePlayers();
    if (alive.length <= 1) return;
    const currentId = room.players[room.turnIndex].id;
    let ci = 0;
    for (let i = 0; i < alive.length; i++) if (alive[i].id === currentId) ci = i;
    const steps = step || 1;
    let ti = ci;
    for (let s = 0; s < steps; s++) ti = (ti + room.direction + alive.length * 10) % alive.length;
    const targetId = alive[ti].id;
    room.turnIndex = room.players.findIndex(p => p.id === targetId);
    room.drawnCardId = null;
    room.message = '';
    const tp = room.players[room.turnIndex];
    if (tp) tp.unoCalled = false;
  }

  function handlePlayCard(peerId, cardId, color) {
    const room = state.room;
    if (!room || room.phase !== 'playing') return;
    const player = findPlayer(peerId);
    if (!player || player.alive === false) return;
    if (room.players[room.turnIndex].id !== peerId) return;
    if (room.drawnCardId !== null && room.drawnCardId !== cardId) return;

    const cardIndex = player.hand.findIndex(c => c.id === cardId);
    if (cardIndex === -1) return;
    const card = player.hand[cardIndex];

    if (room.rules.stacking && room.pendingDraw > 0) {
      if (room.pendingType === '+2' && card.type !== 'draw2') return;
      if (room.pendingType === '+4' && card.type !== 'wild4') return;
    }

    const top = room.topCard;
    let playable = false;
    if (card.color === 'wild') playable = true;
    else if (card.color === room.currentColor) playable = true;
    else if (card.type === 'number' && top.type === 'number' && card.value === top.value) playable = true;
    else if (card.type !== 'number' && card.type === top.type) playable = true;
    if (!playable) return;

    player.hand.splice(cardIndex, 1);
    room.discard.push(room.topCard);
    room.topCard = card;
    room.drawnCardId = null;
    room.currentColor = card.color === 'wild' ? (color || 'red') : card.color;

    let skipNext = false;

    if (room.rules.sevenZero && card.type === 'number' && (card.value === 7 || card.value === 0)) {
      if (card.value === 7) {
        room.pendingSwap = { from: peerId, value: 7 };
        room.message = player.name + ' 打出 7，即将交换手牌';
        if (checkWin(player)) return;
        broadcastState();
        return;
      } else {
        const len = room.players.length;
        const hands = room.players.map(p => p.hand);
        for (let i = 0; i < len; i++) {
          const from = (i + room.direction + len) % len;
          room.players[i].hand = hands[from];
        }
        room.message = player.name + ' 打出 0，所有玩家交换手牌';
      }
    }

    if (room.rules.stacking && (card.type === 'draw2' || card.type === 'wild4')) {
      room.pendingDraw = (room.pendingDraw || 0) + (card.type === 'draw2' ? 2 : 4);
      room.pendingType = card.type === 'draw2' ? '+2' : '+4';
      room.message = player.name + ' 打出 ' + room.pendingType + '，累计 ' + room.pendingDraw + ' 张';
      if (checkWin(player)) return;
      nextTurn(1);
      broadcastState();
      return;
    }

    if (card.type === 'skip') { skipNext = true; room.message = player.name + ' 出牌，下家跳过'; }
    else if (card.type === 'reverse') { room.direction *= -1; room.message = player.name + ' 出牌，方向反转'; }
    else if (card.type === 'draw2') {
      const ni = nextAliveIdx(1);
      const v = room.players[ni];
      drawCards(v, 2); skipNext = true;
      room.message = player.name + ' 对 ' + v.name + ' 打出 +2！';
    } else if (card.type === 'wild4') {
      const ni4 = nextAliveIdx(1);
      const v4 = room.players[ni4];
      const illegal = hasColor(player, room.topCard.color);
      if (illegal) {
        room.pendingChallenge = { victimId: v4.id, offenderId: peerId, color: card.color };
        room.message = player.name + ' 打出 +4，下家可质疑';
        if (checkWin(player)) return;
        nextTurn(1);
        broadcastState();
        return;
      }
      drawCards(v4, 4); skipNext = true;
      room.message = player.name + ' 对 ' + v4.name + ' 打出 +4！';
    } else room.message = player.name + ' 出牌';

    if (checkWin(player)) return;
    nextTurn(skipNext ? 2 : 1);
    broadcastState();
  }

  function handleDrawCard(peerId) {
    const room = state.room;
    if (!room || room.phase !== 'playing') return;
    const player = findPlayer(peerId);
    if (!player || player.alive === false) return;
    if (room.players[room.turnIndex].id !== peerId) return;
    if (room.drawnCardId !== null && room.pendingDraw === 0) return;

    if (room.rules.stacking && room.pendingDraw > 0) {
      drawCards(player, room.pendingDraw);
      room.message = player.name + ' 摸了 ' + room.pendingDraw + ' 张牌';
      room.pendingDraw = 0;
      room.pendingType = null;
      nextTurn(1);
      broadcastState();
      return;
    }

    if (room.drawnCardId !== null) return;

    if (room.deck.length === 0) {
      if (room.discard.length > 1) {
        const top = room.discard.pop();
        room.deck = shuffle(room.discard);
        room.discard = [top];
      } else return;
    }
    const card = room.deck.shift();
    player.hand.push(card);
    room.drawnCardId = card.id;

    const topCard = room.topCard;
    const playable = card.color === 'wild' || card.color === room.currentColor ||
      (card.type === 'number' && topCard.type === 'number' && card.value === topCard.value) ||
      (card.type !== 'number' && card.type === topCard.type);

    if (!playable) {
      room.message = '摸到一张牌，无法出牌，自动跳过';
      nextTurn(1);
    } else {
      room.message = room.rules.forcePlay ? '摸到一张牌，必须打出' : '摸到一张牌，可出牌或跳过';
    }
    broadcastState();
  }

  function handlePass(peerId) {
    const room = state.room;
    if (!room || room.phase !== 'playing') return;
    const player = findPlayer(peerId);
    if (!player || player.alive === false) return;
    if (room.players[room.turnIndex].id !== peerId) return;
    if (room.drawnCardId === null) return;
    if (room.rules.forcePlay) { toast('摸到的牌可出，不能跳过'); return; }
    room.message = '跳过回合';
    nextTurn(1);
    broadcastState();
  }

  function handleCallUno(peerId) {
    const room = state.room;
    if (!room || room.phase !== 'playing') return;
    const player = findPlayer(peerId);
    if (!player || player.alive === false) return;
    player.unoCalled = true;
    room.message = player.name + ' 喊了 UNO！';
    broadcastState();
  }

  function handleCatchUno(catcherId, targetId) {
    const room = state.room;
    if (!room || room.phase !== 'playing') return;
    const target = findPlayer(targetId), catcher = findPlayer(catcherId);
    if (!target || !catcher) return;
    if (target.alive === false) return;
    if (target.hand.length !== 1) return;
    if (target.unoCalled) { room.message = target.name + ' 已经喊过 UNO 了！'; broadcastState(); return; }
    drawCards(target, 2);
    target.unoCalled = false;
    room.message = target.name + ' 忘记喊 UNO，被 ' + catcher.name + ' 抓到，摸 2 张牌！';
    broadcastState();
  }

  function handleChallenge(peerId) {
    const room = state.room;
    if (!room || !room.pendingChallenge) return;
    if (peerId !== room.pendingChallenge.victimId) return;
    const offender = findPlayer(room.pendingChallenge.offenderId);
    const victim = findPlayer(room.pendingChallenge.victimId);
    if (!offender || !victim) return;
    const illegal = hasColor(offender, room.pendingChallenge.color);
    if (illegal) {
      drawCards(offender, 4);
      room.message = offender.name + ' 违规 +4，被质疑成功，罚抽 4 张！';
      pushSystemMessage('⚠ ' + victim.name + ' 质疑成功，' + offender.name + ' 罚抽 4 张');
      room.pendingChallenge = null;
      room.pendingDraw = 0;
      room.pendingType = null;
      nextTurn(1);
    } else {
      drawCards(victim, 6);
      room.message = victim.name + ' 质疑失败，罚抽 6 张！';
      pushSystemMessage('⚠ ' + victim.name + ' 质疑失败，罚抽 6 张');
      room.pendingChallenge = null;
      nextTurn(2);
    }
    broadcastState();
  }

  function handleAcceptDraw(peerId) {
    const room = state.room;
    if (!room || !room.pendingChallenge) return;
    if (peerId !== room.pendingChallenge.victimId) return;
    const victim = findPlayer(room.pendingChallenge.victimId);
    if (!victim) return;
    drawCards(victim, 4);
    room.message = victim.name + ' 摸了 4 张牌';
    room.pendingChallenge = null;
    room.pendingDraw = 0;
    room.pendingType = null;
    nextTurn(2);
    broadcastState();
  }

  function handleSwapTarget(peerId, targetId) {
    const room = state.room;
    if (!room || !room.pendingSwap) return;
    if (peerId !== room.pendingSwap.from) return;
    const from = findPlayer(peerId), to = findPlayer(targetId);
    if (!from || !to || from.id === to.id) return;
    const tmp = from.hand;
    from.hand = to.hand;
    to.hand = tmp;
    room.pendingSwap = null;
    room.message = from.name + ' 与 ' + to.name + ' 交换了手牌';
    pushSystemMessage('🔄 ' + from.name + ' 与 ' + to.name + ' 交换了手牌');
    nextTurn(1);
    broadcastState();
  }

  function broadcastState() {
    const room = state.room;
    if (!room) return;
    for (let i = 0; i < room.players.length; i++) {
      const p = room.players[i];
      const st = {
        id: room.id, hostId: room.hostId, phase: room.phase,
        rules: room.rules,
        serverId: room.serverId,
        players: room.players.map(pl => ({
          id: pl.id, name: pl.name, cardCount: pl.hand.length,
          isYou: pl.id === p.id, hand: pl.id === p.id ? pl.hand : undefined,
          unoCalled: pl.unoCalled, score: pl.score || 0, alive: pl.alive !== false
        })),
        turnId: room.players[room.turnIndex] ? room.players[room.turnIndex].id : null,
        currentColor: room.currentColor, topCard: room.topCard,
        drawnCardId: room.drawnCardId,
        winnerId: room.winnerId, winnerName: room.winnerName,
        message: room.message || '',
        chatMessages: room.chatMessages,
        pendingDraw: room.pendingDraw, pendingType: room.pendingType,
        pendingChallenge: room.pendingChallenge, pendingSwap: room.pendingSwap,
        eliminatedId: room.eliminatedId, eliminatedName: room.eliminatedName
      };
      if (p.id === room.hostId) applyState(st);
      else {
        const c = state.clientConns[p.id];
        if (c && c.open) c.send({ type: 'state', state: st });
      }
    }
  }

  /* =========================================================
     8. 网络层（PeerJS 优先 + Vercel 自动兜底）
     ========================================================= */
  function createRoom() {
    const primaryServer = 'peerjs';
    const fallbackServer = 'vercel';

    showLoading('正在连接 PeerJS 官方…', '若 8 秒内无响应，将自动切换到 Vercel 备用');

    const hostDigits = Math.floor(1000 + Math.random() * 9000);  // 4 位数字

    // 先把房间号占位显示，等确定服务器后再更新前缀
    tryCreateOnServer(primaryServer, hostDigits, fallbackServer);
  }

  function tryCreateOnServer(serverId, hostDigits, fallbackServer) {
    const roomId = SERVERS[serverId].prefix + hostDigits;
    const myPeerId = 'uno-host-' + roomId;

    // 初始化房间对象（但先不加入 players，等 peer 打开成功再正式生效）
    const roomObj = {
      id: roomId, hostId: myPeerId, phase: 'waiting',
      serverId: serverId,
      players: [{ id: myPeerId, name: getName(), hand: [], unoCalled: false, score: 0, alive: true }],
      deck: [], discard: [], topCard: null,
      currentColor: null, turnIndex: 0, direction: 1,
      drawnCardId: null, winnerId: null, winnerName: null, message: '',
      chatMessages: [],
      rules: { mode: 'single', stacking: false, forcePlay: false, sevenZero: false },
      pendingDraw: 0, pendingType: null,
      pendingChallenge: null, pendingSwap: null,
      eliminatedId: null, eliminatedName: null
    };

    const { peer, error } = createPeer(myPeerId, serverId);
    if (error || !peer) {
      if (fallbackServer) {
        showLoading('PeerJS 官方不可用', '正在尝试 Vercel 备用服务器…');
        setTimeout(() => tryCreateOnServer(fallbackServer, hostDigits, null), 400);
      } else {
        hideLoading();
        toast('所有信令服务器都不可用，请稍后再试');
      }
      return;
    }

    let opened = false;
    const timeout = setTimeout(() => {
      if (opened) return;
      try { peer.destroy(); } catch (e) {}

      if (fallbackServer) {
        // 自动切换到 Vercel 备用
        showLoading('PeerJS 官方超时', '正在尝试 Vercel 备用服务器…');
        setTimeout(() => tryCreateOnServer(fallbackServer, hostDigits, null), 400);
      } else {
        hideLoading();
        toast('无法连接信令服务器，请检查网络或稍后再试');
      }
    }, 8000);

    peer.on('open', () => {
      opened = true;
      clearTimeout(timeout);

      // 正式生效
      state.isHost = true;
      state.roomId = roomId;
      state.myPeerId = myPeerId;
      state.myPlayerId = myPeerId;
      state.usedServer = serverId;
      state.room = roomObj;
      state.peer = peer;

      // 监听连接
      peer.on('connection', conn => {
        conn.on('open', () => {
          conn.on('data', data => handleClientMessage(conn, data));
          conn.on('close', () => removePlayer(conn.peer));
        });
      });
      peer.on('error', err => {
        if (err.type === 'unavailable-id') {
          toast('房间号冲突，请重试');
          resetAndGoHome();
        }
      });

      hideLoading();
      $('roomCode').textContent = roomId;
      const serverLabel = SERVERS[serverId].label +
        (serverId === 'vercel' ? '（PeerJS 超时自动切换）' : '');
      $('roomServerHint').textContent = '信令服务器：' + serverLabel;
      $('rulesBtn').classList.add('show');
      switchScreen('room');
      broadcastState();
    });

    peer.on('error', err => {
      if (opened) return;
      clearTimeout(timeout);
      try { peer.destroy(); } catch (e) {}

      if (fallbackServer) {
        showLoading('PeerJS 官方出错', '正在尝试 Vercel 备用服务器…');
        setTimeout(() => tryCreateOnServer(fallbackServer, hostDigits, null), 400);
      } else {
        hideLoading();
        toast('连接信令服务器失败：' + (err.type || err.message || '未知错误'));
      }
    });
  }

  function joinRoom(inputRoomId) {
    const parsed = parseRoomId(inputRoomId);
    if (!parsed) {
      toast('房间号格式不对，应以 P 或 V 开头');
      return;
    }

    if (parsed.serverId === 'vercel' && !getVercelHost()) {
      toast('房主使用了 Vercel 服务器，但你的备用地址未配置');
      return;
    }

    const serverLabel = SERVERS[parsed.serverId].label;
    showLoading('正在加入房间 ' + parsed.fullRoomId + '…', '使用 ' + serverLabel);

    state.isHost = false;
    state.roomId = parsed.fullRoomId;
    state.myPeerId = 'uno-client-' + Math.random().toString(36).slice(2, 8);
    state.myPlayerId = state.myPeerId;
    state.usedServer = parsed.serverId;

    const { peer, error } = createPeer(state.myPeerId, parsed.serverId);
    if (error || !peer) {
      hideLoading();
      toast('无法创建连接：' + (error ? error.message : '未知'));
      resetAndGoHome();
      return;
    }

    let opened = false;
    const timeout = setTimeout(() => {
      if (opened) return;
      try { peer.destroy(); } catch (e) {}
      hideLoading();
      toast('连接信令服务器超时，请检查网络');
      resetAndGoHome();
    }, 10000);

    peer.on('open', () => {
      opened = true;
      clearTimeout(timeout);

      state.peer = peer;
      const hostId = 'uno-host-' + state.roomId;
      state.hostConn = peer.connect(hostId);

      let connOpened = false;
      const connTimeout = setTimeout(() => {
        if (connOpened) return;
        hideLoading();
        toast('无法连接到房主，请确认房间号');
        try { peer.destroy(); } catch (e) {}
        resetAndGoHome();
      }, 10000);

      state.hostConn.on('open', () => {
        connOpened = true;
        clearTimeout(connTimeout);
        state.hostConn.send({ type: 'join', name: getName() });
        // loading 会在 applyState 里被隐藏
      });
      state.hostConn.on('data', data => handleHostMessage(data));
      state.hostConn.on('close', () => { hideLoading(); toast('与房主断开连接'); resetAndGoHome(); });
      state.hostConn.on('error', () => {
        clearTimeout(connTimeout);
        hideLoading();
        toast('连接房间失败');
        resetAndGoHome();
      });
    });

    peer.on('error', err => {
      if (opened) return;
      clearTimeout(timeout);
      hideLoading();
      toast('连接失败：' + (err.type || err.message || '未知错误'));
      resetAndGoHome();
    });
  }

  function resetAndGoHome() {
    if (state.peer) { try { state.peer.destroy(); } catch (e) {} state.peer = null; }
    state.hostConn = null;
    Object.keys(state.clientConns).forEach(k => { try { state.clientConns[k].close(); } catch (e) {} });
    state.clientConns = {};
    state.room = null;
    state.isHost = false;
    state.roomId = '';
    state.myPlayerId = '';
    state.S = null;
    state.currentRoomId = '';
    state.usedServer = 'peerjs';
    hideLoading();
    $('rulesBtn').classList.remove('show');
    $('chatToggleBtn').classList.remove('show');
    $('chatPanel').classList.remove('open');
    $('overlay').classList.remove('show');
    $('challengeOverlay').classList.remove('show');
    $('swapOverlay').classList.remove('show');
    $('colorPicker').classList.remove('show');
    $('rulesPanel').classList.remove('show');
    switchScreen('home');
  }

  function removePlayer(peerId) {
    const room = state.room;
    if (!room) return;
    let wasName = '';
    const p = room.players.find(x => x.id === peerId);
    if (p) wasName = p.name;
    room.players = room.players.filter(x => x.id !== peerId);
    delete state.clientConns[peerId];
    if (room.players.length === 0) return;
    if (room.hostId === peerId) room.hostId = room.players[0].id;
    if (room.phase === 'playing' || room.phase === 'roundEnd') {
      const aliveCount = room.players.filter(p => p.alive !== false).length;
      if (aliveCount < 2) {
        room.phase = 'ended';
        room.winnerName = '玩家不足';
        room.winnerId = null;
      }
    }
    if (wasName) pushSystemMessage(wasName + ' 离开了房间');
    broadcastState();
  }

  function handleClientMessage(conn, data) {
    const room = state.room;
    if (!room || room.phase === 'ended') return;
    if (data.type === 'join') {
      if (room.phase !== 'waiting') { conn.send({ type: 'toast', msg: '游戏已开始' }); return; }
      if (room.players.length >= 4) { conn.send({ type: 'toast', msg: '房间已满' }); return; }
      room.players.push({ id: conn.peer, name: (data.name || '玩家').slice(0, 8), hand: [], unoCalled: false, score: 0, alive: true });
      state.clientConns[conn.peer] = conn;
      pushSystemMessage((data.name || '玩家') + ' 加入了房间');
      broadcastState();
    } else if (data.type === 'start') {
      if (conn.peer !== room.hostId) return;
      if (room.players.length >= 2) startGame();
    }
    else if (data.type === 'playCard') handlePlayCard(conn.peer, data.cardId, data.color);
    else if (data.type === 'drawCard') handleDrawCard(conn.peer);
    else if (data.type === 'pass') handlePass(conn.peer);
    else if (data.type === 'callUno') handleCallUno(conn.peer);
    else if (data.type === 'catchUno') handleCatchUno(conn.peer, data.targetId);
    else if (data.type === 'chat') handleChatMessage(conn.peer, data.text);
    else if (data.type === 'challenge') handleChallenge(conn.peer);
    else if (data.type === 'acceptDraw') handleAcceptDraw(conn.peer);
    else if (data.type === 'swapTarget') handleSwapTarget(conn.peer, data.targetId);
  }

  function handleHostMessage(data) {
    if (data.type === 'state') applyState(data.state);
    else if (data.type === 'toast') toast(data.msg);
  }

  /* =========================================================
     9. UI 渲染
     ========================================================= */
  function applyState(newState) {
    hideLoading();  // 收到房主第一条状态后隐藏 loading
    if (newState.id !== state.currentRoomId) {
      state.currentRoomId = newState.id;
      state.lastChatLen = -1;
      state.chatInitialized = false;
      state.unreadCount = 0;
      updateChatBadge();
      $('chatMessages').innerHTML = '<div class="chat-empty">暂无消息</div>';
    }
    state.S = newState;
    render();
  }

  function render() {
    const S = state.S;
    if (!S) return;
    updateChatBtnVisibility();
    renderChat();

    if (state.isHost) $('rulesBtn').classList.add('show');
    else $('rulesBtn').classList.remove('show');

    if (S.pendingChallenge && S.pendingChallenge.victimId === myId()) {
      $('challengeText').textContent = nameOf(S.pendingChallenge.offenderId) + ' 对你打出 +4';
      $('challengeOverlay').classList.add('show');
    } else $('challengeOverlay').classList.remove('show');

    if (S.pendingSwap && S.pendingSwap.from === myId()) {
      let html = '';
      S.players.forEach(p => {
        if (p.id !== myId() && p.alive !== false)
          html += '<button style="width:100%" data-swap="' + p.id + '">' + esc(p.name) + '</button>';
      });
      $('swapList').innerHTML = html;
      $('swapOverlay').classList.add('show');
    } else $('swapOverlay').classList.remove('show');

    if (S.phase === 'waiting') {
      switchScreen('room');
      renderRoom();
      $('overlay').classList.remove('show');
      $('colorPicker').classList.remove('show');
      return;
    }
    switchScreen('game');
    renderGame();
  }

  function renderRoom() {
    const S = state.S;
    $('roomCode').textContent = S.id;
    const host = S.hostId === myId();
    const serverLabel = SERVERS[S.serverId] ? SERVERS[S.serverId].label : '';
    $('roomServerHint').textContent = serverLabel ? ('信令服务器：' + serverLabel) : '';
    const modeText = S.rules.mode === 'score' ? ' · 计分制' : (S.rules.mode === 'elimination' ? ' · 淘汰制' : ' · 单局制');
    $('playerList').innerHTML = S.players.map((p, i) => {
      let tag = i === 0 ? '房主' : '';
      if (S.rules.mode === 'score') tag = (tag ? tag + ' · ' : '') + (p.score || 0) + ' 分';
      if (S.rules.mode === 'elimination' && p.alive === false) tag = (tag ? tag + ' · ' : '') + '观战';
      return '<li><span>' + esc(p.name) + (p.isYou ? '（你）' : '') + '</span><span class="tag">' + tag + '</span></li>';
    }).join('');
    const btn = $('startBtn'), tip = $('waitTip');
    btn.style.display = host ? 'block' : 'none';
    tip.style.display = host ? 'none' : 'block';
    btn.disabled = S.players.length < 2;
    btn.textContent = S.players.length < 2 ? '等待玩家加入…' : '开始游戏';
    if (!host) tip.textContent = '等待房主开始…' + modeText;
  }

  function renderGame() {
    const S = state.S;
    const me = myPlayer();
    if (!me) return;
    const isSpectator = me.alive === false;

    const others = S.players.filter(p => !p.isYou);
    $('opponents').innerHTML = others.length ? others.map(p => {
      let unoBtn = '';
      if (p.cardCount === 1 && !p.unoCalled && p.alive !== false)
        unoBtn = '<button class="opp-uno-btn" data-catch="' + p.id + '">抓UNO</button>';
      const scoreHtml = (S.rules.mode === 'score') ? '<div style="font-size:10px;color:#ffd166;font-weight:700">' + (p.score || 0) + '分</div>' : '';
      const specHtml = p.alive === false ? '<div style="font-size:10px;color:#7f9b8e;font-weight:700">👁 观战</div>' : '';
      return '<div class="opp ' + (S.turnId === p.id ? 'active' : '') + (p.alive === false ? ' spectator' : '') + '">' +
        '<div class="opp-name">' + esc(p.name) + '</div>' + unoBtn + scoreHtml + specHtml + '</div>';
    }).join('') : '<div class="opp"><div class="opp-name">等待中…</div></div>';

    const top = S.topCard;
    $('discard').innerHTML = top ? '<div class="card ' + top.color + '">' + cardLabel(top) + '</div>' : '';
    const colorMap = { red: '#e63946', yellow: '#e6a800', green: '#2a9d8f', blue: '#3a7bd5' };
    $('discard').style.boxShadow = '0 0 0 4px ' + (colorMap[S.currentColor] || 'transparent');

    const isMyTurn = S.turnId === me.id && S.phase === 'playing' && !isSpectator;

    if (S.phase === 'ended') $('status').textContent = S.winnerName + ' 获胜 🎉';
    else if (S.phase === 'roundEnd') $('status').textContent = S.message || (S.winnerName + ' 赢得本局');
    else if (isSpectator) $('status').textContent = '👁 观战中 — ' + (S.message || (nameOf(S.turnId) + ' 出牌中…'));
    else if (isMyTurn) {
      if (S.rules.stacking && S.pendingDraw > 0) $('status').textContent = '需出 ' + S.pendingType + ' 或摸 ' + S.pendingDraw + ' 张';
      else $('status').textContent = S.drawnCardId !== null ? (S.rules.forcePlay ? '必须打出摸到的牌' : '出牌，或点「跳过回合」') : '轮到你了';
    } else {
      $('status').textContent = S.message || ('等待 ' + nameOf(S.turnId) + ' 出牌…');
    }

    $('deck').classList.toggle('can-draw', isMyTurn && S.drawnCardId === null && !(S.rules.stacking && S.pendingDraw > 0 && S.drawnCardId !== null));

    const passBtn = $('passBtn');
    if (isSpectator) passBtn.classList.remove('show');
    else if (S.rules.stacking && S.pendingDraw > 0 && isMyTurn) {
      passBtn.classList.add('show');
      passBtn.textContent = '摸 ' + S.pendingDraw + ' 张并跳过';
    } else if (isMyTurn && S.drawnCardId !== null && !S.rules.forcePlay) {
      passBtn.classList.add('show');
      passBtn.textContent = '跳过回合';
    } else passBtn.classList.remove('show');

    const unoBtnEl = $('unoBtn');
    if (!isSpectator && me.hand && me.hand.length === 1 && !me.unoCalled && S.phase === 'playing') unoBtnEl.classList.add('show');
    else unoBtnEl.classList.remove('show');

    if (isSpectator) {
      $('myHand').innerHTML = '<div class="spectator-tip">👁 观战中 · 等待下一局</div>';
    } else if (me.hand) {
      $('myHand').innerHTML = me.hand.map(c => {
        const ok = isPlayable(c, me);
        return '<div class="card ' + c.color + ' ' + (ok ? 'playable' : 'dim') + '" data-id="' + c.id + '">' + cardLabel(c) + '</div>';
      }).join('');
    } else $('myHand').innerHTML = '';

    if (S.phase === 'ended') {
      const win = S.winnerId === myId();
      const host = S.hostId === myId();
      const modeLabel = S.rules.mode === 'score' ? '（计分制）' : (S.rules.mode === 'elimination' ? '（淘汰制）' : '');
      $('overlayTitle').textContent = win ? '🎉 你赢了！' + modeLabel : S.winnerName + ' 获胜' + modeLabel;
      if (S.rules.mode === 'score') {
        let txt = '';
        S.players.forEach(p => { txt += p.name + '：' + (p.score || 0) + ' 分<br>'; });
        const reached500 = S.players.some(p => (p.score || 0) >= 500);
        if (reached500) {
          $('overlayTitle').textContent = '🏆 最终获胜：' + S.winnerName;
          $('overlayBtn').textContent = host ? '重新开始' : '等待房主';
        } else {
          $('overlayBtn').textContent = host ? '下一局' : '等待房主';
        }
        $('overlayScore').style.display = 'block';
        $('overlayScore').innerHTML = txt;
      } else if (S.rules.mode === 'elimination') {
        $('overlayScore').style.display = 'block';
        $('overlayScore').innerHTML = '淘汰制结束 · 最后幸存者：<b style="color:#ffd166">' + S.winnerName + '</b>';
        $('overlayBtn').textContent = host ? '重新开始' : '等待房主';
      } else {
        $('overlayScore').style.display = 'none';
        $('overlayBtn').textContent = host ? '再来一局' : '等待房主开始…';
      }
      $('overlayBtn').disabled = !host;
      $('overlay').classList.add('show');
      if (win) sfxWin(); else sfxLose();
    } else if (S.phase === 'roundEnd') {
      const host2 = S.hostId === myId();
      $('overlayTitle').textContent = S.winnerName + ' 赢得本局';
      $('overlayScore').style.display = 'block';
      $('overlayScore').innerHTML = S.eliminatedName ? ('💀 ' + S.eliminatedName + ' 被淘汰，进入观战') : '本局结束';
      $('overlayBtn').textContent = host2 ? '下一局' : '等待房主开始…';
      $('overlayBtn').disabled = !host2;
      $('overlay').classList.add('show');
    } else {
      $('overlay').classList.remove('show');
      $('overlayScore').style.display = 'none';
    }
  }

  function updateChatBtnVisibility() {
    const S = state.S;
    if (S && (S.phase === 'playing' || S.phase === 'waiting' || S.phase === 'roundEnd')) {
      $('chatToggleBtn').classList.add('show');
    } else {
      $('chatToggleBtn').classList.remove('show');
      $('chatPanel').classList.remove('open');
    }
  }
  function updateChatBadge() {
    const badge = $('chatBadge');
    if (state.unreadCount > 0) {
      badge.textContent = state.unreadCount > 99 ? '99+' : state.unreadCount;
      badge.classList.add('show');
    } else badge.classList.remove('show');
  }
  function renderMsgHtml(m) {
    if (m.sender === 'system') return '<div class="chat-msg-sys">' + esc(m.text) + '</div>';
    const isSelf = m.sender === state.myPlayerId;
    return '<div class="chat-msg' + (isSelf ? ' self' : '') + '">' +
      '<div class="chat-msg-sender">' + esc(m.senderName) + '</div>' +
      '<div class="chat-msg-bubble">' + esc(m.text) + '</div></div>';
  }
  function renderChat() {
    const S = state.S;
    if (!S) return;
    const msgs = S.chatMessages || [];
    const el = $('chatMessages');
    if (!state.chatInitialized) {
      el.innerHTML = msgs.length ? msgs.map(renderMsgHtml).join('') : '<div class="chat-empty">暂无消息</div>';
      state.chatInitialized = true;
      state.lastChatLen = msgs.length;
      return;
    }
    if (msgs.length === state.lastChatLen) return;
    el.innerHTML = msgs.length ? msgs.map(renderMsgHtml).join('') : '<div class="chat-empty">暂无消息</div>';
    if (msgs.length > state.lastChatLen) {
      const added = msgs.length - state.lastChatLen;
      if ($('chatPanel').classList.contains('open')) {
        setTimeout(() => { el.scrollTop = el.scrollHeight; }, 0);
      } else {
        state.unreadCount += added;
        updateChatBadge();
        sfxMsg();
      }
    }
    state.lastChatLen = msgs.length;
  }
  function openChat() {
    $('chatPanel').classList.add('open');
    state.unreadCount = 0;
    updateChatBadge();
    setTimeout(() => { $('chatMessages').scrollTop = $('chatMessages').scrollHeight; }, 320);
  }

  /* =========================================================
     10. 设置 / 房规
     ========================================================= */
  let globalFontScale = parseFloat(localStorage.getItem('uno_font_scale') || '100') / 100;
  function applyFontScale() {
    const app = $('app');
    app.style.zoom = globalFontScale;
    app.style.width = (100 / globalFontScale) + '%';
    app.style.height = (100 / globalFontScale) + 'vh';
  }

  function initSettings() {
    applyFontScale();

    const vercelHostInput = $('vercelHostInput');
    vercelHostInput.value = localStorage.getItem('uno_vercel_host') || '';

    const volumeSlider = $('volumeSlider');
    const fontSlider = $('fontSlider');
    volumeSlider.value = Math.round(globalVolume * 100);
    fontSlider.value = Math.round(globalFontScale * 100);
    $('volumeValue').textContent = Math.round(globalVolume * 100);
    $('fontValue').textContent = Math.round(globalFontScale * 100);

    volumeSlider.addEventListener('input', function () {
      const v = parseInt(this.value);
      globalVolume = v / 100;
      localStorage.setItem('uno_volume', v);
      $('volumeValue').textContent = v;
      initAudio();
      playTone(880, 0.08, 'sine', 0.15);
    });

    fontSlider.addEventListener('input', function () {
      const v = parseInt(this.value);
      globalFontScale = v / 100;
      localStorage.setItem('uno_font_scale', v);
      $('fontValue').textContent = v;
      applyFontScale();
    });

    vercelHostInput.addEventListener('change', function () {
      const v = this.value.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
      this.value = v;
      if (v) localStorage.setItem('uno_vercel_host', v);
      else localStorage.removeItem('uno_vercel_host');
    });

    $('settingsBtn').addEventListener('click', () => { initAudio(); $('settingsPanel').classList.add('show'); });
    $('settingsCloseBtn').addEventListener('click', () => $('settingsPanel').classList.remove('show'));

    bindRulesEvents();
  }

  function bindRulesEvents() {
    const ruleStacking = $('ruleStacking'), ruleForcePlay = $('ruleForcePlay'), ruleSevenZero = $('ruleSevenZero');

    function loadRulesToUI() {
      const room = state.room;
      if (!room) return;
      const m = room.rules.mode || 'single';
      document.querySelectorAll('input[name="gameMode"]').forEach(r => {
        r.checked = (r.value === m);
        r.closest('.mode-option').classList.toggle('active', r.checked);
      });
      ruleStacking.checked = !!room.rules.stacking;
      ruleForcePlay.checked = !!room.rules.forcePlay;
      ruleSevenZero.checked = !!room.rules.sevenZero;
    }

    document.querySelectorAll('input[name="gameMode"]').forEach(r => {
      r.addEventListener('change', () => {
        document.querySelectorAll('.mode-option').forEach(el => el.classList.remove('active'));
        if (r.checked) r.closest('.mode-option').classList.add('active');
      });
    });
    document.querySelectorAll('.mode-option').forEach(el => {
      el.addEventListener('click', e => {
        if (e.target.tagName === 'INPUT') return;
        const input = el.querySelector('input');
        input.checked = true;
        input.dispatchEvent(new Event('change'));
      });
    });

    $('rulesBtn').addEventListener('click', () => {
      if (state.isHost) { loadRulesToUI(); $('rulesPanel').classList.add('show'); }
    });

    $('rulesCloseBtn').addEventListener('click', () => {
      const room = state.room;
      if (!room || !state.isHost) { $('rulesPanel').classList.remove('show'); return; }
      const newMode = document.querySelector('input[name="gameMode"]:checked').value;
      const modeChanged = room.rules.mode !== newMode;
      room.rules.mode = newMode;
      room.rules.stacking = ruleStacking.checked;
      room.rules.forcePlay = ruleForcePlay.checked;
      room.rules.sevenZero = ruleSevenZero.checked;
      if (modeChanged) {
        room.players.forEach(p => { p.alive = true; p.score = 0; });
        room.phase = 'waiting';
        room.winnerId = null; room.winnerName = null;
        room.eliminatedId = null; room.eliminatedName = null;
        room.pendingDraw = 0; room.pendingType = null;
        room.pendingChallenge = null; room.pendingSwap = null;
        const modeLabels = { single: '单局制', score: '累积500分', elimination: '淘汰制' };
        pushSystemMessage('模式已切换为：' + modeLabels[newMode]);
      }
      $('rulesPanel').classList.remove('show');
      broadcastState();
    });
  }

  /* =========================================================
     11. 聊天交互
     ========================================================= */
  function bindChatEvents() {
    $('chatToggleBtn').addEventListener('click', () => {
      initAudio();
      if ($('chatPanel').classList.contains('open')) $('chatPanel').classList.remove('open');
      else openChat();
    });
    $('chatCloseBtn').addEventListener('click', () => $('chatPanel').classList.remove('open'));
    $('chatSendBtn').addEventListener('click', sendChat);
    $('chatInput').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); sendChat(); }
    });
  }
  function sendChat() {
    const input = $('chatInput');
    const text = input.value.trim();
    if (!text) return;
    initAudio();
    if (state.isHost) handleChatMessage(state.myPlayerId, text);
    else if (state.hostConn && state.hostConn.open) state.hostConn.send({ type: 'chat', text });
    input.value = '';
  }

  /* =========================================================
     12. 主入口
     ========================================================= */
  function init() {
    $('nameInput').value = localStorage.getItem('uno_name') || '';

    initSettings();
    bindChatEvents();

    $('createBtn').addEventListener('click', () => { initAudio(); createRoom(); });
    $('joinBtn').addEventListener('click', () => {
      initAudio();
      const rid = $('roomInput').value.trim();
      if (!rid) return toast('请输入房间号');
      joinRoom(rid);
    });
    $('roomInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('joinBtn').click(); });
    $('nameInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('createBtn').click(); });

    $('startBtn').addEventListener('click', () => {
      if (state.isHost) {
        if (state.room && state.room.players.length >= 2) startGame();
        else toast('至少需要2名玩家');
      } else if (state.hostConn && state.hostConn.open) {
        state.hostConn.send({ type: 'start' });
      }
    });

    $('exitBtn').addEventListener('click', () => {
      const msg = state.isHost ? '确定解散房间并退出吗？' : '确定离开房间吗？';
      if (!confirm(msg)) return;
      if (state.isHost && state.room && state.clientConns) {
        Object.keys(state.clientConns).forEach(pid => {
          const c = state.clientConns[pid];
          if (c && c.open) { try { c.send({ type: 'toast', msg: '房主已解散房间' }); } catch (e) {} }
          try { c.close(); } catch (e) {}
        });
      }
      resetAndGoHome();
      toast('已退出房间');
    });

    $('overlayBtn').addEventListener('click', () => {
      const btn = $('overlayBtn');
      if (btn.disabled) return;
      const S = state.S;
      if (!S) return;
      if (S.phase === 'roundEnd') {
        if (state.isHost) startGame();
        return;
      }
      if (state.isHost) {
        const room = state.room;
        if (!room) return;
        let reached500 = false;
        if (room.rules.mode === 'score') {
          room.players.forEach(p => { if ((p.score || 0) >= 500) reached500 = true; });
        }
        if (reached500 || room.rules.mode === 'elimination') {
          room.players.forEach(p => { p.score = 0; p.alive = true; });
        }
        room.phase = 'waiting';
        room.winnerId = null; room.winnerName = null;
        room.eliminatedId = null; room.eliminatedName = null;
        room.pendingDraw = 0; room.pendingType = null;
        room.pendingChallenge = null; room.pendingSwap = null;
        room.message = '';
        broadcastState();
      } else if (state.hostConn && state.hostConn.open) {
        state.hostConn.send({ type: 'start' });
      }
    });

    $('myHand').addEventListener('click', e => {
      const el = e.target.closest ? e.target.closest('.card') : null;
      if (!el || !state.S || state.S.phase !== 'playing') return;
      const me = myPlayer();
      if (!me || me.alive === false || state.S.turnId !== me.id) return;
      const card = me.hand.find(c => String(c.id) === el.dataset.id);
      if (!card || !isPlayable(card, me)) return;
      sfxClick();
      if (card.color === 'wild') {
        state.pendingWild = card.id;
        $('colorPicker').classList.add('show');
      } else {
        if (state.isHost) handlePlayCard(state.myPlayerId, card.id);
        else if (state.hostConn && state.hostConn.open) state.hostConn.send({ type: 'playCard', cardId: card.id });
      }
    });

    $('deck').addEventListener('click', () => {
      if (!state.S || state.S.phase !== 'playing') return;
      const me = myPlayer();
      if (!me || me.alive === false || state.S.turnId !== me.id) return;
      if (state.S.drawnCardId !== null && !(state.S.rules.stacking && state.S.pendingDraw > 0)) return;
      sfxDraw();
      if (state.isHost) handleDrawCard(state.myPlayerId);
      else if (state.hostConn && state.hostConn.open) state.hostConn.send({ type: 'drawCard' });
    });

    $('passBtn').addEventListener('click', () => {
      sfxClick();
      if (state.S && state.S.rules.stacking && state.S.pendingDraw > 0) {
        if (state.isHost) handleDrawCard(state.myPlayerId);
        else if (state.hostConn && state.hostConn.open) state.hostConn.send({ type: 'drawCard' });
      } else {
        if (state.isHost) handlePass(state.myPlayerId);
        else if (state.hostConn && state.hostConn.open) state.hostConn.send({ type: 'pass' });
      }
    });

    $('unoBtn').addEventListener('click', () => {
      sfxPlay();
      if (state.isHost) handleCallUno(state.myPlayerId);
      else if (state.hostConn && state.hostConn.open) state.hostConn.send({ type: 'callUno' });
    });

    $('opponents').addEventListener('click', e => {
      const btn = e.target.closest ? e.target.closest('.opp-uno-btn') : null;
      if (!btn) return;
      const targetId = btn.dataset.catch;
      sfxClick();
      if (state.isHost) handleCatchUno(state.myPlayerId, targetId);
      else if (state.hostConn && state.hostConn.open) state.hostConn.send({ type: 'catchUno', targetId });
    });

    $('challengeBtn').addEventListener('click', () => {
      $('challengeOverlay').classList.remove('show');
      sfxClick();
      if (state.isHost) handleChallenge(state.myPlayerId);
      else if (state.hostConn && state.hostConn.open) state.hostConn.send({ type: 'challenge' });
    });
    $('acceptDrawBtn').addEventListener('click', () => {
      $('challengeOverlay').classList.remove('show');
      sfxClick();
      if (state.isHost) handleAcceptDraw(state.myPlayerId);
      else if (state.hostConn && state.hostConn.open) state.hostConn.send({ type: 'acceptDraw' });
    });

    $('swapList').addEventListener('click', e => {
      const btn = e.target.closest ? e.target.closest('button[data-swap]') : null;
      if (!btn) return;
      $('swapOverlay').classList.remove('show');
      sfxClick();
      if (state.isHost) handleSwapTarget(state.myPlayerId, btn.dataset.swap);
      else if (state.hostConn && state.hostConn.open) state.hostConn.send({ type: 'swapTarget', targetId: btn.dataset.swap });
    });

    document.querySelectorAll('#colorPicker .swatch').forEach(el => {
      el.addEventListener('click', () => {
        $('colorPicker').classList.remove('show');
        if (state.pendingWild !== null) {
          sfxPlay();
          if (state.isHost) handlePlayCard(state.myPlayerId, state.pendingWild, el.dataset.color);
          else if (state.hostConn && state.hostConn.open) state.hostConn.send({ type: 'playCard', cardId: state.pendingWild, color: el.dataset.color });
          state.pendingWild = null;
        }
      });
    });

    window.addEventListener('beforeunload', e => {
      if (state.room && state.room.phase !== 'waiting') {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  init();
})();