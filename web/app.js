'use strict';

// ===== Constants =====
const STORAGE_KEY = 'french_study_progress';
const MASTERY_THRESHOLD = 3;   // correct answers needed
const SPACED_REPETITION  = 5;  // sessions before mastered item resurfaces
const SESSION_SIZE       = 17; // target questions per session

// ===== State =====
let concepts  = [];   // all concepts from knowledge.json
let progress  = null; // { session_count, concepts: { id: {correct,wrong,streak,last_session} } }

// Quiz session state
let sessionConcepts    = [];
let sessionIdx         = 0;
let sessionResults     = [];   // { concept, correct }
let currentQuestion    = null; // { prompt, answer, concept, direction }
let waitingForNext     = false;

// Flashcard state
let fcConcepts = [];
let fcIdx      = 0;
let fcFlipped  = false;

// ===== Boot =====
document.addEventListener('DOMContentLoaded', init);

async function init() {
  showView('loading');
  setLoadingText('Loading concepts…');

  try {
    const res = await fetch('/data/knowledge.json');
    if (!res.ok) throw new Error('Cannot load knowledge.json');
    concepts = await res.json();
  } catch (e) {
    setLoadingText('❌ Could not load /data/knowledge.json.\nMake sure you ran: python3 -m http.server 8080 from the project folder.');
    return;
  }

  progress = loadProgress();

  // First-load migration: try to pull from data/progress.json if localStorage is empty
  if (!progress) {
    progress = { session_count: 0, concepts: {} };
    try {
      const r = await fetch('/data/progress.json');
      if (r.ok) {
        const remote = await r.json();
        progress = remote;
        saveProgress(progress);
      }
    } catch (_) { /* ignore */ }
    saveProgress(progress);
  }

  bindNavButtons();
  bindDashboardButtons();
  bindQuizButtons();
  bindFlashcardButtons();
  bindSummaryButtons();

  showView('dashboard');
  renderDashboard();
}

// ===== Storage =====
function loadProgress() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) { return null; }
}

function saveProgress(p) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
}

// ===== Stats =====
function getStats(cnpts, prog) {
  let mastered = 0, learning = 0, newItems = 0;
  for (const c of cnpts) {
    const p = prog.concepts[c.id];
    if (!p) { newItems++; continue; }
    if (isMastered(p)) { mastered++; }
    else { learning++; }
  }
  return { mastered, learning, new: newItems, total: cnpts.length };
}

function isMastered(p) {
  return p && p.correct >= MASTERY_THRESHOLD;
}

