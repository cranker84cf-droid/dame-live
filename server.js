import express from "express";
import http from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

// Permanent setup
const FIXED_ROOM = "chris-sandrina";

// Convenience short links
app.get("/chris", (req, res) => res.redirect(`/#seat=white`));
app.get("/sandrina", (req, res) => res.redirect(`/#seat=black`));

// ------------------- Game State -------------------
/**
 * Pieces:
 *  0 = empty
 *  1 = White man,  2 = White king
 * -1 = Black man, -2 = Black king
 * Turn:
 *  1 = White to move
 * -1 = Black to move
 */
function createInitialState() {
  const board = Array.from({ length: 8 }, () => Array(8).fill(0));
  // Black on top (rows 0..2), White on bottom (rows 5..7)
  for (let r = 0; r < 3; r++) for (let c = 0; c < 8; c++) if ((r + c) % 2 === 1) board[r][c] = -1;
  for (let r = 5; r < 8; r++) for (let c = 0; c < 8; c++) if ((r + c) % 2 === 1) board[r][c] = 1;

  return {
    board,
    turn: 1,
    winner: 0,
    lastMove: null,
    rules: {
      mustCapture: true,
      skipCapturePenaltyRemoveMoved: true,
      multiCapture: "optional", // "optional" | "forced" (forced is planned; optional works now)
      flyingKingMove: true,
      flyingKingCapture: true,
      menBackwardCapture: false
    }
  };
}

const rooms = new Map(); // roomId -> { state, players:{white,black}, clientMap }

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      state: createInitialState(),
      players: { white: null, black: null },
      clientMap: new Map()
    });
  }
  return rooms.get(roomId);
}

function sign(piece) { return piece === 0 ? 0 : piece > 0 ? 1 : -1; }
function isKing(piece) { return Math.abs(piece) === 2; }
function inBounds(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }
function cloneBoard(board) { return board.map(row => row.slice()); }
function forwardDir(side) { return side === 1 ? -1 : +1; }

// ---------- Move generators (respect rules) ----------
function listManMoves(board, r, c, side) {
  const dr = forwardDir(side);
  const out = [];
  for (const dc of [-1, +1]) {
    const r1 = r + dr, c1 = c + dc;
    if (inBounds(r1, c1) && board[r1][c1] === 0) out.push({ from: { r, c }, to: { r: r1, c: c1 } });
  }
  return out;
}

function listManCaptures(board, r, c, side, allowBackwardCapture) {
  const drs = allowBackwardCapture ? [-1, +1] : [forwardDir(side)];
  const out = [];
  for (const dr of drs) {
    for (const dc of [-1, +1]) {
      const r1 = r + dr, c1 = c + dc;
      const r2 = r + 2 * dr, c2 = c + 2 * dc;
      if (!inBounds(r2, c2)) continue;
      const mid = board[r1]?.[c1];
      if (mid && sign(mid) === -side && board[r2][c2] === 0) {
        out.push({ from: { r, c }, over: { r: r1, c: c1 }, to: { r: r2, c: c2 } });
      }
    }
  }
  return out;
}

function listKingMoves(board, r, c, flying) {
  if (!flying) {
    // short king move (1 step)
    const out = [];
    for (const dr of [-1, +1]) for (const dc of [-1, +1]) {
      const rr = r + dr, cc = c + dc;
      if (inBounds(rr, cc) && board[rr][cc] === 0) out.push({ from: { r, c }, to: { r: rr, c: cc } });
    }
    return out;
  }

  const out = [];
  for (const dr of [-1, +1]) {
    for (const dc of [-1, +1]) {
      let rr = r + dr, cc = c + dc;
      while (inBounds(rr, cc) && board[rr][cc] === 0) {
        out.push({ from: { r, c }, to: { r: rr, c: cc } });
        rr += dr; cc += dc;
      }
    }
  }
  return out;
}

