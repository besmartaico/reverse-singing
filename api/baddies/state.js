import { getGame, redactState } from './_lib.js';

export default async function handler(req, res) {
  // Allow GET for polling
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { code, playerId, token, since } = req.query;
    if (!code || !playerId || !token) {
      return res.status(400).json({ error: 'code, playerId, token required' });
    }
    const upperCode = String(code).toUpperCase().trim();

    const game = await getGame(upperCode);
    if (!game) return res.status(404).json({ error: 'Game not found' });

    const player = game.players.find(p => p.id === playerId && p.token === token);
    if (!player) return res.status(403).json({ error: 'Invalid identity' });

    // Optional: If client passes ?since=updatedAt and nothing changed, return 304-like minimal response
    if (since && Number(since) === game.updatedAt) {
      return res.status(200).json({ unchanged: true, updatedAt: game.updatedAt });
    }

    // Set cache headers to prevent caching of polling responses
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    return res.status(200).json(redactState(game, playerId));
  } catch (e) {
    console.error('state error', e);
    return res.status(500).json({ error: e.message || 'Internal error' });
  }
}
