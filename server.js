const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const TICK_RATE = 20;
const TICK_MS = 1000 / TICK_RATE;

const players = new Map();

const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    ok: true,
    service: "realtime-tank-backend",
    players: players.size
  }));
});

const wss = new WebSocket.Server({ server: httpServer });

function makeId() {
  return crypto.randomUUID();
}

function safeNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function send(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function broadcast(message, except = null) {
  const data = JSON.stringify(message);
  for (const player of players.values()) {
    if (player.ws !== except && player.ws.readyState === WebSocket.OPEN) {
      player.ws.send(data);
    }
  }
}

function publicPlayer(player) {
  return {
    id: player.id,
    x: player.x,
    y: player.y,
    angle: player.angle,
    name: player.name
  };
}

wss.on("connection", (ws) => {
  const id = makeId();

  const player = {
    id,
    ws,
    name: `Player-${id.slice(0, 4)}`,
    x: 0,
    y: 0,
    angle: 0,
    input: {
      up: false,
      down: false,
      left: false,
      right: false
    },
    lastInputTime: Date.now()
  };

  players.set(id, player);

  send(ws, {
    type: "welcome",
    id,
    tickRate: TICK_RATE,
    players: [...players.values()].map(publicPlayer)
  });

  broadcast(
    { type: "playerJoined", player: publicPlayer(player) },
    ws
  );

  ws.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString());

      if (message.type === "ping") {
        send(ws, {
          type: "pong",
          clientTime: message.clientTime,
          serverTime: Date.now()
        });
        return;
      }

      if (message.type === "input") {
        player.input = {
          up: Boolean(message.up),
          down: Boolean(message.down),
          left: Boolean(message.left),
          right: Boolean(message.right)
        };

        player.angle = safeNumber(message.angle, player.angle);
        player.lastInputTime = Date.now();
        return;
      }

      if (message.type === "setName") {
        const name = String(message.name || "").trim().slice(0, 20);
        if (name) player.name = name;
        return;
      }
    } catch {
      // Ignore malformed packets.
    }
  });

  ws.on("close", () => {
    players.delete(id);
    broadcast({ type: "playerLeft", id });
  });

  ws.on("error", () => {
    players.delete(id);
  });
});

// Basic authoritative movement simulation.
// Game combat, bullets, XP, upgrades, etc. should be added later.
setInterval(() => {
  const speed = 180 / TICK_RATE;

  for (const player of players.values()) {
    const i = player.input;

    let dx = 0;
    let dy = 0;

    if (i.left) dx -= 1;
    if (i.right) dx += 1;
    if (i.up) dy -= 1;
    if (i.down) dy += 1;

    // Normalize diagonal movement.
    if (dx !== 0 && dy !== 0) {
      dx *= Math.SQRT1_2;
      dy *= Math.SQRT1_2;
    }

    player.x += dx * speed;
    player.y += dy * speed;
  }

  broadcast({
    type: "state",
    serverTime: Date.now(),
    players: [...players.values()].map(publicPlayer)
  });
}, TICK_MS);

httpServer.listen(PORT, () => {
  console.log(`Realtime server listening on port ${PORT}`);
});
