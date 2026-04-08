#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

// ─── Configuration ──────────────────────────────────────────────────────────

const GOLDSTONE = '/Users/anna/Documents/claude/data/goldstone/derivative';
const DAILY_LOGS = '/Users/anna/Projects/Development/track/data/daily-logs';
const PRIOR_ARCHIVE = '/Users/anna/Documents/claude/prior archive';

const START_DATE = '2025-08-01';

// ─── Privacy safeguards ─────────────────────────────────────────────────────

const HARD_EXCLUDE_FILENAMES = [
  'transformation', 'sensitive-issues', 'trauma-pt-indian',
  'psychosocial-assessment', 'personal-profile-summary'
];

const CONTENT_EXCLUDE_KEYWORDS = [
  'bicalutamide', 'casodex', 'gender identity', 'gender transition',
  'transitioning', 'HRT', 'hormone replacement', 'sexuality',
  'sexual orientation', 'dysphoria', 'sex reassignment',
  'gender affirming', 'gender-affirming'
];

const MEDICATION_EXCLUDE = ['bicalutamide'];

// ─── Sentiment lexicons ─────────────────────────────────────────────────────

const POSITIVE_WORDS = [
  'flow', 'focused', 'managed', 'finished', 'proud', 'breakthrough',
  'completed', 'accomplished', 'productive', 'good', 'great', 'excellent',
  'clear', 'energized', 'motivated', 'calm', 'steady', 'progress',
  'happy', 'excited', 'confident', 'strong', 'achieved', 'succeeded',
  'nailed', 'crushed', 'solid', 'smooth', 'satisfying', 'relief'
];

const NEGATIVE_WORDS = [
  'scattered', 'frustrated', 'exhausted', 'crashed', 'anxious', 'guilty',
  'struggling', 'tired', 'overwhelmed', 'distracted', 'unfocused',
  'stressed', 'angry', 'sad', 'depressed', 'hopeless', 'shame',
  'failed', 'couldn\'t', 'can\'t', 'terrible', 'awful', 'drained',
  'sluggish', 'numb', 'lost', 'scared', 'panic', 'crying', 'cried',
  'hurt', 'pain', 'sick', 'nauseous', 'dizzy', 'headache'
];

const KEYWORD_VALENCE = {
  'on-a-roll': 2, 'hyperfocused': 2, 'task-complete': 1, 'low-friction': 1,
  'social-fuel': 1, 'med-peak': 0.5,
  'scattered': -1, 'high-friction': -1.5, 'intention-gap': -1,
  'abandoned': -2, 'guilt-spike': -2, 'crashed': -2, 'anxious': -1.5,
  'sluggish': -1, 'pivoted': -0.5, 'overrun': -0.5,
  'med-fading': -0.5, 'med-absent': -0.5, 'med-unclear': 0,
  'night-owl': 0, 'solo': 0, 'partial': -0.5
};

// ─── Utilities ──────────────────────────────────────────────────────────────

function dateRange(start, end) {
  const dates = [];
  const d = new Date(start + 'T00:00:00');
  const e = new Date(end + 'T00:00:00');
  while (d <= e) {
    dates.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function scoreSentiment(text) {
  if (!text) return 0;
  const lower = text.toLowerCase();
  let score = 0;
  for (const w of POSITIVE_WORDS) {
    if (lower.includes(w)) score += 1;
  }
  for (const w of NEGATIVE_WORDS) {
    if (lower.includes(w)) score -= 1;
  }
  return score;
}

function scoreKeywords(keywords) {
  if (!keywords || !keywords.length) return 0;
  let score = 0;
  for (const kw of keywords) {
    score += KEYWORD_VALENCE[kw] || 0;
  }
  return score;
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function readJSON(filepath) {
  return JSON.parse(fs.readFileSync(filepath, 'utf8'));
}

function fileContainsExcludedContent(content) {
  const lower = content.toLowerCase();
  return CONTENT_EXCLUDE_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()));
}

function filenameExcluded(filename) {
  const lower = filename.toLowerCase();
  return HARD_EXCLUDE_FILENAMES.some(pat => lower.includes(pat));
}

function achievementIsSafe(name) {
  if (!name) return false;
  const lower = name.toLowerCase();
  return !CONTENT_EXCLUDE_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()));
}

// ─── Dose decomposition ─────────────────────────────────────────────────────
// Available pills: 18mg Concerta, 20mg Inspiral, 36mg Concerta, 54mg Concerta
// Composite doses must be decomposed into actual pills taken.

