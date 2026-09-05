#!/usr/bin/env node
// Headless simulator for Vigil. Extracts the CORE block from index.html
// verbatim (so the bots play the exact rules the page does) and drives it with
// a simulated hand: reaction time, travel time, and real pour dwell.
//
//   node sim.js                 # all tiers, all bots, 300 games each
//   node sim.js -n 1000 -t calm # more games, one tier
//   node sim.js --human slow    # a slower hand model

const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const core = html.slice(html.indexOf('// ── CORE BEGIN ──'), html.indexOf('// ── CORE END ──'));
const Core = new Function(core + '\nreturn { CONFIG, createGame, advance, startPour, stopPour, lanternLevel, isWeary, isDazzled, pourRate, nextDarkLantern, progress, mulberry32, flaskOil, flaskTotal };')();
const { CONFIG, createGame, advance, startPour, stopPour, lanternLevel, isWeary, isDazzled, pourRate, nextDarkLantern, mulberry32, flaskOil, flaskTotal } = Core;

// ── Hand models ──
// Time costs of a human on a phone. reaction = decide + start moving; travel
// tray↔lantern and lantern↔lantern; dazzled adds hesitation and a chance of
// reaching for the wrong lantern (perfect memory would make Dazzled free).
const HUMANS = {
  quick:  { reaction: 0.18, travelTray: 0.22, travelLantern: 0.22, dazzledReaction: 0.35, dazzledMistake: 0.15, mistakeCost: 0.45, wearyTravel: 1.3 },
  normal: { reaction: 0.25, travelTray: 0.27, travelLantern: 0.28, dazzledReaction: 0.5,  dazzledMistake: 0.25, mistakeCost: 0.55, wearyTravel: 1.4 },
  slow:   { reaction: 0.35, travelTray: 0.35, travelLantern: 0.35, dazzledReaction: 0.7,  dazzledMistake: 0.35, mistakeCost: 0.7,  wearyTravel: 1.5 },
};

// ── Strategies ──
// choose(state, ctx) → { flaskId, lanternId } | null (null = wait a beat)
// keepPouring(state, ctx) → boolean, asked every tick while a pour is active

function litMatches(state, flask) {
  return state.lanterns.filter(l => l.lit && flaskOil(flask, l.color) > 1e-6);
}
function timeLeft(state, l) { return l.emptiesAt - state.t; }
// true if emptying this compartment would spend the whole flask (draw a new one)
function spends(flask, color) { return flaskTotal(flask) - flaskOil(flask, color) <= 1e-6; }

