/* WebClaw Video Creator — public site. No dependencies, no network calls, no analytics. */
(function () {
  'use strict';
  var CFG = window.WVC_CONFIG || {};

  // ----- hydrate links / meta from the central config (see config.js) -----
  // The markup already carries the same defaults, so this only matters when the
  // constants change after the pages are generated.
  if (CFG.siteUrl) {
    var page = document.documentElement.getAttribute('data-page') || '';
    var here = CFG.siteUrl.replace(/\/$/, '') + page;
    Array.prototype.forEach.call(document.querySelectorAll('link[rel="canonical"], meta[property="og:url"]'), function (el) {
      var key = el.tagName === 'LINK' ? 'href' : 'content';
      if (el.getAttribute(key)) el.setAttribute(key, here);
    });
  }
  Array.prototype.forEach.call(document.querySelectorAll('[data-link]'), function (el) {
    var v = CFG[el.getAttribute('data-link')];
    if (v) el.setAttribute('href', v);
  });
  Array.prototype.forEach.call(document.querySelectorAll('[data-version]'), function (el) {
    if (CFG.version) el.textContent = CFG.version;
  });

  // ----- theme toggle (initial value is applied by the inline head script) -----
  var KEY = 'wvc-theme';
  var btn = document.querySelector('[data-theme-toggle]');
  if (btn) {
    btn.addEventListener('click', function () {
      var root = document.documentElement;
      var current = root.getAttribute('data-theme');
      if (!current) {
        current = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      }
      var next = current === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem(KEY, next); } catch (e) { /* private mode */ }
      btn.setAttribute('aria-label', next === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
    });
  }

  // ----- reveal on scroll -----
  // The animation must never be the reason content is unreadable: anything still
  // hidden after a short grace period is revealed unconditionally.
  var targets = document.querySelectorAll('[data-reveal]');
  var revealAll = function () {
    Array.prototype.forEach.call(targets, function (el) { el.classList.add('in'); });
  };
  if (!('IntersectionObserver' in window) ||
      matchMedia('(prefers-reduced-motion: reduce)').matches) {
    revealAll();
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      });
    }, { rootMargin: '0px 0px -10% 0px', threshold: 0.08 });
    Array.prototype.forEach.call(targets, function (el) { io.observe(el); });
    setTimeout(function () { io.disconnect(); revealAll(); }, 2500);
  }

  // ----- screenshot lightbox -----
  var lb = document.getElementById('lightbox');
  if (lb) {
    var lbImg = lb.querySelector('img');
    var close = function () {
      lb.classList.remove('on');
      lb.setAttribute('aria-hidden', 'true');
      lbImg.removeAttribute('src');
      document.body.style.overflow = '';
    };
    document.querySelectorAll('.shot-frame').forEach(function (frame) {
      frame.addEventListener('click', function () {
        var img = frame.querySelector('img');
        if (!img) return;
        lbImg.src = img.currentSrc || img.src;
        lbImg.alt = img.alt;
        lb.classList.add('on');
        lb.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';
      });
    });
    lb.addEventListener('click', close);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && lb.classList.contains('on')) close();
    });
  }
})();
