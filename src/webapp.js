import * as db from './db.js';
import { readFeed, readRecent } from './catalog.js';
import { smartSearch } from './search.js';
import { addTitle, resolveDate, pickOverview, ensureRatings } from './titles.js';
import { posterUrl, getDetails, tmdbUrl } from './tmdb.js';
import { kpById, kpReleaseDate, kpIsSeries, normalizeTitle, isRussianItem } from './kinopoisk.js';
import { GENRES, COUNTRIES, parseFilter } from './filters.js';
import { igdbById, igdbCover, igdbDate, igdbPlatforms, igdbStudio, igdbUrl, gameGenres } from './igdb.js';
import {
  today, daysBetween, formatDate, humanCountdown, dayHeader, titleOf, year, kindWord,
} from './format.js';

// Mini App — обычная страница, которую Telegram открывает внутри себя.
// Отдаёт её этот же воркер, данные берёт из той же D1: ничего нового
// поднимать не нужно, и всё остаётся на бесплатном тарифе.

const HTML = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Release Radar</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
  :root {
    --bg: var(--tg-theme-bg-color, #17212b);
    --card: var(--tg-theme-secondary-bg-color, #232e3c);
    --text: var(--tg-theme-text-color, #fff);
    --hint: var(--tg-theme-hint-color, #8a9aa9);
    --accent: var(--tg-theme-button-color, #4f9bd9);
    --accent-text: var(--tg-theme-button-text-color, #fff);
  }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 15px/1.4 -apple-system, "Segoe UI", Roboto, sans-serif;
    padding-bottom: 24px;
  }
  header {
    position: sticky; top: 0; z-index: 5; background: var(--bg);
    /* В полноэкранном режиме Telegram рисует свои кнопки поверх верха экрана —
       отступаем на безопасную зону, в обычном режиме она нулевая. */
    padding: calc(8px + var(--tg-safe-area-inset-top, 0px) + var(--tg-content-safe-area-inset-top, 0px)) 12px 0;
    border-bottom: 1px solid rgba(128,128,128,.18);
  }
  .tabs { display: flex; gap: 4px; }
  .tab {
    flex: 1; padding: 9px 2px; text-align: center; font-size: 14px; font-weight: 500; white-space: nowrap;
    color: var(--hint); border: 0; background: none; border-bottom: 2px solid transparent;
    cursor: pointer;
  }
  .tab.on { color: var(--text); border-bottom-color: var(--accent); }
  .bar { display: flex; align-items: center; gap: 8px; padding: 12px 0; }
  .chips { display: flex; gap: 6px; flex: 1; min-width: 0; overflow-x: auto; }
  .chip {
    padding: 5px 12px; border-radius: 14px; font-size: 13px; white-space: nowrap;
    background: var(--card); color: var(--hint); border: 0; cursor: pointer;
  }
  .chip.on { background: var(--accent); color: var(--accent-text); }
  .icon {
    flex: none; width: 34px; height: 34px; border-radius: 17px; border: 0; cursor: pointer;
    background: var(--card); color: var(--text); font-size: 15px; line-height: 1;
  }
  #search {
    flex: 1; min-width: 0; padding: 8px 12px; margin: 0; border-radius: 10px;
    border: 0; background: var(--card); color: var(--text); font-size: 15px;
  }
  main { padding: 10px 12px; }
  /* Градиент у нижнего края: сразу видно, что под ним ещё есть карточки. */
  .edge {
    position: fixed; left: 0; right: 0; bottom: 0; height: 36px; z-index: 4; pointer-events: none;
    background: linear-gradient(transparent, var(--bg));
    opacity: 0; transition: opacity .2s;
  }
  .edge.on { opacity: 1; }
  /* Строка фильтров уезжает, когда листаешь вниз, и возвращается при движении вверх. */
  #controls { overflow: hidden; transition: max-height .2s, opacity .2s; max-height: 60px; }
  #controls.away { max-height: 0; opacity: 0; }
  .day { font-size: 13px; font-weight: 600; color: var(--hint); margin: 16px 0 8px; }
  .day:first-child { margin-top: 4px; }
  .row {
    display: flex; gap: 10px; align-items: flex-start; padding: 8px; cursor: pointer;
    background: var(--card); border-radius: 12px; margin-bottom: 8px;
  }
  .row img, .ph {
    width: 54px; height: 80px; border-radius: 7px; object-fit: cover; flex: none;
    background: rgba(128,128,128,.25);
  }
  .info { flex: 1; min-width: 0; }
  .name { font-weight: 600; margin-bottom: 3px; }
  .meta { font-size: 13px; color: var(--hint); }
  .desc {
    font-size: 13px; color: var(--hint); margin-top: 3px; opacity: .85;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .cast { font-style: italic; }
  .act {
    flex: none; width: 34px; height: 34px; margin-top: 2px; border-radius: 17px; border: 0;
    background: rgba(128,128,128,.18); color: var(--text); font-size: 17px; line-height: 1;
    cursor: pointer;
  }
  .act.add { background: var(--accent); color: var(--accent-text); }
  .empty { text-align: center; color: var(--hint); padding: 40px 20px; }
  .end { text-align: center; color: var(--hint); font-size: 13px; padding: 14px 20px 4px; }
  .more {
    display: block; width: 100%; padding: 11px; margin-top: 4px; border: 0; border-radius: 10px;
    background: var(--card); color: var(--text); font-size: 15px; cursor: pointer;
  }
  .toast {
    position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); z-index: 20;
    background: var(--accent); color: var(--accent-text); padding: 9px 16px;
    border-radius: 18px; font-size: 14px; opacity: 0; transition: opacity .2s; pointer-events: none;
  }
  .toast.on { opacity: 1; }

  /* карточка тайтла */
  #sheet { position: fixed; inset: 0; z-index: 10; background: var(--bg); overflow-y: auto; display: none; }
  #sheet.on { display: block; }
  .hero { position: relative; }
  .hero img { width: 100%; display: block; aspect-ratio: 16/9; object-fit: cover; }
  .hero .fade {
    position: absolute; left: 0; right: 0; bottom: 0; height: 60%;
    background: linear-gradient(transparent, var(--bg));
  }
  .back {
    position: absolute;
    top: calc(10px + var(--tg-safe-area-inset-top, 0px) + var(--tg-content-safe-area-inset-top, 0px));
    left: 10px; width: 34px; height: 34px; border: 0;
    border-radius: 17px; background: rgba(0,0,0,.55); color: #fff; font-size: 18px; cursor: pointer;
  }
  .sheet-body { padding: 0 14px 30px; margin-top: -26px; position: relative; }
  .sheet-top { display: flex; gap: 12px; align-items: flex-end; }
  .sheet-top img { width: 84px; border-radius: 9px; flex: none; }
  .sheet-title { font-size: 20px; font-weight: 700; line-height: 1.25; }
  .sheet-orig { font-size: 13px; color: var(--hint); margin-top: 2px; }
  .facts { margin: 14px 0 0; font-size: 14px; }
  .facts div { margin-bottom: 5px; }
  .facts b { font-weight: 600; }
  /* Значки рейтингов в фирменных цветах: жёлтый IMDb, оранжевый Кинопоиск. */
  .r {
    display: inline-block; padding: 0 4px; margin-right: 3px; border-radius: 3px;
    font-size: 11px; font-weight: 800; line-height: 15px; vertical-align: 1px;
  }
  .r.imdb { background: #f5c518; color: #000; }
  .r.kp { background: #ff6600; color: #fff; }
  .r.tmdb { background: #01b4e4; color: #fff; }
  .label { color: var(--hint); }
  .big {
    display: block; width: 100%; padding: 13px; margin: 16px 0 4px; border: 0; border-radius: 11px;
    background: var(--accent); color: var(--accent-text); font-size: 16px; font-weight: 600;
    cursor: pointer;
  }
  .big.off { background: var(--card); color: var(--text); }
  .about { margin-top: 14px; font-size: 15px; line-height: 1.5; }
  h3 { font-size: 14px; color: var(--hint); margin: 20px 0 8px; font-weight: 600; }
  .strip { display: flex; gap: 10px; overflow-x: auto; padding-bottom: 4px; }
  .person { width: 74px; flex: none; text-align: center; font-size: 12px; }
  .person img, .person .ph2 {
    width: 74px; height: 74px; border-radius: 37px; object-fit: cover; margin-bottom: 5px;
    background: rgba(128,128,128,.25); display: block;
  }
  .person .role { color: var(--hint); }
  .still { width: 220px; flex: none; border-radius: 9px; }
  a { color: var(--accent); }
  .icon.on { background: var(--accent); color: var(--accent-text); }
  .icon.wide { width: auto; padding: 0 11px; font-size: 14px; font-weight: 600; }
  .settings { padding: calc(20px + var(--tg-safe-area-inset-top, 0px) + var(--tg-content-safe-area-inset-top, 0px)) 16px 24px; }
  .switch-row {
    display: flex; align-items: center; gap: 12px; margin: 18px 0 8px; padding: 12px;
    background: var(--card); border-radius: 12px; cursor: pointer;
  }
  .switch-row > span { flex: 1; }
  .hint { display: block; font-size: 13px; color: var(--hint); margin-top: 4px; }
  .switch-row input { width: 22px; height: 22px; flex: none; accent-color: var(--accent); }
  .picks { display: flex; flex-wrap: wrap; gap: 6px; }
  .picks .chip { font-size: 14px; padding: 7px 12px; }
</style>
</head>
<body>
<header>
  <div class="tabs">
    <button class="tab on" data-tab="feed">Скоро выйдет</button>
    <button class="tab" data-tab="recent">Недавно вышло</button>
    <button class="tab" data-tab="fav">Избранное</button>
  </div>
  <div id="controls"></div>
</header>
<main id="list"><div class="empty">Загружаю…</div></main>
<div class="edge" id="edge"></div>
<div id="sheet"></div>
<div class="toast" id="toast"></div>
<script>
var tg = window.Telegram.WebApp;
tg.ready(); tg.expand();

// Одна строка управления на все вкладки: фильтр типа общий, поиск — по значку.
var tab = 'feed';
var type = 'a';
var episodes = false;
var searching = false;

var feedPage = 1;
var feedItems = [];
var feedMore = false;
var feedLoaded = false;
var recentItems = [];
var recentLoaded = false;
var data = { upcoming: [], released: [] };
var listLoaded = false;
var searchItems = [];
var searchQuery = '';
var hideRussian = false;
var filterGenres = [];
var filterCountries = [];
var showGames = false;
// Списки кнопок подставляет сервер: он же знает, какие жанры и страны бывают.
var FILTER_OPTIONS = __FILTER_OPTIONS__;

function api(method, payload) {
  var body = payload || {};
  body.initData = tg.initData;
  return fetch('/api/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }).then(function (r) {
    if (!r.ok) throw new Error('http ' + r.status);
    return r.json();
  }).then(function (res) {
    if (res && res.error) throw new Error(res.error);
    return res;
  });
}

function fail(message) {
  document.getElementById('list').innerHTML = '<div class="empty">' + esc(message) + '</div>';
}

function toast(text) {
  var el = document.getElementById('toast');
  el.textContent = text;
  el.classList.add('on');
  setTimeout(function () { el.classList.remove('on'); }, 1600);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}

// «IMDb 7.2 · КП 8.1» -> цветные значки. На входе уже экранированный текст.
function badges(html) {
  return html.replace(/(IMDb|КП|TMDB) ([0-9.]+)/g, function (m, name, value) {
    var cls = name === 'IMDb' ? 'imdb' : (name === 'КП' ? 'kp' : 'tmdb');
    return '<span class="r ' + cls + '">' + name + '</span>' + value;
  });
}

function row(item, action) {
  var desc = '';
  if (item.cast || item.desc) {
    desc = '<div class="desc">' +
      (item.cast ? '<span class="cast">' + esc(item.cast) + '</span>' + (item.desc ? ' — ' : '') : '') +
      esc(item.desc || '') + '</div>';
  }
  return '<div class="row" data-open="' + item.media_type + ':' + item.id + '">' +
    (item.poster ? '<img src="' + esc(item.poster) + '" alt="" loading="lazy">' : '<div class="ph"></div>') +
    '<div class="info"><div class="name">' + esc(item.title) + '</div>' +
    '<div class="meta">' + badges(esc(item.meta)) + '</div>' + desc + '</div>' +
    '<button class="act' + (action === 'add' ? ' add' : '') + '" ' +
    'data-act="' + action + '" data-type="' + item.media_type + '" data-id="' + item.id + '">' +
    (action === 'add' ? '+' : '×') + '</button></div>';
}

function chip(value, label) {
  return '<button class="chip' + (type === value ? ' on' : '') + '" data-ft="' + value + '">' + label + '</button>';
}

function renderControls() {
  var el = document.getElementById('controls');
  if (searching) {
    el.innerHTML = '<div class="bar">' +
      '<input id="search" placeholder="Название фильма или сериала" autocomplete="off" value="' + esc(searchQuery) + '">' +
      '<button class="icon" data-close-search="1" aria-label="Закрыть поиск">✕</button></div>';
    var input = document.getElementById('search');
    input.focus();
    return;
  }
  var html = '<div class="bar"><div class="chips">' + chip('a', 'Всё') + chip('m', 'Кино') + chip('t', 'Сериалы');
  if (showGames) html += chip('g', 'Игры');
  var active = filterGenres.length + filterCountries.length + (hideRussian ? 1 : 0) + (episodes ? 1 : 0);
  html += '</div><button class="icon' + (active ? ' on wide' : '') + '" data-open-settings="1" aria-label="Фильтры">⚙️' +
    (active ? ' ' + active : '') + '</button>' +
    '<button class="icon" data-open-search="1" aria-label="Поиск">🔍</button></div>';
  el.innerHTML = html;
}

function byType(list) {
  return list.filter(function (x) {
    return type === 'a' || (type === 'm' ? x.media_type === 'movie' : x.media_type === 'tv');
  });
}

function render() {
  setTimeout(onScroll, 50);
  var box = document.getElementById('list');
  var html = '';
  var i;

  if (searching) {
    if (!searchQuery) { box.innerHTML = '<div class="empty">Начните вводить название — можно с опечатками.</div>'; return; }
    if (!searchItems.length) { box.innerHTML = '<div class="empty">Ничего не нашлось</div>'; return; }
    for (i = 0; i < searchItems.length; i++) html += row(searchItems[i], 'add');
    box.innerHTML = html;
    return;
  }

  if (tab === 'feed') {
    if (!feedLoaded) { box.innerHTML = '<div class="empty">Загружаю…</div>'; return; }
    if (!feedItems.length) { box.innerHTML = '<div class="empty">Ничего не нашлось</div>'; return; }
    for (i = 0; i < feedItems.length; i++) html += row(feedItems[i], 'add');
    html += feedMore
      ? '<button class="more" id="more">Показать ещё</button>'
      : '<div class="end">Это всё, что уже известно. Даты дальше появляются постепенно.</div>';
    box.innerHTML = html;
    return;
  }

  if (tab === 'recent') {
    if (!recentLoaded) { box.innerHTML = '<div class="empty">Загружаю…</div>'; return; }
    if (!recentItems.length) { box.innerHTML = '<div class="empty">За последние две недели ничего не вышло.</div>'; return; }
    for (i = 0; i < recentItems.length; i++) html += row(recentItems[i], 'add');
    box.innerHTML = html;
    return;
  }

  // Избранное: впереди — по дням, вышедшее — в конце, чтобы его можно было убрать.
  if (!listLoaded) { box.innerHTML = '<div class="empty">Загружаю…</div>'; return; }
  var ahead = byType(data.upcoming);
  var done = byType(data.released);
  if (!ahead.length && !done.length) {
    box.innerHTML = '<div class="empty">Пока пусто. Добавьте что-нибудь плюсом справа в «Скоро выйдет».</div>';
    return;
  }
  var day = null;
  for (i = 0; i < ahead.length; i++) {
    if (ahead[i].day !== day) {
      day = ahead[i].day;
      html += '<div class="day">' + esc(day) + '</div>';
    }
    html += row(ahead[i], 'remove');
  }
  if (done.length) {
    html += '<div class="day">Уже вышло</div>';
    for (i = 0; i < done.length; i++) html += row(done[i], 'remove');
  }
  box.innerHTML = html;
}

function loadFeed(reset) {
  if (reset) { feedPage = 1; feedItems = []; feedLoaded = false; }
  return api('feed', { type: type, page: feedPage, episodes: episodes }).then(function (res) {
    feedItems = feedItems.concat(res.items || []);
    feedMore = Boolean(res.hasMore);
    feedLoaded = true;
    if (tab === 'feed' && !searching) render();
  }).catch(function () {
    if (tab === 'feed' && !searching) fail('Не удалось загрузить. Откройте приложение из чата с ботом.');
  });
}

function loadRecent() {
  recentLoaded = false;
  return api('recent', { type: type, episodes: episodes }).then(function (res) {
    recentItems = res.items || [];
    recentLoaded = true;
    if (tab === 'recent' && !searching) render();
  }).catch(function () {
    if (tab === 'recent' && !searching) fail('Не удалось загрузить. Откройте приложение из чата с ботом.');
  });
}

function loadList() {
  return api('list').then(function (res) {
    data = { upcoming: res.upcoming || [], released: res.released || [] };
    listLoaded = true;
    filterGenres = res.genres || filterGenres;
    filterCountries = res.countries || filterCountries;
    if (Boolean(res.games) !== showGames) {
      showGames = Boolean(res.games);
      if (!searching) renderControls();
    }
    if (Boolean(res.hideRussian) !== hideRussian) {
      hideRussian = Boolean(res.hideRussian);
      if (!searching) renderControls();
    }
    if (tab === 'fav' && !searching) render();
  }).catch(function () {
    if (tab === 'fav' && !searching) fail('Не удалось загрузить. Откройте приложение из чата с ботом.');
  });
}

/** Подгрузить то, что нужно текущей вкладке, если фильтр поменялся или её ещё не открывали. */
function refreshTab() {
  render();
  if (tab === 'feed' && !feedLoaded) loadFeed(true);
  if (tab === 'recent' && !recentLoaded) loadRecent();
  if (tab === 'fav') loadList();
}

function switchTab(next) {
  tab = next;
  searching = false;
  var tabs = document.querySelectorAll('.tab');
  for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('on', tabs[i].dataset.tab === next);
  renderControls();
  refreshTab();
}

/** Фильтр общий для вкладок, поэтому при его смене ленты надо перезапросить. */
function filterChanged() {
  feedLoaded = false;
  recentLoaded = false;
  renderControls();
  refreshTab();
}

// --- карточка тайтла -------------------------------------------------------

function closeSheet() {
  document.getElementById('sheet').classList.remove('on');
  document.body.style.overflow = '';
  if (tg.BackButton) tg.BackButton.hide();
}

function openSheet(type, id) {
  var el = document.getElementById('sheet');
  el.innerHTML = '<div class="empty">Загружаю…</div>';
  el.classList.add('on');
  el.scrollTop = 0;
  document.body.style.overflow = 'hidden';
  if (tg.BackButton) { tg.BackButton.show(); tg.BackButton.onClick(closeSheet); }

  api('title', { mediaType: type, tmdbId: Number(id) }).then(function (t) {
    el.innerHTML = sheetHtml(t);
  }).catch(function () {
    el.innerHTML = '<div class="empty">Не удалось загрузить карточку.<br><br>' +
      '<button class="more" data-close="1">Назад</button></div>';
  });
}

function personCard(p) {
  return '<div class="person">' +
    (p.photo ? '<img src="' + esc(p.photo) + '" alt="" loading="lazy">' : '<div class="ph2"></div>') +
    '<div>' + esc(p.name) + '</div>' +
    (p.role ? '<div class="role">' + esc(p.role) + '</div>' : '') + '</div>';
}

function sheetHtml(t) {
  var html = '<div class="hero">' +
    (t.backdrop ? '<img src="' + esc(t.backdrop) + '" alt="">' : '') +
    '<div class="fade"></div><button class="back" data-close="1">✕</button></div>';

  html += '<div class="sheet-body"><div class="sheet-top">' +
    (t.poster ? '<img src="' + esc(t.poster) + '" alt="">' : '') +
    '<div><div class="sheet-title">' + esc(t.title) + '</div>' +
    (t.original && t.original !== t.title ? '<div class="sheet-orig">' + esc(t.original) + '</div>' : '') +
    '</div></div>';

  html += '<div class="facts">';
  for (var i = 0; i < t.facts.length; i++) {
    html += '<div><span class="label">' + esc(t.facts[i][0]) + ':</span> <b>' +
      badges(esc(t.facts[i][1])) + '</b></div>';
  }
  html += '</div>';

  html += '<button class="big' + (t.inList ? ' off' : '') + '" data-toggle="' +
    t.media_type + ':' + t.id + '" data-in="' + (t.inList ? '1' : '0') + '">' +
    (t.inList ? '✓ В избранном — убрать' : '⭐ В избранное') + '</button>';

  if (t.overview) html += '<div class="about">' + esc(t.overview) + '</div>';

  if (t.cast && t.cast.length) {
    html += '<h3>В ролях</h3><div class="strip">';
    for (var j = 0; j < t.cast.length; j++) html += personCard(t.cast[j]);
    html += '</div>';
  }
  if (t.stills && t.stills.length) {
    html += '<h3>Кадры</h3><div class="strip">';
    for (var k = 0; k < t.stills.length; k++) {
      html += '<img class="still" src="' + esc(t.stills[k]) + '" alt="" loading="lazy">';
    }
    html += '</div>';
  }
  html += '<h3>Ссылка</h3><a href="' + esc(t.tmdb) + '" target="_blank">Страница на ' + esc(t.source || 'TMDB') + '</a>';
  return html + '</div>';
}

// --- настройки -------------------------------------------------------------

function pickRow(list, chosen, attr) {
  var html = '<div class="picks">';
  for (var i = 0; i < list.length; i++) {
    var on = chosen.indexOf(list[i].key) >= 0;
    html += '<button class="chip' + (on ? ' on' : '') + '" data-' + attr + '="' + list[i].key + '">' +
      esc(list[i].label) + '</button>';
  }
  return html + '</div>';
}

function openSettings() {
  var el = document.getElementById('sheet');
  el.innerHTML = '<div class="settings">' +
    '<div class="sheet-title">Фильтры</div>' +
    '<h3>Жанр</h3>' + pickRow(FILTER_OPTIONS.genres, filterGenres, 'gk') +
    '<h3>Страна</h3>' + pickRow(FILTER_OPTIONS.countries, filterCountries, 'ck') +
    '<span class="hint">Индийское, китайское, турецкое, корейское и японское показывается, ' +
    'только если страна выбрана здесь.</span>' +
    '<label class="switch-row"><span><b>Без российского</b>' +
    '<span class="hint">Не показывать российские фильмы и сериалы в «Скоро выйдет» и «Недавно вышло». ' +
    'Избранное не трогаю — там только то, что вы добавили сами.</span></span>' +
    '<input type="checkbox" id="hideRu"' + (hideRussian ? ' checked' : '') + '></label>' +
    '<label class="switch-row"><span><b>Все серии</b>' +
    '<span class="hint">Показывать каждую серию идущих сериалов, а не только премьеры сезонов.</span></span>' +
    '<input type="checkbox" id="allEpisodes"' + (episodes ? ' checked' : '') + '></label>' +
    '<label class="switch-row"><span><b>Игры</b>' +
    '<span class="hint">Показывать игры вместе с кино и сериалами: даты по платформам, ' +
    'PS5, Xbox, Switch, PC. Появится отдельная кнопка «Игры» в фильтрах.</span></span>' +
    '<input type="checkbox" id="showGames"' + (showGames ? ' checked' : '') + '></label>' +
    (filterGenres.length + filterCountries.length ? '<button class="big off" data-reset="1">Сбросить фильтры</button>' : '') +
    '<button class="big" data-close="1">Готово</button></div>';
  el.classList.add('on');
  document.body.style.overflow = 'hidden';
  if (tg.BackButton) { tg.BackButton.show(); tg.BackButton.onClick(closeSheet); }
}

function saveFilters() {
  api('settings', { genres: filterGenres, countries: filterCountries }).then(function (res) {
    filterGenres = res.genres || [];
    filterCountries = res.countries || [];
    filterChanged();
  }).catch(function () { toast('Не вышло, попробуйте ещё раз'); });
}

document.addEventListener('change', function (e) {
  if (e.target.id === 'allEpisodes') {
    episodes = e.target.checked;
    renderControls();
    refreshTab();
    return;
  }
  if (e.target.id === 'showGames') {
    var on = e.target.checked;
    api('settings', { games: on }).then(function (res) {
      showGames = Boolean(res.games);
      if (!showGames && type === 'g') type = 'a';
      toast(showGames ? 'Игры включены' : 'Игры выключены');
      filterChanged();
    }).catch(function () {
      e.target.checked = !on;
      toast('Не вышло, попробуйте ещё раз');
    });
    return;
  }
  if (e.target.id !== 'hideRu') return;
  var value = e.target.checked;
  api('settings', { hideRussian: value }).then(function (res) {
    hideRussian = Boolean(res.hideRussian);
    toast(hideRussian ? 'Российское скрыто' : 'Российское снова видно');
    filterChanged();
  }).catch(function () {
    e.target.checked = !value;
    toast('Не вышло, попробуйте ещё раз');
  });
});

// --- события ---------------------------------------------------------------

document.addEventListener('click', function (e) {
  var t = e.target;
  var d = t.dataset || {};

  if (d.close) { closeSheet(); return; }

  if (t.classList.contains('tab')) { switchTab(d.tab); return; }

  if (d.openSettings) { openSettings(); return; }

  if (d.gk || d.ck) {
    var list = d.gk ? filterGenres : filterCountries;
    var key = d.gk || d.ck;
    var at = list.indexOf(key);
    if (at >= 0) list.splice(at, 1); else list.push(key);
    saveFilters();
    openSettings();
    return;
  }
  if (d.reset) {
    filterGenres = [];
    filterCountries = [];
    saveFilters();
    openSettings();
    return;
  }

  if (d.openSearch) {
    searching = true;
    renderControls();
    render();
    return;
  }
  if (d.closeSearch) {
    searching = false;
    searchQuery = '';
    searchItems = [];
    renderControls();
    refreshTab();
    return;
  }

  if (d.episodes) { episodes = !episodes; filterChanged(); return; }
  if (t.classList.contains('chip')) { type = d.ft; filterChanged(); return; }

  if (t.id === 'more') { feedPage += 1; loadFeed(false); return; }

  if (d.toggle) {
    var parts = d.toggle.split(':');
    var adding = d.in !== '1';
    t.disabled = true;
    if (tg.HapticFeedback) tg.HapticFeedback.impactOccurred('light');
    api(adding ? 'add' : 'remove', { mediaType: parts[0], tmdbId: Number(parts[1]) })
      .then(function () {
        t.disabled = false;
        t.dataset.in = adding ? '1' : '0';
        t.className = 'big' + (adding ? ' off' : '');
        t.textContent = adding ? '✓ В избранном — убрать' : '⭐ В избранное';
        toast(adding ? 'Добавлено — напомню заранее' : 'Убрано');
        loadList();
      }).catch(function () { t.disabled = false; toast('Не вышло, попробуйте ещё раз'); });
    return;
  }

  if (t.classList.contains('act')) {
    var payload = { mediaType: d.type, tmdbId: Number(d.id) };
    t.disabled = true;
    if (tg.HapticFeedback) tg.HapticFeedback.impactOccurred('light');
    if (d.act === 'add') {
      api('add', payload).then(function (res) {
        toast(res.ok ? 'Добавлено — напомню заранее' : 'Не вышло');
        t.textContent = '✓';
        loadList();
      }).catch(function () { toast('Не вышло, попробуйте ещё раз'); t.disabled = false; });
    } else {
      api('remove', payload).then(function () {
        toast('Убрано');
        t.closest('.row').remove();
        loadList();
      }).catch(function () { toast('Не вышло, попробуйте ещё раз'); t.disabled = false; });
    }
    return;
  }

  var openRow = t.closest && t.closest('[data-open]');
  if (openRow) {
    var ref = openRow.dataset.open.split(':');
    openSheet(ref[0], ref[1]);
  }
});

var searchTimer = null;
document.addEventListener('input', function (e) {
  if (e.target.id !== 'search') return;
  searchQuery = e.target.value.trim();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(function () {
    if (!searchQuery) { searchItems = []; render(); return; }
    var asked = searchQuery;
    api('search', { query: asked }).then(function (res) {
      if (asked !== searchQuery) return; // пока ждали ответ, пользователь допечатал
      searchItems = res.items || [];
      render();
    }).catch(function () { fail('Поиск не отвечает, попробуйте ещё раз.'); });
  }, 400);
});

// Подсказка, что список листается: пока внизу что-то есть, край притенён,
// а строка фильтров уезжает при листании вниз — чтобы не занимать экран.
var lastScroll = 0;
function onScroll() {
  var y = window.scrollY || document.documentElement.scrollTop;
  var bottom = document.body.scrollHeight - window.innerHeight - y;
  document.getElementById('edge').className = bottom > 24 ? 'edge on' : 'edge';
  var controls = document.getElementById('controls');
  var down = y > lastScroll && y > 80;
  if (!searching) controls.className = down ? 'away' : '';
  lastScroll = y;
}
document.addEventListener('scroll', onScroll, { passive: true });

renderControls();
loadFeed(true);
loadList();
setTimeout(onScroll, 300);
</script>
</body>
</html>`;

export function appPage() {
  const options = JSON.stringify({
    genres: GENRES.map((g) => ({ key: g.key, label: g.label })),
    countries: COUNTRIES.map((c) => ({ key: c.key, label: c.label })),
  });
  return new Response(HTML.replace('__FILTER_OPTIONS__', options), {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

// ---------------------------------------------------------------------------
// Проверка подписи initData
// ---------------------------------------------------------------------------

async function hmac(keyBytes, message) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
}

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Telegram подписывает initData ключом, производным от токена бота.
 * Без этой проверки любой мог бы дёрнуть наш API от чужого имени.
 */
async function verifyInitData(env, initData) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const check = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secret = await hmac(new TextEncoder().encode('WebAppData'), env.TELEGRAM_BOT_TOKEN);
  if (hex(await hmac(secret, check)) !== hash) return null;

  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Date.now() / 1000 - authDate > 86400) return null;

  try {
    return JSON.parse(params.get('user') || 'null');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// API мини-аппа
// ---------------------------------------------------------------------------

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8' },
});

/** Короткий синопсис: режем по концу предложения, а не по счётчику символов. */
function shortSynopsis(text, limit = 150) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean || clean.length <= limit) return clean || null;
  const head = clean.slice(0, limit + 1);
  const dot = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  if (dot > limit * 0.4) return head.slice(0, dot + 1);
  const space = head.lastIndexOf(' ');
  return `${clean.slice(0, space > limit * 0.4 ? space : limit).replace(/[\s,;:—-]+$/, '')}…`;
}

/** Рейтинги с подписями: IMDb — зрители, 🍅 — критики. */
function ratings(item) {
  const out = [];
  // КП — только у российского: у зарубежного есть IMDb и 🍅. По горстке голосов не показываем.
  if (isRussianItem(item) && item.kp_rating && (item.kp_votes == null || item.kp_votes >= 100)) {
    out.push(`КП ${Number(item.kp_rating).toFixed(1)}`);
  }
  if (item.imdb_rating) out.push(`IMDb ${Number(item.imdb_rating).toFixed(1)}`);
  else if (item.vote_average >= 1 && (item.vote_count || 0) >= 50) {
    out.push(`TMDB ${Number(item.vote_average).toFixed(1)}`);
  }
  if (item.rt_critics) out.push(`🍅 ${item.rt_critics}%`);
  return out;
}

function favoriteRow(item, todayIso) {
  const date = item.release_date ? item.release_date.slice(0, 10) : null;
  const days = date ? daysBetween(todayIso, date) : null;
  const bits = [];
  // У игры «тип релиза» — это подпись про точность даты («в декабре 2026»),
  // а в поле статуса лежат платформы.
  const vague = item.media_type === 'game' && /^в /.test(item.release_type || '');

  if (vague) {
    bits.push(item.release_type);
  } else if (date) {
    bits.push(formatDate(date, todayIso));
    if (days !== null && days >= 0) bits.push(humanCountdown(days));
  } else {
    bits.push('дата уточняется');
  }
  if (item.media_type === 'game') {
    if (item.status) bits.push(item.status);
  } else if (item.media_type === 'tv') {
    if (/^S\d/.test(item.release_type || '')) bits.push(item.release_type);
    if (['Ended', 'Canceled'].includes(item.status)) bits.push('завершён');
  } else if (item.release_type) {
    bits.push(kindWord(item.release_type));
    const other = item.theatrical_date === date ? item.digital_date : item.theatrical_date;
    const label = item.theatrical_date === date ? 'онлайн' : 'в кино';
    if (other && other !== date && other >= todayIso) {
      bits.push(`${label} ${formatDate(other, todayIso)}`);
    }
  }
  bits.push(...ratings(item));

  return {
    id: item.tmdb_id,
    media_type: item.media_type,
    title: item.title,
    poster: posterUrl(item.poster_path, 'w154'),
    meta: bits.join(' · '),
    cast: item.actors || null,
    desc: shortSynopsis(item.overview),
    day: date ? dayHeader(date, todayIso) : 'Дата пока неизвестна',
  };
}

/** «1 человек», «53 человека», «1058 человек». */
function people(n) {
  const last = n % 10;
  const teen = n % 100 >= 11 && n % 100 <= 14;
  if (!teen && last === 1) return 'человек';
  if (!teen && last >= 2 && last <= 4) return 'человека';
  return 'человек';
}

/** Карточка игры: всё из IGDB, включая даты по платформам. */
async function gameCard(env, budget, userId, gameId) {
  const game = await igdbById(env, budget, gameId);
  if (!game) return null;

  const todayIso = today(env);
  const { date, note } = igdbDate(game);
  const inList = await db.isFavorite(env, userId, gameId, 'game');

  const facts = [];
  if (note) facts.push(['Выход', note]);
  else if (date) {
    const days = daysBetween(todayIso, date);
    facts.push(['Выход', `${formatDate(date, todayIso)}${days >= 0 ? ` · ${humanCountdown(days)}` : ''}`]);
  }
  const platforms = igdbPlatforms(game);
  if (platforms) facts.push(['Платформы', platforms]);
  const genres = gameGenres(game);
  if (genres) facts.push(['Жанр', genres]);
  const studio = igdbStudio(game);
  if (studio) facts.push(['Разработчик', studio]);
  if (game.total_rating && (game.total_rating_count || 0) >= 5) {
    facts.push(['Оценка', `IGDB ${(Math.round(game.total_rating) / 10).toFixed(1)}`]);
  } else if (game.hypes) {
    facts.push(['Ждут', `${Number(game.hypes).toLocaleString('ru-RU')} ${people(game.hypes)}`]);
  }

  // Даты по платформам показываем, только если они расходятся: иначе это шум.
  // У платформы бывает несколько записей (разные регионы) — берём самую раннюю.
  const earliest = new Map();
  for (const r of game.release_dates || []) {
    const name = r.platform?.abbreviation;
    if (!r.date || !name) continue;
    if (!earliest.has(name) || r.date < earliest.get(name)) earliest.set(name, r.date);
  }
  if (new Set(earliest.values()).size > 1) {
    const sorted = [...earliest].sort((a, b) => a[1] - b[1]).slice(0, 6);
    for (const [name, seconds] of sorted) {
      facts.push([name, formatDate(new Date(seconds * 1000).toISOString().slice(0, 10), todayIso)]);
    }
  }

  return {
    id: gameId,
    media_type: 'game',
    title: game.name,
    original: null,
    poster: igdbCover(game),
    backdrop: null,
    facts,
    overview: (game.summary || '').trim() || null,
    inList,
    tmdb: igdbUrl(gameId),
    source: 'IGDB',
    cast: [],
    stills: [],
  };
}

/** Карточка тайтла из Кинопоиска (отрицательный id) — в том же виде, что из TMDB. */
async function kpTitleCard(env, budget, userId, mediaType, tmdbId) {
  const doc = await kpById(env, budget, -tmdbId);
  if (!doc) return null;

  const todayIso = today(env);
  const series = kpIsSeries(doc);
  const date = kpReleaseDate(doc, todayIso);
  const inList = await db.isFavorite(env, userId, tmdbId, mediaType);

  const facts = [];
  if (date.release_date) {
    const days = daysBetween(todayIso, date.release_date);
    const when = `${formatDate(date.release_date, todayIso)}${days >= 0 ? ` · ${humanCountdown(days)}` : ''}`;
    facts.push([series ? 'Премьера' : date.release_type, when]);
  }
  if (!series && date.theatrical_date && date.theatrical_date !== date.release_date) {
    facts.push(['В кино', formatDate(date.theatrical_date, todayIso)]);
  }
  if (date.digital_date && date.digital_date !== date.release_date) {
    facts.push(['Онлайн', formatDate(date.digital_date, todayIso)]);
  }

  const genres = (doc.genres || []).map((g) => g.name).join(', ');
  if (genres) facts.push(['Жанр', genres.toLowerCase()]);

  const length = doc.movieLength || doc.seriesLength;
  if (length) {
    const h = Math.floor(length / 60);
    const m = length % 60;
    facts.push([series ? 'Серия' : 'Длительность', h ? `${h} ч ${m} мин` : `${m} мин`]);
  }

  const persons = doc.persons || [];
  const director = persons.filter((p) => p.enProfession === 'director' && p.name)
    .slice(0, 2).map((p) => p.name).join(', ');
  if (director) facts.push(['Режиссёр', director]);

  const rate = ratings({
    tmdb_id: tmdbId,
    kp_rating: doc.rating?.kp ? Math.round(doc.rating.kp * 10) / 10 : null,
    kp_votes: doc.votes?.kp || 0,
    imdb_rating: doc.rating?.imdb || null,
  });
  if (rate.length) facts.push(['Рейтинг', rate.join(' · ')]);

  return {
    id: tmdbId,
    media_type: mediaType,
    title: doc.name || doc.alternativeName,
    original: doc.alternativeName && doc.alternativeName !== doc.name ? doc.alternativeName : null,
    poster: doc.poster?.previewUrl || doc.poster?.url || null,
    backdrop: doc.backdrop?.url || null,
    facts,
    overview: (doc.description || doc.shortDescription || '').trim() || null,
    inList,
    tmdb: tmdbUrl(mediaType, tmdbId),
    source: 'Кинопоиск',
    cast: persons.filter((p) => p.enProfession === 'actor' && p.name).slice(0, 10).map((p) => ({
      name: p.name,
      role: p.description || null,
      photo: p.photo || null,
    })),
    stills: [],
  };
}

/** Полная карточка тайтла: один запрос к TMDB на открытие. */
async function titleCard(env, budget, userId, mediaType, tmdbId) {
  if (tmdbId < 0) return kpTitleCard(env, budget, userId, mediaType, tmdbId);
  const details = await getDetails(env, budget, mediaType, tmdbId, true, true);
  if (!details) return null;

  const todayIso = today(env);
  const date = await resolveDate(env, budget, details, todayIso);
  const meta = await ensureRatings(env, budget, details, tmdbId, mediaType);
  const inList = await db.isFavorite(env, userId, tmdbId, mediaType);

  const facts = [];
  if (date.release_date) {
    const days = daysBetween(todayIso, date.release_date);
    const when = `${formatDate(date.release_date, todayIso)}${days >= 0 ? ` · ${humanCountdown(days)}` : ''}`;
    const label = mediaType === 'tv' ? 'Ближайшая серия' : (kindWord(date.release_type) || 'Релиз');
    facts.push([label.charAt(0).toUpperCase() + label.slice(1), when]);
  }
  if (date.theatrical_date && date.theatrical_date !== date.release_date) {
    facts.push(['В кино', formatDate(date.theatrical_date, todayIso)]);
  }
  if (date.digital_date && date.digital_date !== date.release_date) {
    facts.push(['Онлайн', formatDate(date.digital_date, todayIso)]);
  }

  const genres = (details.genres || []).map((g) => g.name).join(', ');
  if (genres) facts.push(['Жанр', genres.toLowerCase()]);

  if (mediaType === 'movie' && details.runtime) {
    const h = Math.floor(details.runtime / 60);
    const m = details.runtime % 60;
    facts.push(['Длительность', h ? `${h} ч ${m} мин` : `${m} мин`]);
  }
  if (mediaType === 'tv') {
    const parts = [];
    if (details.number_of_seasons) parts.push(`сезонов: ${details.number_of_seasons}`);
    if (details.number_of_episodes) parts.push(`серий: ${details.number_of_episodes}`);
    if (['Ended', 'Canceled'].includes(details.status)) parts.push('завершён');
    if (parts.length) facts.push(['Сериал', parts.join(' · ')]);
  }

  const director = mediaType === 'movie'
    ? (details.credits?.crew || []).find((c) => c.job === 'Director')?.name
    : (details.created_by || []).map((c) => c.name).join(', ');
  if (director) facts.push([mediaType === 'movie' ? 'Режиссёр' : 'Автор', director]);

  const rate = ratings({
    ...meta,
    tmdb_id: tmdbId,
    is_russian: details.original_language === 'ru' || (details.origin_country || []).includes('RU'),
    vote_average: details.vote_average,
    vote_count: details.vote_count,
  });
  if (rate.length) facts.push(['Рейтинг', rate.join(' · ')]);

  return {
    id: tmdbId,
    media_type: mediaType,
    title: titleOf(details),
    original: details.original_title || details.original_name || null,
    poster: posterUrl(details.poster_path, 'w342'),
    backdrop: posterUrl(details.backdrop_path, 'w780'),
    facts,
    overview: pickOverview(details),
    inList,
    tmdb: tmdbUrl(mediaType, tmdbId),
    cast: (details.credits?.cast || []).slice(0, 10).map((person) => ({
      name: person.name,
      role: person.character || null,
      photo: posterUrl(person.profile_path, 'w185'),
    })),
    stills: (details.images?.backdrops || []).slice(0, 8)
      .map((b) => posterUrl(b.file_path, 'w500'))
      .filter(Boolean),
  };
}

/** Сохранённый выбор фильтров — только известные ключи. */
async function readFilters(env, userId) {
  const saved = await db.getFilters(env, userId);
  return {
    genres: parseFilter(saved.genres, 'genres'),
    countries: parseFilter(saved.countries, 'countries'),
    games: await db.getShowGames(env, userId),
  };
}

export async function handleApi(request, env, budget, method) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'bad request' }, 400);
  }

  const user = await verifyInitData(env, body.initData);
  if (!user?.id) return json({ error: 'unauthorized' }, 401);

  const userId = user.id;
  const todayIso = today(env);
  await db.ensureUser(env, userId);

  const mediaType = ['tv', 'game'].includes(body.mediaType) ? body.mediaType : 'movie';
  const tmdbId = Number(body.tmdbId);

  if (method === 'list') {
    const favorites = await db.listFavorites(env, userId);
    const upcoming = [];
    const released = [];
    for (const item of favorites) {
      const date = item.release_date ? item.release_date.slice(0, 10) : null;
      (date && date < todayIso ? released : upcoming).push(item);
    }
    upcoming.sort((a, b) => String(a.release_date || '9999').localeCompare(String(b.release_date || '9999')));
    released.sort((a, b) => String(b.release_date).localeCompare(String(a.release_date)));
    return json({
      hideRussian: await db.getHideRussian(env, userId),
      ...(await readFilters(env, userId)),
      upcoming: upcoming.map((i) => favoriteRow(i, todayIso)),
      released: released.map((i) => favoriteRow(i, todayIso)),
    });
  }

  const card = (item, bits) => ({
    id: item.tmdb_id,
    media_type: item.media_type,
    title: item.title,
    poster: posterUrl(item.poster_path, 'w154'),
    meta: [...bits, ...ratings(item)].filter(Boolean).join(' · '),
    cast: item.actors || null,
    desc: shortSynopsis(item.overview),
  });
  const type = ['a', 'm', 't', 'g'].includes(body.type) ? body.type : 'a';
  const episodes = Boolean(body.episodes);
  // Настройка хранится у пользователя, а не в запросе: одинакова на всех устройствах.
  const hideRussian = await db.getHideRussian(env, userId);
  const { genres, countries, games } = await readFilters(env, userId);

  if (method === 'settings') {
    if (typeof body.hideRussian === 'boolean') await db.setHideRussian(env, userId, body.hideRussian);
    if (typeof body.games === 'boolean') await db.setShowGames(env, userId, body.games);
    if (Array.isArray(body.genres) || Array.isArray(body.countries)) {
      await db.setFilters(env, userId, {
        genres: parseFilter((body.genres || []).join(','), 'genres'),
        countries: parseFilter((body.countries || []).join(','), 'countries'),
      });
    }
    return json({
      hideRussian: await db.getHideRussian(env, userId),
      ...(await readFilters(env, userId)),
    });
  }

  if (method === 'feed') {
    const page = Math.max(1, Math.min(30, Number(body.page) || 1));
    const { items, hasMore } = await readFeed(env, {
      type, page, size: 12, episodes, hideRussian, genres, countries, games,
    });
    return json({
      hasMore,
      items: items.map((item) => {
        const days = daysBetween(todayIso, item.release_date);
        // У игры дата бывает известна с точностью до месяца или квартала — тогда вместо
        // числа стоит подпись вроде «в декабре 2026», выдумывать день нечестно.
        const vague = item.media_type === 'game' ? item.date_note : null;
        const bits = vague
          ? [vague]
          : [formatDate(item.release_date, todayIso), humanCountdown(days)];
        // Платформа: у игры консоли, у сериала — Netflix, Disney+ и прочие.
        if (item.platforms) bits.push(item.platforms);
        if (item.episode_label) bits.push(item.episode_label);
        else if (item.media_type === 'tv' && item.episode_code) {
          // E00 у TMDB — спецвыпуск вне основной нумерации.
          bits.push(/E00$/.test(item.episode_code) ? 'спецвыпуск' : `серия ${item.episode_code}`);
        } else if (item.release_kind) bits.push(kindWord(item.release_kind));
        if (item.digital_date && item.digital_date !== item.release_date
          && item.digital_date >= todayIso) {
          bits.push(`онлайн ${formatDate(item.digital_date, todayIso)}`);
        }
        // У премьеры сериала полезно знать, сколько всего серий.
        if (item.media_type === 'tv' && item.is_premiere && item.date_note) bits.push(item.date_note);
        return card(item, bits);
      }),
    });
  }

  if (method === 'recent') {
    const recent = await readRecent(env, {
      type, episodes, limit: 40, hideRussian, genres, countries, games,
    });
    return json({
      items: recent.map((item) => {
        const days = daysBetween(todayIso, item.recent_date);
        const bits = [days === -1 ? 'вчера' : formatDate(item.recent_date, todayIso), item.recent_label];
        if (item.platforms) bits.push(item.platforms);
        return card(item, bits);
      }),
    });
  }

  if (method === 'search') {
    const query = String(body.query || '');
    const { results } = await smartSearch(env, budget, query);
    // Российское из Кинопоиска ищем по своему каталогу: запросов к API это не стоит.
    const needle = normalizeTitle(query);
    const { results: kpRows } = needle.length < 2 ? { results: [] } : await env.DB.prepare(
      'SELECT tmdb_id, media_type, title, poster_path, overview, first_year FROM catalog WHERE tmdb_id < 0',
    ).all();
    const russian = (kpRows || [])
      .filter((r) => normalizeTitle(r.title).includes(needle))
      .slice(0, 5)
      .map((r) => ({
        id: r.tmdb_id,
        media_type: r.media_type,
        title: r.title,
        poster: posterUrl(r.poster_path, 'w154'),
        meta: [r.media_type === 'tv' ? 'сериал' : 'фильм', r.first_year].filter(Boolean).join(' · '),
        desc: shortSynopsis(r.overview, 120),
      }));
    return json({
      items: [...russian, ...results.slice(0, 12 - russian.length).map((item) => {
        const type = item.media_type === 'tv' ? 'tv' : 'movie';
        return {
          id: item.id,
          media_type: type,
          title: titleOf(item),
          poster: posterUrl(item.poster_path, 'w154'),
          meta: [type === 'tv' ? 'сериал' : 'фильм', year(item)].filter(Boolean).join(' · '),
          desc: shortSynopsis(item.overview, 120),
        };
      })],
    });
  }

  if (method === 'title') {
    if (!tmdbId) return json({ error: 'bad id' }, 400);
    const card = mediaType === 'game'
      ? await gameCard(env, budget, userId, tmdbId)
      : await titleCard(env, budget, userId, mediaType, tmdbId);
    return card ? json(card) : json({ error: 'not found' }, 404);
  }

  if (method === 'add') {
    if (!tmdbId) return json({ error: 'bad id' }, 400);
    const res = await addTitle(env, budget, userId, mediaType, tmdbId);
    if (res.ok) await db.recordDigestDecision(env, userId, tmdbId, mediaType, 'added');
    return json({ ok: Boolean(res.ok) });
  }

  if (method === 'remove') {
    if (!tmdbId) return json({ error: 'bad id' }, 400);
    await db.removeFavorite(env, userId, tmdbId, mediaType);
    return json({ ok: true });
  }

  return json({ error: 'unknown method' }, 404);
}
