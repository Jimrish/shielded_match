const { redis, sign, json } = require("./_lib");
const KEY = "naka:match:leaderboard";

// POST /api/match-score { handle, score, level, moves, t, token } -> { ok, rank, top }
module.exports = async (req, res) => {
  if (req.method !== "POST") return json(res, 405, { error: "POST only" });
  let b = req.body;
  if (typeof b === "string") {
    try {
      b = JSON.parse(b);
    } catch (e) {
      b = null;
    }
  }
  if (!b || typeof b !== "object")
    return json(res, 400, { error: "Bad request" });

  const handle = String(b.handle || "").replace(/^@/, "");
  const score = Math.floor(+b.score),
    level = Math.floor(+b.level),
    moves = Math.floor(+b.moves),
    t = +b.t;
  const [ts, nonce, sig] = String(b.token || "").split(".");

  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle))
    return json(res, 400, { error: "Invalid X handle" });
  if (
    !(score >= 0 && score <= 1e6) ||
    !(level >= 1 && level <= 500) ||
    !(moves >= 0 && moves <= 20000) ||
    !(t >= 0 && t <= 14400)
  )
    return json(res, 400, { error: "Invalid numbers" });
  if (!ts || !nonce || !sig || sign(ts + "." + nonce) !== sig)
    return json(res, 403, { error: "Invalid token" });

  const age = (Date.now() - +ts) / 1000; // real seconds since the run started
  if (!(age >= 0 && age <= 14400) || t > age + 3)
    return json(res, 403, { error: "Timing check failed" });
  // Each move takes at least about 0.7 s, a level needs several moves, and one move scores well under 800 points.
  if (
    moves > t * 1.5 + 6 ||
    level > moves / 3 + 1 ||
    score > moves * 800 + level * 1500 + 200
  )
    return json(res, 400, { error: "Score not plausible" });

  try {
    const ip =
      (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
    const rl = "naka:match:rate:" + ip;
    const n = await redis(["INCR", rl]);
    if (n === 1) await redis(["EXPIRE", rl, 600]);
    if (n > 30)
      return json(res, 429, { error: "Too many submissions, try again later" });

    const fresh = await redis([
      "SET",
      "naka:match:used:" + nonce,
      "1",
      "NX",
      "EX",
      14400,
    ]); // each token works once
    if (fresh !== "OK") return json(res, 403, { error: "Token already used" });

    const member = handle.toLowerCase();
    await redis(["ZADD", KEY, "GT", score, member]); // keep each player's best
    const rank = await redis(["ZREVRANK", KEY, member]);
    const r = await redis(["ZREVRANGE", KEY, 0, 9, "WITHSCORES"]);
    const top = [];
    for (let i = 0; i < r.length; i += 2)
      top.push({ handle: r[i], score: Math.round(+r[i + 1]) });
    json(res, 200, { ok: true, rank: rank + 1, top });
  } catch (e) {
    json(res, 503, {
      error: "Leaderboard unavailable",
      reason: String(e.message || e).slice(0, 160),
    });
  }
};
