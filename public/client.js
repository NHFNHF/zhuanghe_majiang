const socket = io();

let my = { roomId: null, seat: null, ready: false };
let latestRoom = null;
let latestGame = null;

const $ = (id) => document.getElementById(id);
const status = (msg) => { $("status").textContent = msg; };

const TILE_LABELS = {
  E: "东", S: "南", Ws: "西", N: "北",
  R: "中", G: "发", Wh: "白"
};

function tileToZh(tile) {
  if (!tile) return "";
  if (TILE_LABELS[tile]) return TILE_LABELS[tile];
  const suit = tile[0];
  const rank = tile.slice(1);
  if (!/^\d+$/.test(rank)) return tile;
  if (suit === "W") return `${rank}万`;
  if (suit === "T") return `${rank}筒`;
  if (suit === "B") return rank === "1" ? "1条（鸡）" : `${rank}条`;
  return tile;
}

function seatNameFromMine(seat) {
  if (my.seat == null || seat == null) return `座位${seat}`;
  const delta = (seat - my.seat + 4) % 4;
  if (delta === 0) return "自己";
  if (delta === 1) return "右家";
  if (delta === 2) return "对家";
  return "左家";
}

function relativeSeat(target) {
  if (my.seat == null || target == null) return "";
  const delta = (target - my.seat + 4) % 4;
  if (delta === 0) return "bottom";
  if (delta === 1) return "right";
  if (delta === 2) return "top";
  return "left";
}

$("btnCreate").onclick = () => {
  socket.emit("room_create", { name: $("name").value.trim() });
};

$("btnJoin").onclick = () => {
  socket.emit("room_join", { roomId: $("roomId").value.trim(), name: $("name").value.trim() });
};

$("btnReady").onclick = () => {
  if (!my.roomId) return status("先加入房间");
  my.ready = !my.ready;
  socket.emit("ready", { roomId: my.roomId, ready: my.ready });
};

$("btnStart").onclick = () => {
  if (!my.roomId) return status("先加入房间");
  socket.emit("game_start", { roomId: my.roomId });
};

$("btnPreWind").onclick = () => emitPre("wind");
$("btnPreDragon").onclick = () => emitPre("dragon");
$("btnPreDone").onclick = () => {
  if (!my.roomId) return;
  socket.emit("pre_reveal_done", { roomId: my.roomId });
};

function emitPre(kind) {
  if (!my.roomId) return;
  socket.emit("pre_reveal", { roomId: my.roomId, kind });
}

$("btnDraw").onclick = () => {
  if (!my.roomId) return;
  socket.emit("draw", { roomId: my.roomId });
};

$("btnPass").onclick = () => {
  if (!my.roomId) return;
  socket.emit("pass", { roomId: my.roomId });
};

$("btnRiichi").onclick = () => {
  if (!my.roomId) return;
  const discardTile = prompt("输入你要打出去的宝牌（例如 W3 / B1 / E / Wh）");
  if (!discardTile) return;
  socket.emit("riichi", { roomId: my.roomId, discardTile: discardTile.trim() });
};

$("btnKong").onclick = () => {
  if (!my.roomId || !latestGame) return;
  const me = latestGame.hands.find((x) => x.seat === my.seat);
  if (!me?.tiles?.length) return status("你当前没有可见手牌");

  const tile = prompt(`输入要开杠的牌（例如 ${me.tiles.slice(0, 6).join(" /")}）`);
  if (!tile) return;
  const type = prompt("输入杠类型：an(暗杠) 或 ming(明杠)", "an");
  if (!type) return;
  socket.emit("kong", { roomId: my.roomId, payload: { type: type.trim(), tile: tile.trim() } });
};

$("btnWin").onclick = () => {
  if (!my.roomId) return;
  socket.emit("win", { roomId: my.roomId });
};

$("btnNewRound").onclick = () => {
  if (!my.roomId) return;
  socket.emit("new_round", { roomId: my.roomId });
};

socket.on("room_joined", ({ roomId, seat }) => {
  my.roomId = roomId;
  my.seat = seat;
  $("roomId").value = roomId;
  status(`已加入房间 ${roomId}，座位 ${seat}`);
});

socket.on("room_state", (room) => {
  latestRoom = room;
  renderRoom();
  renderSeats();
});

socket.on("game_state", (g) => {
  latestGame = g;
  renderGame();
  renderHand();
  renderSeats();
  updateActionAvailability();
});

socket.on("error_msg", ({ message }) => status("错误：" + message));

function renderRoom() {
  if (!latestRoom) { $("roomView").textContent = "未加入"; return; }
  const lines = [];
  lines.push(`房间码：${latestRoom.roomId}`);
  lines.push(`游戏中：${latestRoom.inGame ? "是" : "否"}`);
  for (const p of latestRoom.players) {
    lines.push(`[座位${p.seat}] ${p.name ?? "(空)"} | ${p.connected ? "在线" : "离线"} | ${p.ready ? "已准备" : "未准备"}`);
  }
  $("roomView").textContent = lines.join("\n");
}

function playerDisplay(seat) {
  const p = latestRoom?.players?.find((x) => x.seat === seat);
  return p?.name || `玩家${seat + 1}`;
}

