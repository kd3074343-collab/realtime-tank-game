# Realtime Tank Backend

A minimal Node.js + WebSocket backend for a browser-based realtime multiplayer tank game.

## Files

- `server.js` — HTTP health endpoint + WebSocket server + basic authoritative movement
- `package.json` — Node.js project configuration
- `README.md` — setup instructions

## Run locally

Requirements:

- Node.js 18 or newer

Commands:

```bash
npm install
npm start
```

The server listens on:

```text
http://localhost:3000
```

WebSocket endpoint:

```text
ws://localhost:3000
```

## Current protocol

### Server → client

`welcome`

Contains the player's ID, server tick rate, and the players currently connected.

`playerJoined`

Sent when another player joins.

`playerLeft`

Sent when another player disconnects.

`state`

Sent at the server tick rate with authoritative player positions.

`pong`

Response to a client ping.

### Client → server

`input`

Example:

```json
{
  "type": "input",
  "up": true,
  "down": false,
  "left": false,
  "right": true,
  "angle": 1.57
}
```

`ping`

Example:

```json
{
  "type": "ping",
  "clientTime": 1760000000000
}
```

`setName`

Example:

```json
{
  "type": "setName",
  "name": "Player"
}
```

## Important

This is intentionally only the realtime backend foundation.

It does NOT yet implement:

- bullets
- damage
- health
- XP
- leveling
- upgrades
- kills
- matchmaking
- accounts
- persistent storage
- anti-cheat
- advanced lag compensation

Those should be added after the basic connection and synchronization are working.

## Deployment

Deploy this Node.js project to a hosting provider that supports long-lived WebSocket connections.

Set the start command to:

```text
npm start
```

The server automatically uses the hosting provider's `PORT` environment variable.

After deployment, your browser client should connect using the provider's secure WebSocket URL:

```text
wss://YOUR-SERVER-DOMAIN
```

Do not hard-code a development `ws://localhost:3000` URL into the production game.

## Security note

The server is authoritative for the basic movement state, but this is still an early prototype. Before a public game launch, add stronger input validation, rate limiting, room management, authentication if needed, and authoritative combat/gameplay validation.
