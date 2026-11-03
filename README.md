# 🤥 Lieage

A bluffing trivia party game for the browser. One screen hosts the game, everyone else plays on their phone:
each question is a strange but true fact with a word missing, everyone writes a believable lie to fill the
blank, and then everyone tries to spot the real answer among the lies.

**Play:** https://josephjackman.com/games/lieage/

## The rules

- **One screen hosts.** Open Lieage on a TV, laptop or tablet that everyone can see and tap **Host a game on
  this screen**. The host screen **is the game**: it shows the join code, the questions, the answers, the
  reveal and the scores. It doesn't play.
- **Everyone else joins on their phone** with the 5-number code (or the invite link, `?room=CODE`). **2 to 10
  players.** The first player to join is the **👑 lead**: they can change the settings and start the game from
  their phone, and pause or skip during the game, so nobody has to get up and touch the laptop.
- **Settings** (host screen or lead): game length **Quick** (5 questions), **Classic** (7) or **Long** (9);
  **time to write** 45, 60, 90 or 120 seconds; **family friendly** leaves out the grown-up questions.
- A game is **round 1** (normal points), **round 2** (double points) and a **final question** (triple
  points). Quick has 2 questions in each round, Classic 3 and Long 4, plus the final question.
- **Picking a topic.** Players take turns (in join order) picking from **4 topics**, each from a different
  category. 15 seconds, then one is picked for them. Nobody picks the final question's topic.
- **Writing.** Everyone writes a lie (up to 45 characters) on their phone. Writing the real answer is refused
  ("that's actually the real answer!"); the check ignores case, punctuation, accents, a leading "the/a/his/
  their" and a plural s. Stuck? **💡 Get an idea** offers a couple of ready-made lies. A lie can be changed
  until time's up. When everyone is done, writing ends early.
- **Voting.** All the lies are mixed in with the truth, in capitals (so neat spelling doesn't give the truth
  away). Two players who wrote the same lie share one answer. With only a few players the game adds some lies of
  its own so there are at least **5 answers**. Everyone picks the one they think is true; you can't pick your
  own lie. After voting you can tap **😂** on any answer that made you laugh.
- **Scoring:** find the truth **+500**; every player who falls for your lie **+250** (shared lies score for
  each writer). ×2 in round 2, ×3 on the final question. Falling for a lie costs nothing.
- **The reveal** on the big screen goes through the lies people fell for (fewest fooled first): who fell for
  it, a LIE stamp, who wrote it and their points. Then the truth: who found it, filled into the sentence, and
  a list of the lies nobody fell for. Each phone then shows how the question went for that player.
- **The end:** the winner (ties share it), the final scores and four awards: 🎭 **Master Liar** (fooled the
  most players), 🔍 **Truth Detector** (found the truth most often), 😂 **Crowd Favourite** (most laughs) and
  🐟 **Hook, Line & Sinker** (fell for the most lies). Then **Play again** with the same players, or go back
  to the lobby.
- Players can join mid-game, and a player who drops out gets their seat and score back when they return. If
  everyone drops out, the clock stops until someone is back. The host screen can pause, skip ahead, remove a
  player, stop the game or close it (☰ menu). Keys on the host screen: **N**/space skip, **P** pause,
  **F** full screen, **M** sound.

## The questions

**480 original questions** in eight categories (60 each): Animals & Nature, History, Food & Drink, Laws &
Crime, Science & Inventions, Pop Culture, Sports & Games, Places & Words. Every one is a real, documented fact,
written for this game; each has a short teaser topic, the true answer (plus accepted spellings), three
believable house lies and a note of where the fact comes from. 8 are marked grown-up and left out in family
mode.

A host screen remembers which questions it has shown (in `localStorage`) and doesn't repeat them until it has
been through nearly all of them. A game never repeats a question.

- The questions live in `data/prompts/<category>.json`. Each entry:
  `{ "id", "topic", "q" (one _____ blank), "a", "alt": [], "d": [3 house lies], "x": 0|1, "src" }`.