function listKingCaptures(board, r, c, side, flyingCapture) {
  if (!flyingCapture) {
    // short king capture (2 steps)
    const out = [];
    for (const dr of [-1, +1]) for (const dc of [-1, +1]) {
      const r1 = r + dr, c1 = c + dc;
      const r2 = r + 2 * dr, c2 = c + 2 * dc;
      if (!inBounds(r2, c2)) continue;
      const mid = board[r1]?.[c1];
      if (mid && sign(mid) === -side && board[r2][c2] === 0) {
        out.push({ from: { r, c }, over: { r: r1, c: c1 }, to: { r: r2, c: c2 } });
      }
    }
    return out;
  }

  // flying capture: jump exactly one enemy, land on any empty beyond
  const out = [];
  for (const dr of [-1, +1]) {
    for (const dc of [-1, +1]) {
      let rr = r + dr, cc = c + dc;
      let seenEnemy = null;
      while (inBounds(rr, cc)) {
        const cell = board[rr][cc];
        if (cell === 0) {
          if (seenEnemy) {
            out.push({ from: { r, c }, over: { r: seenEnemy.r, c: seenEnemy.c }, to: { r: rr, c: cc } });
          }
          rr += dr; cc += dc;
          continue;
        }
        const s = sign(cell);
        if (s === side) break;
        if (s === -side) {
          if (seenEnemy) break; // can't jump two
          seenEnemy = { r: rr, c: cc };
          rr += dr; cc += dc;
          continue;
        }
        break;
      }
    }
  }
  return out;
}

function listCapturesForPiece(board, r, c, rules) {
  const piece = board[r][c];
  if (!piece) return [];
  const side = sign(piece);
  if (isKing(piece)) return listKingCaptures(board, r, c, side, rules.flyingKingCapture);
  return listManCaptures(board, r, c, side, rules.menBackwardCapture);
}

function listMovesForPiece(board, r, c, rules) {
  const piece = board[r][c];
  if (!piece) return [];
  const side = sign(piece);
  if (isKing(piece)) return listKingMoves(board, r, c, rules.flyingKingMove);
  return listManMoves(board, r, c, side);
}

function anyCaptureAvailable(board, side, rules) {
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    if (sign(board[r][c]) === side && listCapturesForPiece(board, r, c, rules).length) return true;
  }
  return false;
}

function applyMoveWithRules(state, move) {
  const board = state.board;
  const rules = state.rules;
  const fr = move.from.r, fc = move.from.c, tr = move.to.r, tc = move.to.c;
  const piece = board[fr][fc];
  const side = sign(piece);

  const newBoard = cloneBoard(board);
  newBoard[fr][fc] = 0;

  // Is capture?
  const caps = listCapturesForPiece(board, fr, fc, rules);
  const capMatch = caps.find(x => x.to.r === tr && x.to.c === tc);

  let isCapture = false;
  let capturedPos = null;

  if (capMatch) {
    isCapture = true;
    capturedPos = capMatch.over;
    newBoard[capturedPos.r][capturedPos.c] = 0;
  }

  // Place piece
  let placed = piece;

  // Kinging: only when man reaches last row
  if (!isKing(piece)) {
    if (side === 1 && tr === 0) placed = 2;
    if (side === -1 && tr === 7) placed = -2;
  }
  newBoard[tr][tc] = placed;

  // Penalty rule: if capture existed anywhere, but player chose non-capture,
  // then moved piece is removed after moving
  const captureWasAvailable = anyCaptureAvailable(board, side, rules);
  let penaltyRemoved = false;
  if (rules.mustCapture && rules.skipCapturePenaltyRemoveMoved && captureWasAvailable && !isCapture) {
    newBoard[tr][tc] = 0;
    penaltyRemoved = true;
  }

  const next = {
    ...state,
    board: newBoard,
    lastMove: { from: move.from, to: move.to, captured: capturedPos, penaltyRemoved },
    turn: -state.turn
  };

  return next;
}

function countPieces(board, side) {
  let n = 0;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (sign(board[r][c]) === side) n++;
  return n;
}

function hasAnyLegalMove(state, side) {
  const { board, rules } = state;
  // even if capture exists, a non-capture might still be allowed (with/without penalty), depending on rules
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    if (sign(board[r][c]) !== side) continue;
    if (listCapturesForPiece(board, r, c, rules).length) return true;
    if (listMovesForPiece(board, r, c, rules).length) return true;
  }
  return false;
}

function checkWinner(state) {
  const white = countPieces(state.board, 1);
  const black = countPieces(state.board, -1);
  if (white === 0) return -1;
  if (black === 0) return 1;
  if (!hasAnyLegalMove(state, state.turn)) return -state.turn;
  return 0;
}

