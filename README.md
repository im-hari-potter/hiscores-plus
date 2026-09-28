# Hiscores+

Hiscores for [Lost City](https://2004.lostcity.rs) (2004scape) with a **Top %** for every skill,
side-by-side compare, XP gains tracking and skill leaderboards. Made to run as a
[LostKit](https://github.com/LostHQ/LostKit-Electron) tool.

**Open it:** <https://im-hari-potter.github.io/hiscores-plus/>

![Hiscores+ lookup view](screenshot.png)

## Add it to LostKit

In LostKit, click **Add tool** and enter `im-hari-potter.github.io/hiscores-plus`.
The name and icon are filled in automatically.

## What it does

- **Lookup**: every skill with level, XP, rank, XP to the next level, and **Top %**, which is
  your rank divided by the number of players ranked in that skill. Sort the tiles by level, XP,
  rank or Top %, or drag them into your own layout.
- **Combat**: just the combat skills and your combat level, worked out with the game's own
  formula. It also shows what one skill needs for the next level, and has a what-if calculator.
- **Compare**: up to 5 players side by side, with the leader of each skill highlighted. Click a
  player's name to rank the skills by their numbers; the top 10 are marked in gold.
- **Gains**: every lookup saves a snapshot, so you can see XP, levels and ranks gained since last
  time, or since a day, a week or a month ago.
- **Leaderboard**: any skill's hiscores, 21 at a time, with Top % next to every rank.
- **Saved players**: one click to look up yourself and your friends.

Saved players and gains history stay in your own browser. **Settings** has backup and restore.

## Good to know

- A skill only shows up on the hiscores at level 15, so every skill has its own player count.
  A GitHub Action (`update-totals.mjs`) refreshes those counts twice a day.
- The hiscores API allows one request every 2 seconds, so lookups queue up politely.
- Lost City's API only lets its own website read it from a browser, and LostKit's tool tabs are
  the exception. A copy hosted on Netlify (see `_redirects`) also works in any browser.

## Development

Plain HTML, CSS and JavaScript, with no build step. `node --test` runs the unit tests.
`node mock-server.mjs` serves the site with a fake API at <http://localhost:8787/?api=local>,
and `node e2e.mjs` runs the browser tests against it (needs Playwright).

## Credits

Data comes from the Lost City hiscores API. Skill icons and RuneScape fonts are from
[LostKit](https://github.com/LostHQ/LostKit-Electron) (GPL-3.0). RuneScape is © Jagex Ltd.
This is a fan project, not affiliated with Jagex, Lost City or LostHQ. Licensed under GPL-3.0.
