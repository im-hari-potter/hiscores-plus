// Dragging the items of a grid into a new order: the Lookup tiles, and the
// Bank tab's All view. Mouse: press and move. Touch: hold for a moment, then
// move (a quick swipe still scrolls). Escape puts everything back.
//
//   root    where to listen
//   item    selector for what can be dragged
//   skip    selector for parts that keep their own use (a text box)
//   onDrop  (el) the item was dropped; the page already shows the new order
//   onEnd   ({ dropped, stale }) the drag is over. stale: something asked to be
//           redrawn while it was going on (see hold), so redraw now.

export function sortable({ root, item, skip = null, onDrop, onEnd = () => {} }) {
  let d = null;
  let swallow = false;

  root.addEventListener('pointerdown', e => {
    const el = e.target.closest(item);
    if (!el || !root.contains(el) || e.button !== 0 || d) return;
    if (skip && e.target.closest(skip)) return;
    d = { el, id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, active: false, touch: e.pointerType !== 'mouse' };
    if (d.touch) d.timer = setTimeout(() => d && !d.active && start(), 350);
  });
  window.addEventListener('pointermove', e => {
    if (!d || e.pointerId !== d.id) return;
    d.x = e.clientX; d.y = e.clientY;
    if (!d.active) {
      const moved = Math.hypot(d.x - d.x0, d.y - d.y0);
      if (d.touch) { if (moved > 10) end(false); return; }   // moved before the hold: it's a scroll
      if (moved < 6) return;
      start();
      if (!d) return;
    }
    move();
    e.preventDefault();
  }, { passive: false });
  window.addEventListener('touchmove', e => { if (d?.active) e.preventDefault(); }, { passive: false });
  window.addEventListener('pointerup', e => { if (d && e.pointerId === d.id) end(true); });
  window.addEventListener('pointercancel', e => { if (d && e.pointerId === d.id) end(false); });
  window.addEventListener('keydown', e => { if (e.key === 'Escape' && d?.active) end(false); });
  // The click that finishes a drag (it comes straight after the button is let
  // go) isn't a click on what's under it: a bank item would put the cursor in
  // its amount.
  window.addEventListener('click', e => {
    if (!swallow) return;
    swallow = false;
    e.preventDefault();
    e.stopPropagation();
  }, true);

  function start() {
    if (!d.el.isConnected) { d = null; return; }     // redrawn under the press: let go and try again
    const rect = d.el.getBoundingClientRect();
    d.active = true;
    d.dx = d.x0 - rect.left; d.dy = d.y0 - rect.top;
    d.before = [...d.el.parentNode.children];
    d.ghost = d.el.cloneNode(true);
    d.ghost.classList.add('drag-ghost');
    d.ghost.removeAttribute('id');
    Object.assign(d.ghost.style, { width: rect.width + 'px', height: rect.height + 'px' });
    document.body.appendChild(d.ghost);
    d.el.classList.add('drag-placeholder');
    document.body.classList.add('dragging');
    window.getSelection?.().removeAllRanges();
    move();
  }

  function move() {
    d.ghost.style.left = (d.x - d.dx) + 'px';
    d.ghost.style.top = (d.y - d.dy) + 'px';
    const over = document.elementFromPoint(d.x, d.y)?.closest(item);
    if (!over || over === d.el || over.parentNode !== d.el.parentNode) return;
    const all = [...d.el.parentNode.children];
    if (all.indexOf(d.el) < all.indexOf(over)) over.after(d.el); else over.before(d.el);
  }

  function end(keep) {
    const was = d;
    d = null;
    if (!was) return;
    clearTimeout(was.timer);
    if (!was.active) return;
    was.ghost.remove();
    was.el.classList.remove('drag-placeholder');
    document.body.classList.remove('dragging');
    swallow = true;
    setTimeout(() => { swallow = false; }, 0);
    const parent = was.el.parentNode;
    if (!keep) for (const el of was.before) parent.appendChild(el);   // put everything back
    else onDrop(was.el);
    onEnd({ dropped: keep, stale: !!was.stale });
  }

  return {
    get active() { return !!d?.active; },
    // Call before redrawing what's being dragged: true means not now (it's
    // remembered, and onEnd says stale).
    hold() {
      if (!d?.active) return false;
      d.stale = true;
      return true;
    },
  };
}