const strategies = {
  // Random legal play: any flask, any matching lit lantern, pour until empty.
  random(rand) {
    return {
      choose(state) {
        const hand = state.hands.p1;
        const opts = [];
        for (const f of hand) for (const l of litMatches(state, f)) opts.push({ flaskId: f.id, lanternId: l.id });
        if (opts.length) return opts[Math.floor(rand() * opts.length)];
        // nothing lit matches: light something
        const darks = [];
        for (const f of hand) for (const l of state.lanterns) if (!l.lit && flaskOil(f, l.color) > 1e-6) darks.push({ flaskId: f.id, lanternId: l.id });
        return darks.length ? darks[Math.floor(rand() * darks.length)] : null;
      },
      keepPouring() { return true; },
    };
  },

  // Greedy: always the most urgent lantern any flask in hand can reach, and
  // stop when it's full. If nothing needs oil, churn: empty the flask with
  // the least oil into a matching lantern (spilling) to advance the deck.
  // Lights dark lanterns as soon as nothing lit matches the hand.
  greedy() {
    return {
      choose(state) {
        const hand = state.hands.p1;
        let best = null, bestLeft = Infinity;
        for (const f of hand) for (const l of litMatches(state, f)) {
          const tl = timeLeft(state, l);
          if (lanternLevel(state, l) < 0.85 && tl < bestLeft) { bestLeft = tl; best = { flaskId: f.id, lanternId: l.id }; }
        }
        if (best) return best;
        let churn = null, least = Infinity;
        for (const f of hand) for (const l of litMatches(state, f)) if (flaskOil(f, l.color) < least) { least = flaskOil(f, l.color); churn = { flaskId: f.id, lanternId: l.id, spill: true }; }
        if (churn) return churn;
        for (const f of hand) for (const l of state.lanterns) if (!l.lit && flaskOil(f, l.color) > 1e-6) return { flaskId: f.id, lanternId: l.id };
        return null;
      },
      keepPouring(state, ctx) {
        const l = state.lanterns[ctx.lanternId];
        const f = state.hands.p1.find(x => x.id === ctx.flaskId);
        if (!f) return false;
        if (ctx.spill) return true;
        if (lanternLevel(state, l) < 0.985) return true;
        return flaskOil(f, l.color) < 0.15;   // finish the dregs rather than carry them
      },
    };
  },

  // Steady: a good reactive player. Tops up the most urgent lantern it can
  // reach, stops when it's full, churns the smallest flask when a lit lantern's
  // colour is missing from the hand, and holds flasks for dark lanterns until
  // nothing else can be done. No lookahead, never abandons a pour.
  steady() {
    return {
      choose(state) {
        const hand = state.hands.p1;
        const lit = state.lanterns.filter(l => l.lit);
        // a lantern nobody in hand can serve, getting low → churn to find it
        let starving = null;
        for (const o of lit) {
          if (hand.some(f => flaskOil(f, o.color) > 1e-6)) continue;
          if (lanternLevel(state, o) < 0.55 && (!starving || timeLeft(state, o) < timeLeft(state, starving))) starving = o;
        }
        let best = null, bestLeft = Infinity;
        for (const f of hand) for (const l of litMatches(state, f)) {
          const tl = timeLeft(state, l);
          if (lanternLevel(state, l) < 0.9 && tl < bestLeft) { bestLeft = tl; best = { flaskId: f.id, lanternId: l.id }; }
        }
        if (starving && (!best || bestLeft > state.lanterns[0].burn * 0.35)) {
          // churn the compartment that spends a flask soonest
          let churn = null, least = Infinity;
          for (const f of hand) for (const l of litMatches(state, f)) {
            const k = flaskOil(f, l.color) + (spends(f, l.color) ? 0 : 1) - (1 - lanternLevel(state, l)) * 0.5;
            if (k < least) { least = k; churn = { flaskId: f.id, lanternId: l.id, spill: true }; }
          }
          if (churn) return churn;
        }
        if (best) return best;
        // nothing needs oil: churn the smallest compartment that matches a lit lantern
        let churn = null, least = Infinity;
        for (const f of hand) for (const l of litMatches(state, f)) {
          const k = flaskOil(f, l.color) + (spends(f, l.color) ? 0 : 1);
          if (k < least) { least = k; churn = { flaskId: f.id, lanternId: l.id, spill: true }; }
        }
        if (churn) return churn;
        // hand is all dark-lantern flasks: wait for the lamplighter if close, else light his next one
        const next = nextDarkLantern(state);
        if (!next) return null;
        if (state.nextLightAt - state.t < 3) return null;
        for (const f of hand) if (flaskOil(f, next.color) > 1e-6) return { flaskId: f.id, lanternId: next.id };
        for (const f of hand) for (const l of state.lanterns) if (!l.lit && flaskOil(f, l.color) > 1e-6) return { flaskId: f.id, lanternId: l.id };
        return null;
      },
      keepPouring(state, ctx) {
        const l = state.lanterns[ctx.lanternId];
        const f = state.hands.p1.find(x => x.id === ctx.flaskId);
        if (!f) return false;
        if (ctx.spill) return true;
        if (lanternLevel(state, l) < 0.985) return true;
        return flaskOil(f, l.color) < 0.15;
      },
    };
  },

  // Planner: scores each action by the worst slack across lanterns after the
  // pour, accounts for travel/pour time, holds flasks for dark lanterns until
  // forced, and abandons a pour when another lantern is about to die.
  planner(rand, human) {
    const cost = (state, from, act) => {
      const w = isWeary(state) ? human.wearyTravel : 1;
      const base = human.reaction + (from.flaskId === act.flaskId ? human.travelLantern : human.travelTray * 2) * w;
      return base + (isDazzled(state) ? human.dazzledReaction : 0);
    };
    return {
      choose(state, ctx) {
        const hand = state.hands.p1;
        const lit = state.lanterns.filter(l => l.lit);
        const rate = pourRate(state);
        // starvation: a lit lantern whose colour no flask in hand can serve
        let starving = 0;
        for (const o of lit) {
          if (hand.some(f => flaskOil(f, o.color) > 1e-6)) continue;
          starving = Math.max(starving, 1 - timeLeft(state, o) / o.burn);
        }
        let best = null, bestScore = -Infinity, bestUseful = 0;
        for (const f of hand) {
          for (const l of litMatches(state, f)) {
            const act = { flaskId: f.id, lanternId: l.id };
            const c = cost(state, ctx, act);
            const deficit = 1 - lanternLevel(state, l);
            const oil = flaskOil(f, l.color);
            const pourAmt = Math.min(oil, deficit + 0.02);
            const pourT = state.cfg.pourArmSeconds + pourAmt / rate;
            const total = c + pourT;
            let minSlack = Infinity;
            for (const o of lit) {
              let tl = timeLeft(state, o) - total;
              if (o.id === l.id) tl += Math.min(pourAmt, deficit) * o.burn;
              minSlack = Math.min(minSlack, tl);
            }
            const useful = Math.min(pourAmt, deficit);
            let score = minSlack + useful * 4 - total * 0.5;
            // emptying a flask draws a new one — worth a lot when a lantern is starving
            const emptiesT = c + state.cfg.pourArmSeconds + oil / rate;
            if (starving > 0.3) score += (spends(f, l.color) ? starving * 12 : starving * 5) - emptiesT * 3;
            else if (oil - pourAmt < 1e-6) score += spends(f, l.color) ? 1.5 : 0.5;
            if (score > bestScore) { bestScore = score; best = act; bestUseful = useful; }
          }
        }
        if (best && (bestUseful > 0.08 || starving > 0.3)) {
          if (starving > 0.3) best.spill = true;   // empty it, whatever it takes
          return best;
        }
        // Nothing useful to pour. If the hand is full, churn the flask with
        // the least oil (spill) so the deck moves; prefer lanterns with room.
        if (hand.length >= state.cfg.handSize || state.deckPos >= state.deck.length) {
          let churn = null, least = Infinity;
          for (const f of hand) for (const l of litMatches(state, f)) {
            const k = flaskOil(f, l.color) + (spends(f, l.color) ? 0 : 1) - (1 - lanternLevel(state, l));
            if (k < least) { least = k; churn = { flaskId: f.id, lanternId: l.id, spill: true }; }
          }
          if (churn) return churn;
        } else if (best) return best;
        // Nothing lit matches: wait for the lamplighter if he's close, else
        // light the lantern he'd light next with the flask holding the least oil.
        const next = nextDarkLantern(state);
        if (!next) return best;
        if (state.nextLightAt - state.t < 2.5) return null;
        let pick = null, least = Infinity;
        for (const f of hand) for (const l of state.lanterns) {
          if (l.lit || flaskOil(f, l.color) <= 1e-6) continue;
          const key = flaskOil(f, l.color) - (l.id === next.id ? 10 : 0);
          if (key < least) { least = key; pick = { flaskId: f.id, lanternId: l.id }; }
        }
        return pick;
      },
      keepPouring(state, ctx) {
        const l = state.lanterns[ctx.lanternId];
        const f = state.hands.p1.find(x => x.id === ctx.flaskId);
        if (!f) return false;
        const lvl = lanternLevel(state, l);
        // abandon if another lantern is about to die and we can reach it
        for (const o of state.lanterns) {
          if (!o.lit || o.id === l.id) continue;
          const reachable = state.hands.p1.some(x => flaskOil(x, o.color) > 1e-6);
          if (reachable && timeLeft(state, o) < human.reaction + human.travelTray * 2 + 0.7 && lvl > 0.3) return false;
        }
        if (ctx.spill) return true;
        if (lvl < 0.985) return true;
        if (flaskOil(f, l.color) < 0.12) return true;
        return false;
      },
    };
  },
};

