const socket = io();

let my = { roomId: null, seat: null, ready: false };
let latestRoom = null;
let latestGame = null;

const $ = (id) => document.getElementById(id);
const status = (msg) => { $("status").textContent = msg; };

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

$("btnDiscard").onclick = () => {
  if (!my.roomId) return;
  const tile = $("tileInput").value.trim();
  socket.emit("discard", { roomId: my.roomId, tile });
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
  if (!my.roomId) return;
  const tile = prompt("输入要开杠的牌（MVP：只支持你手里有4张同牌）");
  if (!tile) return;
  const type = prompt("输入杠类型：an(暗杠) 或 ming(明杠) 。门清立直只能an");
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
});

socket.on("game_state", (g) => {
  latestGame = g;
  renderGame();
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

function renderGame() {
  if (!latestGame) { $("gameView").textContent = "未开始"; return; }
  const g = latestGame;
  const lines = [];
  lines.push(`阶段：${g.stage} | 庄家：${g.dealerSeat} | 当前行动：${g.turnSeat} | 剩余牌：${g.wallCount}`);
  if (g.treasureTile) lines.push(`宝牌：${g.treasureTile}（仅听牌者可见）`);
  lines.push(`当前弃牌：${g.currentDiscard ? `座位${g.currentDiscard.seat} -> ${g.currentDiscard.tile}` : "无"}`);

  // 我的手牌
  const me = g.hands.find(x => x.seat === my.seat);
  if (me?.tiles) lines.push(`\n【我的手牌】\n${me.tiles.join(" ")}`);

  // 其他人手牌数
  for (const h of g.hands) {
    if (h.seat === my.seat) continue;
    lines.push(`座位${h.seat} 手牌数：${h.count}`);
  }

  // 副露与弃牌
  lines.push("\n【副露】");
  for (const m of g.melds) {
    const str = m.melds.map(mm => `${mm.type}:${mm.tiles.join(",")}`).join(" | ");
    lines.push(`座位${m.seat}: ${str || "-"}`);
  }

  lines.push("\n【弃牌】");
  for (const d of g.discards) {
    lines.push(`座位${d.seat}: ${d.tiles.join(" ")}`);
  }

  lines.push("\n【开局亮杠】");
  for (const pk of g.preKongWind) lines.push(`风杠 座位${pk.seat}: ${pk.active ? pk.tiles.join(" ") : "-"}`);
  for (const pk of g.preKongDragon) lines.push(`箭杠 座位${pk.seat}: ${pk.active ? pk.tiles.join(" ") : "-"}`);

  if (g.result) {
    lines.push("\n=== 结果 ===");
    if (g.result.type === "draw") {
      lines.push("流局：杠作废，庄家连庄。");
    } else if (g.result.type === "win") {
      lines.push(`赢家：座位${g.result.winner} | 类型：${g.result.winType} | 番：${g.result.baseFan}`);
      lines.push(`役种：${g.result.yaku.filter(Boolean).join("、")}`);
      lines.push("胡牌赔付：");
      for (const p of g.result.payments) {
        lines.push(`  座位${p.from} -> 座位${p.to}：${p.money}元（${p.reason}）`);
      }
      if (g.result.kongPayments?.length) {
        lines.push("杠赔付：");
        for (const p of g.result.kongPayments) {
          lines.push(`  座位${p.from} -> 座位${p.to}：${p.money}元（${p.reason}）`);
        }
      }
      lines.push(`下一局庄家座位：${g.result.nextDealer}`);
    }
  }

  $("gameView").textContent = lines.join("\n");
}