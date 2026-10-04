/**
 * Authoritative 2D Realtime Multiplayer Tank Game Server
 * Conforms to: wss://realtime-tank-game.onrender.com
 * Max 8 players per room, 30 Hz authoritative simulation tick
 */

const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 8080;
const TICK_RATE = 30; // 30 updates per second
const TICK_INTERVAL = 1000 / TICK_RATE;

// Arena dimensions & constants
const ARENA_WIDTH = 3000;
const ARENA_HEIGHT = 3000;
const MAX_PLAYERS_PER_ROOM = 8;
const PLAYER_RADIUS = 24;
const PLAYER_SPEED = 240; // units per second
const PLAYER_MAX_HP = 100;
const FIRE_COOLDOWN = 320; // ms between shots
const BULLET_SPEED = 620;
const BULLET_RADIUS = 5;
const BULLET_LIFETIME = 1.35; // seconds
const BULLET_DAMAGE = 25;
const RESPAWN_TIME = 2.5; // seconds

// Neutral destructible objects
const NEUTRAL_COUNT = 24;
const NEUTRAL_RADIUS = 20;
const NEUTRAL_MAX_HP = 50;

// Simple obstacles
const OBSTACLES = [
  { x: 750, y: 750, w: 120, h: 120 },
  { x: 2250, y: 750, w: 120, h: 120 },
  { x: 750, y: 2250, w: 120, h: 120 },
  { x: 2250, y: 2250, w: 120, h: 120 },
  { x: 1500, y: 1500, w: 180, h: 180 },
  { x: 1500, y: 800, w: 80, h: 260 },
  { x: 1500, y: 2200, w: 80, h: 260 },
  { x: 800, y: 1500, w: 260, h: 80 },
  { x: 2200, y: 1500, w: 260, h: 80 }
];

let nextRoomId = 1;
let nextEntityId = 1;

