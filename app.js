(function () {
  'use strict';

  /* ⚠️【需要手动修改】Vercel 备用服务器地址 */
  const DEFAULT_VERCEL_HOST = 'uno-peerjs.vercel.app';  // 👈 改成你的域名

  const UNO_GRACE_MS = 1500;  // UNO 保护期 1.5 秒

  /* ============ 1. 通用工具 ============ */
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
    if (name === 'room' || name === 'game') {
      topBar.classList.add('show');
      $('guideBtn').classList.add('show');
    } else {
      topBar.classList.remove('show');
      $('guideBtn').classList.remove('show');
    }
  }
  function getName() {
    const n = ($('nameInput').value.trim() || '玩家').slice(0, 8);
    localStorage.setItem('uno_name', n);
    return n;
  }
  function getAvatar() {
    return localStorage.getItem('uno_avatar') || '😀';
  }
  function showLoading(text, subtext) {
    $('loadingText').innerHTML = esc(text || '正在连接…') +
      (subtext ? '<strong>' + esc(subtext) + '</strong>' : '');
    $('loadingOverlay').classList.add('show');
  }
  function hideLoading() { $('loadingOverlay').classList.remove('show'); }

  /* ============ 2. 服务器 ============ */
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
        username: 'user', credential: 'password'
      }
    ]
  };

  function getVercelHost() {
    return (localStorage.getItem('uno_vercel_host') || DEFAULT_VERCEL_HOST).trim();
  }

  const SERVERS = {
    peerjs: {
      id: 'peerjs', label: 'PeerJS 官方', prefix: 'P',
      buildOptions: () => ({ debug: 0, config: TURN_CONFIG })
    },
    vercel: {
      id: 'vercel', label: 'Vercel 备用', prefix: 'V',
      buildOptions: () => {
        const host = getVercelHost();
        if (!host) return null;
        return {
          host, port: 443, path: '/', secure: true, key: 'peerjs',
          debug: 0, config: TURN_CONFIG
        };
      }
    }
  };

  function createPeer(peerId, serverId) {
    const cfg = SERVERS[serverId];
    if (!cfg) return { error: new Error('未知服务器') };
    const opts = cfg.buildOptions();
    if (!opts) return { error: new Error('服务器未配置') };
    try { return { peer: new Peer(peerId, opts) }; }
    catch (e) { return { error: e }; }
  }

  function genRoomId(serverId) {
    const prefix = SERVERS[serverId].prefix;
    let digits = '';
    for (let i = 0; i < 4; i++) digits += Math.floor(Math.random() * 10);
    return prefix + digits;
  }

  function parseRoomId(input) {
    const str = String(input || '').trim().toUpperCase();
    if (!str) return null;
    if (str[0] === 'P') return { serverId: 'peerjs', fullRoomId: 'P' + str.slice(1) };
    if (str[0] === 'V') return { serverId: 'vercel', fullRoomId: 'V' + str.slice(1) };
    return null;
  }

  /* ============ 3. 状态 ============ */
  const state = {
    peer: null, isHost: false, roomId: '', myPeerId: '', myPlayerId: '',
    hostConn: null, clientConns: {}, room: null, S: null, currentRoomId: '',
    pendingWild: null, unreadCount: 0, lastChatLen: -1, chatInitialized: false,
    usedServer: 'peerjs', lastDiscardId: null, hiddenAt: null, reconnecting: false,
    showSysMessages: localStorage.getItem('uno_show_sys') === '1'
  };

  /* ============ 4. 音效 ============ */
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

  /* ============ 5. 牌组 ============ */
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

  /* ============ 6. 逻辑辅助 ============ */
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

  /* ============ 7. 游戏核心 ============ */
  function pushSystemMessage(text, level) {
    const room = state.room;
    if (!room) return;
    room.chatMessages.push({
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      sender: 'system', senderName: '', text, time: Date.now(),
      level: level || 2
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
      p.unoGraceUntil = 0;
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
    room.typingNow = {};
    room.chatMessages = [];
    pushSystemMessage('游戏开始，' + room.players[firstIdx].name + ' 先出牌', 1);
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
      pushSystemMessage('🏆 ' + player.name + ' 获胜！', 1);
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
      pushSystemMessage('💀 ' + eliminated.name + ' 被淘汰，进入观战', 1);
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
    pushSystemMessage('🏆 ' + winner.name + ' 获得最终胜利！', 1);
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

    // UNO 保护期：剩 1 张牌且没喊 UNO
    if (player.hand.length === 1 && !player.unoCalled) {
      player.unoGraceUntil = Date.now() + UNO_GRACE_MS;
    } else {
      player.unoGraceUntil = 0;
    }

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
      const tag = card.type === 'draw2' ? '+2' : '+4';
      room.message = player.name + ' 打出 ' + tag + '，累计 ' + room.pendingDraw + ' 张';
      pushSystemMessage('⚡ ' + player.name + ' 打出 ' + tag + '，累计 ' + room.pendingDraw + ' 张', 1);
      if (checkWin(player)) return;
      nextTurn(1);
      broadcastState();
      return;
    }

    if (card.type === 'skip') {
      skipNext = true;
      const victim = room.players[nextAliveIdx(1)];
      room.message = player.name + ' 出禁止，' + victim.name + ' 跳过';
      pushSystemMessage('🚫 ' + player.name + ' 对 ' + victim.name + ' 打出禁止', 1);
    }
    else if (card.type === 'reverse') {
      room.direction *= -1;
      room.message = player.name + ' 出反转，方向颠倒';
      pushSystemMessage('⇄ ' + player.name + ' 打出反转', 1);
    }
    else if (card.type === 'draw2') {
      const ni = nextAliveIdx(1);
      const v = room.players[ni];
      drawCards(v, 2); skipNext = true;
      room.message = player.name + ' 对 ' + v.name + ' 打出 +2，' + v.name + ' 摸 2 张';
      pushSystemMessage('➕ ' + player.name + ' 对 ' + v.name + ' 打出 +2，' + v.name + ' 摸 2 张', 1);
    }
    else if (card.type === 'wild4') {
      const ni4 = nextAliveIdx(1);
      const v4 = room.players[ni4];
      const offenderHadColor = hasColor(player, room.topCard.color);
      if (room.rules.challenge === false) {
        // 质疑关闭：直接罚 4 张
        drawCards(v4, 4); skipNext = true;
        room.message = player.name + ' 对 ' + v4.name + ' 打出 +4，' + v4.name + ' 摸 4 张';
        pushSystemMessage('➕ ' + player.name + ' 对 ' + v4.name + ' 打出 +4，' + v4.name + ' 摸 4 张', 1);
      } else {
        // 质疑开启：弹出质疑窗口
        room.pendingChallenge = {
          victimId: v4.id, offenderId: peerId, color: card.color,
          offenderHadColor: offenderHadColor
        };
        room.message = player.name + ' 对 ' + v4.name + ' 打出 +4，等待选择…';
        pushSystemMessage('❓ ' + player.name + ' 对 ' + v4.name + ' 打出 +4，等待选择质疑…', 1);
        if (checkWin(player)) return;
        nextTurn(1);
        broadcastState();
        return;
      }
    }
    else {
      room.message = player.name + ' 出牌';
    }

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
      pushSystemMessage('🃏 ' + player.name + ' 摸了 ' + room.pendingDraw + ' 张牌', 1);
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

    if (player.hand.length === 1 && !player.unoCalled) {
      player.unoGraceUntil = Date.now() + UNO_GRACE_MS;
    }

    const topCard = room.topCard;
    const playable = card.color === 'wild' || card.color === room.currentColor ||
      (card.type === 'number' && topCard.type === 'number' && card.value === topCard.value) ||
      (card.type !== 'number' && card.type === topCard.type);

    if (!playable) {
      room.message = '摸到一张牌，无法出牌，自动跳过';
      pushSystemMessage('🃏 ' + player.name + ' 摸了一张牌，跳过', 2);
      nextTurn(1);
    } else {
      room.message = room.rules.forcePlay ? '摸到一张牌，必须打出' : '摸到一张牌，可出牌或跳过';
      pushSystemMessage('🃏 ' + player.name + ' 摸了一张牌', 2);
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
    room.message = player.name + ' 跳过回合';
    nextTurn(1);
    broadcastState();
  }

  function handleCallUno(peerId) {
    const room = state.room;
    if (!room || room.phase !== 'playing') return;
    const player = findPlayer(peerId);
    if (!player || player.alive === false) return;
    player.unoCalled = true;
    player.unoGraceUntil = 0;
    room.message = player.name + ' 喊了 UNO！';
    pushSystemMessage('📢 ' + player.name + ' 喊了 UNO！', 1);
    broadcastState();
  }

  function handleCatchUno(catcherId, targetId) {
    const room = state.room;
    if (!room || room.phase !== 'playing') return;
    const target = findPlayer(targetId), catcher = findPlayer(catcherId);
    if (!target || !catcher) return;
    if (target.alive === false) return;
    if (target.hand.length !== 1) return;
    if (target.unoCalled) {
      room.message = target.name + ' 已经喊过 UNO 了！';
      broadcastState();
      return;
    }
    if (target.unoGraceUntil && Date.now() < target.unoGraceUntil) {
      room.message = target.name + ' 还在保护期内，不能抓！';
      broadcastState();
      return;
    }
    drawCards(target, 2);
    target.unoCalled = false;
    room.message = target.name + ' 忘记喊 UNO，被 ' + catcher.name + ' 抓到，摸 2 张牌！';
    pushSystemMessage('⚠ ' + target.name + ' 被 ' + catcher.name + ' 抓到，罚摸 2 张', 1);
    broadcastState();
  }

  function handleChallenge(peerId) {
    const room = state.room;
    if (!room || !room.pendingChallenge) return;
    if (peerId !== room.pendingChallenge.victimId) return;
    const offender = findPlayer(room.pendingChallenge.offenderId);
    const victim = findPlayer(room.pendingChallenge.victimId);
    if (!offender || !victim) return;

    const illegal = room.pendingChallenge.offenderHadColor;
    if (illegal) {
      drawCards(offender, 4);
      room.message = offender.name + ' 违规 +4，被质疑成功，罚抽 4 张！';
      pushSystemMessage('⚠ ' + victim.name + ' 质疑成功，' + offender.name + ' 罚抽 4 张', 1);
      room.pendingChallenge = null;
      room.pendingDraw = 0;
      room.pendingType = null;
      nextTurn(1);
    } else {
      drawCards(victim, 6);
      room.message = victim.name + ' 质疑失败，罚抽 6 张！';
      pushSystemMessage('⚠ ' + victim.name + ' 质疑失败，罚抽 6 张', 1);
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
    pushSystemMessage('➕ ' + victim.name + ' 选择摸 4 张牌', 1);
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
    pushSystemMessage('🔄 ' + from.name + ' 与 ' + to.name + ' 交换了手牌', 1);
    nextTurn(1);
    broadcastState();
  }

  function handleTyping(peerId, typing) {
    const room = state.room;
    if (!room) return;
    if (!room.typingNow) room.typingNow = {};
    if (typing) room.typingNow[peerId] = Date.now();
    else delete room.typingNow[peerId];
    broadcastState();
  }

  function handleUpdateAvatar(peerId, avatar) {
    const room = state.room;
    if (!room) return;
    const player = findPlayer(peerId);
    if (!player) return;
    player.avatar = avatar || '😀';
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
          unoCalled: pl.unoCalled, score: pl.score || 0, alive: pl.alive !== false,
          unoGraceUntil: pl.unoGraceUntil || 0,
          avatar: pl.avatar || '😀'
        })),
        turnId: room.players[room.turnIndex] ? room.players[room.turnIndex].id : null,
        currentColor: room.currentColor, topCard: room.topCard,
        drawnCardId: room.drawnCardId,
        winnerId: room.winnerId, winnerName: room.winnerName,
        message: room.message || '',
        chatMessages: room.chatMessages,
        typingNow: room.typingNow || {},
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

  /* ============ 8. 网络层 ============ */
  function createRoom() {
    const primaryServer = 'peerjs';
    const fallbackServer = 'vercel';
    showLoading('正在连接 PeerJS 官方…', '若 8 秒内无响应，将自动切换到 Vercel 备用');
    const hostDigits = Math.floor(1000 + Math.random() * 9000);
    tryCreateOnServer(primaryServer, hostDigits, fallbackServer);
  }

  function tryCreateOnServer(serverId, hostDigits, fallbackServer) {
    const roomId = SERVERS[serverId].prefix + hostDigits;
    const myPeerId = 'uno-host-' + roomId;

    const roomObj = {
      id: roomId, hostId: myPeerId, phase: 'waiting',
      serverId: serverId,
      players: [{
        id: myPeerId, name: getName(), hand: [], unoCalled: false,
        score: 0, alive: true, unoGraceUntil: 0, avatar: getAvatar()
      }],
      deck: [], discard: [], topCard: null,
      currentColor: null, turnIndex: 0, direction: 1,
      drawnCardId: null, winnerId: null, winnerName: null, message: '',
      chatMessages: [], typingNow: {},
      rules: { mode: 'single', stacking: false, forcePlay: false, sevenZero: false, challenge: true },
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

      state.isHost = true;
      state.roomId = roomId;
      state.myPeerId = myPeerId;
      state.myPlayerId = myPeerId;
      state.usedServer = serverId;
      state.room = roomObj;
      state.peer = peer;
      state.lastDiscardId = null;

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
      peer.on('disconnected', () => {
        if (!state.reconnecting) showReconnectButton();
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
    if (!parsed) { toast('房间号格式不对，应以 P 或 V 开头'); return; }
    if (parsed.serverId === 'vercel' && !getVercelHost()) {
      toast('房主使用了 Vercel 服务器，但你的备用地址未配置'); return;
    }
    const serverLabel = SERVERS[parsed.serverId].label;
    showLoading('正在加入房间 ' + parsed.fullRoomId + '…', '使用 ' + serverLabel);

    state.isHost = false;
    state.roomId = parsed.fullRoomId;
    state.myPeerId = 'uno-client-' + Math.random().toString(36).slice(2, 8);
    state.myPlayerId = state.myPeerId;
    state.usedServer = parsed.serverId;
    state.lastDiscardId = null;

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
        state.hostConn.send({ type: 'join', name: getName(), avatar: getAvatar() });
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

    peer.on('disconnected', () => {
      if (!state.reconnecting) showReconnectButton();
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
    state.lastDiscardId = null;
    state.hiddenAt = null;
    state.reconnecting = false;
    hideLoading();
    $('rulesBtn').classList.remove('show');
    $('chatToggleBtn').classList.remove('show');
    $('chatPanel').classList.remove('open');
    $('overlay').classList.remove('show');
    $('challengeOverlay').classList.remove('show');
    $('swapOverlay').classList.remove('show');
    $('colorPicker').classList.remove('show');
    $('rulesPanel').classList.remove('show');
    $('guidePanel').classList.remove('show');
    $('chatPopup').classList.remove('show');
    $('reconnectOverlay').classList.remove('show');
    hideReconnectButton();
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
    if (room.typingNow) delete room.typingNow[peerId];
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
    if (wasName) pushSystemMessage(wasName + ' 离开了房间', 2);
    broadcastState();
  }

  function handleClientMessage(conn, data) {
    const room = state.room;
    if (!room || room.phase === 'ended') return;
    if (data.type === 'join') {
      // ✅ 修复重复玩家：如果同名且旧连接已断开，视为重连
      const name = (data.name || '玩家').slice(0, 8);
      const existingIdx = room.players.findIndex(p => {
        if (p.name !== name) return false;
        if (p.id === conn.peer) return false;
        const oldConn = state.clientConns[p.id];
        return !oldConn || !oldConn.open;
      });
      if (existingIdx !== -1) {
        const old = room.players[existingIdx];
        delete state.clientConns[old.id];
        old.id = conn.peer;
        old.avatar = data.avatar || old.avatar || '😀';
        state.clientConns[conn.peer] = conn;
        pushSystemMessage(name + ' 重新连接了房间', 2);
        broadcastState();
        return;
      }
      if (room.phase !== 'waiting') { conn.send({ type: 'toast', msg: '游戏已开始' }); return; }
      if (room.players.length >= 4) { conn.send({ type: 'toast', msg: '房间已满' }); return; }
      room.players.push({
        id: conn.peer, name: name,
        hand: [], unoCalled: false, score: 0, alive: true, unoGraceUntil: 0,
        avatar: data.avatar || '😀'
      });
      state.clientConns[conn.peer] = conn;
      pushSystemMessage(name + ' 加入了房间', 2);
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
    else if (data.type === 'typing') handleTyping(conn.peer, data.typing);
    else if (data.type === 'updateAvatar') handleUpdateAvatar(conn.peer, data.avatar);
    else if (data.type === 'challenge') handleChallenge(conn.peer);
    else if (data.type === 'acceptDraw') handleAcceptDraw(conn.peer);
    else if (data.type === 'swapTarget') handleSwapTarget(conn.peer, data.targetId);
  }

  function handleHostMessage(data) {
    if (data.type === 'state') applyState(data.state);
    else if (data.type === 'toast') toast(data.msg);
  }

  /* ============ 8.5 断线重连 ============ */
  async function copyRoomId() {
    const roomId = state.roomId;
    if (!roomId) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(roomId);
      } else {
        const ta = document.createElement('textarea');
        ta.value = roomId;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.focus(); ta.select();
        try { document.execCommand('copy'); } catch (e) {}
        document.body.removeChild(ta);
      }
      toast('已复制房间号：' + roomId);
      if (navigator.vibrate) navigator.vibrate(30);
    } catch (e) { toast('复制失败，请长按手动复制'); }
  }

  function setupVisibilityHandling() {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) state.hiddenAt = Date.now();
      else handleVisibilityReturn();
    });
    window.addEventListener('online', () => {
      if (state.peer && state.peer.disconnected) tryAutoReconnect();
    });
  }

  function handleVisibilityReturn() {
    const hiddenTime = state.hiddenAt ? Date.now() - state.hiddenAt : 0;
    state.hiddenAt = null;
    if (!state.peer) return;
    if (hiddenTime < 2000) return;
    if (state.peer.destroyed) { showReconnectButton(); return; }
    if (state.peer.disconnected) {
      tryAutoReconnect();
    } else if (state.isHost && state.room) {
      let alive = 0;
      Object.keys(state.clientConns).forEach(k => {
        const c = state.clientConns[k];
        if (c && c.open) alive++;
        else delete state.clientConns[k];
      });
      if (alive < state.room.players.length - 1) {
        toast('部分玩家已断开');
        broadcastState();
      }
    }
  }

  function tryAutoReconnect() {
    if (state.reconnecting) return;
    state.reconnecting = true;
    $('reconnectText').innerHTML = '正在恢复连接…';
    $('reconnectOverlay').classList.add('show');
    try { state.peer.reconnect(); }
    catch (e) {
      $('reconnectOverlay').classList.remove('show');
      state.reconnecting = false;
      showReconnectButton();
      return;
    }
    setTimeout(() => {
      $('reconnectOverlay').classList.remove('show');
      state.reconnecting = false;
      if (state.peer && !state.peer.disconnected && !state.peer.destroyed) {
        toast('连接已恢复');
        hideReconnectButton();
      } else {
        showReconnectButton();
        toast('连接未恢复，请点「重连」');
      }
    }, 5000);
  }

  function showReconnectButton() {
    const btn = $('reconnectBtn');
    if (btn) btn.style.display = 'block';
  }
  function hideReconnectButton() {
    const btn = $('reconnectBtn');
    if (btn) btn.style.display = 'none';
  }

  function manualReconnect() {
    if (!state.roomId || !state.room) { resetAndGoHome(); return; }
    if (state.reconnecting) return;
    state.reconnecting = true;
    const serverId = state.usedServer;
    $('reconnectText').innerHTML = '正在重连房间…<strong>房间号：' + state.roomId + '</strong>';
    $('reconnectOverlay').classList.add('show');
    hideReconnectButton();
    if (state.peer) { try { state.peer.destroy(); } catch (e) {} state.peer = null; }
    if (state.isHost) reconnectHost(serverId, 0);
    else reconnectClient(serverId);
  }

  function reconnectHost(serverId, attempt) {
    const myPeerId = 'uno-host-' + state.roomId;
    const { peer, error } = createPeer(myPeerId, serverId);
    if (error || !peer) {
      if (attempt < 3) setTimeout(() => reconnectHost(serverId, attempt + 1), 1500 * (attempt + 1));
      else {
        $('reconnectOverlay').classList.remove('show');
        state.reconnecting = false;
        toast('重连失败，请重新创建房间');
        resetAndGoHome();
      }
      return;
    }
    let opened = false;
    const timeout = setTimeout(() => {
      if (opened) return;
      try { peer.destroy(); } catch (e) {}
      if (attempt < 3) setTimeout(() => reconnectHost(serverId, attempt + 1), 1500 * (attempt + 1));
      else {
        $('reconnectOverlay').classList.remove('show');
        state.reconnecting = false;
        showReconnectButton();
        toast('重连超时');
      }
    }, 6000);
    peer.on('open', () => {
      opened = true;
      clearTimeout(timeout);
      state.peer = peer;
      peer.on('connection', conn => {
        conn.on('open', () => {
          conn.on('data', data => handleClientMessage(conn, data));
          conn.on('close', () => removePlayer(conn.peer));
        });
      });
      $('reconnectOverlay').classList.remove('show');
      state.reconnecting = false;
      toast('房间已恢复');
      broadcastState();
    });
    peer.on('error', err => {
      if (opened) return;
      clearTimeout(timeout);
      try { peer.destroy(); } catch (e) {}
      if (err.type === 'unavailable-id' && attempt < 3) {
        setTimeout(() => reconnectHost(serverId, attempt + 1), 2000 * (attempt + 1));
      } else if (attempt < 3) {
        setTimeout(() => reconnectHost(serverId, attempt + 1), 1500 * (attempt + 1));
      } else {
        $('reconnectOverlay').classList.remove('show');
        state.reconnecting = false;
        showReconnectButton();
        toast('重连失败：' + (err.type || err.message || '未知错误'));
      }
    });
  }

  function reconnectClient(serverId) {
    state.myPeerId = 'uno-client-' + Math.random().toString(36).slice(2, 8);
    state.myPlayerId = state.myPeerId;
    const { peer, error } = createPeer(state.myPeerId, serverId);
    if (error || !peer) {
      $('reconnectOverlay').classList.remove('show');
      state.reconnecting = false;
      toast('重连失败');
      resetAndGoHome();
      return;
    }
    let opened = false;
    const timeout = setTimeout(() => {
      if (opened) return;
      try { peer.destroy(); } catch (e) {}
      $('reconnectOverlay').classList.remove('show');
      state.reconnecting = false;
      showReconnectButton();
      toast('重连超时');
    }, 10000);
    peer.on('open', () => {
      opened = true;
      clearTimeout(timeout);
      state.peer = peer;
      const hostId = 'uno-host-' + state.roomId;
      state.hostConn = peer.connect(hostId);
      state.hostConn.on('open', () => {
        state.hostConn.send({ type: 'join', name: getName(), avatar: getAvatar() });
      });
      state.hostConn.on('data', data => handleHostMessage(data));
      state.hostConn.on('close', () => {
        $('reconnectOverlay').classList.remove('show');
        state.reconnecting = false;
        showReconnectButton();
        toast('与房主断开连接');
      });
      state.hostConn.on('error', () => {
        $('reconnectOverlay').classList.remove('show');
        state.reconnecting = false;
        showReconnectButton();
        toast('重连失败');
      });
    });
    peer.on('error', err => {
      if (opened) return;
      clearTimeout(timeout);
      $('reconnectOverlay').classList.remove('show');
      state.reconnecting = false;
      showReconnectButton();
      toast('重连失败：' + (err.type || err.message || '未知错误'));
    });
  }

  /* ============ 9. UI 渲染 ============ */
  function applyState(newState) {
    hideLoading();
    $('reconnectOverlay').classList.remove('show');
    state.reconnecting = false;
    hideReconnectButton();

    if (newState.id !== state.currentRoomId) {
      state.currentRoomId = newState.id;
      state.lastChatLen = -1;
      state.chatInitialized = false;
      state.unreadCount = 0;
      updateChatBadge();
      $('chatMessages').innerHTML = '<div class="chat-empty">暂无消息</div>';
      state.lastDiscardId = null;
    }
    state.S = newState;
    render();
  }

  function render() {
    const S = state.S;
    if (!S) return;
    updateChatBtnVisibility();
    renderChat();
    renderTypingIndicator();

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
      return '<li><div class="p-left">' +
        '<div class="p-avatar">' + esc(p.avatar || '😀') + '</div>' +
        '<span>' + esc(p.name) + (p.isYou ? '（你）' : '') + '</span>' +
        '</div><span class="tag">' + tag + '</span></li>';
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
      if (p.cardCount === 1 && !p.unoCalled && p.alive !== false) {
        const graceLeft = (p.unoGraceUntil || 0) - Date.now();
        if (graceLeft <= 0) {
          unoBtn = '<button class="opp-uno-btn" data-catch="' + p.id + '">抓 UNO</button>';
        } else {
          const sec = (graceLeft / 1000).toFixed(1);
          unoBtn = '<div class="opp-grace">⏱ ' + sec + 's</div>';
        }
      }
      const scoreHtml = (S.rules.mode === 'score') ? '<div class="opp-score">' + (p.score || 0) + ' 分</div>' : '';
      const specHtml = p.alive === false ? '<div class="opp-status">👁 观战</div>' : '';
      return '<div class="opp ' + (S.turnId === p.id ? 'active' : '') + (p.alive === false ? ' spectator' : '') + '">' +
        '<div class="opp-avatar">' + esc(p.avatar || '😀') + '</div>' +
        '<div class="opp-name">' + esc(p.name) + '</div>' +
        unoBtn + scoreHtml + specHtml +
        '</div>';
    }).join('') : '<div class="opp"><div class="opp-name">等待中…</div></div>';

    // 弃牌堆
    const top = S.topCard;
    const newTopId = top ? top.id : null;
    const topChanged = newTopId !== state.lastDiscardId;
    if (topChanged) {
      let stackHtml = '<div class="discard-shadow s1"></div><div class="discard-shadow s2"></div><div class="discard-shadow s3"></div>';
      $('discard').innerHTML = stackHtml +
        (top ? '<div class="card ' + top.color + ' drop-anim" data-id="' + top.id + '">' + cardLabel(top) + '</div>' : '');
      state.lastDiscardId = newTopId;
    }
    const colorMap = { red: '#e63946', yellow: '#e6a800', green: '#2a9d8f', blue: '#3a7bd5' };
    $('discard').style.boxShadow = '0 0 0 4px ' + (colorMap[S.currentColor] || 'transparent');

    const isMyTurn = S.turnId === me.id && S.phase === 'playing' && !isSpectator;

    if (S.phase === 'ended') $('status').textContent = S.winnerName + ' 获胜 🎉';
    else if (S.phase === 'roundEnd') $('status').textContent = S.message || (S.winnerName + ' 赢得本局');
    else if (isSpectator) $('status').textContent = '👁 观战中 — ' + (S.message || (nameOf(S.turnId) + ' 出牌中…'));
    else if (isMyTurn) {
      if (S.rules.stacking && S.pendingDraw > 0) $('status').textContent = '需出 ' + S.pendingType + ' 或摸 ' + S.pendingDraw + ' 张';
      else $('status').textContent = S.drawnCardId !== null ? (S.rules.forcePlay ? '必须打出摸到的牌' : '出牌，或点「跳过回合」') : '🎯 轮到你了';
    } else {
      $('status').textContent = S.message || ('等待 ' + nameOf(S.turnId) + ' 出牌…');
    }

    if (S.rules.mode === 'score' && !isSpectator) {
      $('myScoreBadge').textContent = '我的积分：' + (me.score || 0);
      $('myScoreBadge').style.display = 'block';
    } else {
      $('myScoreBadge').style.display = 'none';
    }

    // 牌堆提示
    const canDraw = isMyTurn && S.drawnCardId === null &&
      !(S.rules.stacking && S.pendingDraw > 0 && S.drawnCardId !== null);
    $('deckWrap').classList.toggle('can-draw', canDraw);

    // 跳过按钮
    const passBtn = $('passBtn');
    if (isSpectator) passBtn.classList.remove('show');
    else if (S.rules.stacking && S.pendingDraw > 0 && isMyTurn) {
      passBtn.classList.add('show');
      passBtn.textContent = '摸 ' + S.pendingDraw + ' 张并跳过';
    } else if (isMyTurn && S.drawnCardId !== null && !S.rules.forcePlay) {
      passBtn.classList.add('show');
      passBtn.textContent = '跳过回合';
    } else passBtn.classList.remove('show');

    // UNO 按钮
    const unoBtnEl = $('unoBtn');
    const needUno = !isSpectator && me.hand && me.hand.length === 1 &&
      !me.unoCalled && S.phase === 'playing';
    unoBtnEl.classList.toggle('show', !!needUno);

    // 手牌区高亮：轮到自己
    const myHandEl = $('myHand');
    myHandEl.classList.toggle('my-turn', isMyTurn);

    // 手牌
    if (isSpectator) {
      $('myHand').innerHTML = '<div class="spectator-tip">👁 观战中 · 等待下一局</div>';
    } else if (me.hand) {
      $('myHand').innerHTML = me.hand.map((c, i) => {
        const ok = isPlayable(c, me);
        if (i < 9) {
          return '<div class="card ' + c.color + ' ' + (ok ? 'playable' : 'dim') +
            ' hint-number" data-id="' + c.id + '" data-key="' + (i + 1) + '">' +
            cardLabel(c) + '</div>';
        } else {
          return '<div class="card ' + c.color + ' ' + (ok ? 'playable' : 'dim') +
            '" data-id="' + c.id + '">' + cardLabel(c) + '</div>';
        }
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

    if (S.phase === 'playing') scheduleUnoRefresh();
  }

  // 倒计时刷新：100ms 一次，保证时间准确
  let unoRefreshTimer = null;
  function scheduleUnoRefresh() {
    if (unoRefreshTimer) clearTimeout(unoRefreshTimer);
    const S = state.S;
    if (!S) return;
    const hasGrace = S.players.some(p =>
      !p.isYou && p.alive !== false && p.cardCount === 1 && !p.unoCalled &&
      (p.unoGraceUntil || 0) > Date.now());
    if (hasGrace) {
      unoRefreshTimer = setTimeout(() => { renderGame(); }, 100);
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

  function shouldShowMessage(m) {
    if (m.sender !== 'system') return true;
    if (m.level === 1) return true;
    return state.showSysMessages;
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
    const allMsgs = S.chatMessages || [];
    const msgs = allMsgs.filter(shouldShowMessage);
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
      const newOnes = msgs.slice(state.lastChatLen);
      newOnes.forEach(m => {
        if (m.sender !== 'system' && m.sender !== state.myPlayerId) showChatPopup(m);
      });
      if ($('chatPanel').classList.contains('open')) {
        setTimeout(() => { el.scrollTop = el.scrollHeight; }, 0);
      } else {
        state.unreadCount += newOnes.filter(m => m.sender !== state.myPlayerId).length;
        updateChatBadge();
        if (newOnes.some(m => m.sender !== 'system')) sfxMsg();
      }
    }
    state.lastChatLen = msgs.length;
  }

  let chatPopupTimer = null;
  function showChatPopup(m) {
    const popup = $('chatPopup');
    $('chatPopupAvatar').textContent = m.senderName ? m.senderName[0] : '?';
    $('chatPopupName').textContent = m.senderName;
    $('chatPopupText').textContent = m.text;
    popup.classList.add('show');
    clearTimeout(chatPopupTimer);
    chatPopupTimer = setTimeout(() => popup.classList.remove('show'), 3000);
  }

  function renderTypingIndicator() {
    const S = state.S;
    if (!S) return;
    const typing = S.typingNow || {};
    const now = Date.now();
    const names = [];
    Object.keys(typing).forEach(k => {
      if (k === state.myPlayerId) return;
      if (now - typing[k] < 3000) names.push(nameOf(k));
    });
    const el = $('typingIndicator');
    if (names.length > 0) {
      el.textContent = names.join('、') + ' 正在输入中…';
      el.classList.add('show');
      if (!window._typingRefresh) {
        window._typingRefresh = setTimeout(() => {
          window._typingRefresh = null;
          renderTypingIndicator();
        }, 1500);
      }
    } else {
      el.classList.remove('show');
    }
  }

  function openChat() {
    $('chatPanel').classList.add('open');
    state.unreadCount = 0;
    updateChatBadge();
    setTimeout(() => { $('chatMessages').scrollTop = $('chatMessages').scrollHeight; }, 320);
  }

  /* ============ 10. 设置/房规 ============ */
  let globalFontScale = parseFloat(localStorage.getItem('uno_font_scale') || '100') / 100;
  function applyFontScale() {
    document.documentElement.style.setProperty('--fs', globalFontScale);
  }

  function renderAvatarPickers() {
    const emojis = ['😀','😎','🐱','🐶','🦊','🐼','🦁','🐸','🐵','🦄','🐙','👻','🤖','👽','🎃','🍔','⭐','🔥','💎','🎮','🎲','🍕','🌈','🚀'];
    const current = getAvatar();
    ['avatarPickerHome', 'avatarPickerSettings'].forEach(id => {
      const el = $(id);
      if (!el) return;
      el.innerHTML = emojis.map(e =>
        '<button class="avatar-option' + (e === current ? ' active' : '') +
        '" data-emoji="' + e + '">' + e + '</button>'
      ).join('');
    });
  }

  function bindAvatarPickers() {
    ['avatarPickerHome', 'avatarPickerSettings'].forEach(id => {
      const el = $(id);
      if (!el) return;
      el.addEventListener('click', e => {
        const btn = e.target.closest ? e.target.closest('.avatar-option') : null;
        if (!btn) return;
        const emoji = btn.dataset.emoji;
        localStorage.setItem('uno_avatar', emoji);
        sfxClick();
        renderAvatarPickers();
        // 通知房间
        if (state.S && state.S.phase && !state.isHost && state.hostConn && state.hostConn.open) {
          state.hostConn.send({ type: 'updateAvatar', avatar: emoji });
        } else if (state.isHost && state.room) {
          const me = findPlayer(state.myPlayerId);
          if (me) me.avatar = emoji;
          broadcastState();
        }
      });
    });
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

    const sysToggle = $('showSysToggle');
    sysToggle.checked = state.showSysMessages;
    sysToggle.addEventListener('change', function () {
      state.showSysMessages = this.checked;
      localStorage.setItem('uno_show_sys', this.checked ? '1' : '0');
      state.lastChatLen = -1;
      renderChat();
    });

    vercelHostInput.addEventListener('change', function () {
      const v = this.value.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
      this.value = v;
      if (v) localStorage.setItem('uno_vercel_host', v);
      else localStorage.removeItem('uno_vercel_host');
    });

    $('settingsBtn').addEventListener('click', () => { initAudio(); $('settingsPanel').classList.add('show'); });
    $('settingsCloseBtn').addEventListener('click', () => $('settingsPanel').classList.remove('show'));
    $('guideBtn').addEventListener('click', () => { initAudio(); $('guidePanel').classList.add('show'); });
    $('guideCloseBtn').addEventListener('click', () => $('guidePanel').classList.remove('show'));

    renderAvatarPickers();
    bindAvatarPickers();
    bindRulesEvents();
  }

  function bindRulesEvents() {
    const ruleStacking = $('ruleStacking'), ruleForcePlay = $('ruleForcePlay'),
          ruleSevenZero = $('ruleSevenZero'), ruleChallenge = $('ruleChallenge');

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
      ruleChallenge.checked = room.rules.challenge !== false;
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
      room.rules.challenge = ruleChallenge.checked;
      if (modeChanged) {
        room.players.forEach(p => { p.alive = true; p.score = 0; });
        room.phase = 'waiting';
        room.winnerId = null; room.winnerName = null;
        room.eliminatedId = null; room.eliminatedName = null;
        room.pendingDraw = 0; room.pendingType = null;
        room.pendingChallenge = null; room.pendingSwap = null;
        const modeLabels = { single: '单局制', score: '累积500分', elimination: '淘汰制' };
        pushSystemMessage('模式已切换为：' + modeLabels[newMode], 2);
      }
      $('rulesPanel').classList.remove('show');
      broadcastState();
    });
  }

  /* ============ 11. 聊天 ============ */
  let typingSendTimer = null;
  let lastTypingSent = 0;
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
    $('chatInput').addEventListener('input', () => {
      const text = $('chatInput').value.trim();
      const now = Date.now();
      if (text && now - lastTypingSent > 1500) {
        sendTyping(true);
        lastTypingSent = now;
      }
      clearTimeout(typingSendTimer);
      typingSendTimer = setTimeout(() => {
        sendTyping(false);
        lastTypingSent = 0;
      }, 2500);
    });
  }
  function sendTyping(isTyping) {
    if (!state.S || !state.S.phase) return;
    if (state.isHost) handleTyping(state.myPlayerId, isTyping);
    else if (state.hostConn && state.hostConn.open) state.hostConn.send({ type: 'typing', typing: isTyping });
  }
  function sendChat() {
    const input = $('chatInput');
    const text = input.value.trim();
    if (!text) return;
    initAudio();
    if (state.isHost) handleChatMessage(state.myPlayerId, text);
    else if (state.hostConn && state.hostConn.open) state.hostConn.send({ type: 'chat', text });
    input.value = '';
    sendTyping(false);
  }

  /* ============ 12. 键盘 ============ */
  function setupKeyboard() {
    document.addEventListener('keydown', e => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;
      const S = state.S;
      if (!S || S.phase !== 'playing') return;
      const me = myPlayer();
      if (!me || me.alive === false) return;

      if (e.key >= '1' && e.key <= '9') {
        const idx = parseInt(e.key) - 1;
        if (me.hand && me.hand[idx]) {
          const card = me.hand[idx];
          if (isPlayable(card, me)) {
            sfxClick();
            if (card.color === 'wild') {
              state.pendingWild = card.id;
              $('colorPicker').classList.add('show');
            } else {
              if (state.isHost) handlePlayCard(state.myPlayerId, card.id);
              else if (state.hostConn && state.hostConn.open)
                state.hostConn.send({ type: 'playCard', cardId: card.id });
            }
          }
        }
        e.preventDefault();
        return;
      }
      if (e.key === ' ' || e.code === 'Space') {
        if (S.turnId === me.id && S.drawnCardId === null) {
          sfxDraw();
          if (state.isHost) handleDrawCard(state.myPlayerId);
          else if (state.hostConn && state.hostConn.open)
            state.hostConn.send({ type: 'drawCard' });
        }
        e.preventDefault();
        return;
      }
      if (e.key === 'Enter') {
        if (S.turnId === me.id && S.drawnCardId !== null && !S.rules.forcePlay) {
          if (state.isHost) handlePass(state.myPlayerId);
          else if (state.hostConn && state.hostConn.open)
            state.hostConn.send({ type: 'pass' });
        }
        e.preventDefault();
        return;
      }
      if (e.key === 'u' || e.key === 'U') {
        if (me.hand && me.hand.length === 1 && !me.unoCalled) {
          sfxPlay();
          if (state.isHost) handleCallUno(state.myPlayerId);
          else if (state.hostConn && state.hostConn.open)
            state.hostConn.send({ type: 'callUno' });
        }
        e.preventDefault();
        return;
      }
      if (e.key === 'k' || e.key === 'K') {
        const now = Date.now();
        const target = S.players.find(p =>
          !p.isYou && p.alive !== false && p.cardCount === 1 && !p.unoCalled &&
          (!p.unoGraceUntil || now >= p.unoGraceUntil));
        if (target) {
          sfxClick();
          if (state.isHost) handleCatchUno(state.myPlayerId, target.id);
          else if (state.hostConn && state.hostConn.open)
            state.hostConn.send({ type: 'catchUno', targetId: target.id });
        }
        e.preventDefault();
      }
    });
  }

  /* ============ 13. 出牌飞行动画 ============ */
  function playCardFlyAnimation(fromEl, card) {
    try {
      const fromRect = fromEl.getBoundingClientRect();
      const discardRect = $('discard').getBoundingClientRect();
      const fly = document.createElement('div');
      fly.className = 'card ' + card.color + ' card-fly';
      fly.textContent = cardLabel(card);
      fly.style.left = fromRect.left + 'px';
      fly.style.top = fromRect.top + 'px';
      fly.style.width = fromRect.width + 'px';
      fly.style.height = fromRect.height + 'px';
      document.body.appendChild(fly);
      fromEl.style.opacity = '0';
      requestAnimationFrame(() => {
        fly.style.left = discardRect.left + 'px';
        fly.style.top = discardRect.top + 'px';
        fly.style.width = discardRect.width + 'px';
        fly.style.height = discardRect.height + 'px';
        fly.style.opacity = '0.6';
        fly.style.transform = 'rotate(-15deg)';
      });
      setTimeout(() => {
        fly.remove();
        if (fromEl.parentNode) fromEl.style.opacity = '';
      }, 460);
    } catch (e) {}
  }

  /* ============ 14. 主入口 ============ */
  function init() {
    const savedName = localStorage.getItem('uno_name') || '';
    $('nameInput').value = savedName;
    if (savedName.trim()) $('actionBlock').classList.add('show');

    $('nameInput').addEventListener('input', function () {
      $('actionBlock').classList.toggle('show', this.value.trim().length > 0);
    });

    initSettings();
    bindChatEvents();
    setupKeyboard();
    setupVisibilityHandling();

    $('copyRoomBtn').addEventListener('click', () => { initAudio(); copyRoomId(); });
    $('reconnectBtn').addEventListener('click', () => { initAudio(); manualReconnect(); });

    $('createBtn').addEventListener('click', () => { initAudio(); createRoom(); });
    $('joinBtn').addEventListener('click', () => {
      initAudio();
      const rid = $('roomInput').value.trim();
      if (!rid) return toast('请输入房间号');
      joinRoom(rid);
    });
    $('roomInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('joinBtn').click(); });
    $('nameInput').addEventListener('keydown', e => {
      if (e.key === 'Enter' && $('nameInput').value.trim()) $('createBtn').click();
    });

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
      if (S.phase === 'roundEnd') { if (state.isHost) startGame(); return; }
      if (state.isHost) {
        const room = state.room;
        if (!room) return;
        let reached500 = false;
        if (room.rules.mode === 'score') {
          room.players.forEach(p => { if ((p.score || 0) >= 500) reached500 = true; });
        }
        if (reached500 || room.rules.mode === 'elimination') {
          room.players.forEach(p => { p.score = 0; p.alive = true; p.unoGraceUntil = 0; });
        }
        room.phase = 'waiting';
        room.winnerId = null; room.winnerName = null;
        room.eliminatedId = null; room.eliminatedName = null;
        room.pendingDraw = 0; room.pendingType = null;
        room.pendingChallenge = null; room.pendingSwap = null;
        room.message = '';
        room.typingNow = {};
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
        playCardFlyAnimation(el, card);
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
      const deck = $('deck');
      deck.classList.add('deck-shake');
      setTimeout(() => deck.classList.remove('deck-shake'), 400);
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
          else if (state.hostConn && state.hostConn.open)
            state.hostConn.send({ type: 'playCard', cardId: state.pendingWild, color: el.dataset.color });
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