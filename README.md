# Hiscores+ for Lost City (2004scape)

A hiscores tool for [Lost City](https://2004.lostcity.rs), built to live inside
[LostKit](https://github.com/LostHQ/LostKit-Electron) as a custom tool.

- **Lookup**: every skill, laid out like LostKit's own hiscores panel, plus
  **Top %** for each skill: your rank ÷ the number of players ranked in that skill.
- **Combat filter**: just the 7 combat skills, the combat level worked out with the
  game's own formula, what one skill needs to reach the next level, and a what-if calculator.
- **Compare**: up to 5 players side by side, with the leader of each skill highlighted.
- **Gains**: every lookup saves a snapshot, so you can see XP, levels and rank gained
  since the last lookup, a day ago, a week ago and so on.
- **Leaderboard**: browse any skill's hiscores 21 at a time, with Top % next to every rank.
- **Saved players**: star players for one-click lookups.

## Setting it up (no installs needed)

1. **Make a GitHub account** at <https://github.com/signup> (free).
2. **Create a repository**: the **+** at the top right, then **New repository**. Name it
   `hiscores-plus`, choose **Public**, and click **Create repository**.
3. **Turn on Pages**: in the new repository, go to **Settings → Pages**. Under
   *Build and deployment → Source*, pick **GitHub Actions**.
4. **Upload the files**: go back to the **Code** tab and click **uploading an existing file**.
   Open the unzipped `hiscores-plus` folder, select everything inside it (Ctrl+A), and drag it
   onto the page. Include the `.github` folder. Then click **Commit changes**.
5. **Wait about a minute**: the **Actions** tab shows a run called
   *Publish site and update player counts*. When it has a green tick, the site is live at
   `https://YOUR-USERNAME.github.io/hiscores-plus/` (also shown under **Settings → Pages**).
6. **Start the player counts**: **Actions → Publish site and update player counts →
   Run workflow → Run workflow**. From then on this runs twice a day on its own.
7. **Add it to LostKit**: **Add tool**. For the address, use `YOUR-USERNAME.github.io/hiscores-plus`,
   then click **Add tool**. The name (*Hiscores+*) and icon are picked up automatically.

It only works inside LostKit. The hiscores API only answers requests from Lost City's
own website, and LostKit's tool tabs are allowed through while a normal browser tab isn't.

If the Actions tab doesn't list the workflow in step 5, the `.github` folder didn't upload.
Use **Add file → Create new file**, type `.github/workflows/pages.yml` as the name, paste in
the contents of that file from the zip, and commit.

## How Top % is worked out

The API has no "how many players" number, so the tool finds the last ranked player
itself. Asking for a rank past the end returns an empty page, and a page that
comes back short contains the last player. That turns it into a quick binary search
instead of reading every page. With last time's count as the starting point, it
usually takes one request per skill.

A skill only gets a hiscores entry at **level 15**, so each skill has its own count.
Overall counts every ranked account.

The API allows **one request every 2 seconds** for your whole connection, so:

- The counting is done by the GitHub job (`scripts/update-totals.mjs`) twice a day and
  shared through `data/totals.json`. Every player count in `data/totals-history.csv` is kept,
  so you also get a record of how the player base grows.
- If the job stops running, the page re-counts anything older than a day and a half
  itself, in the background, behind anything you click on.
- All lookups go through one queue that follows the API's own rate-limit headers. Several
  open copies of the tool take turns.

## Your data

Saved players, snapshots and settings live in LostKit's browser storage on your PC,
and nothing is sent anywhere else. **Settings → Copy backup / Download backup** makes a
backup, and **Restore** puts one back.

## Updating

Upload the changed files the same way (**Add file → Upload files**) and commit.
The site republishes itself in about a minute.

## Development

Plain HTML, CSS and JavaScript modules, with no build step. With Node 18+:

```sh
node --test test/                          # unit tests: totals search, XP table, combat formula
RATE_MS=300 node test/mock-server.mjs      # fake API + the site on http://localhost:8787
# then open http://localhost:8787/?api=local  (or run the browser tests: node test/e2e.mjs, needs Playwright)
```

## Credits

- Hiscores data: the [Lost City hiscores API](https://2004.lostcity.rs/news/199).
- Skill icons and RuneScape fonts come from [LostKit](https://github.com/LostHQ/LostKit-Electron)
  (GPL-3.0). RuneScape and its artwork are © Jagex Ltd. This is a fan project and is not
  affiliated with Jagex, Lost City or LostHQ.
- Licensed under the GPL-3.0 (see `LICENSE`).