// ===== Concept Selection =====
function selectConcepts(cnpts, prog, n = SESSION_SIZE) {
  const session = prog.session_count;
  const pools = { p1: [], p2: [], p3: [], p4: [] };

  for (const c of cnpts) {
    const p = prog.concepts[c.id];
    if (!p) {
      pools.p1.push(c);  // never tested
    } else if (isMastered(p)) {
      // mastered: resurface only if 5+ sessions have passed
      if (session - p.last_session >= SPACED_REPETITION) {
        pools.p4.push(c);
      }
      // else skip entirely
    } else if (p.wrong > 0 && p.streak === 0) {
      pools.p2.push(c);  // got wrong recently
    } else {
      pools.p3.push(c);  // learning, low streak
    }
  }

  // shuffle each pool
  for (const k of Object.keys(pools)) shuffle(pools[k]);

  const result = [];
  // fill in priority order
  for (const pool of [pools.p1, pools.p2, pools.p3, pools.p4]) {
    for (const c of pool) {
      if (result.length >= n) break;
      result.push(c);
    }
    if (result.length >= n) break;
  }

  // if still short, add more from p3 (learning) that weren't already picked
  if (result.length < n) {
    const picked = new Set(result.map(c => c.id));
    for (const c of pools.p3) {
      if (result.length >= n) break;
      if (!picked.has(c.id)) result.push(c);
    }
  }

  return result;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// ===== Question Generation =====
function generateQuestion(concept) {
  const type = concept.type;
  let prompt, answer, direction = null;

  if (type === 'conjugation') {
    prompt = `Conjugate this verb — type all 6 forms separated by commas\n(je…, tu…, il/elle…, nous…, vous…, ils/elles…):\n\n${concept.french}`;
    answer = concept.context;
    direction = 'conjugation';
  } else if (type === 'grammar') {
    // Always FR → EN for grammar (show the rule, ask what it means)
    prompt = `Grammar — what does this mean in English?\n\n${concept.french}`;
    answer = concept.english;
    direction = 'fr→en';
  } else {
    // vocabulary or expression: random direction
    if (Math.random() < 0.5) {
      prompt = `Translate to English:\n\n${concept.french}`;
      answer = concept.english;
      direction = 'fr→en';
    } else {
      prompt = `Translate to French:\n\n${concept.english}`;
      answer = concept.french;
      direction = 'en→fr';
    }
  }

  return { prompt, answer, concept, direction };
}

// ===== Answer Checking =====
function normalize(str) {
  return str
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

// Strip parenthetical notes: "please (informal)" → "please"
function stripParens(str) {
  return str.replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
}

// Levenshtein distance for typo tolerance
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0)
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

function checkAnswer(userInput, expected) {
  const nu      = normalize(userInput);
  const nuClean = normalize(stripParens(userInput));

  // Build list of all valid forms from expected:
  // split by " / " or " | " to get alternatives, then check each
  // both with and without parenthetical notes
  const candidates = new Set();
  const parts = expected.split(/\s*[\/|]\s*/);
  for (const part of parts) {
    candidates.add(normalize(part));
    candidates.add(normalize(stripParens(part)));
  }
  candidates.add(normalize(expected));
  candidates.add(normalize(stripParens(expected)));

  // 1. Exact or cleaned match against any candidate
  for (const c of candidates) {
    if (nu === c || nuClean === c) return true;
  }

  // 2. Typo tolerance for single-word answers (no spaces)
  if (!nu.includes(' ')) {
    for (const c of candidates) {
      if (c.includes(' ')) continue; // only compare single words
      const len = Math.max(nu.length, c.length);
      const maxDist = len <= 3 ? 0 : len <= 6 ? 1 : 2;
      if (levenshtein(nu, c) <= maxDist) return true;
    }
  }

  return false;
}

// For conjugation: compare form by form, return { correct: bool, details: [{form, ok}] }
function checkConjugation(userInput, expected) {
  const userForms = userInput.split(',').map(s => s.trim());
  const expForms  = expected.split(',').map(s => s.trim());

  const details = expForms.map((ef, i) => {
    const uf = userForms[i] || '';
    return { form: ef, ok: normalize(uf) === normalize(ef) };
  });

  const allCorrect = details.every(d => d.ok);
  return { correct: allCorrect, details };
}

// ===== Progress Update =====
function updateProgress(prog, conceptId, correct) {
  if (!prog.concepts[conceptId]) {
    prog.concepts[conceptId] = { correct: 0, wrong: 0, streak: 0, last_session: 0 };
  }
  const p = prog.concepts[conceptId];
  p.last_session = prog.session_count;
  if (correct) {
    p.correct++;
    p.streak++;
  } else {
    p.wrong++;
    p.streak = 0;
  }
}

// ===== Routing / Views =====
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  const el = document.getElementById(`view-${name}`);
  if (el) el.classList.remove('hidden');

  // update nav active state
  document.querySelectorAll('.nav-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.view === name);
  });
}

function setLoadingText(msg) {
  document.getElementById('loading-text').textContent = msg;
}

// ===== Nav Bindings =====
function bindNavButtons() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      if (view === 'status') {
        renderStatus();
      } else if (view === 'mistakes') {
        renderMistakes();
      } else if (view === 'dashboard') {
        renderDashboard();
      }
      showView(view);
    });
  });
}

// ===== Dashboard =====
function bindDashboardButtons() {
  document.getElementById('btn-study').addEventListener('click', startQuiz);
  document.getElementById('btn-flashcards').addEventListener('click', startFlashcards);
}

function renderDashboard() {
  const stats = getStats(concepts, progress);
  const pct = stats.total ? Math.round((stats.mastered / stats.total) * 100) : 0;

  document.getElementById('db-bar').style.width = pct + '%';
  document.getElementById('db-label').textContent =
    `Session #${progress.session_count} | ${pct}% mastered (${stats.mastered}/${stats.total} concepts)`;
  document.getElementById('db-mastered').textContent = `🟢 Mastered: ${stats.mastered}`;
  document.getElementById('db-learning').textContent = `🟡 Learning: ${stats.learning}`;
  document.getElementById('db-new').textContent = `🔴 New: ${stats.new}`;
}

