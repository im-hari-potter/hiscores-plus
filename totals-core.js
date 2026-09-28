// Finding how many players are ranked in a category.
//
// The API has no "count" endpoint. What it has is ?rank=P, which returns the
// 21 ranks that end at P (P-20 .. P). Near the end of the list that page comes
// back short, and past the end it comes back empty. So one request tells us:
//
//   21 rows ending at P  ->  total >= P
//   1-20 rows            ->  total is exactly the last rank on the page
//   no rows              ->  total <= P - 21
//
// That is enough to binary-search for the last player instead of walking the
// list page by page (a few dozen requests instead of about a thousand), and
// when we already know last time's total, usually one or two requests.
//
// Shared by the page and by the GitHub Action, so it only takes a `probe`
// function and never touches the network itself.

export const PAGE_SIZE = 21;

/**
 * @param {(rank: number) => Promise<Array<{rank: number}>>} probe
 * @param {object} [opts]
 * @param {number} [opts.lower]  a rank known to exist (total >= lower)
 * @param {number} [opts.upper]  a hint: total is probably <= upper
 * @param {number} [opts.guess]  a recent value of the total, checked first
 * @param {number} [opts.maxProbes]
 * @returns {Promise<{total: number, probes: number, exact: boolean}>}
 */
export async function findTotal(probe, opts = {}) {
  const maxProbes = opts.maxProbes ?? 60;
  let lo = Math.max(0, Math.floor(opts.lower ?? 0));
  let loIsHint = lo > 0;                         // from outside this search, may be stale
  let hi = Number.isFinite(opts.upper) ? Math.max(0, Math.floor(opts.upper)) : Infinity;
  let hiIsHint = hi !== Infinity;
  let guess = Number.isFinite(opts.guess) && opts.guess > 0 ? Math.floor(opts.guess) : null;
  const baseStep = Math.max(64, guess ? Math.ceil(guess * 0.01) : 0);
  let upStep = guess ? baseStep : Math.max(64, lo);
  let downStep = 0;                              // > 0 while walking down from a guess that was too high
  let probes = 0;

  if (hi < lo) { hi = Infinity; hiIsHint = false; }

  while (probes < maxProbes) {
    const closed = hi !== Infinity && hi <= lo;
    if (closed && !loIsHint && !hiIsHint) return { total: lo, probes, exact: true };

    const fromGuess = guess !== null;
    let P;
    if (closed) {
      P = lo + PAGE_SIZE - 1;                    // bounds met but rest on a hint: look at lo .. lo+20
      guess = null;
    } else if (fromGuess) {
      P = guess + 10;                            // window guess-10 .. guess+10
      guess = null;
    } else if (hi === Infinity) {
      P = lo + upStep;                           // gallop upwards
      upStep *= 2;
    } else if (downStep > 0 && hi - downStep > lo + PAGE_SIZE) {
      P = hi - downStep;                         // gallop downwards
      downStep *= 2;
    } else {
      P = Math.floor((lo + hi) / 2) + 10;        // centre the window on the midpoint
      downStep = 0;
    }
    if (P <= lo) P = lo + 1;
    if (hi !== Infinity && P - (PAGE_SIZE - 1) > hi) P = hi + PAGE_SIZE - 1;
    P = Math.max(PAGE_SIZE, P);

    probes++;
    const rows = await probe(P);
    const n = Array.isArray(rows) ? rows.length : 0;

    if (n === 0) {
      hi = Math.min(hi, P - PAGE_SIZE);
      hiIsHint = false;
      if (fromGuess) downStep = baseStep;
      if (hi < lo) {
        if (loIsHint) { lo = 0; loIsHint = false; }   // the outside lower bound was stale
        else return { total: Math.max(0, hi), probes, exact: false };
      }
    } else {
      const last = Number(rows[n - 1].rank);
      if (n < PAGE_SIZE || last < P) return { total: last, probes, exact: true };
      lo = Math.max(lo, P);
      loIsHint = false;
      downStep = 0;
      if (hi < lo) {
        if (hiIsHint) { hi = Infinity; hiIsHint = false; upStep = baseStep; } // outside upper bound was stale
        else { hi = Infinity; upStep = PAGE_SIZE; }                          // list grew while we searched
      }
    }
  }
  return { total: lo, probes, exact: false };
}

// Page n (1-based) shows ranks 21(n-1)+1 .. 21n, which the API serves at ?rank=21n.
export const pageOfRank = rank => Math.max(1, Math.ceil(rank / PAGE_SIZE));
export const rankParamForPage = page => Math.max(1, page) * PAGE_SIZE;
export const pageCount = total => Math.max(1, Math.ceil(total / PAGE_SIZE));