const BASE_DOSES = [54, 36, 20, 18]; // greedy decomposition order

function decomposeDose(mg) {
  if (!mg || mg === 0) return [];
  if (mg === 15) mg = 18; // known data entry error
  const pills = [];
  let remaining = mg;
  for (const pill of BASE_DOSES) {
    while (remaining >= pill) {
      pills.push(pill);
      remaining -= pill;
    }
  }
  if (remaining > 0) {
    console.warn(`  Warning: could not fully decompose ${mg}mg (${remaining}mg remainder)`);
    pills.push(remaining);
  }
  return pills.sort((a, b) => b - a); // largest first
}

function pillType(mg) {
  if (mg === 20) return 'inspiral';
  return 'concerta';
}

// ─── Step 1: Dosing data ────────────────────────────────────────────────────

console.log('Step 1: Loading dosing data...');

const concertaRaw = readJSON(path.join(GOLDSTONE, 'concerta-doses.json'));
const concertaData = concertaRaw.data;

function correctDose(mg) {
  if (mg === 15) return 18;
  return mg;
}

const doseMap = {};
for (const d of concertaData) {
  if (d.date >= START_DATE) {
    // Use actual dose1/dose2 fields when available (more accurate than decomposing total)
    const d1 = correctDose(d.dose1mg) || null;
    const d2 = correctDose(d.dose2mg) || null;
    let pills = [];
    if (d1 && d2) {
      pills = [d1, d2].sort((a, b) => b - a);
    } else if (d1) {
      pills = decomposeDose(d1);
    } else if (d2) {
      pills = decomposeDose(d2);
    }
    const totalMg = pills.length ? pills.reduce((a, b) => a + b, 0) : null;
    doseMap[d.date] = {
      pills,
      totalMg,
      zeroDoseDay: d.zeroDoseDay,
      toleranceBreak: d.toleranceBreak
    };
  }
}

// Supplement: April 2026 daily logs
const aprilFiles = fs.readdirSync(DAILY_LOGS).filter(f => f.startsWith('2026-04') && f.endsWith('.json'));
for (const file of aprilFiles) {
  const date = file.replace('.json', '');
  if (!doseMap[date]) {
    try {
      const log = readJSON(path.join(DAILY_LOGS, file));
      const med = log.medication || {};
      const d1 = med.dose1 || {};
      const d2 = med.dose2 || {};
      const d1mg = d1.mg === 15 ? 18 : (d1.mg || null);
      const d2mg = d2.mg === 15 ? 18 : (d2.mg || null);
      const total = (d1mg || 0) + (d2mg || 0);
      const pills = decomposeDose(total || null);
      doseMap[date] = {
        pills,
        totalMg: total || null,
        zeroDoseDay: !d1mg && !d2mg,
        toleranceBreak: false
      };
    } catch (e) {
      console.warn(`  Skipping ${file}: ${e.message}`);
    }
  }
}

console.log(`  ${Object.keys(doseMap).length} dose days loaded`);

// ─── Step 2: Productivity data ──────────────────────────────────────────────

console.log('Step 2: Loading productivity data...');

const productivityRaw = readJSON(path.join(GOLDSTONE, 'productivity-daily.json'));
const productivityData = productivityRaw.data;

const prodMap = {};
for (const d of productivityData) {
  if (d.date >= START_DATE) {
    prodMap[d.date] = {
      pomodoroCount: d.pomodoroCount || 0,
      completedPomodoros: d.completedPomodoros || 0,
      completionRate: d.completionRate,
      avgFocusRevised: d.avgFocusRevised,
      peakFocusRevised: d.peakFocusRevised,
      dayStatus: d.dayStatus || 'normal',
      keywords: d.keywords || []
    };
  }
}

const pomodoroRaw = readJSON(path.join(GOLDSTONE, 'pomodoro-sessions.json'));
const pomodoroData = pomodoroRaw.data;

// Group sessions by date for emotion scoring
const sessionsByDate = {};
for (const s of pomodoroData) {
  if (s.date >= START_DATE) {
    if (!sessionsByDate[s.date]) sessionsByDate[s.date] = [];
    sessionsByDate[s.date].push(s);
  }
}

// Supplement: daily logs for energy, symptoms, achievements, extra pomodoro data
const dailyLogFiles = fs.readdirSync(DAILY_LOGS).filter(f => f.endsWith('.json'));
const energyMap = {};
const symptomMap = {};
const achievementMap = {};
const dailyLogTextMap = {};