function seatPanelText(seat) {
  if (seat == null) return "等待入座";
  const role = seatNameFromMine(seat);
  const isDealer = latestGame?.dealerSeat === seat;
  const isTurn = latestGame?.turnSeat === seat;
  const hand = latestGame?.hands?.find((x) => x.seat === seat);
  const handInfo = hand?.tiles ? `${hand.tiles.length}张` : `${hand?.count ?? 0}张`;
  const riichi = latestGame?.riichi?.find((x) => x.seat === seat)?.declared;
  return `${role}｜${playerDisplay(seat)}\n${isDealer ? "庄家 " : ""}${isTurn ? "当前行动" : ""}\n手牌:${handInfo}${riichi ? "｜已立直" : ""}`.trim();
}

function renderSeats() {
  const slots = {
    top: $("seatTop"),
    left: $("seatLeft"),
    right: $("seatRight"),
    bottom: $("seatBottom")
  };
  Object.values(slots).forEach((el) => {
    el.textContent = "等待开局";
    el.classList.remove("active-turn", "dealer");
  });

  if (!latestRoom || my.seat == null) return;

  for (const p of latestRoom.players) {
    const pos = relativeSeat(p.seat);
    if (!pos || !slots[pos]) continue;
    const el = slots[pos];
    el.textContent = seatPanelText(p.seat);
    if (latestGame?.turnSeat === p.seat) el.classList.add("active-turn");
    if (latestGame?.dealerSeat === p.seat) el.classList.add("dealer");
  }
}

function renderGame() {
  if (!latestGame) {
    $("tableMeta").textContent = "未开始";
    $("tableCenter").textContent = "等待游戏开始";
    $("resultView").textContent = "";
    return;
  }
  const g = latestGame;
  $("tableMeta").textContent = `阶段：${g.stage} ｜ 庄家：${seatNameFromMine(g.dealerSeat)} ｜ 当前：${seatNameFromMine(g.turnSeat)} ｜ 剩余牌：${g.wallCount} ｜ 宝牌：${g.treasureTile ? `${tileToZh(g.treasureTile)}(${g.treasureTile})` : "未公开"}`;

  const discarder = g.currentDiscard ? seatNameFromMine(g.currentDiscard.seat) : "无";
  const discardTile = g.currentDiscard ? `${tileToZh(g.currentDiscard.tile)}(${g.currentDiscard.tile})` : "";
  $("tableCenter").textContent = `当前弃牌：${discarder} ${discardTile}`;

  if (!g.result) {
    $("resultView").textContent = "";
    return;
  }

  const lines = ["=== 结果 ==="];
  if (g.result.type === "draw") {
    lines.push("流局：杠作废，庄家连庄。");
  } else if (g.result.type === "win") {
    lines.push(`赢家：${seatNameFromMine(g.result.winner)} | 类型：${g.result.winType} | 番：${g.result.baseFan}`);
    lines.push(`役种：${g.result.yaku.filter(Boolean).join("、")}`);
    lines.push("胡牌赔付：");
    for (const p of g.result.payments) {
      lines.push(`  ${seatNameFromMine(p.from)} -> ${seatNameFromMine(p.to)}：${p.money}元（${p.reason}）`);
    }
    if (g.result.kongPayments?.length) {
      lines.push("杠赔付：");
      for (const p of g.result.kongPayments) {
        lines.push(`  ${seatNameFromMine(p.from)} -> ${seatNameFromMine(p.to)}：${p.money}元（${p.reason}）`);
      }
    }
  }
  $("resultView").textContent = lines.join("\n");
}

function renderHand() {
  const handWrap = $("myHand");
  handWrap.innerHTML = "";
  if (!latestGame || my.seat == null) return;
  const me = latestGame.hands.find((x) => x.seat === my.seat);
  if (!me?.tiles) return;

  for (const tile of me.tiles) {
    const btn = document.createElement("button");
    btn.className = "tile-btn";
    btn.type = "button";
    btn.innerHTML = `<span class="tile-zh">${tileToZh(tile)}</span><span class="tile-code">${tile}</span>`;
    btn.onclick = () => {
      const g = latestGame;
      const canDiscard = g && g.stage === "PLAYING" && g.turnSeat === my.seat && !g.currentDiscard;
      if (!canDiscard) {
        status("当前不能出牌：请在自己回合且无待响应弃牌时操作");
        return;
      }
      socket.emit("discard", { roomId: my.roomId, tile });
    };
    handWrap.appendChild(btn);
  }
}

function updateActionAvailability() {
  const g = latestGame;
  const inRoom = !!my.roomId;
  const inGame = !!g;
  const isPlaying = g?.stage === "PLAYING";
  const isPre = g?.stage === "PRE_REVEAL";
  const isSettle = g?.stage === "SETTLE";
  const myTurn = isPlaying && g.turnSeat === my.seat;
  const hasDiscard = !!g?.currentDiscard;
  const canRespond = hasDiscard && g.currentDiscard.seat !== my.seat;

  $("btnPreWind").disabled = !(inGame && isPre);
  $("btnPreDragon").disabled = !(inGame && isPre);
  $("btnPreDone").disabled = !(inGame && isPre);

  $("btnDraw").disabled = !(inRoom && myTurn && !hasDiscard);
  $("btnRiichi").disabled = !(inRoom && myTurn && !hasDiscard);
  $("btnKong").disabled = !(inRoom && myTurn && !hasDiscard);
  $("btnWin").disabled = !(inRoom && isPlaying && ((myTurn && !hasDiscard) || canRespond));
  $("btnPass").disabled = !(inRoom && canRespond);
  $("btnNewRound").disabled = !(inRoom && isSettle);

  const canDiscard = inRoom && myTurn && !hasDiscard;
  document.querySelectorAll(".tile-btn").forEach((btn) => {
    btn.disabled = !canDiscard;
  });
}

updateActionAvailability();
renderGame();
renderHand();
renderSeats();
