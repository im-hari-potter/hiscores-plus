# Hiscores+ for Lost City (2004scape)

A hiscores tool for [Lost City](https://2004.lostcity.rs), built to live inside
[LostKit](https://github.com/LostHQ/LostKit-Electron) as a custom tool.

- **Lookup**: every skill, laid out like LostKit's own hiscores panel, plus
  **Top %** for each skill: your rank ÷ the number of players ranked in that skill.
  Drag the tiles into any order you like (**Reset layout** puts them back).
- **Combat filter**: just the 7 combat skills, the combat level worked out with the
  game's own formula, what one skill needs to reach the next level, and a what-if calculator.
- **Compare**: up to 5 players side by side, with the leader of each skill highlighted.
- **Gains**: every lookup saves a snapshot, so you can see XP, levels and rank gained
  since the last lookup, a day ago, a week ago and so on.
- **Leaderboard**: browse any skill's hiscores 21 at a time, with Top % next to every rank.
  Click a column header to sort the page by it; click again to flip the order.
- **Saved players**: star players for one-click lookups.

## Setting it up (no installs needed)

Every file sits at the top level (no folders), because GitHub's upload page tends to flatten
or drop folders. The one exception is the publishing job, which GitHub only runs from
`.github/workflows/pages.yml`, so you create that file once by hand.

1. **Make a GitHub account** at <https://github.com/signup> (free).
2. **Create a repository**: the **+** at the top right, then **New repository**. Name it
   `hiscores-plus`, choose **Public**, and click **Create repository**.
3. **Turn on Pages**: in the repository, go to **Settings → Pages**. Under
   *Build and deployment → Source*, pick **GitHub Actions**.
4. **Upload the files**: on the **Code** tab, click **Add file → Upload files**. Drag in every
   file from the unzipped folder, then click **Commit changes**.
5. **Create the publishing job**: click **Add file → Create new file** and type
   `.github/workflows/pages.yml` as the name (the slashes make the folders). Open the
   `pages.yml` file from the zip in Notepad, copy everything, paste it in, and click
   **Commit changes**. This starts the first publish.
6. **Wait about a minute**: the **Actions** tab shows *Publish site and update player counts*
   in its left sidebar. When the run has a green tick, the site is live at
   `https://YOUR-USERNAME.github.io/hiscores-plus/` (also shown under **Settings → Pages**).
7. **Start the player counts**: **Actions → Publish site and update player counts →
   Run workflow → Run workflow**. From then on this runs twice a day on its own.
8. **Add it to LostKit**: **Add tool**. For the address, use `YOUR-USERNAME.github.io/hiscores-plus`,
   then click **Add tool**. The name (*Hiscores+*) and icon are picked up automatically.

The `pages.yml` at the top level is only a copy to paste from. GitHub ignores it there.

## Using it in a normal browser

Browsers only let a page read data from its own website, or from websites that say
"other sites may read me". Lost City's API says only its own website may, so Chrome,
Edge and the rest block this page from reading it, however slowly it asks. LostKit's tool
tabs switch that browser rule off, which is why it works there.

The page picks its route by itself:

- **Inside LostKit** it reads the API directly.
- **In a browser** it tries directly first (in case Lost City ever allows other websites),
  then a relay on its own address (`/api/hiscores/...`). If neither works, it says so at the top.

Two ways to get the browser route working:

1. **Host it on Netlify as well** (free; sign in with your GitHub account, no new password).
   The `_redirects` file tells Netlify to pass hiscores requests through its own address,
   which browsers accept. On netlify.com: **Sign up → GitHub**, then **Add new site →
   Import an existing project → GitHub →** `hiscores-plus` → **Deploy** (leave the build
   settings empty). Under **Site configuration → Change site name** pick something like
   `hiscores-plus`, giving `https://hiscores-plus.netlify.app`. Netlify republishes by itself
   whenever the GitHub repository changes, including the twice-daily player counts.
2. **Ask Lost City** to allow other websites to read the hiscores API (the response header
   `Access-Control-Allow-Origin: *`). If they do, the GitHub Pages address works in every
   browser with no changes.

## How Top % is worked out

The API has no "how many players" number, so the tool finds the last ranked player
itself. Asking for a rank past the end returns an empty page, and a page that
comes back short contains the last player. That turns it into a quick binary search
instead of reading every page. With last time's count as the starting point, it
usually takes one request per skill.

A skill only gets a hiscores entry at **level 15**, so each skill has its own count.
Overall counts every ranked account.

The API allows **one request every 2 seconds** for your whole connection, so:

- The counting is done by the GitHub job (`update-totals.mjs`) twice a day and
  shared through `totals.json`. Every player count in `totals-history.csv` is kept,
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

Upload the changed files the same way (**Add file → Upload files**). Files with the same name are replaced.
Commit, and the site republishes itself in about a minute.

## Development

Plain HTML, CSS and JavaScript modules, with no build step. With Node 18+:

```sh
node --test                          # unit tests: totals search, XP table, combat formula
RATE_MS=300 node mock-server.mjs     # fake API + the site on http://localhost:8787
# then open http://localhost:8787/?api=local  (or run the browser tests: node e2e.mjs, needs Playwright)
```

## Credits

- Hiscores data: the [Lost City hiscores API](https://2004.lostcity.rs/news/199).
- Skill icons and RuneScape fonts come from [LostKit](https://github.com/LostHQ/LostKit-Electron)
  (GPL-3.0). RuneScape and its artwork are © Jagex Ltd. This is a fan project and is not
  affiliated with Jagex, Lost City or LostHQ.
- Licensed under the GPL-3.0 (see `LICENSE`).
