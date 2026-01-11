const socket = io();

const FIXED_ROOM = "chris-sandrina";

const elBoard = document.getElementById("board");
const elStatus = document.getElementById("status");
const elPresence = document.getElementById("presence");
const elRoomInfo = document.getElementById("roomInfo");
const elHint = document.getElementById("hint");
const resetBtn = document.getElementById("resetBtn");

const rulesBox = document.getElementById("rulesBox");
const saveRulesBtn = document.getElementById("saveRulesBtn");

const linkChris = document.getElementById("linkChris");
const linkSandrina = document.getElementById("linkSandrina");

function getParams() {
  const hash = location.hash.replace(/^#/, "");
  const params = new URLSearchParams(hash);

  const seat = params.get("seat"); // white|black|null

  // always fixed room
  params.set("room", FIXED_ROOM);
  if (seat) params.set("seat", seat);

  // keep hash tidy
  location.hash = params.toString();

  return { roomId: FIXED_ROOM, seat };
}

const { roomId, seat } = getParams();

let clientId = localStorage.getItem("dameClientId");
if (!clientId) {
  clientId = crypto.randomUUID();
  localStorage.setItem("dameClientId", clientId);
}

let role = "spectator"; // white|black|spectator
let state = null;

let selected = null;
let legalTargets = new Set();

function key(rc){ return `${rc.r},${rc.c}`; }
function sign(piece){ return piece===0?0:(piece>0?1:-1); }
function isKing(piece){ return Math.abs(piece)===2; }
function inBounds(r,c){ return r>=0 && r<8 && c>=0 && c<8; }
function forwardDir(side){ return side===1 ? -1 : +1; }

// --- client-side helpers (for highlighting only) ---
function listManMoves(board,r,c,side){
  const dr = forwardDir(side);
  const out = [];
  for (const dc of [-1,+1]){
    const r1=r+dr, c1=c+dc;
    if (inBounds(r1,c1) && board[r1][c1]===0) out.push({to:{r:r1,c:c1}});
  }
  return out;
}
function listManCaptures(board,r,c,side,allowBackward){
  const drs = allowBackward ? [-1,+1] : [forwardDir(side)];
  const out = [];
  for (const dr of drs){
    for (const dc of [-1,+1]){
      const r1=r+dr, c1=c+dc;
      const r2=r+2*dr, c2=c+2*dc;
      if (!inBounds(r2,c2)) continue;
      const mid = board[r1]?.[c1];
      if (mid && sign(mid)===-side && board[r2][c2]===0) out.push({to:{r:r2,c:c2}});
    }
  }
  return out;
}
function listKingMoves(board,r,c,flying){
  const out = [];
  if (!flying){
    for (const dr of [-1,+1]) for (const dc of [-1,+1]){
      const rr=r+dr, cc=c+dc;
      if (inBounds(rr,cc) && board[rr][cc]===0) out.push({to:{r:rr,c:cc}});
    }
    return out;
  }
  for (const dr of [-1,+1]){
    for (const dc of [-1,+1]){
      let rr=r+dr, cc=c+dc;
      while (inBounds(rr,cc) && board[rr][cc]===0){
        out.push({to:{r:rr,c:cc}});
        rr+=dr; cc+=dc;
      }
    }
  }
  return out;
}
function listKingCaptures(board,r,c,side,flyingCap){
  const out = [];
  if (!flyingCap){
    for (const dr of [-1,+1]) for (const dc of [-1,+1]){
      const r1=r+dr, c1=c+dc;
      const r2=r+2*dr, c2=c+2*dc;
      if (!inBounds(r2,c2)) continue;
      const mid = board[r1]?.[c1];
      if (mid && sign(mid)===-side && board[r2][c2]===0) out.push({to:{r:r2,c:c2}});
    }
    return out;
  }
  for (const dr of [-1,+1]){
    for (const dc of [-1,+1]){
      let rr=r+dr, cc=c+dc;
      let seenEnemy=null;
      while (inBounds(rr,cc)){
        const cell = board[rr][cc];
        if (cell===0){
          if (seenEnemy) out.push({to:{r:rr,c:cc}});
          rr+=dr; cc+=dc;
          continue;
        }
        const s = sign(cell);
        if (s===side) break;
        if (s===-side){
          if (seenEnemy) break;
          seenEnemy={r:rr,c:cc};
          rr+=dr; cc+=dc;
          continue;
        }
        break;
      }
    }
  }
  return out;
}
function listMovesForPiece(board,r,c,rules){
  const piece = board[r][c];
  if (!piece) return [];
  const side = sign(piece);
  return isKing(piece) ? listKingMoves(board,r,c,rules.flyingKingMove) : listManMoves(board,r,c,side);
}
function listCapturesForPiece(board,r,c,rules){
  const piece = board[r][c];
  if (!piece) return [];
  const side = sign(piece);
  return isKing(piece) ? listKingCaptures(board,r,c,side,rules.flyingKingCapture)
                       : listManCaptures(board,r,c,side,rules.menBackwardCapture);
}
function anyCaptureAvailable(board, side, rules){
  for (let r=0;r<8;r++) for (let c=0;c<8;c++){
    if (sign(board[r][c])===side && listCapturesForPiece(board,r,c,rules).length) return true;
  }
  return false;
}

function computeLegalTargets(r,c){
  legalTargets.clear();
  if (!state) return;

  const piece = state.board[r][c];
  const side = role==="white" ? 1 : role==="black" ? -1 : 0;
  if (!side) return;
  if (state.winner) return;
  if (state.turn !== side) return;
  if (sign(piece) !== side) return;

  const rules = state.rules;
  const caps = listCapturesForPiece(state.board, r, c, rules);
  const moves = listMovesForPiece(state.board, r, c, rules);

  // highlight both (server decides penalty if skipping capture)
  for (const x of [...caps, ...moves]) legalTargets.add(key(x.to));
}

function setRulesUI(rules){
  document.getElementById("r_mustCapture").checked = !!rules.mustCapture;
  document.getElementById("r_penalty").checked = !!rules.skipCapturePenaltyRemoveMoved;
  document.getElementById("r_multi").value = rules.multiCapture === "forced" ? "forced" : "optional";
  document.getElementById("r_flyMove").checked = !!rules.flyingKingMove;
  document.getElementById("r_flyCap").checked = !!rules.flyingKingCapture;
  document.getElementById("r_backCap").value = rules.menBackwardCapture ? "all" : "kingOnly";
}

function getRulesFromUI(){
  return {
    mustCapture: document.getElementById("r_mustCapture").checked,
    skipCapturePenaltyRemoveMoved: document.getElementById("r_penalty").checked,
    multiCapture: document.getElementById("r_multi").value, // optional|forced
    flyingKingMove: document.getElementById("r_flyMove").checked,
    flyingKingCapture: document.getElementById("r_flyCap").checked,
    menBackwardCapture: (document.getElementById("r_backCap").value === "all")
  };
}

saveRulesBtn?.addEventListener("click", () => {
  if (!state) return;
  socket.emit("updateRules", { roomId, rules: getRulesFromUI() });
});

function render(){
  if (!state) return;

  // show permanent links
  const base = `${location.origin}`;
  linkChris.textContent = `${base}/chris  (oder ${base}/#seat=white)`;
  linkSandrina.textContent = `${base}/sandrina  (oder ${base}/#seat=black)`;

  elRoomInfo.textContent = `Raum: ${roomId} • Du: ${role.toUpperCase()}`;

  if (state.winner){
    elStatus.textContent = state.winner === 1 ? "Weiß gewinnt 🎉" : "Schwarz gewinnt 🎉";
  } else {
    const turnTxt = state.turn === 1 ? "Weiß" : "Schwarz";
    const side = role==="white" ? 1 : role==="black" ? -1 : 0;
    elStatus.textContent = `${turnTxt} ist am Zug${(side && state.turn===side) ? " (DU)" : ""}`;
  }

  if (role === "white"){
    rulesBox.classList.remove("hidden");
    setRulesUI(state.rules);
  } else {
    rulesBox.classList.add("hidden");
  }

  if (role !== "spectator"){
    const side = role==="white" ? 1 : -1;
    const capAvail = anyCaptureAvailable(state.board, side, state.rules);
    elHint.textContent = (state.rules.mustCapture && capAvail)
      ? (state.rules.skipCapturePenaltyRemoveMoved
          ? "Schlag ist möglich: Wenn du NICHT schlägst, fliegt der gezogene Stein raus."
          : "Schlag ist möglich: Du darfst trotzdem ziehen (keine Strafe).")
      : "Tippe eine Figur an, dann ein Ziel.";
  } else {
    elHint.textContent = "Du bist Zuschauer. Öffne /chris oder /sandrina.";
  }

  elBoard.innerHTML = "";
  for (let r=0;r<8;r++){
    for (let c=0;c<8;c++){
      const sq = document.createElement("div");
      sq.className = "sq " + (((r+c)%2===0) ? "light" : "dark");
      sq.dataset.r = r;
      sq.dataset.c = c;

      if (selected && selected.r===r && selected.c===c) sq.classList.add("select");
      if (legalTargets.has(`${r},${c}`)) sq.classList.add("move");

      const piece = state.board[r][c];
      if (piece !== 0){
        const p = document.createElement("div");
        p.className = "piece " + (piece>0 ? "white" : "black") + (isKing(piece) ? " king" : "");
        p.textContent = isKing(piece) ? "D" : "";
        sq.appendChild(p);
      }

      sq.addEventListener("click", onSquareClick);
      elBoard.appendChild(sq);
    }
  }
}

function onSquareClick(e){
  if (!state || state.winner) return;
  const r = Number(e.currentTarget.dataset.r);
  const c = Number(e.currentTarget.dataset.c);

  if (selected && legalTargets.has(`${r},${c}`)){
    socket.emit("makeMove", { roomId, from: selected, to: { r, c } });
    return;
  }

  selected = { r, c };
  computeLegalTargets(r, c);

  if (legalTargets.size === 0){
    const side = role==="white" ? 1 : role==="black" ? -1 : 0;
    if (!side || sign(state.board[r][c]) !== side) selected = null;
  }
  render();
}

socket.on("presence", ({ players }) => {
  elPresence.textContent = `Spieler: Weiß ${players.white ? "✅" : "—"} • Schwarz ${players.black ? "✅" : "—"}`;
});

socket.emit("joinRoom", { roomId, seat, clientId });

socket.on("roomJoined", ({ role: r, state: s }) => {
  role = r;
  state = s;
  selected = null;
  legalTargets.clear();
  render();
});

socket.on("state", ({ state: s }) => {
  state = s;
  selected = null;
  legalTargets.clear();
  render();
});

resetBtn?.addEventListener("click", () => {
  socket.emit("resetGame", { roomId });
});
