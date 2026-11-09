// Shared script for the pages made by scripts/build-pages.ps1 (systems, UGC, games).
// The homepage has its own copy of these behaviours inside index.html.
(function(){
  'use strict';
  const fmt = function(n){ return Number(n).toLocaleString('en-US'); };
  const year = document.getElementById('year');
  if (year) year.textContent = new Date().getFullYear();

  // ---------- header shadow on scroll + phone menu ----------
  const header = document.getElementById('siteHeader');
  const toggle = document.getElementById('navToggle');
  function onScroll(){ if (header) header.classList.toggle('scrolled', window.scrollY > 20); }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
  if (toggle) {
    toggle.addEventListener('click', function(){
      const open = !document.body.classList.contains('nav-open');
      document.body.classList.toggle('nav-open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    document.querySelectorAll('#siteNav a').forEach(function(a){
      a.addEventListener('click', function(){ document.body.classList.remove('nav-open'); toggle.setAttribute('aria-expanded', 'false'); });
    });
  }

  // ---------- prices and Preview buttons (from the shop data copied from the homepage) ----------
  const shopEl = document.getElementById('shopData');
  const shop = shopEl ? JSON.parse(shopEl.textContent) : { systems: {} };
  document.querySelectorAll('.sys-price[data-system]').forEach(function(el){
    const p = shop.systems[el.dataset.system];
    if (!p) return;
    el.innerHTML = '<b>' + fmt(p.robux) + ' Robux</b><span>or ৳' + fmt(p.bdt) + ' with bKash / Nagad</span><span class="usd">about $' + fmt(p.usd) + ' USD</span><small>Robux price includes the 30% Roblox fee</small>';
  });

  // accepts youtube.com/watch?v=, youtu.be/, /shorts/ and /embed/ links
  function youtubeId(url){
    const m = String(url || '').match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/))([\w-]{11})/);
    return m ? m[1] : null;
  }
  const videoModal = document.getElementById('videoModal');
  if (videoModal) {
    const frame = document.getElementById('videoFrame');
    const openVideo = function(name, id){
      document.getElementById('videoTitle').textContent = name + ' preview';
      document.getElementById('videoYouTube').href = 'https://www.youtube.com/watch?v=' + id;
      frame.src = 'https://www.youtube-nocookie.com/embed/' + id + '?autoplay=1&rel=0';
      if (videoModal.showModal) videoModal.showModal(); else videoModal.setAttribute('open', '');
    };
    const closeVideo = function(){
      // clearing the frame stops the video
      frame.src = 'about:blank';
      if (videoModal.close) videoModal.close(); else videoModal.removeAttribute('open');
    };
    document.getElementById('videoClose').addEventListener('click', closeVideo);
    videoModal.addEventListener('cancel', function(e){ e.preventDefault(); closeVideo(); });
    videoModal.addEventListener('click', function(e){ if (e.target === videoModal) closeVideo(); });
    const playIcon = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M8 5v14l11-7L8 5z" fill="currentColor"/></svg>';
    document.querySelectorAll('.sys-cta[data-order]').forEach(function(cta){
      const name = cta.dataset.order;
      const id = youtubeId((shop.systems[name] || {}).video);
      if (!id) return;
      const actions = document.createElement('div');
      actions.className = 'sys-actions';
      cta.parentNode.insertBefore(actions, cta);
      actions.appendChild(cta);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-outline sys-preview';
      btn.innerHTML = playIcon + 'Preview';
      btn.setAttribute('aria-label', 'Watch the ' + name + ' preview video');
      btn.addEventListener('click', function(){ openVideo(name, id); });
      actions.appendChild(btn);
    });
  }

  // ---------- reviews for one system (the list has data-item) ----------
  const list = document.getElementById('reviewList');
  if (list && list.dataset.item) {
    const item = list.dataset.item;
    const summary = document.getElementById('reviewSummary');
    const STAR = '<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9L12 3z" fill="currentColor"/></svg>';
    const CHECK = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const stars = function(n){
      let s = '';
      for (let i = 1; i <= 5; i++) s += i <= n ? STAR : STAR.replace('aria-hidden', 'class="off" aria-hidden');
      return '<span class="stars" role="img" aria-label="' + n + ' out of 5 stars">' + s + '</span>';
    };
    const el = function(tag, cls, text){ const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const empty = function(text){ list.innerHTML = ''; list.appendChild(el('p', 'review-empty', text)); };
    fetch('/api/reviews')
      .then(function(r){ if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function(d){
        const reviews = (d.reviews || []).filter(function(r){ return r.item === item; });
        if (!reviews.length) { empty('No reviews for the ' + item + ' yet. Bought it? Be the first to review it.'); return; }
        const avg = reviews.reduce(function(t, r){ return t + r.rating; }, 0) / reviews.length;
        summary.innerHTML = '<b>' + avg.toFixed(1) + '</b>' + stars(Math.round(avg)) + '<span>' + reviews.length + (reviews.length === 1 ? ' review' : ' reviews') + '</span>';
        summary.hidden = false;
        list.innerHTML = '';
        reviews.forEach(function(r){
          // review text and names are set with textContent, never as HTML
          const card = el('article', 'review');
          const top = el('div', 'review-top');
          top.insertAdjacentHTML('beforeend', stars(r.rating));
          top.appendChild(el('span', 'review-date', new Date(r.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })));
          const by = el('div', 'review-by');
          by.appendChild(el('b', null, r.name));
          const v = el('span', 'verified');
          v.innerHTML = CHECK;
          v.appendChild(document.createTextNode('Verified purchase'));
          by.appendChild(v);
          card.appendChild(top);
          card.appendChild(el('p', null, r.text));
          card.appendChild(by);
          list.appendChild(card);
        });
      })
      .catch(function(){ empty("Reviews couldn't load right now."); });
  }

  // ---------- live Roblox game info (games page) ----------
  const cards = document.querySelectorAll('[data-game]');
  const stats = document.querySelectorAll('[data-stat]');
  if (cards.length || stats.length) {
    // rounded down so a "+" is always true: 77, 320+, 5.6K+, 650K+, 1.2M+
    const short = function(n, exactBelow){
      if (n < exactBelow) return String(n);
      if (n < 1000) return Math.floor(n / 10) * 10 + '+';
      if (n < 10000) return (Math.floor(n / 100) / 10) + 'K+';
      if (n < 1e6) return Math.floor(n / 1000) + 'K+';
      return (Math.floor(n / 1e5) / 10) + 'M+';
    };
    const setText = function(e, text){ const node = e.lastChild; if (node && node.nodeType === 3) node.nodeValue = text; else e.textContent = text; };
    const swapImg = function(img, url){
      if (!img || !url || img.src === url) return;
      const probe = new Image();
      probe.onload = function(){ img.src = url; img.removeAttribute('data-empty'); };
      probe.src = url;
    };
    fetch('/api/roblox-stats')
      .then(function(r){ if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function(d){
        if (!d.games) return;
        cards.forEach(function(card){
          const g = d.games[card.getAttribute('data-game')];
          if (!g) return;
          const title = card.querySelector('.game-body h3');
          if (g.name && title) title.textContent = g.name.trim();
          const thumb = card.querySelector('.game-thumb');
          const main = thumb && thumb.querySelector('img:first-child');
          if (main && g.name) main.alt = g.name + ' on Roblox';
          // "contain" cards (CTG CITY) show the icon full size
          if (thumb && thumb.classList.contains('contain')) swapImg(main, g.icon); else swapImg(main, g.thumbnail);
          swapImg(card.querySelector('.game-icon'), g.icon);
        });
        stats.forEach(function(e){
          const stat = e.getAttribute('data-stat');
          if (stat === 'total-visits') { if (d.totalVisits > 0) setText(e, short(d.totalVisits, 0)); return; }
          const g = d.games[e.getAttribute('data-universe')];
          if (!g) return;
          if (stat === 'visits') setText(e, short(g.visits, 0) + ' visits');
          if (stat === 'favorites') setText(e, short(g.favorites, 100) + ' favorites');
        });
        const note = document.getElementById('statsNote');
        if (note) note.textContent = 'Visit counts update live from Roblox.';
      })
      .catch(function(){});
  }
})();