for (const file of dailyLogFiles) {
  const date = file.replace('.json', '');
  if (date < START_DATE) continue;

  try {
    const log = readJSON(path.join(DAILY_LOGS, file));

    // Energy pulse
    if (log.energyPulse) {
      const ratings = log.energyPulse.ratings || [];
      if (ratings.length) {
        const avg = ratings.reduce((s, r) => s + (r.value || 0), 0) / ratings.length;
        energyMap[date] = { avgEnergy: Math.round(avg * 10) / 10, ratingCount: ratings.length };
      }
    }

    // Symptoms (count moderate/severe)
    if (log.methylphenidateSymptoms) {
      let severityCount = 0;
      const symp = log.methylphenidateSymptoms;
      for (const category of Object.values(symp)) {
        if (typeof category === 'object' && category !== null) {
          for (const [, severity] of Object.entries(category)) {
            if (severity === 'moderate' || severity === 'severe') severityCount++;
          }
        }
      }
      symptomMap[date] = { moderateSevereCount: severityCount };
    }

    // Achievements
    if (log.completedConstellationTodos && log.completedConstellationTodos.length) {
      const safe = log.completedConstellationTodos
        .filter(t => achievementIsSafe(t.name))
        .map(t => ({ name: t.name, icon: t.icon || '✓' }));
      if (safe.length) achievementMap[date] = safe;
    }

    // Collect text for sentiment (pomodoro journals + break comments) — analyze, don't store
    let dayText = '';
    if (log.pomodoros) {
      for (const p of log.pomodoros) {
        if (p.journal) dayText += ' ' + p.journal;
        if (p.intention && typeof p.intention === 'string') dayText += ' ' + p.intention;
      }
    }
    if (log.breaks) {
      for (const b of log.breaks) {
        if (b.comment) dayText += ' ' + b.comment;
      }
    }
    if (dayText.trim()) dailyLogTextMap[date] = dayText;

    // Supplement productivity for dates not in goldstone
    if (!prodMap[date] && log.pomodoros) {
      const poms = log.pomodoros;
      const completed = poms.filter(p => p.completed === 'Yes' || p.completed === true).length;
      const focuses = poms.map(p => p.focus).filter(f => f != null);
      prodMap[date] = {
        pomodoroCount: poms.length,
        completedPomodoros: completed,
        completionRate: poms.length ? completed / poms.length : null,
        avgFocusRevised: focuses.length ? focuses.reduce((a, b) => a + b, 0) / focuses.length : null,
        peakFocusRevised: focuses.length ? Math.max(...focuses) : null,
        dayStatus: log.dayStatus || 'normal',
        keywords: []
      };
    }
  } catch (e) {
    console.warn(`  Skipping daily log ${file}: ${e.message}`);
  }
}

console.log(`  ${Object.keys(prodMap).length} productivity days`);
console.log(`  ${Object.keys(energyMap).length} days with energy data`);
console.log(`  ${Object.keys(achievementMap).length} days with achievements`);

// ─── Step 3: Emotion scoring ────────────────────────────────────────────────

console.log('Step 3: Deriving emotion scores...');

const emotionMap = {};
const enrichedSessions = {};