// ------------------- Socket Handling -------------------
io.on("connection", (socket) => {
  socket.on("joinRoom", ({ roomId, seat, clientId }) => {
    // force fixed room (ignore user-supplied)
    roomId = FIXED_ROOM;

    const room = getRoom(roomId);
    let role = "spectator";

    if (clientId && room.clientMap.has(clientId)) {
      role = room.clientMap.get(clientId);
      if (role === "white") room.players.white = socket.id;
      if (role === "black") room.players.black = socket.id;
    } else {
      if (seat === "white") {
        if (!room.players.white) { room.players.white = socket.id; role = "white"; }
      } else if (seat === "black") {
        if (!room.players.black) { room.players.black = socket.id; role = "black"; }
      }
      if (role === "spectator") {
        if (!room.players.white) { room.players.white = socket.id; role = "white"; }
        else if (!room.players.black) { room.players.black = socket.id; role = "black"; }
      }
      if (clientId && (role === "white" || role === "black")) room.clientMap.set(clientId, role);
    }

    socket.join(roomId);
    socket.emit("roomJoined", { roomId, role, state: room.state });
    io.to(roomId).emit("presence", { players: { white: !!room.players.white, black: !!room.players.black } });
  });

  socket.on("updateRules", ({ roomId, rules }) => {
    roomId = FIXED_ROOM;
    const room = rooms.get(roomId);
    if (!room) return;

    const role = room.players.white === socket.id ? "white" :
                 room.players.black === socket.id ? "black" : "spectator";
    if (role !== "white") return; // only Chris by default

    room.state.rules = {
      mustCapture: !!rules.mustCapture,
      skipCapturePenaltyRemoveMoved: !!rules.skipCapturePenaltyRemoveMoved,
      multiCapture: (rules.multiCapture === "forced" ? "forced" : "optional"),
      flyingKingMove: !!rules.flyingKingMove,
      flyingKingCapture: !!rules.flyingKingCapture,
      menBackwardCapture: !!rules.menBackwardCapture
    };

    io.to(roomId).emit("state", { state: room.state });
  });

  socket.on("makeMove", ({ roomId, from, to }) => {
    roomId = FIXED_ROOM;
    const room = rooms.get(roomId);
    if (!room) return;

    const role =
      room.players.white === socket.id ? "white" :
      room.players.black === socket.id ? "black" : "spectator";
    if (role === "spectator") return;

    const side = role === "white" ? 1 : -1;
    const state = room.state;

    if (state.winner !== 0) return;
    if (state.turn !== side) return;

    const fr = from?.r, fc = from?.c, tr = to?.r, tc = to?.c;
    if (![fr, fc, tr, tc].every(Number.isInteger)) return;
    if (![fr, fc, tr, tc].every(v => v >= 0 && v < 8)) return;

    const piece = state.board[fr][fc];
    if (sign(piece) !== side) return;
    if (state.board[tr][tc] !== 0) return;

    const caps = listCapturesForPiece(state.board, fr, fc, state.rules);
    const moves = listMovesForPiece(state.board, fr, fc, state.rules);

    const isCap = caps.some(x => x.to.r === tr && x.to.c === tc);
    const isMove = moves.some(x => x.to.r === tr && x.to.c === tc);

    if (!isCap && !isMove) return;

    // If rules.mustCapture is true, captures should be prioritized but
    // non-capture is still allowed (penalty toggle decides).
    room.state = applyMoveWithRules(state, { from: { r: fr, c: fc }, to: { r: tr, c: tc } });

    const w = checkWinner(room.state);
    if (w !== 0) room.state.winner = w;

    io.to(roomId).emit("state", { state: room.state });
  });

  socket.on("resetGame", () => {
    const room = rooms.get(FIXED_ROOM);
    if (!room) return;

    const role =
      room.players.white === socket.id ? "white" :
      room.players.black === socket.id ? "black" : "spectator";
    if (role === "spectator") return;

    room.state = createInitialState();
    io.to(FIXED_ROOM).emit("state", { state: room.state });
  });

  socket.on("disconnect", () => {
    const room = rooms.get(FIXED_ROOM);
    if (!room) return;
    let changed = false;
    if (room.players.white === socket.id) { room.players.white = null; changed = true; }
    if (room.players.black === socket.id) { room.players.black = null; changed = true; }
    if (changed) {
      io.to(FIXED_ROOM).emit("presence", { players: { white: !!room.players.white, black: !!room.players.black } });
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
