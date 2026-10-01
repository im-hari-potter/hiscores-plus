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

The planner works out what it takes to reach a goal, from your XP on the hiscores, what's in your bank
and the prices you set. Any skill can have a goal. A skill with its full planner (marked with a dot
when you add a goal) also gets a plan: so far **Herblore**, **Runecraft**, **Woodcutting**,
**Firemaking** and **Fletching**, with the other skills to follow.

- **Goals**: set a **level, XP, rank or top %** goal in any skill. Your XP comes from the hiscores.
  - Move goals up and down to put them in your own order. Show only the ones in progress or reached,
    or only one skill.
  - A rank or top % goal becomes "beat whoever holds that rank now", and it re-checks as they train.

#### How the calculators work

- Every number comes from the game itself (Lost City's server content): the level each way to train
  needs, the XP it gives, and what it takes and makes. The maths is done in tenths of XP, like the
  game does.
- How many you need = the XP still to go ÷ the XP each one gives, rounded up.
- **Gross** is what something is worth, with nothing taken off. **Net** takes off what you pay for its
  supplies, so it can be negative: a loss.
- A plan has three parts:
  1. **From your bank**: what the items in your bank make, best XP first (the one you train with goes
     first when it can), including steps on the way like unfinished potions. Each step shows what it
     makes is worth, and the total is its **Gross**.
  2. **Then, to reach your goal**: the rest, made the way you pick under **Train with**. If you're
     short of levels for it, the plan works up to it with the best one at each level on the way
     (willows to 45, maples to 60, then yews). Below that: what to collect or buy, what to bring, what
     buying it all costs, what it makes is worth, and the net.
  3. **Every option**: one row for each way to train, side by side (see the table below). Click a row
     to train with it.
- Per skill:
  - Runecraft counts in essence, and shows how many runes each essence makes at your level (×2, ×3…).
  - Woodcutting needs nothing but an axe, so its plan is the logs to chop and what they're worth.
  - Firemaking burns the logs in your bank, best first.
  - Fletching has every way to train: bows cut and strung (or only cut, or only strung), arrows from
    logs or step by step, darts, and bolts. The table shows one of those at a time.
- Click an item a plan says to collect, buy or bring to open its page on the market.

#### Check your prices first

Costs, gross, net and gp per XP are only as good as the prices behind them. Market prices come from what
players have listed and sold lately, and some items have few listings or none. **Look over the Prices
tab for the items you'll use, and pick or type the price that's right for you** (see Prices below).
Anything without a price shows **?** until it has one.

#### Use my bank

- **On** (the default): your bank is put to work first.
  - **From your bank** lists what it makes and what each part is worth. The total is **Gross**:
    your banked supplies are already yours, so nothing is taken off for them.
  - Everything after it comes after all your bank makes: its XP counts toward the goal, and what's left
    in your bank is used before anything is collected.
- **Off**: the plan starts from scratch, as if your bank were empty. Plan a mix of your own instead
  (below), or let one way to train take you all the way.

#### Plan a mix (Use my bank off)

With your bank left out, you can plan your own path to the goal: type how many of each you'll make in
the table's **Plan to make** column (1,000 prayer potions, then 2,000 super attacks, say).

- **Your mix** shows what that comes to: the XP and the level it gets you to, what buying it all costs,
  what it makes is worth, and the net. It's made lowest level first, and anything that needs a level
  you won't have by then is marked.
- Its XP counts toward your goal. The rest is planned after it (**Then, to reach your goal**), with a
  total for both together, and the table shows **Still needed to goal** after your mix.
- The mix is kept with the goal. With **Use my bank** on, your actual bank is used instead, and the mix
  waits until you turn it off again. Skills that never use the bank (Woodcutting) can always have one.

#### The table of every option

| Column | Use my bank on | Use my bank off |
|---|---|---|
| **Use** (first) | Lets the bank plan make it (see below) | the same |
| **XP** | XP for one | the same |
| **Net/item** | What one sells for, less what it takes, bought from scratch | the same |
| **gp/XP** | What each XP costs you (negative: you make money doing it) | the same |
| **To goal** | not shown | How many to reach the goal, on their own |
| **Plan to make** | not shown | How many you'll make in your mix (see above) |
| **From bank** | How many your bank makes of it now | not shown |
| **Gross from banked supplies** | What your bank plan makes of it (its part of From your bank) is worth, before any evening out. Your banked supplies are yours already | not shown |
| **Even out** | What to collect so nothing in your bank is left over: your most plentiful ingredient decides | not shown |
| **Net after even out** | What your bank makes of it once evened out is worth, less what evening out takes to collect. Your banked supplies are yours already. Shown with Even out | not shown |
| **Still needed to goal** | How many more to reach your goal, after everything your bank makes | After your mix, once you've planned one |
| **Supplies needed** | What those take, beyond what's left in your bank | not shown |
| **Net after buying supplies** | What the ones still needed are worth, less what their supplies cost | not shown |
| **Total net gp toward goal** | Gross from banked supplies + net after buying supplies: the gp it all comes to on the way to your goal, from your bank and from what you still buy. Net after even out isn't part of it, since evening out would count those supplies twice | not shown |

Sort the table by level, XP each, cheapest XP, or (with your bank in use) **Total net**, most gp toward
your goal first.

For example, Herblore 74 → 78 with Super attack: with the bank off, **4,328** to the goal. With it on,
**2,305** still needed after everything the bank makes, and the supplies those need. And with
605 kwuarm and 518 limpwurt root in the bank, Super strength's **Even out** says collect 87 limpwurt
root, and your bank covers 605 instead of 518.

#### Untick what you won't make

The **Use** boxes at the front of each row decide what the bank plan may make. It makes everything it can
by default, so **turn off anything you don't plan to make**: a potion you'd rather not, or one whose
supplies you're saving. Otherwise the plan spends your supplies on it, and From your bank, Still needed to
goal and the gp totals count XP you won't get. Unticked options also leave the Train with list.

#### Vials of water

**I'll buy vials of water as I go** is on by default for Herblore: vials never hold a plan back, and
they're left out of the supplies needed and of every cost and net. Turn it off to plan around the
vials in your bank and count them like any other supply.

- **Bank**: type in what you have (`1500`, `1.5k` and `2m` all work), one tab per skill. Each account has
  its own bank, and the tabs share it (logs count for Firemaking and Fletching alike).
  - **All** shows everything you have and what your whole bank is worth, in the order your bank has
    in-game (once you've read it from screenshots). Drag items into your own order, or show the most
    valuable first. A skill's tab shows only its items and what they're worth; every tab shows its value.
  - Click an item's name to open its page on the market.
  - **Read it from screenshots**: open your bank in LostKit, press the screenshot key (scroll and take
    more if it doesn't fit), then drop the pictures from *Pictures › LostKit Screenshots* on the Bank
    tab, paste one, or choose them. You see what was read before anything changes, and only the
    ticked items are updated.
    - **Choose screenshots** opens in the folder you last picked from. The very first time it opens
      in Pictures (a web page can't name a folder itself), so open *LostKit Screenshots* once.
    - It reads the picture the way the game drew it: the scrollbar says where the bank is and how far
      it's scrolled, icon outlines and colours say which item is in each slot, and the yellow numbers
      say how many. Screenshots that overlap don't count twice.
    - Amounts of 100K and up are rounded on screen (`150K`). If the amount you entered fits, it's kept;
      otherwise the low end is used.
    - Lantadyme looks exactly like an unid herb in this version, so it's read as one.
    - Items cut off at the top or bottom edge of the bank are skipped, so let screenshots overlap.
    - Where each item sits is kept too, for All. If you've dragged items around since, you can choose
      to put them back in your bank's order.
  - With no method picked, the bank plan finds the order that gets the most XP out of what you have
    (rune dart tips get your feathers before bronze arrows do).
  - Unidentified herbs are one "Unid herb" entry, because in-game they're all a plain "Herb". They count
    toward the bank's value, priced from the market's unid listing. Plans leave them out until you
    identify them.
- **Prices**: pick the price each item uses, and it sticks. Check them before trusting a plan's money.
  - **Market**, the default, comes from player listings on
    [markets.lostcity.rs](https://markets.lostcity.rs): the median of recent sales, otherwise of open
    offers. If the market has nothing for an item, its high alch value is used. A 3-dose potion with no
    trades of its own is priced at ¾ of the 4-dose.
  - **High alch** is what High Level Alchemy gives for it: 3/5 of its value, the game's own sum.
  - **Your price**: type one in and it's used until you pick another or clear it.
  - Switch a whole skill or one list at once (high alch for Fletching, say, then logs back to the
    market). That leaves prices you typed in be.
  - Bank values, gross, net and gp per XP all use the price each item has.
  - Market prices are checked one at a time and kept for 12 hours.
  - Click an item on the Prices, Goals or Bank tab to open its page on the market. Inside LostKit it
    opens right in the tool's tab, and LostKit's ◀ button brings you back.

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
- The numbers are the game's own (Lost City's server content), so a few may surprise you: achey tree
  logs give no Firemaking XP in this version, and any axe can be used at any Woodcutting level.

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
  - `prices-core.js` and `prices.js` handle the market (and high alch).
  - `sortable.js` drags things into a new order: the Lookup tiles and the bank's All view.
  - `bankread.js` reads a bank screenshot. It loads only when used, along with `bankread-data.js` and
    `bankicons.png`, which `build-data.mjs` also generates (bank layout, the p11 font and the icons to
    compare with). The tests paint pretend screenshots with `bankfake.mjs`.

## Credits

- Hiscores come from the Lost City hiscores API.
- Levels and XP for the planner, and the bank layout and font the screenshot reader uses, come from
  Lost City's server content and client (MIT).
- Item names and icons come from [LostHQ](https://2004.losthq.rs) (GPL-3.0).
- Prices come from [markets.lostcity.rs](https://markets.lostcity.rs). How they're read follows
  LostKit's own price check.
- Skill icons and RuneScape fonts come from [LostKit](https://github.com/LostHQ/LostKit-Electron)
  (GPL-3.0).
- RuneScape is © Jagex Ltd.

This is a fan project, not affiliated with Jagex, Lost City or LostHQ. Licensed under GPL-3.0.