// ── One game ──
function playGame(strategyName, tierName, seed, human, dt = 0.02, maxT = 900) {
  const rand = mulberry32(seed * 7919 + 13);
  const state = createGame(CONFIG, tierName, seed);
  const strat = strategies[strategyName](rand, human);
  const ctx = { flaskId: -1, lanternId: -1 };   // where the hand is
  let busyUntil = 0, pending = null, t = 0;
  while (state.status === 'playing' && t < maxT) {
    t += dt;
    advance(state, t);
    if (state.status !== 'playing') break;
    if (t < busyUntil) continue;
    if (pending) {
      const ok = startPour(state, 'p1', pending.flaskId, pending.lanternId);
      if (ok) { ctx.flaskId = pending.flaskId; ctx.lanternId = pending.lanternId; ctx.spill = !!pending.spill; }
      pending = null;
      continue;
    }
    if (state.pours.p1) {
      if (!strat.keepPouring(state, ctx)) { stopPour(state, 'p1'); busyUntil = t + human.reaction * 0.5; }
      continue;
    }
    const act = strat.choose(state, ctx);
    if (!act) { busyUntil = t + 0.1; continue; }
    const w = isWeary(state) ? human.wearyTravel : 1;
    let c = human.reaction + (ctx.flaskId === act.flaskId ? human.travelLantern : human.travelTray * 2) * w;
    if (isDazzled(state)) {
      c += human.dazzledReaction;
      if (rand() < human.dazzledMistake) c += human.mistakeCost;
    }
    busyUntil = t + c;
    pending = act;
  }
  return { won: state.status === 'won', t: state.t, spent: state.spent, total: state.totalFlasks, spilled: state.spilled };
}

