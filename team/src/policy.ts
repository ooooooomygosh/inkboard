export const REPOS = [
  "OmnixSI/NextThought",
  "OmnixSI/NextThought-Website",
  "OmnixSI/WhalePartner",
  "OmnixSI/peiwan-store-platform-blueprint",
];
export const EFFORT = {
  chat: "high",
  plan: "max",
  memory: "max",
  code: "max",
} as const;
export function command(text: string) {
  // Only a direct command at the beginning authorizes execution; quoted/forwarded elements never enter here.
  const m = text.trim().match(/^\/(开工|方案)\s+(\S+)\s+([\s\S]{1,4000})$/u);
  if (!m) return null;
  const repo = REPOS.find(
    (r) =>
      r.toLowerCase() === m[2].toLowerCase() ||
      r.split("/")[1].toLowerCase() === m[2].toLowerCase() ||
      (INITIAL_PROJECT_HINTS as Record<string, string[]>)[r]?.includes(m[2]),
  );
  return repo ? { repo, title: m[3].trim(), execute: m[1] === "开工" } : null;
}
export function validStatus(s: string) {
  return [
    "proposal",
    "queued",
    "running",
    "needs_human",
    "ready_for_review",
    "done",
    "failed",
  ].includes(s);
}
// Initial hints only. Learned project facts and corrections are supplied to the model at runtime.
export const INITIAL_PROJECT_HINTS = {
  "OmnixSI/WhalePartner": ["大肥鱼", "大鲸鱼", "鲸鱼娘", "鲸汐"],
  "OmnixSI/NextThought": ["面试软件", "面试助手"],
  "OmnixSI/NextThought-Website": ["面试软件官网", "官网"],
  "OmnixSI/peiwan-store-platform-blueprint": ["陪玩店", "陪玩店那个项目"],
};

export function extractUrls(text: string) {
  return [
    ...new Set(
      text.match(
        /https?:\/\/[^\s"'<>\\\[\]()（）\u3001\uff0c\u3002\uff1b]+/g,
      ) || [],
    ),
  ]
    .map((x) => x.replace(/[.,;!?]+$/, ""))
    .filter((x) => {
      try {
        return !!new URL(x).hostname;
      } catch {
        return false;
      }
    })
    .slice(0, 5);
}
