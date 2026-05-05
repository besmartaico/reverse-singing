// Shared game logic for The Baddies
// This module is used by all API endpoints. Pure functions where possible.

import { kv } from '@vercel/kv';
import crypto from 'crypto';

// ============ KV helpers ============

export const gameKey = (code) => `baddies:game:${code}`;

export async function getGame(code) {
  return await kv.get(gameKey(code));
}

export async function saveGame(game) {
  game.updatedAt = Date.now();
  // 24-hour TTL — abandoned games auto-expire
  await kv.set(gameKey(game.code), game, { ex: 86400 });
}

// ============ ID generation ============

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I, O for clarity
export function newGameCode() {
  let s = '';
  for (let i = 0; i < 6; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

export function newPlayerId() {
  return 'p_' + crypto.randomBytes(8).toString('hex');
}

export function newToken() {
  return crypto.randomBytes(16).toString('hex');
}

export function newMessageId() {
  return 'm_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex');
}

// ============ Constants ============

export const ROLES = {
  LOYALIST: 'loyalist',
  MOLE: 'mole',
  CHIEF: 'chief'
};

// Role distribution per player count [loyalists, moles, chief=1]
export const ROLE_TABLE = {
  5:  { loyalists: 3, moles: 1 },
  6:  { loyalists: 4, moles: 1 },
  7:  { loyalists: 4, moles: 2 },
  8:  { loyalists: 5, moles: 2 },
  9:  { loyalists: 5, moles: 3 },
  10: { loyalists: 6, moles: 3 }
};

// Director powers triggered when N compromised missions enacted
// Indexed by player count. Each entry maps compromised count → power
// Powers: peek (look at top 3), investigate, election, terminate
export const POWER_TABLE = {
  5:  { 3: 'investigate', 4: 'election', 5: 'terminate' },
  6:  { 3: 'investigate', 4: 'election', 5: 'terminate' },
  7:  { 2: 'investigate', 3: 'election', 4: 'terminate', 5: 'terminate' },
  8:  { 2: 'investigate', 3: 'election', 4: 'terminate', 5: 'terminate' },
  9:  { 1: 'investigate', 2: 'investigate', 3: 'election', 4: 'terminate', 5: 'terminate' },
  10: { 1: 'investigate', 2: 'investigate', 3: 'election', 4: 'terminate', 5: 'terminate' }
};
// Note: peek for 5-6p at compromised=2 is handled separately (no player target needed)
export const PEEK_TABLE = {
  5: 2,
  6: 2
};

// Mission deck: 6 compromised + 11 clean = 17 cards
export function freshDeck() {
  const deck = [];
  for (let i = 0; i < 11; i++) deck.push('clean');
  for (let i = 0; i < 6; i++) deck.push('compromised');
  return shuffle(deck);
}

// Spy thriller mission flavor names
export const MISSION_NAMES = {
  clean: [
    'Operation Daybreak', 'Project Lighthouse', 'Phantom Oversight',
    'Operation Clearwater', 'Initiative Atlas', 'Project Beacon',
    'Operation Truthfinder', 'Codename Halcyon', 'Project Sentinel',
    'Operation Witness', 'Initiative Compass'
  ],
  compromised: [
    'Operation Nightfall', 'Project Whisper', 'Codename Viper',
    'Operation Blackout', 'Project Cinder', 'Codename Hollow'
  ]
};

// ============ Helpers ============

export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function alivePlayers(game) {
  return game.players.filter(p => p.alive);
}

export function playerById(game, id) {
  return game.players.find(p => p.id === id);
}

export function playerIdx(game, id) {
  return game.players.findIndex(p => p.id === id);
}

// ============ Role assignment ============

export function assignRoles(players) {
  const n = players.length;
  const config = ROLE_TABLE[n];
  if (!config) throw new Error(`Unsupported player count: ${n}`);

  const roleArr = [];
  for (let i = 0; i < config.loyalists; i++) roleArr.push(ROLES.LOYALIST);
  for (let i = 0; i < config.moles; i++) roleArr.push(ROLES.MOLE);
  roleArr.push(ROLES.CHIEF);

  const shuffled = shuffle(roleArr);
  players.forEach((p, i) => { p.role = shuffled[i]; });
  return players;
}

// ============ State redaction ============

// Returns a state object safe to send to a particular player.
// Hides other players' roles, hidden deck contents, current draw if not theirs, etc.
export function redactState(game, viewerId) {
  const viewer = playerById(game, viewerId);
  // Mole Chief special rule (Secret Hitler): in 5-6 player games, Chief knows moles. In 7+, Chief doesn't.
  const chiefSeesMoles = game.players.length <= 6;
  const knowsMoles = viewer && (
    viewer.role === ROLES.MOLE ||
    (viewer.role === ROLES.CHIEF && chiefSeesMoles)
  );

  const players = game.players.map(p => {
    let visibleRole = null;
    if (p.id === viewerId) {
      visibleRole = p.role;
    } else if (viewer) {
      if (viewer.role === ROLES.MOLE && (p.role === ROLES.MOLE || p.role === ROLES.CHIEF)) {
        visibleRole = p.role;
      } else if (viewer.role === ROLES.CHIEF && chiefSeesMoles && p.role === ROLES.MOLE) {
        visibleRole = p.role;
      }
      // Investigated players appear in viewer.investigated (server-side only filters)
      if (viewer.investigated && viewer.investigated[p.id]) {
        visibleRole = viewer.investigated[p.id]; // could be a fake role due to Cover Identity
      }
    }
    if (game.state.phase === 'gameOver') visibleRole = p.role; // reveal at end

    return {
      id: p.id,
      name: p.name,
      isBot: p.isBot,
      alive: p.alive,
      role: visibleRole,
      isHandler: game.state.handlerIdx === playerIdx(game, p.id),
      isOperative: game.state.operativeIdx === playerIdx(game, p.id)
    };
  });

  const state = { ...game.state };
  // Hide deck contents from everyone (server only)
  delete state.missionDeck;
  delete state.discardPile;

  // Hide currentDraw unless viewer is the holder
  if (state.currentDraw) {
    const holderIdx = state.currentDraw.holder === 'handler'
      ? state.handlerIdx
      : state.operativeIdx;
    if (game.players[holderIdx].id !== viewerId) {
      state.currentDraw = { holder: state.currentDraw.holder, count: state.currentDraw.cards.length };
    }
  }

  // Hide pending power details unless viewer is the handler
  if (state.pendingPower && game.players[state.handlerIdx].id !== viewerId) {
    state.pendingPower = { type: state.pendingPower.type, awaiting: 'handler' };
  }
  // Hide peek result unless viewer is handler
  if (state.peekResult && game.players[state.handlerIdx].id !== viewerId) {
    delete state.peekResult;
  }

  // Hide individual votes during voting; only show counts after vote ends
  let visibleVotes = null;
  if (game.votes) {
    if (game.state.phase === 'voteResult' || game.state.phase === 'gameOver') {
      visibleVotes = game.votes;
    } else {
      visibleVotes = {};
      Object.keys(game.votes).forEach(pid => {
        visibleVotes[pid] = pid === viewerId ? game.votes[pid] : 'pending';
      });
    }
  }

  return {
    code: game.code,
    status: game.status,
    settings: game.settings,
    host: game.host,
    players,
    state,
    votes: visibleVotes,
    chat: game.chat || [],
    log: game.log || [],
    you: viewer ? {
      id: viewer.id,
      name: viewer.name,
      role: viewer.role,
      alive: viewer.alive,
      knowsMoles,
      teammates: knowsMoles ? game.players.filter(p =>
        p.id !== viewerId &&
        (p.role === ROLES.MOLE || (chiefSeesMoles && viewer.role === ROLES.MOLE && p.role === ROLES.CHIEF))
      ).map(p => ({ id: p.id, name: p.name, role: p.role })) : []
    } : null,
    updatedAt: game.updatedAt
  };
}

// ============ State transitions ============

// Start the game: assign roles, build deck, set first handler
export function startGame(game) {
  if (game.players.length < 5) throw new Error('Need at least 5 players (bots can fill)');
  if (game.players.length > 10) throw new Error('Maximum 10 players');

  assignRoles(game.players);
  game.players.forEach(p => { p.alive = true; p.investigated = {}; });
  game.status = 'playing';
  game.state = {
    phase: 'nominate',
    round: 1,
    handlerIdx: Math.floor(Math.random() * game.players.length),
    operativeIdx: null,
    lastHandler: null,
    lastOperative: null,
    missionTrack: { clean: 0, compromised: 0 },
    rejectionCount: 0,
    missionDeck: freshDeck(),
    discardPile: [],
    currentDraw: null,
    pendingPower: null,
    peekResult: null,
    gameOverReason: null
  };
  game.votes = {};
  game.log = game.log || [];
  pushLog(game, `Game started with ${game.players.length} agents.`);
  pushLog(game, `${game.players[game.state.handlerIdx].name} is the first Handler.`);
  return game;
}

export function pushLog(game, msg) {
  if (!game.log) game.log = [];
  game.log.push({ ts: Date.now(), msg });
  // Keep last 100 entries
  if (game.log.length > 100) game.log = game.log.slice(-100);
}

// Advance to next handler (skip dead players)
export function nextHandler(game, fromIdx = null) {
  const start = fromIdx !== null ? fromIdx : game.state.handlerIdx;
  let idx = start;
  for (let i = 0; i < game.players.length; i++) {
    idx = (idx + 1) % game.players.length;
    if (game.players[idx].alive) return idx;
  }
  return start; // fallback
}

// Eligible operative: not the immediately previous Handler or Operative (term limits).
// Exception: if alive players <= 5, only previous Operative is restricted.
export function isEligibleOperative(game, candidateIdx) {
  if (candidateIdx === game.state.handlerIdx) return false;
  if (!game.players[candidateIdx].alive) return false;
  const aliveCount = alivePlayers(game).length;
  if (game.state.lastOperative === candidateIdx) return false;
  if (aliveCount > 5 && game.state.lastHandler === candidateIdx) return false;
  return true;
}

// Handler nominates an operative
export function nominate(game, handlerId, candidateId) {
  const hIdx = playerIdx(game, handlerId);
  if (hIdx !== game.state.handlerIdx) throw new Error('Not the handler');
  if (game.state.phase !== 'nominate') throw new Error('Not in nominate phase');
  const cIdx = playerIdx(game, candidateId);
  if (cIdx < 0) throw new Error('Unknown candidate');
  if (!isEligibleOperative(game, cIdx)) throw new Error('Candidate is not eligible');

  game.state.operativeIdx = cIdx;
  game.state.phase = 'vote';
  game.votes = {};
  pushLog(game, `${game.players[hIdx].name} nominated ${game.players[cIdx].name} as Operative.`);
  return game;
}

// Cast a vote
export function vote(game, voterId, value) {
  if (game.state.phase !== 'vote') throw new Error('Not voting');
  const voter = playerById(game, voterId);
  if (!voter || !voter.alive) throw new Error('Cannot vote');
  if (value !== 'approve' && value !== 'reject') throw new Error('Invalid vote');
  game.votes[voterId] = value;
  // Check if all alive players voted
  const alives = alivePlayers(game);
  const voteCount = alives.filter(p => game.votes[p.id]).length;
  if (voteCount >= alives.length) {
    return resolveVote(game);
  }
  return game;
}

function resolveVote(game) {
  const alives = alivePlayers(game);
  const approve = alives.filter(p => game.votes[p.id] === 'approve').length;
  const reject = alives.length - approve;
  game.state.phase = 'voteResult';

  if (approve > reject) {
    pushLog(game, `Vote PASSED (${approve}–${reject}). Mission proceeds.`);
    // Special: if 3+ compromised already AND chief is operative → moles win
    if (game.state.missionTrack.compromised >= 3) {
      const op = game.players[game.state.operativeIdx];
      if (op.role === ROLES.CHIEF) {
        return endGame(game, 'moles', `The Mole Chief (${op.name}) was elected Operative after 3 compromised missions.`);
      }
    }
    // Draw 3 cards for handler
    if (game.state.missionDeck.length < 3) reshuffle(game);
    game.state.currentDraw = {
      holder: 'handler',
      cards: game.state.missionDeck.splice(0, 3)
    };
    game.state.phase = 'handlerDraw';
    game.state.rejectionCount = 0;
  } else {
    pushLog(game, `Vote FAILED (${approve}–${reject}).`);
    game.state.rejectionCount++;
    if (game.state.rejectionCount >= 3) {
      // Chaos: top mission auto-enacts
      pushLog(game, `Three failed votes — system chaos! Top mission auto-deploys.`);
      if (game.state.missionDeck.length < 1) reshuffle(game);
      const card = game.state.missionDeck.shift();
      enactMission(game, card, true);
      game.state.rejectionCount = 0;
      // Reset term limits on chaos
      game.state.lastHandler = null;
      game.state.lastOperative = null;
    } else {
      passHandler(game);
    }
  }
  return game;
}

function reshuffle(game) {
  game.state.missionDeck = shuffle([...game.state.missionDeck, ...game.state.discardPile]);
  game.state.discardPile = [];
  pushLog(game, `Mission deck reshuffled.`);
}

// Handler discards 1 of 3 cards, passes 2 to operative
export function handlerDiscard(game, handlerId, cardIdx) {
  if (game.state.phase !== 'handlerDraw') throw new Error('Not in handler draw phase');
  if (game.players[game.state.handlerIdx].id !== handlerId) throw new Error('Not the handler');
  if (!game.state.currentDraw || game.state.currentDraw.holder !== 'handler') throw new Error('No cards to discard');
  if (cardIdx < 0 || cardIdx >= game.state.currentDraw.cards.length) throw new Error('Bad card index');

  const cards = game.state.currentDraw.cards;
  const discarded = cards.splice(cardIdx, 1)[0];
  game.state.discardPile.push(discarded);
  game.state.currentDraw = { holder: 'operative', cards };
  game.state.phase = 'operativePlay';
  pushLog(game, `Handler discarded a card and passed two to the Operative.`);
  return game;
}

// Operative enacts 1 of 2 cards
export function operativeEnact(game, operativeId, cardIdx) {
  if (game.state.phase !== 'operativePlay') throw new Error('Not in operative play phase');
  if (game.players[game.state.operativeIdx].id !== operativeId) throw new Error('Not the operative');
  if (!game.state.currentDraw || game.state.currentDraw.holder !== 'operative') throw new Error('No cards to play');
  const cards = game.state.currentDraw.cards;
  if (cardIdx < 0 || cardIdx >= cards.length) throw new Error('Bad card index');

  const enacted = cards[cardIdx];
  const other = cards[1 - cardIdx];
  game.state.discardPile.push(other);
  game.state.currentDraw = null;
  enactMission(game, enacted, false);
  return game;
}

function enactMission(game, card, fromChaos) {
  const flavorList = MISSION_NAMES[card];
  const flavor = flavorList[Math.floor(Math.random() * flavorList.length)];
  if (card === 'clean') {
    game.state.missionTrack.clean++;
    pushLog(game, `${flavor} enacted — CLEAN. (${game.state.missionTrack.clean}/5)`);
  } else {
    game.state.missionTrack.compromised++;
    pushLog(game, `${flavor} enacted — COMPROMISED. (${game.state.missionTrack.compromised}/6)`);
  }

  // Win conditions
  if (game.state.missionTrack.clean >= 5) {
    return endGame(game, 'loyalists', '5 clean missions completed.');
  }
  if (game.state.missionTrack.compromised >= 6) {
    return endGame(game, 'moles', '6 compromised missions enacted.');
  }

  // Save term limits
  if (!fromChaos) {
    game.state.lastHandler = game.state.handlerIdx;
    game.state.lastOperative = game.state.operativeIdx;
  }

  // Check for Director power (only on compromised, only if handler initiated)
  if (card === 'compromised' && !fromChaos) {
    const power = getPower(game);
    if (power) {
      game.state.pendingPower = { type: power };
      game.state.phase = 'power';
      pushLog(game, `Compromise unlocks Handler power: ${power}.`);
      return game;
    }
  }

  // Otherwise advance to next handler
  passHandler(game);
  return game;
}

function getPower(game) {
  const n = game.players.length;
  const c = game.state.missionTrack.compromised;
  if (PEEK_TABLE[n] === c) return 'peek';
  return POWER_TABLE[n] && POWER_TABLE[n][c] ? POWER_TABLE[n][c] : null;
}

function passHandler(game) {
  game.state.handlerIdx = nextHandler(game);
  game.state.operativeIdx = null;
  game.state.phase = 'nominate';
  game.votes = {};
  pushLog(game, `${game.players[game.state.handlerIdx].name} is now the Handler.`);
}

// Use a Director power
export function usePower(game, handlerId, payload) {
  if (game.state.phase !== 'power') throw new Error('No active power');
  if (game.players[game.state.handlerIdx].id !== handlerId) throw new Error('Not the handler');
  const power = game.state.pendingPower;
  if (!power) throw new Error('No pending power');
  const handlerName = game.players[game.state.handlerIdx].name;

  if (power.type === 'peek') {
    if (game.state.missionDeck.length < 3) reshuffle(game);
    const top3 = game.state.missionDeck.slice(0, 3);
    game.state.peekResult = top3;
    pushLog(game, `${handlerName} peeked at the top 3 mission cards.`);
    // Mark power as awaiting acknowledgment
    game.state.pendingPower = { type: 'peek', viewed: true };
    return game; // wait for handler to dismiss
  }

  if (power.type === 'investigate') {
    const target = playerById(game, payload.targetId);
    if (!target || !target.alive) throw new Error('Bad target');
    if (target.id === handlerId) throw new Error('Cannot investigate self');
    if (game.settings.coverIdentity) {
      // Target gets to choose a cover OR truth
      game.state.pendingPower = { type: 'coverChoice', targetId: target.id };
      game.state.phase = 'coverChoice';
      pushLog(game, `${handlerName} requested an investigation of ${target.name}. Awaiting cover identity choice.`);
      return game;
    } else {
      // No cover identity setting — just reveal team (loyalist vs mole/chief)
      const handler = game.players[game.state.handlerIdx];
      handler.investigated = handler.investigated || {};
      const team = (target.role === ROLES.LOYALIST) ? ROLES.LOYALIST : ROLES.MOLE;
      handler.investigated[target.id] = team;
      pushLog(game, `${handlerName} investigated ${target.name}.`);
      game.state.pendingPower = null;
      passHandler(game);
      return game;
    }
  }

  if (power.type === 'election') {
    const target = playerById(game, payload.targetId);
    if (!target || !target.alive) throw new Error('Bad target');
    if (target.id === handlerId) throw new Error('Cannot self-elect');
    pushLog(game, `${handlerName} called a special election: ${target.name} is now the Handler.`);
    game.state.handlerIdx = playerIdx(game, target.id);
    game.state.operativeIdx = null;
    game.state.phase = 'nominate';
    game.state.pendingPower = null;
    game.votes = {};
    // Note: special election doesn't update lastHandler permanently
    return game;
  }

  if (power.type === 'terminate') {
    const target = playerById(game, payload.targetId);
    if (!target || !target.alive) throw new Error('Bad target');
    if (target.id === handlerId) throw new Error('Cannot self-terminate');
    target.alive = false;
    pushLog(game, `${handlerName} terminated ${target.name}.`);
    if (target.role === ROLES.CHIEF) {
      return endGame(game, 'loyalists', `${target.name} was the Mole Chief.`);
    }
    game.state.pendingPower = null;
    passHandler(game);
    return game;
  }

  throw new Error(`Unknown power: ${power.type}`);
}

// Handler dismisses peek result
export function dismissPeek(game, handlerId) {
  if (game.state.phase !== 'power') throw new Error('No active power');
  if (game.players[game.state.handlerIdx].id !== handlerId) throw new Error('Not the handler');
  if (!game.state.pendingPower || game.state.pendingPower.type !== 'peek' || !game.state.pendingPower.viewed) {
    throw new Error('No peek to dismiss');
  }
  game.state.peekResult = null;
  game.state.pendingPower = null;
  passHandler(game);
  return game;
}

// Cover Identity: target chooses what role to show
export function coverIdentity(game, targetId, claimedRole) {
  if (game.state.phase !== 'coverChoice') throw new Error('Not in cover choice phase');
  if (!game.state.pendingPower || game.state.pendingPower.targetId !== targetId) {
    throw new Error('Not the investigation target');
  }
  if (claimedRole !== 'loyalist' && claimedRole !== 'mole') {
    throw new Error('Cover must be loyalist or mole');
  }
  const handler = game.players[game.state.handlerIdx];
  handler.investigated = handler.investigated || {};
  handler.investigated[targetId] = claimedRole;
  const target = playerById(game, targetId);
  pushLog(game, `${target.name} provided their dossier to ${handler.name}.`);
  game.state.pendingPower = null;
  passHandler(game);
  return game;
}

function endGame(game, winner, reason) {
  game.state.phase = 'gameOver';
  game.state.winner = winner;
  game.state.gameOverReason = reason;
  game.status = 'finished';
  pushLog(game, `GAME OVER — ${winner.toUpperCase()} WIN. ${reason}`);
  return game;
}

// Add bots to fill up to N
export function addBotsToFill(game, targetCount) {
  const BOT_NAMES = [
    'Agent Vex', 'Agent Cipher', 'Agent Halo', 'Agent Echo',
    'Agent Raven', 'Agent Sable', 'Agent Wraith', 'Agent Onyx',
    'Agent Lynx', 'Agent Talon'
  ];
  const usedNames = new Set(game.players.map(p => p.name));
  while (game.players.length < targetCount) {
    let name = BOT_NAMES.find(n => !usedNames.has(n));
    if (!name) name = `Agent ${Math.floor(Math.random()*900+100)}`;
    usedNames.add(name);
    game.players.push({
      id: newPlayerId(),
      name,
      isBot: true,
      alive: true,
      role: null,
      joined: Date.now(),
      token: newToken() // bots have tokens too, used by host driver
    });
  }
  return game;
}

// Add a chat message (capped at 200)
export function addChat(game, playerId, text, system = false) {
  if (!text || text.length > 280) throw new Error('Message too long');
  game.chat = game.chat || [];
  const player = playerId ? playerById(game, playerId) : null;
  game.chat.push({
    id: newMessageId(),
    playerId,
    name: system ? 'SYSTEM' : (player ? player.name : 'Unknown'),
    text: text.substring(0, 280),
    ts: Date.now(),
    system
  });
  if (game.chat.length > 200) game.chat = game.chat.slice(-200);
}
