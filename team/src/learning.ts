/** Corpus mining is cheap; only the nightly max pass decides meanings and reusable situations. */
export function phraseCandidates(rows: any[]) {
  const map = new Map<
    string,
    { phrase: string; count: number; speakers: Set<string>; examples: string[] }
  >();
  for (const row of rows) {
    const seen = new Set<string>();
    const chunks =
      String(row.body || "")
        .replace(/https?:\/\/\S+|`[^`]*`/g, "")
        .match(/[\p{L}]{2,24}/gu) || [];
    for (const chunk of chunks)
      for (let size = 2; size <= Math.min(8, chunk.length); size++)
        for (let at = 0; at + size <= chunk.length; at++)
          seen.add(chunk.slice(at, at + size));
    for (const phrase of seen) {
      const value = map.get(phrase) || {
        phrase,
        count: 0,
        speakers: new Set<string>(),
        examples: [],
      };
      value.count++;
      value.speakers.add(row.sender);
      if (value.examples.length < 3) value.examples.push(row.id);
      map.set(phrase, value);
    }
  }
  const found = [...map.values()]
    .filter((x) => x.count >= 3 && x.speakers.size >= 2)
    .sort((a, b) => b.count * b.phrase.length - a.count * a.phrase.length);
  return found
    .filter(
      (x) =>
        !found.some(
          (y) =>
            y.phrase !== x.phrase &&
            y.phrase.includes(x.phrase) &&
            y.count === x.count,
        ),
    )
    .slice(0, 25)
    .map((x) => ({ ...x, speakers: x.speakers.size }));
}
export async function consolidateExpressions(e: any, items: any, rows: any[]) {
  for (const x of Array.isArray(items) ? items.slice(0, 8) : []) {
    if (
      typeof x.phrase !== "string" ||
      x.phrase.length < 1 ||
      x.phrase.length > 40 ||
      typeof x.meaning !== "string" ||
      typeof x.scene !== "string"
    )
      continue;
    const evidence = (Array.isArray(x.evidence) ? x.evidence : []).filter(
      (v: any) =>
        rows.some(
          (m) =>
            m.id === v.source_id &&
            typeof v.quote === "string" &&
            m.body.includes(v.quote) &&
            v.quote.includes(x.phrase),
        ),
    );
    if (
      !evidence.length ||
      /sk-|密码|验证码|忽略.{0,6}指令|系统提示/i.test(x.phrase + x.meaning)
    )
      continue;
    const counts = await e.DB.prepare(
      "SELECT COUNT(*) AS n,COUNT(DISTINCT m.sender) AS speakers FROM messages m LEFT JOIN message_meta mm ON mm.id=m.id WHERE instr(m.body,?)>0 AND COALESCE(json_extract(mm.json,'$.direct'),1)=1",
    )
      .bind(x.phrase)
      .first();
    const explained =
      x.explained === true &&
      evidence.some((v: any) => v.quote.length > x.phrase.length + 3);
    const active = (counts.n >= 3 && counts.speakers >= 2) || explained;
    await e.DB.prepare(
      "INSERT INTO expressions VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(phrase) DO UPDATE SET meaning=excluded.meaning,scene=excluded.scene,evidence=excluded.evidence,source_ids=excluded.source_ids,frequency=excluded.frequency,speakers=excluded.speakers,enabled=excluded.enabled,updated_at=excluded.updated_at WHERE expressions.enabled!=0",
    )
      .bind(
        x.phrase,
        x.meaning.slice(0, 300),
        x.scene.slice(0, 200),
        JSON.stringify(evidence),
        JSON.stringify(evidence.map((v: any) => v.source_id)),
        counts.n,
        counts.speakers,
        active ? 1 : 2,
        new Date().toISOString(),
      )
      .run();
  }
}
function grams(s: string) {
  const out = new Set<string>();
  for (const word of s.match(/[\p{L}]+/gu) || [])
    for (let i = 0; i < word.length - 1; i++) out.add(word.slice(i, i + 2));
  return out;
}
export async function relevantExpressions(e: any, text: string) {
  const rows = (
    await e.DB.prepare(
      "SELECT phrase,meaning,scene,evidence,frequency FROM expressions WHERE enabled=1 AND updated_at>? ORDER BY updated_at DESC LIMIT 40",
    )
      .bind(new Date(Date.now() - 45 * 86400000).toISOString())
      .all()
  ).results;
  const query = grams(text);
  return rows
    .map((r: any) => ({
      ...r,
      score: [...grams(r.phrase + r.scene + r.evidence)].filter((x) =>
        query.has(x),
      ).length,
    }))
    .filter((r: any) => r.score > 0)
    .sort((a: any, b: any) => b.score - a.score)
    .slice(0, 3)
    .map((r: any) => ({
      phrase: r.phrase,
      meaning: r.meaning,
      scene: r.scene,
    }));
}