for (const date of Object.keys(sessionsByDate)) {
  const sessions = sessionsByDate[date];
  let totalTextSentiment = 0;
  let totalKeywordSentiment = 0;
  let totalFocusSignal = 0;
  let totalCompletionSignal = 0;
  let sessionCount = sessions.length;

  const sessionDetails = [];

  for (const s of sessions) {
    // Text sentiment from journal (text is analyzed but never stored)
    const textScore = scoreSentiment(s.journal) + scoreSentiment(s.intention);
    totalTextSentiment += textScore;

    // Keyword valence
    const kwScore = scoreKeywords(s.keywords);
    totalKeywordSentiment += kwScore;

    // Focus signal: remap 1-10 to -2 to +2
    const focus = s.focusRevised || s.focusOriginal;
    const focusSignal = focus != null ? (focus - 5) / 2.5 : 0;
    totalFocusSignal += focusSignal;

    // Completion signal
    const compSignal = s.completed === 'Yes' ? 1 : s.completed === 'Half-way' ? 0 : -1;
    totalCompletionSignal += compSignal;

    sessionDetails.push({
      sessionIndex: s.sessionIndex,
      focusRevised: s.focusRevised,
      completed: s.completed,
      keywords: s.keywords,
      textSentiment: textScore,
      keywordSentiment: kwScore
    });
  }

  // Add daily log text sentiment
  if (dailyLogTextMap[date]) {
    totalTextSentiment += scoreSentiment(dailyLogTextMap[date]);
  }

  // Energy signal
  const energy = energyMap[date];
  const energySignal = energy ? (energy.avgEnergy - 5) / 2.5 : 0;

  // Symptom signal
  const symptoms = symptomMap[date];
  const symptomSignal = symptoms ? -symptoms.moderateSevereCount * 0.5 : 0;

  // Composite scores
  const rawEmotion = totalTextSentiment + totalKeywordSentiment;
  const rawFunctional = totalFocusSignal + totalCompletionSignal + energySignal + symptomSignal;
  const rawComposite = rawEmotion * 0.4 + rawFunctional * 0.6;

  // Normalize to -5 to +5
  const emotionScore = clamp(Math.round(rawEmotion * 10) / 10, -5, 5);
  const functionalScore = clamp(Math.round(rawFunctional * 10) / 10, -5, 5);
  const wellbeingScore = clamp(Math.round(rawComposite * 10) / 10, -5, 5);

  emotionMap[date] = { emotionScore, functionalScore, wellbeingScore };
  enrichedSessions[date] = sessionDetails;
}

// Also score dates with daily log text but no pomodoro sessions in goldstone
for (const date of Object.keys(dailyLogTextMap)) {
  if (emotionMap[date]) continue;
  const textScore = scoreSentiment(dailyLogTextMap[date]);
  const energy = energyMap[date];
  const energySignal = energy ? (energy.avgEnergy - 5) / 2.5 : 0;
  const symptoms = symptomMap[date];
  const symptomSignal = symptoms ? -symptoms.moderateSevereCount * 0.5 : 0;

  const rawComposite = textScore * 0.4 + (energySignal + symptomSignal) * 0.6;
  emotionMap[date] = {
    emotionScore: clamp(Math.round(textScore * 10) / 10, -5, 5),
    functionalScore: clamp(Math.round((energySignal + symptomSignal) * 10) / 10, -5, 5),
    wellbeingScore: clamp(Math.round(rawComposite * 10) / 10, -5, 5)
  };
}

console.log(`  ${Object.keys(emotionMap).length} days with emotion scores`);

// ─── Step 3b: Prior archive sentiment ───────────────────────────────────────

console.log('Step 3b: Processing prior archive...');

const archiveSentiment = {};
let archiveSkipped = 0;
let archiveProcessed = 0;

if (fs.existsSync(PRIOR_ARCHIVE)) {
  const files = fs.readdirSync(PRIOR_ARCHIVE).filter(f => f.endsWith('.md'));

  for (const file of files) {
    // Hard exclusion by filename
    if (filenameExcluded(file)) {
      archiveSkipped++;
      continue;
    }

    try {
      const content = fs.readFileSync(path.join(PRIOR_ARCHIVE, file), 'utf8');

      // Content exclusion
      if (fileContainsExcludedContent(content)) {
        archiveSkipped++;
        continue;
      }

      // Extract date from filename (YYYY-MM-DD-title.md)
      const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
      if (!dateMatch) continue;
      const date = dateMatch[1];
      if (date < START_DATE) continue;

      // Extract Rose's messages only
      const roseMessages = [];
      const lines = content.split('\n');
      let inRose = false;
      for (const line of lines) {
        if (line.startsWith('**Rose:**') || line.startsWith('Rose:')) {
          inRose = true;
          roseMessages.push(line);
        } else if (line.startsWith('**Claude:**') || line.startsWith('Claude:') || line.startsWith('---')) {
          inRose = false;
        } else if (inRose) {
          roseMessages.push(line);
        }
      }

      const roseText = roseMessages.join(' ');
      const sentiment = scoreSentiment(roseText);

      if (!archiveSentiment[date]) {
        archiveSentiment[date] = { totalSentiment: 0, sources: [] };
      }
      archiveSentiment[date].totalSentiment += sentiment;
      archiveSentiment[date].sources.push(file);
      archiveProcessed++;
    } catch (e) {
      console.warn(`  Skipping archive file ${file}: ${e.message}`);
    }
  }

  // Merge archive sentiment into emotion scores
  for (const [date, arch] of Object.entries(archiveSentiment)) {
    const archScore = clamp(Math.round(arch.totalSentiment * 10) / 10, -5, 5);
    if (emotionMap[date]) {
      // Blend: weight archive at 30%, existing at 70%
      const existing = emotionMap[date];
      existing.emotionScore = clamp(
        Math.round((existing.emotionScore * 0.7 + archScore * 0.3) * 10) / 10, -5, 5
      );
      existing.wellbeingScore = clamp(
        Math.round((existing.emotionScore * 0.4 + existing.functionalScore * 0.6) * 10) / 10, -5, 5
      );
    } else {
      emotionMap[date] = {
        emotionScore: archScore,
        functionalScore: null,
        wellbeingScore: archScore
      };
    }
  }
}

