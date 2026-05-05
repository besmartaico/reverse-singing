import {
  newGameCode, newPlayerId, newToken, getGame, saveGame, gameKey, addChat
} from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { name, settings } = body;
    if (!name || typeof name !== 'string' || name.length > 20) {
      return res.status(400).json({ error: 'Invalid name (1-20 chars required)' });
    }
    const cleanName = name.trim().substring(0, 20);
    if (!cleanName) return res.status(400).json({ error: 'Name cannot be empty' });

    // Try a few codes in case of (very rare) collision
    let code, existing;
    for (let i = 0; i < 5; i++) {
      code = newGameCode();
      existing = await getGame(code);
      if (!existing) break;
    }
    if (existing) return res.status(500).json({ error: 'Could not generate code' });

    const hostId = newPlayerId();
    const token = newToken();
    const game = {
      code,
      host: hostId,
      status: 'lobby',
      settings: {
        aiChat: !!(settings && settings.aiChat),
        coverIdentity: settings && settings.coverIdentity !== false  // default true
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      players: [{
        id: hostId,
        name: cleanName,
        isBot: false,
        alive: true,
        role: null,
        joined: Date.now(),
        token
      }],
      state: { phase: 'lobby' },
      votes: {},
      chat: [],
      log: []
    };
    addChat(game, null, `Game created. Share code "${code}" with other players.`, true);
    await saveGame(game);

    // Don't send tokens of other players to client
    return res.status(200).json({
      code,
      playerId: hostId,
      token
    });
  } catch (e) {
    console.error('create error', e);
    return res.status(500).json({ error: e.message || 'Internal error' });
  }
}