// ── CLI ──
const args = process.argv.slice(2);
const opt = (flag, def) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : def; };
const N = +opt('-n', 300);
const tiers = opt('-t', Object.keys(CONFIG.tiers).join(',')).split(',');
const bots = opt('-b', 'random,greedy,steady,planner').split(',');
const human = HUMANS[opt('--human', 'normal')];
// --set burnSeconds=20 --set deck.doubles=22 --set tiers.calm.burnScale=1.1
args.forEach((a, i) => {
  if (a !== '--set') return;
  const [k, v] = args[i + 1].split('=');
  const keys = k.split('.');
  let o = CONFIG;
  for (const kk of keys.slice(0, -1)) o = o[kk];
  o[keys[keys.length - 1]] = JSON.parse(v);
});
const quiet = args.includes('-q');

console.log(`Vigil sim — ${N} games per cell, hand model "${opt('--human', 'normal')}"`);
console.log(`burns ${CONFIG.colors.map(c => c.burn).join('/')}s, pour ${CONFIG.pourSeconds}s, deck ${CONFIG.deck.singles}+${CONFIG.deck.doubles} (single ${CONFIG.flaskVolume.single}, double 2×${CONFIG.flaskVolume.doubleEach}), hand ${CONFIG.handSize}, lamplighter every ${CONFIG.lamplighter.interval}s, fill ${Object.values(CONFIG.tiers).map(x => x.fill).join('/')}\n`);
console.log('tier      bot       win%   avg progress   avg time   spilled/game');
for (const tier of tiers) {
  for (const bot of bots) {
    let wins = 0, prog = 0, time = 0, spill = 0;
    for (let i = 0; i < N; i++) {
      const r = playGame(bot, tier, 1000 + i, human);
      if (r.won) wins++;
      prog += r.spent / r.total; time += r.t; spill += r.spilled;
    }
    console.log(`${tier.padEnd(9)} ${bot.padEnd(9)} ${(100 * wins / N).toFixed(1).padStart(5)}%   ${(100 * prog / N).toFixed(0).padStart(5)}%        ${(time / N).toFixed(0).padStart(4)}s       ${(spill / N).toFixed(2)}`);
  }
}