console.log(`  ${archiveProcessed} archive files processed, ${archiveSkipped} excluded`);

// ─── Step 5: Annotations ───────────────────────────────────────────────────

const annotations = [
  { date: '2025-08-30', type: 'event', label: 'Informed of biological father\'s death' },
  { start: '2025-08-30', end: '2025-10-31', type: 'period', periodType: 'grief', label: 'Grief — no medication' },
  { start: '2025-12-01', end: '2025-12-27', type: 'period', periodType: 'tolerance', label: 'Tolerance break' },
  { start: '2026-02-11', end: '2026-02-18', type: 'period', periodType: 'illness', label: 'Illness (GI)' },
  { start: '2026-03-07', end: '2026-03-12', type: 'period', periodType: 'illness', label: 'Illness (flu)' },
  { date: '2026-03-24', type: 'event', label: 'Paper-lantern experiment begins' }
];

// ─── Assemble output ────────────────────────────────────────────────────────

console.log('Assembling output...');

const allDates = dateRange(START_DATE, today());
const days = [];
let totalPomodoros = 0;
let doseDays = 0;
let doseMgs = [];
let totalAchievements = 0;

for (const date of allDates) {
  const dose = doseMap[date] || {};
  const prod = prodMap[date] || {};
  const emo = emotionMap[date] || {};
  const achievements = achievementMap[date] || [];
  totalAchievements += achievements.length;

  if (dose.totalMg) {
    doseDays++;
    doseMgs.push(dose.totalMg);
  }
  totalPomodoros += prod.pomodoroCount || 0;

  const day = {
    date,
    pills: dose.pills || [], // e.g. [54, 36] — each is a real pill
    totalMg: dose.totalMg || null,
    zeroDoseDay: dose.zeroDoseDay != null ? dose.zeroDoseDay : true,
    toleranceBreak: dose.toleranceBreak || false,
    pomodoroCount: prod.pomodoroCount || 0,
    completedPomodoros: prod.completedPomodoros || 0,
    completionRate: prod.completionRate != null ? prod.completionRate : null,
    avgFocus: prod.avgFocusRevised || null,
    peakFocus: prod.peakFocusRevised || null,
    dayStatus: prod.dayStatus || null,
    emotionScore: emo.emotionScore != null ? emo.emotionScore : null,
    functionalScore: emo.functionalScore != null ? emo.functionalScore : null,
    wellbeingScore: emo.wellbeingScore != null ? emo.wellbeingScore : null,
    avgEnergy: energyMap[date] ? energyMap[date].avgEnergy : null,
    achievements
  };

  days.push(day);
}

// Stats
doseMgs.sort((a, b) => a - b);
const medianDose = doseMgs.length
  ? doseMgs[Math.floor(doseMgs.length / 2)]
  : null;

const wellbeingScores = days.map(d => d.wellbeingScore).filter(w => w != null);
const avgWellbeing = wellbeingScores.length
  ? Math.round((wellbeingScores.reduce((a, b) => a + b, 0) / wellbeingScores.length) * 10) / 10
  : null;

const stats = {
  dateRange: { start: START_DATE, end: today() },
  totalCalendarDays: allDates.length,
  daysWithData: days.filter(d => d.totalMg != null || d.pomodoroCount > 0).length,
  doseDays,
  zeroDoseDays: days.filter(d => d.zeroDoseDay).length,
  medianDoseMg: medianDose,
  totalPomodoros,
  avgWellbeing,
  totalAchievements
};

// ─── Compute analytics ──────────────────────────────────────────────────────

function avg(arr) { return arr.length ? Math.round((arr.reduce((a,b)=>a+b,0)/arr.length)*10)/10 : null; }

