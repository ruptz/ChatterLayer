'use strict';
// The window's own frame: its buttons, and the tab that marks which section
// you're reading. Nothing here knows about captions; renderer.js does that.

(() => {
  const win = window.__TAURI__.window.getCurrentWindow();
  document.getElementById('win-min').addEventListener('click', () => win.minimize());
  document.getElementById('win-max').addEventListener('click', () => win.toggleMaximize());
  // Close asks the app, which parks in the tray or quits as the setting says.
  document.getElementById('win-close').addEventListener('click', () => win.close());

  const scroller = document.getElementById('scroller');
  const tabs = [...document.querySelectorAll('.tabs a')];
  const cells = tabs.map((a) => document.querySelector(a.getAttribute('href')));

  // The current section is the last one whose top has reached a third of the
  // way down the pane, or the last one at all once the pane is scrolled out.
  function mark() {
    const top = scroller.getBoundingClientRect().top;
    const atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
    let current = 0;
    cells.forEach((cell, i) => {
      if (cell && !cell.hidden && cell.getBoundingClientRect().top - top <= scroller.clientHeight / 3) current = i;
    });
    if (atEnd) current = cells.length - 1;
    tabs.forEach((a, i) => a.setAttribute('aria-current', String(i === current)));
    document.querySelectorAll('.cell.is-current').forEach((c) => c.classList.remove('is-current'));
    if (cells[current]) cells[current].classList.add('is-current');
  }

  scroller.addEventListener('scroll', mark, { passive: true });
  window.addEventListener('resize', mark);
  mark();
})();