- `node tools/build-prompts.mjs` checks every question (one blank, answer length, no house lie that counts as
  the truth, no duplicates) and writes `public/js/prompts.js`, which only the host screen loads. Add a
  category by adding a file and an entry in `CATS` in `public/js/looks.js`.

## How online play works

There is no game server. The host screen's browser runs the rules (`public/js/engine.js`) and owns the game;
phones connect straight to it (WebRTC) through the free public [PeerJS](https://peerjs.com) matchmaking
service. The game code is the host's PeerJS id (`jjlieage-v1-<code>`).

- **No peeking.** The host sends each phone **its own view** of the game (`engine.js` `view()`), never the
  whole game: while writing, phones don't have the real answer at all, and while voting they get the answers
  as plain text only. Which one is true, which ones the game made up and who wrote which lie only reach a phone
  once the truth has been shown.
- **Backup relay** for phones that can't connect directly (mobile data, VPNs, privacy settings; PeerJS's own
  free relay has shut down): `public/js/relay.js` carries the same messages through free public MQTT servers
  over secure websockets (the same module as Horse Race and The Deck). The host always listens there too; a
  phone switches to it if the direct connection fails or hasn't opened in 6 seconds, and switches back to
  direct later if it can. Relayed players show a 📡 RELAY tag in the lobby. Messages through the public relay
  aren't private (names, lies, votes). Add `?forcerelay` to the address to test it; `lgTrace()` in the browser
  console shows how a tab connected. Horse Race's
  [connection check](https://josephjackman.com/games/horserace/check.html) tests a phone's network.
- **The game lives on the host screen.** If the host screen reloads, it grabs its code back and carries on
  where it was (the timer doesn't lose the time it was away), and phones reconnect by themselves. If the host
  tab is closed, opening Lieage on that browser again offers **Resume game CODE** for a few hours. Phones keep
  trying to get back in for 3 minutes while the host screen is away. Unlike Horse Race, no phone ever takes
  over hosting: the host screen is the game.
- A phone that reloads goes straight back into its game with the same seat.

## Play locally

```bash
npm start
```

Open http://localhost:8094 and tap **Host a game**. To try it on one computer, open two more tabs, give each a
different name and join the code.

## Tests

```bash
npm test
```

Checks the questions file is up to date and runs `tools/test.mjs`: comparing answers, joining and leaving,
the lead player, settings, a whole question (topics, writing, refusing the truth, shared lies, house lies,
voting, laughs, the reveal, scoring), timers and pausing, a whole game with the real questions, family mode,
and that phones never see the answer early.

## Deploying

`.github/workflows/ready.yml` runs the checks on every push to `main` and then moves the `ready` branch to that
commit. The [games](https://github.com/roamingjackmans-pixel/games) repo publishes every game on
josephjackman.com/games/ and puts this one at `josephjackman.com/games/lieage/`: it looks for new `ready`
commits every 10 minutes, or starts right away when this repo has a `GAMES_DEPLOY_TOKEN` secret. That build
also stamps the version and adds `?v=<commit>` to every file URL (`tools/stamp-build.mjs`) so phones never mix
old and new code.

## Project layout

```
public/              the game (this folder is what gets published)
  index.html, css/style.css, version.js
  js/main.js         home screen, hosting, joining, getting back in after a reload
  js/screen.js       the host screen (the TV): lobby, topics, questions, the reveal, scores, the winner
  js/phone.js        a player's phone: topics, writing a lie, voting, results
  js/engine.js       the rules (host only; no page code, so it can be tested)
  js/net.js          connections: hosting, joining, reconnecting, the per-phone views
  js/relay.js        the backup relay through public MQTT servers
  js/prompts.js      the questions (generated, loaded by the host screen only)
  js/looks.js        player pictures, fallback names, categories
  js/audio.js        synthesized sound effects
  js/ui.js           small page helpers
  vendor/peerjs.min.js  PeerJS 1.5.5
data/prompts/        the questions, one file per category
tools/
  build-prompts.mjs  checks the questions and writes public/js/prompts.js
  test.mjs           rules tests
  serve.mjs          local server
  stamp-build.mjs    deploy version stamp
```
