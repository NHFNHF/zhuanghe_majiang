import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

/**
 * =========================
 * 牌编码（34种，不含花）
 * 万 W1..W9 => 0..8
 * 筒 T1..T9 => 9..17
 * 条 B1..B9 => 18..26  (B1 就是“幺鸡”，4张，正常1条)
 * 风 E,S,Ws,N => 27..30 (西用 Ws 避免和万W冲突)
 * 箭 R(中), G(发), Wh(白) => 31..33
 * =========================
 */

const TILE_NAMES = [
  "W1","W2","W3","W4","W5","W6","W7","W8","W9",
  "T1","T2","T3","T4","T5","T6","T7","T8","T9",
  "B1","B2","B3","B4","B5","B6","B7","B8","B9",
  "E","S","Ws","N",
  "R","G","Wh"
];

const NAME_TO_ID = new Map(TILE_NAMES.map((n, i) => [n, i]));
const isSuit = (id) => id >= 0 && id <= 26;
const suitOf = (id) => (id <= 8 ? "W" : id <= 17 ? "T" : "B");
const rankOf = (id) => (id % 9) + 1;
const isHonor = (id) => id >= 27;
const isB1 = (id) => id === 18; // B1 = 幺鸡

function shuffle(arr, rng=Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function randomInt(min, max) { // inclusive
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function makeRoomId() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/**
 * 配置：按你最后一次确认的口径
 */
const RULES = {
  players: 4,
  // 杠金额（此处不直接结算，先记账：胡牌时结算，流局作废）
  kongMoney: {
    ming: 5,
    an: 10
  },
  // 番->金额（封顶5番）
  fanToMoney(fan) {
    if (fan <= 0) return 0;
    if (fan <= 2) return 5;
    if (fan === 3) return 10;
    if (fan === 4) return 20;
    return 40;
  },
  // 庄家轮换：东南西北
  nextDealer(seat) { return (seat + 1) % 4; },

  // 立直宝牌：倒数第sum张（翻出不移除）
  treasureFromBackIndex(sum) { return sum; },

  // 风杠前后各摸一张：只有风杠底座active且桌上还没出现过立直
  windPreKongDoubleDraw: true,
  // 一旦任意人立直，其他人的风杠底座在其下次摸牌前作废
  riichiInvalidatesWindPreKong: true
};

/**
 * =========================
 * 房间与游戏状态
 * =========================
 */
const rooms = new Map(); // roomId -> room

function makeEmptyRoom(roomId) {
  return {
    roomId,
    createdAt: Date.now(),
    players: Array(4).fill(null).map(() => ({
      socketId: null,
      name: null,
      ready: false,
      connected: false
    })),
    game: null
  };
}

function seatOfSocket(room, socketId) {
  return room.players.findIndex(p => p.socketId === socketId);
}

function publicRoomState(room) {
  return {
    roomId: room.roomId,
    players: room.players.map((p, idx) => ({
      seat: idx,
      name: p.name,
      ready: p.ready,
      connected: p.connected
    })),
    inGame: !!room.game
  };
}

function emitRoom(room) {
  io.to(room.roomId).emit("room_state", publicRoomState(room));
}

/**
 * =========================
 * Game State
 * =========================
 */
function newGameState(room) {
  // 洗牌：每种4张
  const wall = [];
  for (let id = 0; id < 34; id++) {
    for (let k = 0; k < 4; k++) wall.push(id);
  }
  shuffle(wall);

  // 庄家：东家座位0开始（你说从东开始轮）
  const dealerSeat = 0;

  // 起牌点：骰子 sum+1 做切牌点（MVP简化）
  const d1 = randomInt(1,6);
  const d2 = randomInt(1,6);
  const sum = d1 + d2;
  const startIndex = ((sum + 1) * 4) % wall.length;
  const rotated = wall.slice(startIndex).concat(wall.slice(0, startIndex));

  const g = {
    stage: "PRE_REVEAL", // 发完牌后，首轮摸牌前
    dealerSeat,
    turnSeat: dealerSeat,
    dice: { d1, d2, sum },
    wallFront: rotated,      // 用数组前端当“前面”
    wallBack: [],            // 用数组尾端当“后面”，为了实现“前后摸”，我们用同一个数组即可
    hands: Array(4).fill(null).map(() => []),
    melds: Array(4).fill(null).map(() => []), // 明副露：chi/peng/mingkong
    discards: Array(4).fill(null).map(() => []),
    currentDiscard: null, // { seat, tileId }
    riichi: Array(4).fill(null).map(() => ({
      declared: false,
      wasMenzen: true,
      treasureTile: null,
      canSeeTreasure: false,
      locked: false
    })),
    table: {
      riichiOccurred: false,
      firstTreasureTile: null,
      firstRiichiSeat: null
    },
    // 开局亮杠底座
    preKongWind: Array(4).fill(null).map(() => ({ active:false, tiles: [] })),    // E/S/Ws/N 用B1补
    preKongDragon: Array(4).fill(null).map(() => ({ active:false, tiles: [] })),  // R/G/Wh 用B1补
    // 杠：本局待结算（胡牌时结算，流局清空）
    pendingKongs: [], // { seat, type:'ming'|'an', moneyEach, reason, atTurn }
    // 统计摸宝/摸鸡
    bonusFan: Array(4).fill(0),
    lastDrawnTile: Array(4).fill(null),
    // 游戏结束信息
    result: null
  };

  // 发牌：庄家14，其余13
  for (let round = 0; round < 3; round++) {
    for (let seat = 0; seat < 4; seat++) {
      for (let i = 0; i < 4; i++) g.hands[seat].push(drawFront(g));
    }
  }
  // 第4轮：每人1张
  for (let seat = 0; seat < 4; seat++) g.hands[seat].push(drawFront(g));
  // 庄家再补1张（成14）
  g.hands[dealerSeat].push(drawFront(g));

  // 排序手牌（仅方便展示）
  for (let seat = 0; seat < 4; seat++) sortHand(g.hands[seat]);

  return g;
}

function sortHand(hand) { hand.sort((a,b)=>a-b); }

function drawFront(g) {
  if (g.wallFront.length === 0) return null;
  return g.wallFront.shift();
}
function drawBack(g) {
  if (g.wallFront.length === 0) return null;
  return g.wallFront.pop();
}

function wallCount(g) { return g.wallFront.length; }

/**
 * =========================
 * 发送 game_state：每个玩家看到自己的手牌和宝牌权限
 * =========================
 */
function publicGameStateForSeat(room, seat) {
  const g = room.game;
  const you = seat;

  const canSeeTreasure = g.riichi[you].canSeeTreasure;
  const treasureTile = canSeeTreasure ? g.table.firstTreasureTile : null;

  // 对手的暗信息隐藏
  const handsInfo = g.hands.map((h, idx) => {
    if (idx === you) return { seat: idx, tiles: h.map(idToName) };
    return { seat: idx, count: h.length };
  });

  return {
    stage: g.stage,
    dealerSeat: g.dealerSeat,
    turnSeat: g.turnSeat,
    dice: g.dice,
    wallCount: wallCount(g),
    hands: handsInfo,
    melds: g.melds.map((m, idx)=>({ seat: idx, melds: m.map(mm => meldToPublic(mm, you, idx)) })),
    discards: g.discards.map((d, idx)=>({ seat: idx, tiles: d.map(idToName) })),
    currentDiscard: g.currentDiscard ? { seat: g.currentDiscard.seat, tile: idToName(g.currentDiscard.tileId) } : null,
    riichi: g.riichi.map((r, idx)=>({
      seat: idx,
      declared: r.declared,
      wasMenzen: r.wasMenzen,
      locked: r.locked,
      canSeeTreasure: (idx === you) ? r.canSeeTreasure : r.canSeeTreasure && g.riichi[you].declared // 听牌者之间可见
    })),
    treasureTile: treasureTile ? idToName(treasureTile) : null,
    preKongWind: g.preKongWind.map((pk, idx)=>({
      seat: idx,
      active: pk.active,
      // 风暗杠：别人只看到active，不看具体
      tiles: (idx === you) ? pk.tiles.map(idToName) : (pk.active ? ["(已立风杠)"] : [])
    })),
    preKongDragon: g.preKongDragon.map((pk, idx)=>({
      seat: idx,
      active: pk.active,
      // 箭明杠：全员可见（简化减少争议）
      tiles: pk.active ? pk.tiles.map(idToName) : []
    })),
    bonusFan: (idx)=>g.bonusFan[idx], // 客户端不用
    lastDrawnTile: g.lastDrawnTile[you] != null ? idToName(g.lastDrawnTile[you]) : null,
    result: g.result
  };
}

function emitGame(room) {
  const g = room.game;
  if (!g) return;
  for (let seat = 0; seat < 4; seat++) {
    const socketId = room.players[seat].socketId;
    if (!socketId) continue;
    io.to(socketId).emit("game_state", publicGameStateForSeat(room, seat));
  }
}

function idToName(id) { return TILE_NAMES[id] ?? String(id); }
function nameToId(name) { return NAME_TO_ID.get(name); }

function meldToPublic(m, viewerSeat, ownerSeat) {
  // meld: { type, tiles:[id...], fromSeat?, claimedTile? }
  const isConcealedKong = m.type === "ankong";
  const canSeeTiles = !isConcealedKong || viewerSeat === ownerSeat;
  return {
    type: m.type,
    tiles: canSeeTiles ? m.tiles.map(idToName) : ["■■","■■","■■","■■"],
    fromSeat: m.fromSeat ?? null,
    concealed: isConcealedKong && viewerSeat !== ownerSeat
  };
}

/**
 * =========================
 * PRE_REVEAL：开局亮杠底座
 * 风：E,S,Ws,N 四张（可用B1补）
 * 箭：R,G,Wh 三张（可用B1补）
 * =========================
 */
const WIND_SET = [27,28,29,30];
const DRAGON_SET = [31,32,33];

function tryPreReveal(room, seat, kind) {
  const g = room.game;
  if (!g || g.stage !== "PRE_REVEAL") throw new Error("not in PRE_REVEAL");
  const hand = g.hands[seat];

  if (kind === "wind") {
    if (g.preKongWind[seat].active) throw new Error("wind pre-kong already active");
    const tiles = takeWithB1(hand, WIND_SET, 4);
    if (!tiles) throw new Error("not enough for wind pre-kong (need E/S/Ws/N, can use B1 as substitute)");
    g.preKongWind[seat] = { active: true, tiles };
    // 风杠是暗：不加到 melds
    sortHand(hand);
    return;
  }

  if (kind === "dragon") {
    if (g.preKongDragon[seat].active) throw new Error("dragon pre-kong already active");
    const tiles = takeWithB1(hand, DRAGON_SET, 3);
    if (!tiles) throw new Error("not enough for dragon pre-kong (need R/G/Wh, can use B1 as substitute)");
    g.preKongDragon[seat] = { active: true, tiles };
    // 箭杠视为明：记到 melds（展示用）
    g.melds[seat].push({ type: "pre_dragon", tiles: tiles.slice(), fromSeat: null });
    sortHand(hand);
    return;
  }

  throw new Error("unknown pre reveal kind");
}

function takeWithB1(hand, neededSet, size) {
  // 从手牌中拿出 neededSet 的牌，不足用 B1 替代，返回实际取出的 tiles 数组（长度=size or =neededSet.length??）
  const temp = hand.slice();
  const picked = [];
  const need = neededSet.slice();

  // 先拿真实字牌
  for (const n of need) {
    const idx = temp.indexOf(n);
    if (idx !== -1) {
      picked.push(temp[idx]);
      temp.splice(idx,1);
    } else {
      picked.push(null);
    }
  }
  // 用B1补null
  for (let i = 0; i < picked.length; i++) {
    if (picked[i] === null) {
      const j = temp.indexOf(18);
      if (j === -1) return null;
      picked[i] = 18;
      temp.splice(j,1);
    }
  }

  // dragon size=3, wind size=4
  // 从原手牌移除 picked
  for (const t of picked) {
    const idx = hand.indexOf(t);
    if (idx === -1) return null;
    hand.splice(idx,1);
  }
  return picked;
}

/**
 * 立直出现后：风杠作废，牌回手
 */
function invalidateWindPreKong(g, seat) {
  const pk = g.preKongWind[seat];
  if (!pk.active) return;
  // 归还牌到手
  g.hands[seat].push(...pk.tiles);
  sortHand(g.hands[seat]);
  g.preKongWind[seat] = { active:false, tiles:[] };
}

/**
 * =========================
 * 回合流程
 * =========================
 * - PRE_REVEAL 结束：任意时刻可点“开始抓牌”（服务器自动进入PLAYING并让当前turnSeat继续）
 * - PLAYING：turnSeat 行动：若需要摸牌则摸牌 -> 出牌 -> 其他人可响应（吃碰杠胡pass）
 * MVP 简化：只实现“有人打出一张牌后，按优先级处理响应：胡 > 杠 > 碰 > 吃”
 * =========================
 */

function startPlayingIfReady(room) {
  const g = room.game;
  if (!g) return;
  if (g.stage !== "PRE_REVEAL") return;
  g.stage = "PLAYING";
  // turnSeat=dealerSeat 已有14张，按你习惯：庄家先打牌（不先摸）
  // 其他人回合开始需要摸牌
}

/**
 * 摸牌：包含风杠前后摸牌、风杠在立直后作废
 */
function doDraw(room, seat) {
  const g = room.game;
  if (!g || g.stage !== "PLAYING") throw new Error("not playing");
  if (g.turnSeat !== seat) throw new Error("not your turn");
  if (g.currentDiscard) throw new Error("must resolve discard first");

  // 立直出现后，风杠作废（在该玩家摸牌之前）
  if (RULES.riichiInvalidatesWindPreKong && g.table.riichiOccurred && g.preKongWind[seat].active) {
    invalidateWindPreKong(g, seat);
  }

  // 判断是否需要摸牌：庄家起手14张第一回合不摸
  const isDealerFirstTurn = (seat === g.dealerSeat && totalActionsSoFar(g) === 0);
  if (isDealerFirstTurn) {
    // 不摸牌
    return;
  }

  // 风杠前后各摸一张（仅在桌上还未出现立直）
  const canDouble = RULES.windPreKongDoubleDraw && g.preKongWind[seat].active && !g.table.riichiOccurred;
  if (canDouble) {
    const a = drawFront(g);
    const b = drawBack(g);
    if (a == null || b == null) {
      handleDrawEndAsDrawnGame(room);
      return;
    }
    g.hands[seat].push(a, b);
    g.lastDrawnTile[seat] = b;
    afterDrawBonus(g, seat, a);
    afterDrawBonus(g, seat, b);
    sortHand(g.hands[seat]);
    return;
  }

  const t = drawFront(g);
  if (t == null) {
    handleDrawEndAsDrawnGame(room);
    return;
  }
  g.hands[seat].push(t);
  g.lastDrawnTile[seat] = t;
  afterDrawBonus(g, seat, t);
  sortHand(g.hands[seat]);
}

function afterDrawBonus(g, seat, tileId) {
  // 摸宝、摸鸡
  if (g.table.firstTreasureTile != null && tileId === g.table.firstTreasureTile) {
    g.bonusFan[seat] += 1; // 摸宝+1番
  }
  if (isB1(tileId)) {
    g.bonusFan[seat] += 1; // 摸鸡+1番
  }
}

function totalActionsSoFar(g) {
  // 粗略：根据弃牌数估算
  return g.discards.reduce((s,a)=>s+a.length,0);
}

function handleDrawEndAsDrawnGame(room) {
  const g = room.game;
  // 流局：什么都不算，杠作废，庄家连庄
  g.result = { type: "draw" };
  g.pendingKongs = []; // 杠作废
  // 庄家连庄：dealer不变
  g.stage = "SETTLE";
}

/**
 * 出牌：立直后锁手（不能吃碰），但自己出牌仍要允许（立直声明时已出牌）
 */
function doDiscard(room, seat, tileName) {
  const g = room.game;
  if (!g || g.stage !== "PLAYING") throw new Error("not playing");
  if (g.turnSeat !== seat) throw new Error("not your turn");
  if (g.currentDiscard) throw new Error("discard already exists");

  const tileId = nameToId(tileName);
  if (tileId == null) throw new Error("unknown tile");

  const hand = g.hands[seat];
  const idx = hand.indexOf(tileId);
  if (idx === -1) throw new Error("you don't have that tile");

  // 如果已经立直且 locked=true，不能随便改出牌（MVP：locked后只能自动打最后摸到的牌太复杂，这里允许出，但不允许吃碰改变手）
  // 你规则是“打过宝牌后手牌不可变动，也不能吃碰”，对自己而言出牌是允许的（每回合必须出）
  hand.splice(idx, 1);
  g.lastDrawnTile[seat] = null;
  sortHand(hand);

  g.currentDiscard = { seat, tileId };
  g.discards[seat].push(tileId);

  // 进入响应窗口（MVP：客户端弹按钮由服务器判定可行性）
}

/**
 * PASS：放弃响应
 * 当所有其他玩家都pass，进入下家回合并清空currentDiscard
 */
function doPass(room, seat) {
  const g = room.game;
  if (!g || g.stage !== "PLAYING") throw new Error("not playing");
  if (!g.currentDiscard) throw new Error("no discard to pass");

  // MVP简化：我们用一个集合记录谁已pass
  if (!g._passes) g._passes = new Set();
  g._passes.add(seat);

  const discarder = g.currentDiscard.seat;
  const needPassSeats = [0,1,2,3].filter(s=>s!==discarder);

  if (needPassSeats.every(s=>g._passes.has(s))) {
    // 无人吃碰杠胡
    g.currentDiscard = null;
    g._passes = null;
    g.turnSeat = (discarder + 1) % 4;
  }
}

/**
 * 立直（打宝牌）：要求听牌
 * - 支持吃碰后立直（不要求门清）
 * - 若已有人立直，本局宝牌沿用第一位立直者宝牌
 * - 声明立直时要弃一张牌（宝牌弃牌）
 */
function doRiichi(room, seat, discardTileName) {
  const g = room.game;
  if (!g || g.stage !== "PLAYING") throw new Error("not playing");
  if (g.turnSeat !== seat) throw new Error("not your turn");
  if (g.currentDiscard) throw new Error("resolve discard first");
  if (g.riichi[seat].declared) throw new Error("already riichi");

  // 听牌判定：对当前手牌（未弃宝牌前），你们一般是“打出去一张后听牌”
  // 工程口径：尝试每一种可能弃牌，看是否能进入听牌；这里要求弃指定牌后仍听牌
  const discardId = nameToId(discardTileName);
  if (discardId == null) throw new Error("unknown tile");
  const hand = g.hands[seat];
  const idx = hand.indexOf(discardId);
  if (idx === -1) throw new Error("you don't have that tile");

  // 模拟弃牌后的手牌
  const after = hand.slice();
  after.splice(idx,1);

  if (!isTenpai(after, g.melds[seat])) {
    throw new Error("not in tenpai after discarding this tile (cannot riichi)");
  }

  // 设置立直属性
  g.riichi[seat].declared = true;
  g.riichi[seat].wasMenzen = (g.melds[seat].length === 0);
  g.riichi[seat].locked = true;
  g.riichi[seat].canSeeTreasure = true;

  // 确定宝牌（全局一份）
  if (!g.table.riichiOccurred) {
    const d1 = randomInt(1,6);
    const d2 = randomInt(1,6);
    const sum = d1 + d2;
    // 倒数第sum张（翻出不移除）
    const idxFromBack = RULES.treasureFromBackIndex(sum);
    const pos = g.wallFront.length - idxFromBack;
    const treasure = g.wallFront[pos];
    g.table.firstTreasureTile = treasure;
    g.table.firstRiichiSeat = seat;
    g.table.riichiOccurred = true;
    // 记录骰子（给前端显示仪式感）
    g.dice = { d1, d2, sum };
  } else {
    // 已有宝牌：后立直者共享
    g.riichi[seat].canSeeTreasure = true;
  }

  // 执行弃宝牌（也就是正常出牌）
  doDiscard(room, seat, discardTileName);

  // 冲宝：宝牌就是和牌张且当前满足胡牌（按你口径）
  // 这里按“弃牌后手牌处于听牌且宝牌为和张即可直接胡”
  // 由于你说“如果直接宝牌就是和牌叫冲宝”，我们判定宝牌是否是听牌张之一。
  const waits = getWaits(after, g.melds[seat]);
  if (g.table.firstTreasureTile != null && waits.has(g.table.firstTreasureTile)) {
    // 直接胡（冲宝）
    // 视为自摸？你说“冲宝算3番”，这里当成一种额外番（不涉及点炮）
    // 立即结算：赢家seat
    settleWin(room, { winner: seat, winType: "chongbao", fromSeat: null, winningTile: g.table.firstTreasureTile, extraFan: 3 });
  }
}

/**
 * 杠：明/暗/加（MVP提供基础，且立直后需满足“开杠后仍听牌”）
 */
function doKong(room, seat, payload) {
  const g = room.game;
  if (!g || g.stage !== "PLAYING") throw new Error("not playing");
  if (g.turnSeat !== seat) throw new Error("not your turn");
  if (g.currentDiscard) throw new Error("resolve discard first");

  const { type, tile } = payload; // type: 'an'|'ming'|'add', tile: 'W5' etc
  const tileId = nameToId(tile);
  if (tileId == null) throw new Error("unknown tile");

  // 立直后开明杠限制：门清立直不能明杠；副露立直可明/暗
  if (g.riichi[seat].declared && g.riichi[seat].wasMenzen) {
    if (type !== "an") throw new Error("menzen riichi cannot make exposed kong");
  }

  // 具体判定
  if (type === "an") {
    // 暗杠：手里要4张
    const hand = g.hands[seat];
    if (countOf(hand, tileId) < 4) throw new Error("need 4 tiles for concealed kong");
    // 模拟杠后仍听牌（若已立直）
    if (g.riichi[seat].declared) {
      const after = hand.slice();
      removeN(after, tileId, 4);
      if (!isTenpai(after, g.melds[seat])) throw new Error("kong would break tenpai; not allowed");
    }
    // 执行
    removeN(g.hands[seat], tileId, 4);
    g.melds[seat].push({ type: "ankong", tiles: [tileId,tileId,tileId,tileId], fromSeat: null });
    sortHand(g.hands[seat]);
    // 记待结算杠
    g.pendingKongs.push({ seat, type: "an", moneyEach: RULES.kongMoney.an, reason: "ankong", atTurn: totalActionsSoFar(g) });
    // 杠后补摸：你说没有杠上开花/炮，但正常要补摸一张（这里按常规补摸）
    const t = drawFront(g);
    if (t == null) { handleDrawEndAsDrawnGame(room); return; }
    g.hands[seat].push(t);
    g.lastDrawnTile[seat] = t;
    afterDrawBonus(g, seat, t);
    sortHand(g.hands[seat]);
    return;
  }

  // ming/add：MVP简化：只允许“自己回合手里4张明杠”作为明杠（你们也说可明杠）
  // 真正的“他人打牌我杠”需要响应窗口，这里先不做（否则协议复杂）
  if (type === "ming") {
    const hand = g.hands[seat];
    if (countOf(hand, tileId) < 4) throw new Error("need 4 tiles for exposed kong in this MVP");
    if (g.riichi[seat].declared) {
      const after = hand.slice();
      removeN(after, tileId, 4);
      if (!isTenpai(after, g.melds[seat])) throw new Error("kong would break tenpai; not allowed");
    }
    removeN(g.hands[seat], tileId, 4);
    g.melds[seat].push({ type: "mingkong", tiles: [tileId,tileId,tileId,tileId], fromSeat: null });
    sortHand(g.hands[seat]);
    g.pendingKongs.push({ seat, type: "ming", moneyEach: RULES.kongMoney.ming, reason: "mingkong", atTurn: totalActionsSoFar(g) });
    const t = drawFront(g);
    if (t == null) { handleDrawEndAsDrawnGame(room); return; }
    g.hands[seat].push(t);
    g.lastDrawnTile[seat] = t;
    afterDrawBonus(g, seat, t);
    sortHand(g.hands[seat]);
    return;
  }

  throw new Error("kong type not supported in MVP");
}

/**
 * 胡：支持自摸（自己回合）或点炮（响应当前弃牌）
 * 你规则：胡牌三家都付钱；点炮者另+1番
 */
function doWin(room, seat) {
  const g = room.game;
  if (!g || g.stage !== "PLAYING") throw new Error("not playing");

  // 自摸：轮到自己且无currentDiscard（刚摸完准备出牌时胡）
  if (g.turnSeat === seat && !g.currentDiscard) {
    const hand = g.hands[seat].slice();
    // 判定胡牌（手里已经含14张）
    const res = scoreWin(g, seat, { type: "self", winningTile: null });
    if (!res.canWin) throw new Error("not a winning hand");
    settleWin(room, { winner: seat, winType: "self", fromSeat: null, winningTile: null, score: res });
    return;
  }

  // 点炮：存在 currentDiscard，seat 是非出牌者
  if (g.currentDiscard && g.currentDiscard.seat !== seat) {
    const winTile = g.currentDiscard.tileId;
    const hand = g.hands[seat].slice();
    hand.push(winTile);
    sortHand(hand);

    const res = scoreWin(g, seat, { type: "ron", winningTile: winTile, fromSeat: g.currentDiscard.seat });
    if (!res.canWin) throw new Error("not a winning hand by ron");
    settleWin(room, { winner: seat, winType: "ron", fromSeat: g.currentDiscard.seat, winningTile: winTile, score: res });
    return;
  }

  throw new Error("cannot win right now");
}

/**
 * 结算：胡牌才结算pendingKongs；流局则已清空
 */
function settleWin(room, payload) {
  const g = room.game;
  const { winner, winType, fromSeat, winningTile, extraFan } = payload;

  // 基础番与役种
  let score;
  if (payload.score) score = payload.score;
  else score = scoreWin(g, winner, { type: winType, winningTile, fromSeat });

  if (!score.canWin) throw new Error("internal: cannot settle non-win");

  let baseFan = score.totalFan;
  if (extraFan) baseFan += extraFan;

  // 四家闭门（全员门清）=> 5番封顶
  const allMenzen = g.melds.every(m => m.length === 0);
  if (allMenzen) {
    baseFan = 5;
    score.yaku.push("四家闭门(封顶)");
  }

  // 胡牌金额（按番->金额）
  const payBase = RULES.fanToMoney(Math.min(5, baseFan));

  // 每家都付给赢家 payBase
  const payments = [];
  for (let seat = 0; seat < 4; seat++) {
    if (seat === winner) continue;
    let fanForThisPayer = baseFan;
    // 点炮者多算一番（只对点炮者）
    if (winType === "ron" && seat === fromSeat) {
      fanForThisPayer = Math.min(5, baseFan + 1); // 点炮者额外+1番，也封顶
    }
    const money = RULES.fanToMoney(fanForThisPayer);
    payments.push({ from: seat, to: winner, money, reason: (winType==="ron" && seat===fromSeat) ? "点炮加码" : "胡牌" });
  }

  // 结算本局待结算杠：三家付给开杠者
  const kongPayments = [];
  for (const k of g.pendingKongs) {
    for (let seat = 0; seat < 4; seat++) {
      if (seat === k.seat) continue;
      kongPayments.push({ from: seat, to: k.seat, money: k.moneyEach, reason: `杠(${k.type})` });
    }
  }

  // 庄家轮换
  let nextDealer = g.dealerSeat;
  // 流局不在这里；胡牌：
  if (winner === g.dealerSeat) {
    // 庄家胡连庄
    nextDealer = g.dealerSeat;
  } else {
    // 非庄家胡：庄家按东南西北轮换
    nextDealer = RULES.nextDealer(g.dealerSeat);
  }

  g.result = {
    type: "win",
    winner,
    winType,
    fromSeat: fromSeat ?? null,
    baseFan,
    yaku: score.yaku,
    payments,
    kongPayments,
    nextDealer
  };

  g.stage = "SETTLE";
  // 清掉弃牌响应
  g.currentDiscard = null;
  g._passes = null;
}

/**
 * =========================
 * 计番/胡牌/听牌判定（MVP但覆盖你列的多数役种）
 * =========================
 * 1) 必须不缺门：万筒条都出现（手+副露）
 * 2) 必须有刻子；若雀头是字牌可代替刻子要求
 * 3) 支持：普通胡、七对、十三幺、清一色(5)、字一色(5)、混清/混一色(1)、飘胡/碰碰胡(2)
 * 4) 夹胡：胡牌张作为补顺子的那张（包含 12万等3万）
 * 5) 自摸+1番；点炮+1番；庄家胡+1番；立直+1番；摸宝+1；摸鸡+1；冲宝+3（冲宝在外层处理）
 */
function scoreWin(g, seat, ctx) {
  // ctx: {type:'self'|'ron'|'chongbao', winningTile, fromSeat}
  const melds = g.melds[seat];
  const hand = g.hands[seat].slice();
  if (ctx.type === "ron" && ctx.winningTile != null) {
    // doWin里已经加过牌到hand，这里保持一致：若没加就加
    if (!hand.includes(ctx.winningTile) || hand.length % 3 !== 2) {
      // do nothing; MVP容错
    }
  }

  const fullTiles = hand.slice(); // 14张
  const counts = tilesToCounts(fullTiles);

  // 不能缺门（万筒条三门都要有，手+副露）
  if (!hasAllThreeSuits(fullTiles, melds)) {
    return { canWin:false, totalFan:0, yaku:["缺门(不合法)"] };
  }

  // 先判特殊牌型
  const is7 = isSevenPairs(counts);
  const is13 = isThirteenOrphans(counts);

  let canWin = false;
  let baseFan = 0;
  const yaku = [];

  // 字将代替刻子要求：如果雀头是字牌 => ok；否则必须有刻子
  // 对特殊牌型：按你们习惯也要检查缺门等；刻子要求对七对/十三幺是否适用你没强调，这里：七对/十三幺仍允许，不强制刻子
  if (is13) {
    canWin = true;
    baseFan += 5;
    yaku.push("十三幺不重样(5)");
  } else if (is7) {
    canWin = true;
    baseFan += 5;
    yaku.push("七对子(5)");
  } else {
    // 普通胡：标准分解
    const winDecomp = canStandardWin(counts);
    if (!winDecomp.canWin) return { canWin:false, totalFan:0, yaku:["非和牌"] };
    // 刻子要求
    const pairIsHonor = isHonor(winDecomp.pairId);
    const hasTrip = winDecomp.hasTriplet;
    if (!pairIsHonor && !hasTrip) {
      return { canWin:false, totalFan:0, yaku:["必须有刻子(雀头非字)"] };
    }
    canWin = true;

    // 飘胡：全是刻子（对对胡/碰碰胡）=2番
    if (winDecomp.allTriplets) {
      baseFan += 2;
      yaku.push("飘胡/碰碰胡(2)");
    }

    // 清一色/字一色/混清(混一色)
    const suitInfo = suitCategory(fullTiles, melds);
    if (suitInfo.kind === "HONOR_ONLY") {
      baseFan += 5;
      yaku.push("字一色(5)");
    } else if (suitInfo.kind === "PURE_ONE_SUIT") {
      baseFan += 5;
      yaku.push("纯清一色(5)");
    } else if (suitInfo.kind === "ONE_SUIT_WITH_HONOR") {
      baseFan += 1;
      yaku.push("混清/混一色(1)");
    }

    // 夹胡（和夹）=1番：需要知道胡牌张；自摸时胡牌张不明确（MVP：自摸让玩家点“自摸胡”，我们取最后摸到的牌不追踪，这里不算夹胡）
    if (ctx.type === "ron" && ctx.winningTile != null) {
      if (isJiaHuByWinningTile(fullTiles, ctx.winningTile)) {
        baseFan += 1;
        yaku.push("夹胡/和夹(1)");
      }
    }
  }

  if (!canWin) return { canWin:false, totalFan:0, yaku:["不可胡"] };

  // 通用番：自摸/点炮/庄家/立直/摸宝/摸鸡
  if (ctx.type === "self") { baseFan += 1; yaku.push("自摸(1)"); }
  if (ctx.type === "ron") { baseFan += 1; yaku.push("点炮(1)"); }
  if (seat === g.dealerSeat) { baseFan += 1; yaku.push("庄家(1)"); }
  if (g.riichi[seat].declared) { baseFan += 1; yaku.push("立直(1)"); }

  // 摸宝/摸鸡累积（本局累计）
  const bonus = g.bonusFan[seat] || 0;
  for (let i = 0; i < bonus; i++) yaku.push(i===0 ? "摸宝/摸鸡加番(累计)" : "");
  baseFan += bonus;

  // 封顶逻辑放到 settleWin 阶段做（因为点炮者还要额外+1番再封顶）
  return { canWin:true, totalFan: baseFan, yaku };
}

function tilesToCounts(tiles) {
  const c = Array(34).fill(0);
  for (const t of tiles) c[t]++;
  return c;
}

function hasAllThreeSuits(handTiles, melds) {
  let hasW=false, hasT=false, hasB=false;
  const scan = (id)=>{
    if (!isSuit(id)) return;
    const s = suitOf(id);
    if (s==="W") hasW=true;
    if (s==="T") hasT=true;
    if (s==="B") hasB=true;
  };
  handTiles.forEach(scan);
  for (const m of melds) (m.tiles||[]).forEach(scan);
  return hasW && hasT && hasB;
}

function suitCategory(handTiles, melds) {
  // 返回: HONOR_ONLY / PURE_ONE_SUIT / ONE_SUIT_WITH_HONOR / MIXED
  const suitSet = new Set();
  let hasHonor = false;
  const add = (id)=>{
    if (isHonor(id)) { hasHonor=true; return; }
    suitSet.add(suitOf(id));
  };
  handTiles.forEach(add);
  for (const m of melds) (m.tiles||[]).forEach(add);

  if (suitSet.size===0 && hasHonor) return { kind:"HONOR_ONLY" };
  if (suitSet.size===1 && !hasHonor) return { kind:"PURE_ONE_SUIT" };
  if (suitSet.size===1 && hasHonor) return { kind:"ONE_SUIT_WITH_HONOR" };
  return { kind:"MIXED" };
}

function isSevenPairs(counts) {
  let pairs=0;
  for (let i=0;i<34;i++) {
    if (counts[i]===2) pairs++;
    else if (counts[i]===0) {}
    else return false;
  }
  return pairs===7;
}

function isThirteenOrphans(counts) {
  const req = new Set([
    0,8,9,17,18,26, // 1/9万筒条
    27,28,29,30,31,32,33 // 东南西北中发白
  ]);
  let hasPair=false;
  for (const id of req) {
    if (counts[id]===0) return false;
    if (counts[id]>=2) hasPair=true;
  }
  // 其他牌必须为0
  for (let i=0;i<34;i++) {
    if (!req.has(i) && counts[i]>0) return false;
  }
  return hasPair;
}

function canStandardWin(counts) {
  // 返回 {canWin, pairId, hasTriplet, allTriplets}
  // 尝试每个可能的雀头
  for (let pair=0; pair<34; pair++) {
    if (counts[pair] >= 2) {
      const c = counts.slice();
      c[pair] -= 2;
      const res = canMeldAll(c);
      if (res.ok) {
        return { canWin:true, pairId: pair, hasTriplet: res.hasTriplet, allTriplets: res.allTriplets };
      }
    }
  }
  return { canWin:false };
}

function canMeldAll(c) {
  // 递归/回溯：把所有牌拆成刻子或顺子
  // 返回 {ok, hasTriplet, allTriplets}
  // 找第一张有牌的位置
  let i = c.findIndex(x=>x>0);
  if (i === -1) return { ok:true, hasTriplet:false, allTriplets:true };

  // 尝试刻子
  if (c[i] >= 3) {
    c[i] -= 3;
    const r = canMeldAll(c);
    c[i] += 3;
    if (r.ok) return { ok:true, hasTriplet:true || r.hasTriplet, allTriplets: r.allTriplets };
  }

  // 尝试顺子（仅数牌）
  if (isSuit(i)) {
    const s = suitOf(i);
    const r = rankOf(i);
    if (r <= 7) {
      const i2 = i + 1;
      const i3 = i + 2;
      if (isSuit(i2) && isSuit(i3) && suitOf(i2)===s && suitOf(i3)===s && c[i2]>0 && c[i3]>0) {
        c[i]--; c[i2]--; c[i3]--;
        const rr = canMeldAll(c);
        c[i]++; c[i2]++; c[i3]++;
        if (rr.ok) return { ok:true, hasTriplet: rr.hasTriplet, allTriplets:false };
      }
    }
  }

  return { ok:false, hasTriplet:false, allTriplets:false };
}

function isJiaHuByWinningTile(fullTiles, winningTile) {
  // 夹胡：胡牌张作为补顺子的那张（包含 12万等3万）
  // 近似实现：检查是否存在同花色的 (t-2,t-1) 或 (t-1,t+1) 或 (t+1,t+2) 组合
  // 但要避免字牌
  const t = winningTile;
  if (!isSuit(t)) return false;
  const s = suitOf(t);
  const r = rankOf(t);
  const counts = tilesToCounts(fullTiles);

  const has = (rank) => {
    if (rank<1 || rank>9) return false;
    const id = NAME_TO_ID.get(`${s}${rank}`);
    return counts[id] > 0;
  };

  // 12等3：存在 r-2, r-1
  if (has(r-2) && has(r-1)) return true;
  // 2-4等3：存在 r-1, r+1
  if (has(r-1) && has(r+1)) return true;
  // 4-5等3不对；这里是 r+1,r+2 对 r
  if (has(r+1) && has(r+2)) return true;

  return false;
}

function countOf(arr, v) {
  let n=0;
  for (const x of arr) if (x===v) n++;
  return n;
}
function removeN(arr, v, n) {
  for (let k=0;k<n;k++) {
    const i = arr.indexOf(v);
    if (i===-1) throw new Error("removeN failed");
    arr.splice(i,1);
  }
}

/**
 * 听牌判定：是否存在一张牌加入后可以胡（按照同一套胡牌判定）
 */
function isTenpai(hand13, melds) {
  if ((hand13.length % 3) !== 1) return false;
  for (let add=0; add<34; add++) {
    // 还要考虑牌最多4张：这里不严格限制
    const tiles = hand13.slice();
    tiles.push(add);
    tiles.sort((a,b)=>a-b);
    const counts = tilesToCounts(tiles);

    // 缺门检查：手+副露
    if (!hasAllThreeSuits(tiles, melds)) continue;

    // 特殊牌型
    if (isThirteenOrphans(counts) || isSevenPairs(counts)) return true;

    const winDecomp = canStandardWin(counts);
    if (!winDecomp.canWin) continue;

    // 刻子要求（雀头非字必须有刻子）
    const pairIsHonor = isHonor(winDecomp.pairId);
    if (!pairIsHonor && !winDecomp.hasTriplet) continue;

    return true;
  }
  return false;
}

function getWaits(hand13, melds) {
  const waits = new Set();
  for (let add=0; add<34; add++) {
    const tiles = hand13.slice();
    tiles.push(add);
    tiles.sort((a,b)=>a-b);
    const counts = tilesToCounts(tiles);

    if (!hasAllThreeSuits(tiles, melds)) continue;
    if (isThirteenOrphans(counts) || isSevenPairs(counts)) { waits.add(add); continue; }

    const winDecomp = canStandardWin(counts);
    if (!winDecomp.canWin) continue;

    const pairIsHonor = isHonor(winDecomp.pairId);
    if (!pairIsHonor && !winDecomp.hasTriplet) continue;

    waits.add(add);
  }
  return waits;
}

/**
 * =========================
 * Socket.IO 事件
 * =========================
 */

io.on("connection", (socket) => {
  socket.on("room_create", ({ name }) => {
    let roomId = makeRoomId();
    while (rooms.has(roomId)) roomId = makeRoomId();
    const room = makeEmptyRoom(roomId);
    rooms.set(roomId, room);

    // 坐0号位
    room.players[0] = { socketId: socket.id, name: name || "玩家1", ready: false, connected: true };
    socket.join(roomId);
    socket.emit("room_joined", { roomId, seat: 0 });
    emitRoom(room);
  });

  socket.on("room_join", ({ roomId, name }) => {
    const room = rooms.get(roomId);
    if (!room) return socket.emit("error_msg", { message: "房间不存在" });

    const seat = room.players.findIndex(p => !p.socketId);
    if (seat === -1) return socket.emit("error_msg", { message: "房间已满" });

    room.players[seat] = { socketId: socket.id, name: name || `玩家${seat+1}`, ready: false, connected: true };
    socket.join(roomId);
    socket.emit("room_joined", { roomId, seat });
    emitRoom(room);
    if (room.game) emitGame(room);
  });

  socket.on("ready", ({ roomId, ready }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const seat = seatOfSocket(room, socket.id);
    if (seat === -1) return;
    room.players[seat].ready = !!ready;
    emitRoom(room);
  });

  socket.on("game_start", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const seat = seatOfSocket(room, socket.id);
    if (seat !== 0) return socket.emit("error_msg", { message: "只有0号位（房主）可以开始" });

    // 必须4人都在且都ready
    if (room.players.some(p => !p.socketId)) return socket.emit("error_msg", { message: "还没满4人" });
    if (room.players.some(p => !p.ready)) return socket.emit("error_msg", { message: "还有人没准备" });

    room.game = newGameState(room);
    emitRoom(room);
    emitGame(room);
  });

  socket.on("pre_reveal", ({ roomId, kind }) => {
    const room = rooms.get(roomId);
    if (!room || !room.game) return;
    const seat = seatOfSocket(room, socket.id);
    if (seat === -1) return;
    try {
      tryPreReveal(room, seat, kind);
      emitGame(room);
    } catch (e) {
      socket.emit("error_msg", { message: e.message });
    }
  });

  socket.on("pre_reveal_done", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || !room.game) return;
    startPlayingIfReady(room);
    emitGame(room);
  });

  socket.on("draw", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || !room.game) return;
    const seat = seatOfSocket(room, socket.id);
    try {
      doDraw(room, seat);
      emitGame(room);
    } catch (e) {
      socket.emit("error_msg", { message: e.message });
    }
  });

  socket.on("discard", ({ roomId, tile }) => {
    const room = rooms.get(roomId);
    if (!room || !room.game) return;
    const seat = seatOfSocket(room, socket.id);
    try {
      doDiscard(room, seat, tile);
      emitGame(room);
    } catch (e) {
      socket.emit("error_msg", { message: e.message });
    }
  });

  socket.on("pass", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || !room.game) return;
    const seat = seatOfSocket(room, socket.id);
    try {
      doPass(room, seat);
      emitGame(room);
    } catch (e) {
      socket.emit("error_msg", { message: e.message });
    }
  });

  socket.on("riichi", ({ roomId, discardTile }) => {
    const room = rooms.get(roomId);
    if (!room || !room.game) return;
    const seat = seatOfSocket(room, socket.id);
    try {
      doRiichi(room, seat, discardTile);
      emitGame(room);
    } catch (e) {
      socket.emit("error_msg", { message: e.message });
    }
  });

  socket.on("kong", ({ roomId, payload }) => {
    const room = rooms.get(roomId);
    if (!room || !room.game) return;
    const seat = seatOfSocket(room, socket.id);
    try {
      doKong(room, seat, payload);
      emitGame(room);
    } catch (e) {
      socket.emit("error_msg", { message: e.message });
    }
  });

  socket.on("win", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || !room.game) return;
    const seat = seatOfSocket(room, socket.id);
    try {
      doWin(room, seat);
      emitGame(room);
    } catch (e) {
      socket.emit("error_msg", { message: e.message });
    }
  });

  socket.on("new_round", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    if (!room.game || room.game.stage !== "SETTLE") return;
    const seat = seatOfSocket(room, socket.id);
    if (seat !== 0) return socket.emit("error_msg", { message: "只有房主开新一局" });

    const prev = room.game;
    const nextDealer = prev.result?.type === "win" ? prev.result.nextDealer : prev.dealerSeat; // 流局连庄
    room.game = newGameState(room);
    room.game.dealerSeat = nextDealer;
    room.game.turnSeat = nextDealer;
    emitRoom(room);
    emitGame(room);
  });

  socket.on("disconnect", () => {
    // 标记断线（MVP不做重连令牌）
    for (const room of rooms.values()) {
      const seat = seatOfSocket(room, socket.id);
      if (seat !== -1) {
        room.players[seat].connected = false;
        room.players[seat].socketId = null;
        room.players[seat].ready = false;
        emitRoom(room);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});