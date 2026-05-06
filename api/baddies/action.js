import {
  getGame, saveGame, addChat, addBotsToFill, redactState,
  startGame, nominate, vote, handlerDiscard, operativeEnact,
  usePower, dismissPeek, coverIdentity, playerById
} from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { code, playerId, token, action, payload } = body;
    if (!code || !playerId || !token || !action) {
      return res.status(400).json({ error: 'code, playerId, token, action required' });
    }
    const upperCode = String(code).toUpperCase().trim();

    const game = await getGame(upperCode);
    if (!game) return res.status(404).json({ error: 'Game not found' });

    const player = game.players.find(p => p.id === playerId && p.token === token);
    if (!player) return res.status(403).json({ error: 'Invalid identity' });

    // Bot proxy: if caller is host AND payload includes onBehalfOf, the action is performed by the bot.
    // We still require the host's valid token (already verified above) — the host is the only one allowed
    // to submit bot actions because the bot driver runs in the host's browser.
    let actingId = playerId;
    let actingPlayer = player;
    if (payload && payload.onBehalfOf && player.id === game.host) {
      const bot = game.players.find(p => p.id === payload.onBehalfOf && p.isBot);
      if (!bot) return res.status(400).json({ error: 'Bad bot id' });
      actingId = bot.id;
      actingPlayer = bot;
    }

    const isHost = playerId === game.host;
    const p = payload || {};

    switch (action) {
      case 'addBot': {
        if (!isHost) return res.status(403).json({ error: 'Only host can add bots' });
        if (game.status !== 'lobby') return res.status(400).json({ error: 'Cannot add bots after game starts' });
        if (game.players.length >= 10) return res.status(400).json({ error: 'Game full' });
        addBotsToFill(game, game.players.length + 1);
        const newBot = game.players[game.players.length - 1];
        addChat(game, null, `${newBot.name} (bot) joined.`, true);
        break;
      }

      case 'removePlayer': {
        if (!isHost) return res.status(403).json({ error: 'Only host can remove' });
        if (game.status !== 'lobby') return res.status(400).json({ error: 'Cannot remove after game starts' });
        const targetId = p.targetId;
        if (targetId === game.host) return res.status(400).json({ error: 'Host cannot remove self' });
        const idx = game.players.findIndex(pl => pl.id === targetId);
        if (idx < 0) return res.status(404).json({ error: 'Player not found' });
        const removed = game.players.splice(idx, 1)[0];
        addChat(game, null, `${removed.name} left.`, true);
        break;
      }

      case 'updateSettings': {
        if (!isHost) return res.status(403).json({ error: 'Only host can change settings' });
        if (game.status !== 'lobby') return res.status(400).json({ error: 'Cannot change after game starts' });
        if (typeof p.aiChat === 'boolean') game.settings.aiChat = p.aiChat;
        if (typeof p.coverIdentity === 'boolean') game.settings.coverIdentity = p.coverIdentity;
        break;
      }

      case 'start': {
        if (!isHost) return res.status(403).json({ error: 'Only host can start' });
        if (game.status !== 'lobby') return res.status(400).json({ error: 'Game already started' });
        // Auto-fill with bots up to 5 if needed
        if (game.players.length < 5) addBotsToFill(game, 5);
        startGame(game);
        break;
      }

      case 'nominate': {
        nominate(game, actingId, p.targetId);
        break;
      }

      case 'vote': {
        vote(game, actingId, p.value);
        break;
      }

      case 'handlerDiscard': {
        handlerDiscard(game, actingId, p.cardIdx);
        break;
      }

      case 'operativeEnact': {
        operativeEnact(game, actingId, p.cardIdx);
        break;
      }

      case 'usePower': {
        usePower(game, actingId, p);
        break;
      }

      case 'dismissPeek': {
        dismissPeek(game, actingId);
        break;
      }

      case 'coverIdentity': {
        coverIdentity(game, actingId, p.claimedRole);
        break;
      }

      case 'chat': {
        if (!p.text) return res.status(400).json({ error: 'Empty message' });
        addChat(game, actingId, String(p.text));
        break;
      }

      case 'rematch': {
        if (!isHost) return res.status(403).json({ error: 'Only host can start rematch' });
        if (game.status !== 'finished') return res.status(400).json({ error: 'Game not finished' });
        // Reset to lobby with same players
        game.status = 'lobby';
        game.state = { phase: 'lobby' };
        game.votes = {};
        game.players.forEach(pl => {
          pl.role = null;
          pl.alive = true;
          pl.investigated = {};
        });
        addChat(game, null, 'Rematch! Lobby reset.', true);
        break;
      }

      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }

    await saveGame(game);
    return res.status(200).json(redactState(game, playerId));
  } catch (e) {
    console.error('action error', e);
    return res.status(400).json({ error: e.message || 'Action failed' });
  }
}