// ===== Quiz =====
function bindQuizButtons() {
  document.getElementById('quiz-submit').addEventListener('click', submitAnswer);
  document.getElementById('quiz-next').addEventListener('click', advanceQuiz);

  document.getElementById('quiz-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (waitingForNext) advanceQuiz();
      else submitAnswer();
    }
  });
}

function startQuiz() {
  if (concepts.length === 0) return;

  // increment session count
  progress.session_count++;
  saveProgress(progress);

  sessionConcepts = selectConcepts(concepts, progress);
  sessionIdx      = 0;
  sessionResults  = [];
  waitingForNext  = false;

  if (sessionConcepts.length === 0) {
    alert('All concepts mastered! Well done! 🎉');
    return;
  }

  showView('quiz');
  renderQuizQuestion();
}

function renderQuizQuestion() {
  const concept = sessionConcepts[sessionIdx];
  currentQuestion = generateQuestion(concept);

  // progress bar
  const pct = (sessionIdx / sessionConcepts.length) * 100;
  document.getElementById('quiz-progress-fill').style.width = pct + '%';
  document.getElementById('quiz-progress-label').textContent =
    `${sessionIdx + 1} / ${sessionConcepts.length}`;

  // badge
  const badgeLabels = {
    'fr→en': 'French → English',
    'en→fr': 'English → French',
    'conjugation': 'Conjugation',
  };
  document.getElementById('quiz-type-badge').textContent =
    badgeLabels[currentQuestion.direction] || concept.type;

  // prompt
  document.getElementById('quiz-prompt').textContent = currentQuestion.prompt;

  // reset input and feedback
  const input = document.getElementById('quiz-input');
  input.value = '';
  input.disabled = false;

  document.getElementById('quiz-submit').disabled = false;
  document.getElementById('quiz-feedback').classList.add('hidden');
  document.getElementById('quiz-answer-area').classList.remove('hidden');

  waitingForNext = false;
  input.focus();
}

function submitAnswer() {
  if (waitingForNext) return;
  const input = document.getElementById('quiz-input');
  const userInput = input.value.trim();
  if (!userInput) return;

  input.disabled = true;
  document.getElementById('quiz-submit').disabled = true;

  const concept = currentQuestion.concept;
  let correct, feedbackHtml;

  if (currentQuestion.direction === 'conjugation') {
    const result = checkConjugation(userInput, currentQuestion.answer);
    correct = result.correct;
    // build detail display
    const detailLines = result.details.map(d =>
      `${d.ok ? '✓' : '✗'} ${d.form}`
    ).join(' | ');
    feedbackHtml = result.correct
      ? null
      : `Correct forms: <strong>${currentQuestion.answer}</strong><br><small>${detailLines}</small>`;
  } else {
    correct = checkAnswer(userInput, currentQuestion.answer);
    feedbackHtml = correct ? null : `Correct answer: <strong>${currentQuestion.answer}</strong>`;
  }

  // update progress
  updateProgress(progress, concept.id, correct);
  saveProgress(progress);
  sessionResults.push({ concept, correct });

  // show feedback
  const fb = document.getElementById('quiz-feedback');
  const fbResult = document.getElementById('quiz-feedback-result');
  const fbAnswer = document.getElementById('quiz-feedback-answer');
  const fbContext = document.getElementById('quiz-feedback-context');

  fbResult.textContent = correct ? '✓ Correct!' : '✗ Incorrect';
  fbResult.className = 'feedback-result ' + (correct ? 'correct' : 'wrong');

  if (feedbackHtml) {
    fbAnswer.innerHTML = feedbackHtml;
    fbAnswer.classList.remove('hidden');
  } else {
    fbAnswer.classList.add('hidden');
  }

  if (!correct && concept.context) {
    fbContext.textContent = concept.context;
    fbContext.classList.remove('hidden');
  } else {
    fbContext.classList.add('hidden');
  }

  document.getElementById('quiz-answer-area').classList.add('hidden');
  fb.classList.remove('hidden');
  waitingForNext = true;

  document.getElementById('quiz-next').focus();
}

