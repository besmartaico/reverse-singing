import {
  newPlayerId, newToken, getGame, saveGame, addChat
} from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { code, name, playerId, token } = body;
    if (!code) return res.status(400).json({ error: 'Code required' });
    const upperCode = String(code).toUpperCase().trim();

    const game = await getGame(upperCode);
    if (!game) return res.status(404).json({ error: 'Game not found. Check the code.' });

    // RECONNECTION: if playerId+token match an existing player, return same identity
    if (playerId && token) {
      const existing = game.players.find(p => p.id === playerId && p.token === token);
      if (existing) {
        return res.status(200).json({
          code: upperCode,
          playerId: existing.id,
          token: existing.token,
          reconnected: true
        });
      }
    }

    // NEW JOIN: only allowed in lobby
    if (game.status !== 'lobby') {
      return res.status(403).json({ error: 'Game already in progress. Cannot join.' });
    }

    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'Name required' });
    const cleanName = name.trim().substring(0, 20);
    if (!cleanName) return res.status(400).json({ error: 'Name cannot be empty' });

    if (game.players.find(p => p.name.toLowerCase() === cleanName.toLowerCase())) {
      return res.status(409).json({ error: 'Name already taken in this game' });
    }
    if (game.players.length >= 10) {
      return res.status(403).json({ error: 'Game is full (10 players max)' });
    }

    const newId = newPlayerId();
    const newTok = newToken();
    game.players.push({
      id: newId,
      name: cleanName,
      isBot: false,
      alive: true,
      role: null,
      joined: Date.now(),
      token: newTok
    });
    addChat(game, null, `${cleanName} joined.`, true);
    await saveGame(game);

    return res.status(200).json({
      code: upperCode,
      playerId: newId,
      token: newTok,
      reconnected: false
    });
  } catch (e) {
    console.error('join error', e);
    return res.status(500).json({ error: e.message || 'Internal error' });
  }
}