// Dose-response
const doseResponse = {};
for (const d of days) {
  if (d.pomodoroCount === 0 && d.avgFocus == null) continue;
  const dose = d.totalMg || 0;
  if (!doseResponse[dose]) doseResponse[dose] = { focuses: [], poms: [], wellbeing: [], n: 0 };
  doseResponse[dose].n++;
  if (d.avgFocus != null) doseResponse[dose].focuses.push(d.avgFocus);
  doseResponse[dose].poms.push(d.pomodoroCount);
  if (d.wellbeingScore != null) doseResponse[dose].wellbeing.push(d.wellbeingScore);
}

const doseResponseTable = Object.entries(doseResponse)
  .sort((a,b) => Number(a[0]) - Number(b[0]))
  .map(([dose, g]) => ({
    dose: Number(dose),
    n: g.n,
    avgFocus: avg(g.focuses),
    avgPoms: avg(g.poms),
    avgWellbeing: avg(g.wellbeing)
  }));

// Split dosing
const splitStats = { single: { focuses: [], poms: [], wellbeing: [], n: 0 }, split: { focuses: [], poms: [], wellbeing: [], n: 0 } };
for (const d of days) {
  if (!d.pills || d.pills.length === 0) continue;
  const group = d.pills.length > 1 ? splitStats.split : splitStats.single;
  group.n++;
  if (d.avgFocus != null) group.focuses.push(d.avgFocus);
  group.poms.push(d.pomodoroCount);
  if (d.wellbeingScore != null) group.wellbeing.push(d.wellbeingScore);
}

const splitDosing = {
  single: { n: splitStats.single.n, avgFocus: avg(splitStats.single.focuses), avgPoms: avg(splitStats.single.poms), avgWellbeing: avg(splitStats.single.wellbeing) },
  split: { n: splitStats.split.n, avgFocus: avg(splitStats.split.focuses), avgPoms: avg(splitStats.split.poms), avgWellbeing: avg(splitStats.split.wellbeing) }
};

// 90mg days detail
const ninetyMgDays = days.filter(d => d.totalMg === 90).map(d => ({
  date: d.date, pills: d.pills, pomodoroCount: d.pomodoroCount,
  avgFocus: d.avgFocus, wellbeingScore: d.wellbeingScore
}));

const analytics = { doseResponseTable, splitDosing, ninetyMgDays };

// ─── Write site-data.json (public-safe) ─────────────────────────────────────

const siteData = { days, annotations, stats, analytics };
const siteDataJSON = JSON.stringify(siteData);
fs.writeFileSync(
  path.join(__dirname, 'site-data.json'),
  JSON.stringify(siteData, null, 2)
);
console.log(`Wrote site-data.json (${days.length} days)`);

// Inject inline data into index.html for local file:// access
const indexPath = path.join(__dirname, 'index.html');
let html = fs.readFileSync(indexPath, 'utf8');
const dataTag = `<script>window.SITE_DATA=${siteDataJSON};</script>`;
// Remove old inline data if present
html = html.replace(/<script>window\.SITE_DATA=.*?<\/script>\n?/g, '');
// Insert before the main script block
html = html.replace('<script>\n(async function()', dataTag + '\n<script>\n(async function()');
fs.writeFileSync(indexPath, html);
console.log('Injected inline data into index.html');

// ─── Write enriched-data.json (.gitignored) ─────────────────────────────────

const enrichedDays = days.map(d => {
  const enriched = { ...d };
  if (enrichedSessions[d.date]) {
    enriched.sessions = enrichedSessions[d.date];
  }
  if (archiveSentiment[d.date]) {
    enriched.archiveSources = archiveSentiment[d.date].sources;
  }
  return enriched;
});

const enrichedData = { days: enrichedDays, annotations, stats };
fs.writeFileSync(
  path.join(__dirname, 'enriched-data.json'),
  JSON.stringify(enrichedData, null, 2)
);
console.log(`Wrote enriched-data.json (${enrichedDays.length} days)`);

console.log('\nStats:');
console.log(`  Date range: ${stats.dateRange.start} → ${stats.dateRange.end}`);
console.log(`  Calendar days: ${stats.totalCalendarDays}`);
console.log(`  Days with data: ${stats.daysWithData}`);
console.log(`  Dose days: ${stats.doseDays} | Zero-dose: ${stats.zeroDoseDays}`);
console.log(`  Median dose: ${stats.medianDoseMg}mg`);
console.log(`  Total pomodoros: ${stats.totalPomodoros}`);
console.log(`  Avg wellbeing: ${stats.avgWellbeing}`);
console.log(`  Achievements: ${stats.totalAchievements}`);
console.log('\nDone.');