function advanceQuiz() {
  sessionIdx++;
  if (sessionIdx >= sessionConcepts.length) {
    renderSummary(sessionResults);
    showView('summary');
  } else {
    renderQuizQuestion();
  }
}

// ===== Flashcards =====
function bindFlashcardButtons() {
  document.getElementById('fc-flip').addEventListener('click', flipFlashcard);
  document.getElementById('fc-correct').addEventListener('click', () => markFlashcard(true));
  document.getElementById('fc-wrong').addEventListener('click', () => markFlashcard(false));
  document.getElementById('fc-scene').addEventListener('click', flipFlashcard);

  document.addEventListener('keydown', e => {
    const view = document.getElementById('view-flashcards');
    if (view.classList.contains('hidden')) return;
    if (e.key === ' ') { e.preventDefault(); flipFlashcard(); }
    if (e.key === 'ArrowRight') markFlashcard(true);
    if (e.key === 'ArrowLeft')  markFlashcard(false);
  });
}

function startFlashcards() {
  if (concepts.length === 0) return;

  progress.session_count++;
  saveProgress(progress);

  fcConcepts = selectConcepts(concepts, progress, 20);
  fcIdx      = 0;
  fcFlipped  = false;

  if (fcConcepts.length === 0) {
    alert('All concepts mastered! Well done! 🎉');
    return;
  }

  showView('flashcards');
  renderFlashcard();
}

function renderFlashcard() {
  const concept = fcConcepts[fcIdx];

  // progress
  const pct = (fcIdx / fcConcepts.length) * 100;
  document.getElementById('fc-progress-fill').style.width = pct + '%';
  document.getElementById('fc-progress-label').textContent = `${fcIdx + 1} / ${fcConcepts.length}`;

  // card content — always show FR on front, EN on back
  document.getElementById('fc-type-badge').textContent = concept.type;
  document.getElementById('fc-front-text').textContent = concept.french;
  document.getElementById('fc-back-text').textContent  = concept.english;
  document.getElementById('fc-back-context').textContent = concept.context || '';

  // reset flip
  const card = document.getElementById('fc-card');
  card.classList.remove('flipped');
  fcFlipped = false;
}

function flipFlashcard() {
  const card = document.getElementById('fc-card');
  fcFlipped = !fcFlipped;
  card.classList.toggle('flipped', fcFlipped);
}

function markFlashcard(correct) {
  const concept = fcConcepts[fcIdx];
  updateProgress(progress, concept.id, correct);
  saveProgress(progress);

  fcIdx++;
  if (fcIdx >= fcConcepts.length) {
    showView('dashboard');
    renderDashboard();
  } else {
    renderFlashcard();
  }
}

// ===== Status =====
function renderStatus() {
  const stats = getStats(concepts, progress);
  const pct = stats.total ? Math.round((stats.mastered / stats.total) * 100) : 0;

  document.getElementById('st-bar').style.width = pct + '%';
  document.getElementById('st-label').textContent =
    `Session #${progress.session_count} | ${pct}% mastered (${stats.mastered}/${stats.total} concepts)`;
  document.getElementById('st-mastered').textContent = `🟢 Mastered: ${stats.mastered}`;
  document.getElementById('st-learning').textContent = `🟡 Learning: ${stats.learning}`;
  document.getElementById('st-new').textContent = `🔴 New: ${stats.new}`;

  // Class breakdown
  const classMap = {};
  for (const c of concepts) {
    // extract class name from source: "class 1.txt" → "Classe 1"
    const match = c.source.match(/class\s*(\d+)/i);
    const key = match ? `Classe ${parseInt(match[1], 10)}` : c.source;
    if (!classMap[key]) classMap[key] = [];
    classMap[key].push(c);
  }

  const classTbody = document.getElementById('st-class-tbody');
  classTbody.innerHTML = '';

  for (const [className, items] of Object.entries(classMap).sort()) {
    const s = getStats(items, progress);
    const p = items.length ? Math.round((s.mastered / items.length) * 100) : 0;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${className}</td>
      <td>${items.length}</td>
      <td>${s.mastered}</td>
      <td>${s.learning}</td>
      <td>${s.new}</td>
      <td class="pct-cell">${p}%</td>
    `;
    classTbody.appendChild(tr);
  }

  // Type breakdown
  const typeMap = {};
  for (const c of concepts) {
    if (!typeMap[c.type]) typeMap[c.type] = [];
    typeMap[c.type].push(c);
  }

  const typeTbody = document.getElementById('st-type-tbody');
  typeTbody.innerHTML = '';

  const typeLabels = {
    vocabulary: 'Vocabulaire',
    grammar: 'Grammaire',
    conjugation: 'Conjugaison',
    expression: 'Expressions',
    culture: 'Culture',
  };

  for (const [type, items] of Object.entries(typeMap)) {
    const s = getStats(items, progress);
    const p = items.length ? Math.round((s.mastered / items.length) * 100) : 0;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${typeLabels[type] || type}</td>
      <td>${items.length}</td>
      <td>${s.mastered}</td>
      <td class="pct-cell">${p}%</td>
    `;
    typeTbody.appendChild(tr);
  }
}

