# Skills+

Hiscores and a goal planner for [Lost City](https://2004.lostcity.rs) (2004scape), made to run as a
[LostKit](https://github.com/LostHQ/LostKit-Electron) tool. Formerly Hiscores+.

**Open it:** <https://im-hari-potter.github.io/hiscores-plus/>

![Skills+ lookup view](screenshot.png)

## Add it to LostKit

In LostKit, click **Add tool** and enter `im-hari-potter.github.io/hiscores-plus`. The name and icon
are filled in automatically. If you added it back when it was called Hiscores+, rename the tool in
LostKit, or remove it and add it again. Your saved data stays either way.

## What it does

### Hiscores

- **Lookup** shows every skill's level, XP, rank, XP to the next level, and **Top %**. Top % is your rank
  divided by the number of players ranked in that skill.
  - Sort the tiles by level, XP, rank or Top %, or drag them into your own layout.
  - Tiles show your goals once you set some.
- **Combat** shows only the combat skills and your combat level, worked out with the game's own formula.
- **Compare** puts up to 5 players side by side and highlights the leader of each skill.
- **Gains** shows XP, levels and ranks gained since last time, a day, a week or a month ago.
- **Leaderboard** shows any skill's hiscores, 21 at a time, with Top % next to every rank.

### Planner

- **Goals**: set a **level, XP, rank or top %** goal in any skill. Your XP comes from the hiscores.
  - Move goals up and down to put them in your own order. Show only the ones in progress or reached,
    or only one skill.
  - A rank or top % goal becomes "beat whoever holds that rank now", and it re-checks as they train.
  - **Herblore** and **Runecraft** have the full planner so far; the other skills follow in later updates.
    Runecraft counts in essence, and shows how many runes each essence makes at your level (×2, ×3…).
  - For Herblore, the planner shows:
    - what your bank already makes, best XP first, including unfinished potions;
    - how many potions are left after that, with the method you pick;
    - what to collect or buy, and a tip when your ingredients don't pair up (e.g. "collect 300 snape
      grass and your bank makes 1,000 prayer potions instead of 700");
    - every potion side by side: how many to the goal, how many your bank covers, profit per potion,
      and gp per XP.
- **Bank**: type in what you have (`1500`, `1.5k` and `2m` all work), one tab per skill. Each account has
  its own bank.
  The bank's value is shown with market prices.
  - Unidentified herbs are one "Unid herb" entry, because in-game they're all a plain "Herb". They count
    toward the bank's value, priced from the market's unid listing. Plans leave them out until you
    identify them.
- **Prices** come from player listings on [markets.lostcity.rs](https://markets.lostcity.rs).
  - A price is the median of recent sales. Items with no sales use open offers, and if nobody trades
    an item, its shop value is used.
  - A 3-dose potion with no trades of its own is priced at ¾ of the 4-dose.
  - Type your own price to override any of them.
  - Items are checked one at a time and kept for 12 hours.

Saved players, gains history, goals and banks stay in your own browser. **Settings** has backup and
restore.

## Good to know

- A skill only shows up on the hiscores at level 15, so every skill has its own player count. A GitHub
  Action (`update-totals.mjs`) refreshes those counts twice a day.
- The hiscores API allows one request every 2 seconds, so lookups queue up politely.
- Lost City's API only lets its own website read it from a browser; LostKit's tool tabs are the
  exception. A copy hosted on Netlify (see `_redirects`) also works in any browser.
- The market's sale history can also only be read inside LostKit. A normal browser gets open offers
  from the market's JSON API.

## Development

Plain HTML, CSS and JavaScript, with no build step for the site.

- `node --test` runs the unit tests.
- `node mock-server.mjs` serves the site with a fake hiscores API and a fake market at
  <http://localhost:8787/?api=local>. `node e2e.mjs` then runs the browser tests against it (needs
  Playwright).
- The skill data in `gamedata.js` and the icons in `items.png` are generated. To regenerate them, run
  `node build-data.mjs <Content checkout> <LostHQ 2004 checkout>` (needs `sharp`).
  - Content is [LostCityRS/Content](https://github.com/LostCityRS/Content), branch 274.
  - The LostHQ checkout is [LostHQ/2004](https://github.com/LostHQ/2004).
- Planner files:
  - `planner.js` holds the maths, all in tenths of XP like the game.
  - `planner-ui.js` builds the Goals, Bank and Prices views.
  - `prices-core.js` and `prices.js` handle the market.

## Credits

- Hiscores come from the Lost City hiscores API.
- Levels and XP for the planner come from Lost City's server content (MIT).
- Item names and icons come from [LostHQ](https://2004.losthq.rs) (GPL-3.0).
- Prices come from [markets.lostcity.rs](https://markets.lostcity.rs). How they're read follows
  LostKit's own price check.
- Skill icons and RuneScape fonts come from [LostKit](https://github.com/LostHQ/LostKit-Electron)
  (GPL-3.0).
- RuneScape is © Jagex Ltd.

This is a fan project, not affiliated with Jagex, Lost City or LostHQ. Licensed under GPL-3.0.
