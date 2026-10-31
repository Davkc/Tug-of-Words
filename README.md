# Tug of Words

A fast, browser based word tug-of-war for 2–8 players. The server owns room membership, team assignment, word checks, scores, freezes, timers, and winners. The client is plain HTML, CSS, and JavaScript; Express serves it and `ws` handles real-time play.

## Project files

```text
tug-of-words/
├── public/
│   ├── app.js       # Browser UI, WebSocket client, sound and effects
│   ├── index.html   # Single-page game
│   └── style.css    # Responsive visual design
├── .gitignore
├── package.json
├── render.yaml      # One-click Render Blueprint
├── server.js        # Authoritative game server and room state
└── README.md
```

## Run locally

Requires Node.js 20 or newer.

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000). To play a multiplayer round, open the page in two or more browsers/devices, create a room, then share the room code or invite link. Use “Practice vs bots” for a solo demo. The server listens on `PORT` when provided by a host and otherwise uses port 3000.

## Deploy free on Render

The included `render.yaml` is a Render Blueprint for a Node web service. It serves the page and WebSocket endpoint from one host, so no separate frontend deployment or CORS setup is needed.

1. Push this folder to a GitHub repository.
2. In Render, choose **New → Blueprint**, connect the repository, and apply the `tug-of-words` service. Or choose **New → Web Service** and set runtime to Node, build command to `npm install`, and start command to `npm start`.
3. Choose the **Free** instance plan and wait for the deploy to finish.
4. Open the generated `https://…onrender.com` URL and share an invite link from a created lobby.

Render’s free web service can go to sleep after 15 minutes without inbound traffic and may take about a minute to wake. Rooms live in server memory, so a restart or deploy clears active rooms. Free instances are best for hobby play and demos; [Render's free service limits](https://render.com/docs/free) explain the current constraints. Render supports public WebSocket connections; see its [WebSocket deployment guide](https://render.com/docs/websocket).

For another Node host, use the same `npm install` and `npm start` commands, set `PORT` if required, and ensure the host supports long lived WebSocket connections. Set `PUBLIC_URL=https://your-domain` if the host’s forwarded host headers don’t produce the desired invite URL.

## How play works

- Rooms use four character codes, invite URLs, up to eight players, automatic team balancing, ready-up, and team swaps.
- The host starts once all human players are ready and both teams have at least one player. In practice mode, three server-controlled bots fill the room.
- Correct words pull the rope. Longer words and a small set of rare words score more. A five-word streak unlocks a one-use, two-second enemy freeze.
- Each round lasts 90 seconds. Pull the flag across the line to win immediately; otherwise the higher team score wins when time runs out. Every 30 seconds, a 10-second event changes the typing challenge.
- Each player receives only their own team’s current word. The server validates every submission, applies scoring and cooldowns, and decides the winner.
- Clients send word submissions without trusted client timestamps. The server timestamps accepted pulls and sends a fresh authoritative snapshot every 250 ms during a round; periodic ping messages provide a latency estimate without letting clients alter the clock or score.
- Results show the MVP and each human player’s points, correct words, and best streak. Rematches return the room to the lobby.
- If a player disconnects, they leave the room. If that empties a team, an active multiplayer round pauses back to the lobby. The host role moves to another player if the host leaves. An empty room is removed.

## Test checklist

- [ ] Create a room; confirm the room code and copyable invite URL work in another browser.
- [ ] Join by code and by invite link; confirm new players are assigned to the smaller team.
- [ ] Try to swap teams when it would make the sides differ by more than one; confirm the swap is declined.
- [ ] Ready up as all players; confirm only the host can start and an unready player blocks the start.
- [ ] Submit a wrong word and the correct word; confirm only the correct word changes the rope and score.
- [ ] Confirm a player cannot see the opposing team’s word in the browser state/UI.
- [ ] Build a five-word streak, activate Freeze, and confirm the opposing team cannot score for two seconds; confirm it can only be used once.
- [ ] Wait for both 30-second events; test reversed words and the next event; confirm the banner clears afterward.
- [ ] Reach the flag line, then separately let the timer expire; confirm the correct win condition and results stats.
- [ ] Test mobile width, sound mute, confetti, and a rematch.
- [ ] Run Practice vs bots and confirm bot scores, freeze interactions, and round results work.
- [ ] Disconnect the host, disconnect a player who empties a team, and leave the room empty; confirm host reassignment, pause, and cleanup.
- [ ] On Render, test first-load wake-up, multiple browser clients, invite URLs, and reconnect behavior after a redeploy.
