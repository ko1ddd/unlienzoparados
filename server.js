const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

// Estado en memoria por sala: trazos y usuarios conectados.
// rooms[room] = { strokes: [...], users: { socketId: { name, color } } }
const rooms = {};

const PALETTE = ["#E8637C", "#DFAE49", "#7BA6A0", "#9C8AD9"];

function getRoom(room) {
  if (!rooms[room]) rooms[room] = { strokes: [], users: {} };
  return rooms[room];
}

io.on("connection", (socket) => {
  socket.on("join", ({ room, name }) => {
    if (!room) return;
    socket.join(room);
    const state = getRoom(room);

    const usedColors = Object.values(state.users).map((u) => u.color);
    const color = PALETTE.find((c) => !usedColors.includes(c)) || PALETTE[0];

    state.users[socket.id] = { name: name || "Alguien", color };
    socket.data.room = room;

    socket.emit("joined", {
      color,
      history: state.strokes,
      partners: Object.entries(state.users)
        .filter(([id]) => id !== socket.id)
        .map(([, u]) => u),
    });

    socket.to(room).emit("partner-joined", { name: state.users[socket.id].name });
    io.to(room).emit("presence", Object.values(state.users));
  });

  socket.on("draw", (stroke) => {
    const room = socket.data.room;
    if (!room) return;
    const state = getRoom(room);
    state.strokes.push(stroke);
    socket.to(room).emit("draw", stroke);
  });

  socket.on("cursor", (payload) => {
    const room = socket.data.room;
    if (!room) return;
    const state = getRoom(room);
    const user = state.users[socket.id] || {};
    socket.to(room).emit("cursor", { ...payload, id: socket.id, name: user.name, color: user.color });
  });

  socket.on("undo-last-mine", () => {
    const room = socket.data.room;
    if (!room) return;
    const state = getRoom(room);
    for (let i = state.strokes.length - 1; i >= 0; i--) {
      if (state.strokes[i].owner === socket.id) {
        state.strokes.splice(i, 1);
        break;
      }
    }
    io.to(room).emit("redraw", state.strokes);
  });

  socket.on("clear", () => {
    const room = socket.data.room;
    if (!room) return;
    const state = getRoom(room);
    state.strokes = [];
    io.to(room).emit("clear");
  });

  socket.on("disconnect", () => {
    const room = socket.data.room;
    if (!room || !rooms[room]) return;
    const state = rooms[room];
    const leaving = state.users[socket.id];
    delete state.users[socket.id];
    if (leaving) {
      socket.to(room).emit("partner-left", { name: leaving.name });
      io.to(room).emit("presence", Object.values(state.users));
    }
    if (Object.keys(state.users).length === 0 && state.strokes.length === 0) {
      delete rooms[room];
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Escuchando en el puerto ${PORT}`);
});
