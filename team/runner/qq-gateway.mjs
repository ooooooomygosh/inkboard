// Local official QQ gateway. No model runs here; all business processing remains in the team Worker.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
const home = path.join(os.homedir(), ".inkboard-team");
const config = JSON.parse(fs.readFileSync(path.join(home, "config.json")));
const secret = JSON.parse(
  fs.readFileSync(path.join(home, "worker-secrets.json")),
);
const sdk = await import(
  path.join(
    os.homedir(),
    ".dsh/profiles/qq-team/node_modules/@tencent-connect/qqbot-nodejs/dist/index.js",
  )
);
const spool = path.join(home, "qq-spool");
fs.mkdirSync(spool, { recursive: true, mode: 0o700 });
let seed = secret.QQ_APP_SECRET;
while (seed.length < 32) seed += seed;
const key = crypto.createPrivateKey({
  key: Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.from(seed.slice(0, 32)),
  ]),
  format: "der",
  type: "pkcs8",
});
let flushing = false,
  connected = false;
async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    for (const f of fs.readdirSync(spool).slice(0, 30)) {
      const raw = fs.readFileSync(path.join(spool, f), "utf8");
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = crypto.sign(null, Buffer.from(ts + raw), key).toString("hex");
      const r = await fetch(config.url + "/api/qq/events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-signature-timestamp": ts,
          "x-signature-ed25519": sig,
        },
        body: raw,
        signal: AbortSignal.timeout(20000),
      });
      if (!r.ok) throw Error("cloud HTTP " + r.status);
      fs.unlinkSync(path.join(spool, f));
    }
  } catch (e) {
    console.log("QQ relay waiting:", e.message);
  } finally {
    flushing = false;
  }
}
const bot = new sdk.QQBot({
  appId: secret.QQ_APP_ID,
  appSecret: secret.QQ_APP_SECRET,
  baseUrl: "https://api.bot.qq.com",
  tokenBaseUrl: "https://api.bot.qq.com",
  logger: {
    info: () => {},
    debug: () => {},
    warn: () => console.log("QQ gateway warning"),
    error: () => console.log("QQ gateway error"),
  },
});
bot.on("message", async (ctx) => {
  const m = ctx.message;
  if (m.kind !== "group") return;
  const raw = JSON.stringify({ op: 0, t: m.rawEventType, d: m.raw });
  const name =
    crypto.createHash("sha256").update(m.messageId).digest("hex") + ".json";
  fs.writeFileSync(path.join(spool, name), raw, { mode: 0o600 });
  await flush();
});
bot.on("ready", () => {
  connected = true;
  console.log("QQ official gateway connected");
});
bot.on("error", () =>
  console.log("QQ connection error; check credentials/network"),
);
bot.on("disconnected", () => {
  connected = false;
  console.log("QQ gateway disconnected");
});
setInterval(flush, 10000);

let delivering = false;
setInterval(async () => {
  if (delivering) return;
  delivering = true;
  try {
    const dir = path.join(home, "file-deliveries");
    if (!fs.existsSync(dir)) return;
    for (const name of fs
      .readdirSync(dir)
      .filter((x) => x.endsWith(".json"))
      .slice(0, 3)) {
      const file = path.join(dir, name),
        active = file + ".sending";
      fs.renameSync(file, active);
      try {
        const delivery = JSON.parse(fs.readFileSync(active));
        const response = await fetch(
          config.url + "/api/runner/delivery-target",
          {
            method: "POST",
            headers: {
              Authorization: "Bearer " + config.runnerToken,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ message: delivery.message }),
          },
        );
        if (!response.ok) throw Error("unknown target");
        const target = await response.json();
        for (const f of delivery.files) {
          const real = fs.realpathSync(f),
            root = fs.realpathSync(path.join(home, "utility")) + path.sep;
          if (
            !real.startsWith(root) ||
            !real.includes(path.sep + "outputs" + path.sep)
          )
            throw Error("file path denied");
          await bot.sendFile(
            { scope: "group", targetId: target.group_id },
            { localPath: real },
          );
        }
        fs.renameSync(active, file + ".sent");
        console.log("Generated files delivered to target group");
      } catch {
        fs.renameSync(active, file + ".failed");
        console.log("Generated file delivery requires attention");
      }
    }
  } finally {
    delivering = false;
  }
}, 10000);

setInterval(async () => {
  try {
    await fetch(config.url + "/api/runner/gateway-status", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + config.runnerToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ connected }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {}
}, 30000);
await bot.start();