function generateId() {
  return (nextEntityId++).toString(36);
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function sanitizeUsername(name) {
  if (typeof name !== 'string') return 'Tanker';
  const trimmed = name.trim().replace(/[<>'"&]/g, '');
  return trimmed.substring(0, 20) || 'Tanker';
}

function circleAABBOverlap(cx, cy, cr, rx, ry, rw, rh) {
  const closestX = clamp(cx, rx - rw / 2, rx + rw / 2);
  const closestY = clamp(cy, ry - rh / 2, ry + rh / 2);
  const distX = cx - closestX;
  const distY = cy - closestY;
  return distX * distX + distY * distY < cr * cr;
}

// Room Representation
class GameRoom {
  constructor(id) {
    this.id = id;
    this.players = new Map(); // id -> player
    this.projectiles = new Map(); // id -> projectile
    this.neutrals = new Map(); // id -> neutral
    this.tick = 0;
    this.events = [];
    this.initNeutrals();
  }

  initNeutrals() {
    for (let i = 0; i < NEUTRAL_COUNT; i++) {
      this.spawnNeutral();
    }
  }

  spawnNeutral() {
    const id = generateId();
    let x, y, safe;
    let attempts = 0;
    do {
      safe = true;
      x = 100 + Math.random() * (ARENA_WIDTH - 200);
      y = 100 + Math.random() * (ARENA_HEIGHT - 200);
      for (const obs of OBSTACLES) {
        if (circleAABBOverlap(x, y, NEUTRAL_RADIUS + 20, obs.x, obs.y, obs.w, obs.h)) {
          safe = false;
          break;
        }
      }
      attempts++;
    } while (!safe && attempts < 25);

    this.neutrals.set(id, {
      id,
      x: Math.round(x),
      y: Math.round(y),
      hp: NEUTRAL_MAX_HP,
      maxHp: NEUTRAL_MAX_HP
    });
  }

  getSafeSpawn() {
    let x, y, safe;
    let attempts = 0;
    do {
      safe = true;
      x = 120 + Math.random() * (ARENA_WIDTH - 240);
      y = 120 + Math.random() * (ARENA_HEIGHT - 240);
      for (const obs of OBSTACLES) {
        if (circleAABBOverlap(x, y, PLAYER_RADIUS + 30, obs.x, obs.y, obs.w, obs.h)) {
          safe = false;
          break;
        }
      }
      if (safe) {
        for (const p of this.players.values()) {
          if (!p.dead) {
            const dx = p.x - x;
            const dy = p.y - y;
            if (dx * dx + dy * dy < 250 * 250) {
              safe = false;
              break;
            }
          }
        }
      }
      attempts++;
    } while (!safe && attempts < 40);

    return { x: Math.round(x), y: Math.round(y) };
  }

  addPlayer(socket, username) {
    const id = generateId();
    const spawn = this.getSafeSpawn();
    const player = {
      id,
      socket,
      name: sanitizeUsername(username),
      x: spawn.x,
      y: spawn.y,
      vx: 0,
      vy: 0,
      aimAngle: 0,
      hp: PLAYER_MAX_HP,
      maxHp: PLAYER_MAX_HP,
      dead: false,
      respawnTimer: 0,
      lastShotTime: 0,
      lastProcessedInput: 0,
      inputQueue: []
    };
    this.players.set(id, player);
    socket.playerId = id;
    socket.roomId = this.id;

    socket.send(JSON.stringify({
      t: 'joined',
      roomId: this.id,
      id: id,
      arena: {
        width: ARENA_WIDTH,
        height: ARENA_HEIGHT,
        obstacles: OBSTACLES,
        neutrals: Array.from(this.neutrals.values())
      }
    }));

    return player;
  }

  removePlayer(playerId) {
    this.players.delete(playerId);
  }

  handleInput(playerId, data) {
    const player = this.players.get(playerId);
    if (!player || player.dead) return;

    const seq = Number(data.seq) || 0;
    const moveX = clamp(Number(data.moveX) || 0, -1, 1);
    const moveY = clamp(Number(data.moveY) || 0, -1, 1);
    const aimAngle = Number(data.aimAngle) || 0;
    const shoot = Boolean(data.shoot);

    player.inputQueue.push({ seq, moveX, moveY, aimAngle, shoot, time: Date.now() });
  }

  update(dt) {
    this.tick++;
    const now = Date.now();

    // 1. Process Players
    for (const player of this.players.values()) {
      if (player.dead) {
        player.respawnTimer -= dt;
        if (player.respawnTimer <= 0) {
          const spawn = this.getSafeSpawn();
          player.dead = false;
          player.hp = PLAYER_MAX_HP;
          player.x = spawn.x;
          player.y = spawn.y;
          player.inputQueue = [];
        }
        continue;
      }

      // Process input queue
      let shootRequested = false;
      while (player.inputQueue.length > 0) {
        const input = player.inputQueue.shift();
        player.lastProcessedInput = input.seq;
        player.aimAngle = input.aimAngle;
        if (input.shoot) shootRequested = true;

        // Normalize movement vector
        let mx = input.moveX;
        let my = input.moveY;
        const mag = Math.hypot(mx, my);
        if (mag > 1) {
          mx /= mag;
          my /= mag;
        }

        const nextX = player.x + mx * PLAYER_SPEED * dt;
        const nextY = player.y + my * PLAYER_SPEED * dt;

        // Arena boundary collision
        const clampedX = clamp(nextX, PLAYER_RADIUS, ARENA_WIDTH - PLAYER_RADIUS);
        const clampedY = clamp(nextY, PLAYER_RADIUS, ARENA_HEIGHT - PLAYER_RADIUS);

        // Obstacle collision
        let collideX = false;
        let collideY = false;

        for (const obs of OBSTACLES) {
          if (circleAABBOverlap(clampedX, player.y, PLAYER_RADIUS, obs.x, obs.y, obs.w, obs.h)) {
            collideX = true;
          }
          if (circleAABBOverlap(player.x, clampedY, PLAYER_RADIUS, obs.x, obs.y, obs.w, obs.h)) {
            collideY = true;
          }
        }

        if (!collideX) player.x = clampedX;
        if (!collideY) player.y = clampedY;
      }

      // Shoot validation
      if (shootRequested && now - player.lastShotTime >= FIRE_COOLDOWN) {
        player.lastShotTime = now;
        const projId = generateId();
        const spawnDist = PLAYER_RADIUS + 10;
        const bx = player.x + Math.cos(player.aimAngle) * spawnDist;
        const by = player.y + Math.sin(player.aimAngle) * spawnDist;

        this.projectiles.set(projId, {
          id: projId,
          ownerId: player.id,
          x: bx,
          y: by,
          vx: Math.cos(player.aimAngle) * BULLET_SPEED,
          vy: Math.sin(player.aimAngle) * BULLET_SPEED,
          radius: BULLET_RADIUS,
          life: BULLET_LIFETIME
        });

        this.events.push({
          t: 'shot',
          x: Math.round(bx),
          y: Math.round(by),
          angle: Number(player.aimAngle.toFixed(3))
        });
      }
    }

    // 2. Process Projectiles
    for (const [projId, proj] of this.projectiles.entries()) {
      proj.x += proj.vx * dt;
      proj.y += proj.vy * dt;
      proj.life -= dt;

      let destroyed = false;

      // Arena boundary collision
      if (
        proj.x < 0 || proj.x > ARENA_WIDTH ||
        proj.y < 0 || proj.y > ARENA_HEIGHT ||
        proj.life <= 0
      ) {
        destroyed = true;
      }

      // Obstacle collision
      if (!destroyed) {
        for (const obs of OBSTACLES) {
          if (circleAABBOverlap(proj.x, proj.y, proj.radius, obs.x, obs.y, obs.w, obs.h)) {
            destroyed = true;
            this.events.push({ t: 'hit', x: Math.round(proj.x), y: Math.round(proj.y) });
            break;
          }
        }
      }

      // Neutral objects collision
      if (!destroyed) {
        for (const [nid, neutral] of this.neutrals.entries()) {
          const dx = proj.x - neutral.x;
          const dy = proj.y - neutral.y;
          if (dx * dx + dy * dy <= (proj.radius + NEUTRAL_RADIUS) ** 2) {
            destroyed = true;
            neutral.hp -= BULLET_DAMAGE;
            this.events.push({ t: 'hit', x: Math.round(proj.x), y: Math.round(proj.y) });

            if (neutral.hp <= 0) {
              this.events.push({ t: 'n_die', id: nid, x: neutral.x, y: neutral.y });
              this.neutrals.delete(nid);
              setTimeout(() => {
                if (this.players.size > 0) this.spawnNeutral();
              }, 4000);
            }
            break;
          }
        }
      }

      // Player collision
      if (!destroyed) {
        for (const target of this.players.values()) {
          if (target.dead || target.id === proj.ownerId) continue;
          const dx = proj.x - target.x;
          const dy = proj.y - target.y;
          if (dx * dx + dy * dy <= (proj.radius + PLAYER_RADIUS) ** 2) {
            destroyed = true;
            target.hp = Math.max(0, target.hp - BULLET_DAMAGE);
            this.events.push({ t: 'hit', x: Math.round(proj.x), y: Math.round(proj.y) });

            if (target.hp <= 0) {
              target.dead = true;
              target.respawnTimer = RESPAWN_TIME;
              this.events.push({
                t: 'die',
                id: target.id,
                x: Math.round(target.x),
                y: Math.round(target.y)
              });
            }
            break;
          }
        }
      }

      if (destroyed) {
        this.projectiles.delete(projId);
      }
    }

    // 3. Broadcast Snapshot
    this.broadcastState();
  }

  broadcastState() {
    if (this.players.size === 0) return;

    const playersData = [];
    for (const p of this.players.values()) {
      playersData.push({
        id: p.id,
        name: p.name,
        x: Math.round(p.x * 10) / 10,
        y: Math.round(p.y * 10) / 10,
        a: Math.round(p.aimAngle * 100) / 100,
        hp: p.hp,
        dead: p.dead
      });
    }

    const projectilesData = [];
    for (const pr of this.projectiles.values()) {
      projectilesData.push({
        id: pr.id,
        x: Math.round(pr.x * 10) / 10,
        y: Math.round(pr.y * 10) / 10
      });
    }

    const neutralsData = [];
    for (const n of this.neutrals.values()) {
      neutralsData.push({
        id: n.id,
        x: n.x,
        y: n.y,
        hp: n.hp
      });
    }

    for (const player of this.players.values()) {
      if (player.socket.readyState === WebSocket.OPEN) {
        const payload = JSON.stringify({
          t: 'state',
          tick: this.tick,
          ack: player.lastProcessedInput,
          players: playersData,
          projectiles: projectilesData,
          neutrals: neutralsData,
          events: this.events
        });
        player.socket.send(payload);
      }
    }

    this.events = [];
  }
}

// Matchmaker and Room Manager
const rooms = new Map();

function findOrCreateRoom() {
  for (const room of rooms.values()) {
    if (room.players.size < MAX_PLAYERS_PER_ROOM) {
      return room;
    }
  }
  const newId = 'room_' + nextRoomId++;
  const newRoom = new GameRoom(newId);
  rooms.set(newId, newRoom);
  return newRoom;
}

// Global server game loop
setInterval(() => {
  const dt = TICK_INTERVAL / 1000;
  for (const [roomId, room] of rooms.entries()) {
    if (room.players.size === 0) {
      rooms.delete(roomId);
      continue;
    }
    room.update(dt);
  }
}, TICK_INTERVAL);

// HTTP & WebSocket Server Setup
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Authoritative 2D Realtime Tank Server Running');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.isAlive = true;

  ws.on('message', (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch {
      return;
    }

    switch (data.t) {
      case 'ping':
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ t: 'pong', id: data.id }));
        }
        break;

      case 'join': {
        if (ws.roomId && rooms.has(ws.roomId)) {
          rooms.get(ws.roomId).removePlayer(ws.playerId);
        }
        const room = findOrCreateRoom();
        room.addPlayer(ws, data.name);
        break;
      }

      case 'input': {
        if (ws.roomId && rooms.has(ws.roomId)) {
          rooms.get(ws.roomId).handleInput(ws.playerId, data);
        }
        break;
      }

      case 'leave': {
        if (ws.roomId && rooms.has(ws.roomId)) {
          const room = rooms.get(ws.roomId);
          room.removePlayer(ws.playerId);
          if (room.players.size === 0) {
            rooms.delete(ws.roomId);
          }
          ws.roomId = null;
          ws.playerId = null;
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ t: 'left' }));
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    if (ws.roomId && rooms.has(ws.roomId)) {
      const room = rooms.get(ws.roomId);
      room.removePlayer(ws.playerId);
      if (room.players.size === 0) {
        rooms.delete(ws.roomId);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Authoritative Tank Server listening on port ${PORT}`);
});