// ===== Mistakes =====
function renderMistakes() {
  const struggling = concepts.filter(c => {
    const p = progress.concepts[c.id];
    return p && p.wrong >= 2;
  }).sort((a, b) => {
    const pa = progress.concepts[a.id];
    const pb = progress.concepts[b.id];
    return pb.wrong - pa.wrong;
  });

  const subtitle = document.getElementById('mistakes-subtitle');
  const list = document.getElementById('mistakes-list');

  subtitle.textContent = `${struggling.length} concept${struggling.length !== 1 ? 's' : ''} with 2+ mistakes`;
  list.innerHTML = '';

  if (struggling.length === 0) {
    list.innerHTML = '<p class="mistakes-empty">No repeated mistakes — keep it up! 🎉</p>';
    return;
  }

  for (const c of struggling) {
    const p = progress.concepts[c.id];
    const card = document.createElement('div');
    card.className = 'mistake-card';
    card.innerHTML = `
      <div class="mistake-card-header">
        <span class="mistake-french">${escHtml(c.french)}</span>
        <span class="mistake-score">✗ ${p.wrong} mistake${p.wrong > 1 ? 's' : ''}</span>
      </div>
      <div class="mistake-english">${escHtml(c.english)}</div>
      ${c.context ? `<div class="mistake-context">${escHtml(c.context)}</div>` : ''}
      <span class="mistake-type-badge">${c.type}</span>
    `;
    list.appendChild(card);
  }
}

// ===== Summary =====
function bindSummaryButtons() {
  document.getElementById('sum-home').addEventListener('click', () => {
    renderDashboard();
    showView('dashboard');
  });
}

function renderSummary(results) {
  const correct = results.filter(r => r.correct).length;
  const wrong   = results.length - correct;
  const pct     = results.length ? Math.round((correct / results.length) * 100) : 0;

  document.getElementById('sum-correct').textContent = correct;
  document.getElementById('sum-wrong').textContent   = wrong;
  document.getElementById('sum-pct').textContent     = pct + '%';

  // Wrong list
  const wrongItems = results.filter(r => !r.correct);
  const wrongWrap  = document.getElementById('sum-wrong-list-wrap');
  const wrongList  = document.getElementById('sum-wrong-list');
  if (wrongItems.length > 0) {
    wrongList.innerHTML = wrongItems.map(r => `
      <div class="summary-list-item wrong-item">
        <span class="sum-item-fr">${escHtml(r.concept.french)}</span>
        <span class="sum-item-en">${escHtml(r.concept.english)}</span>
      </div>
    `).join('');
    wrongWrap.classList.remove('hidden');
  } else {
    wrongWrap.classList.add('hidden');
  }

  // Correct list
  const correctItems = results.filter(r => r.correct);
  const correctWrap  = document.getElementById('sum-correct-list-wrap');
  const correctList  = document.getElementById('sum-correct-list');
  if (correctItems.length > 0) {
    correctList.innerHTML = correctItems.map(r => `
      <div class="summary-list-item correct-item">
        <span class="sum-item-fr">${escHtml(r.concept.french)}</span>
        <span class="sum-item-en">${escHtml(r.concept.english)}</span>
      </div>
    `).join('');
    correctWrap.classList.remove('hidden');
  } else {
    correctWrap.classList.add('hidden');
  }
}

// ===== Utils =====
function escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
