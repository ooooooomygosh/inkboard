import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { build } from "../../server/node_modules/esbuild/lib/main.js";
await build({
  entryPoints: ["src/worker.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: ".wrangler/test-worker.mjs",
});
const { default: worker, signature } = await import(
  "../.wrangler/test-worker.mjs"
);
function db() {
  const d = new DatabaseSync(":memory:");
  d.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              return d.prepare(sql).get(...args) || null;
            },
            async all() {
              return { results: d.prepare(sql).all(...args) };
            },
            async run() {
              return d.prepare(sql).run(...args);
            },
          };
        },
        async all() {
          return { results: d.prepare(sql).all() };
        },
        async first() {
          return d.prepare(sql).get() || null;
        },
      };
    },
    async batch(ss) {
      return Promise.all(ss.map((s) => s.run()));
    },
  };
}
function env() {
  return {
    DB: db(),
    ADMIN_TOKEN: "owner-secret",
    RUNNER_TOKEN: "runner-secret",
    QQ_APP_SECRET: "test-only-secret",
    WORK: { async send() {} },
    DEEPSEEK_API_KEY: "fake",
  };
}
async function req(
  e,
  path,
  body,
  key = "owner-secret",
  method = body ? "POST" : "GET",
) {
  return worker.fetch(
    new Request("https://team.example" + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + key,
      },
      body: body ? JSON.stringify(body) : undefined,
    }),
    e,
  );
}
async function qq(e, data, type = "GROUP_MESSAGE_CREATE") {
  const raw = JSON.stringify({ op: 0, t: type, d: data });
  const ts = String(Math.floor(Date.now() / 1000));
  return worker.fetch(
    new Request("https://team.example/api/qq/events", {
      method: "POST",
      body: raw,
      headers: {
        "x-signature-timestamp": ts,
        "x-signature-ed25519": await signature(e.QQ_APP_SECRET, ts + raw),
      },
    }),
    e,
  );
}
const msg = (id, content, group = "GROUP000001") => ({
  id,
  content,
  group_openid: group,
  timestamp: new Date().toISOString(),
  author: { id: "member1", member_role: "owner", bot: false },
});
test("anonymous denied and owner secret never returned", async () => {
  const e = env();
  assert.equal((await req(e, "/api/team/state", null, "bad")).status, 401);
  const s = await (await req(e, "/api/team/state")).text();
  assert.ok(!s.includes(e.ADMIN_TOKEN));
});
test("invitation single use, member cannot administer, revocation immediate", async () => {
  const e = env();
  const { invite } = await (
    await req(e, "/api/admin/invite", { name: "张三" })
  ).json();
  const { token } = await (
    await req(e, "/api/team/join", { invite }, "")
  ).json();
  assert.equal((await req(e, "/api/team/join", { invite }, "")).status, 403);
  assert.equal((await req(e, "/api/admin/pair", {}, token)).status, 403);
  const s = await (await req(e, "/api/team/state", null, token)).json();
  await req(e, "/api/admin/revoke", { id: s.who.id });
  assert.equal((await req(e, "/api/team/state", null, token)).status, 401);
});
test("webhook verification, pairing, group isolation, duplicates and explicit dispatch", async () => {
  const e = env();
  const { code } = await (await req(e, "/api/admin/pair", {})).json();
  await qq(e, msg("bind", "/绑定 " + code));
  await qq(e, msg("one", "/开工 WhalePartner 修复测试"));
  await qq(e, msg("one", "/开工 WhalePartner 修复测试"));
  await qq(e, msg("other", "/开工 WhalePartner 偷渡", "OTHERGROUP"));
  await qq(e, {
    ...msg("quote", "/开工 WhalePartner 引用"),
    msg_elements: [{ content: "引用" }],
  });
  const s = await (await req(e, "/api/team/state")).json();
  assert.equal(s.tasks.length, 1);
  assert.equal(s.tasks[0].status, "queued");
  assert.ok(s.connection.fullMessageVerified);
  assert.equal(
    (
      await worker.fetch(
        new Request("https://team.example/api/qq/events", {
          method: "POST",
          body: JSON.stringify({ op: 0 }),
        }),
        e,
      )
    ).status,
    401,
  );
});
test("optimistic task updates do not overwrite human decisions", async () => {
  const e = env();
  const { id } = await (
    await req(e, "/api/team/task", {
      repo: "OmnixSI/WhalePartner",
      title: "test",
    })
  ).json();
  assert.equal(
    (
      await req(
        e,
        "/api/team/task",
        { id, version: 1, status: "done", result: "人工完成" },
        undefined,
        "PATCH",
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await req(
        e,
        "/api/team/task",
        { id, version: 1, status: "running" },
        undefined,
        "PATCH",
      )
    ).status,
    409,
  );
});
test("runner lease exclusive, invalid report rejected and human changes protected", async () => {
  const e = env();
  const { id } = await (
    await req(e, "/api/team/task", {
      repo: "OmnixSI/WhalePartner",
      title: "test",
    })
  ).json();
  await req(
    e,
    "/api/team/task",
    { id, version: 1, status: "queued" },
    undefined,
    "PATCH",
  );
  const { task } = await (
    await req(e, "/api/runner/claim", {}, "runner-secret")
  ).json();
  assert.equal(
    (await (await req(e, "/api/runner/claim", {}, "runner-secret")).json())
      .task,
    null,
  );
  assert.equal(
    (
      await req(
        e,
        "/api/runner/report",
        {
          id,
          lease: "wrong",
          version: task.version,
          status: "needs_human",
          result: "bad",
        },
        "runner-secret",
      )
    ).status,
    409,
  );
  await req(
    e,
    "/api/team/task",
    { id, version: task.version, status: "done", result: "人工完成" },
    undefined,
    "PATCH",
  );
  assert.equal(
    (
      await req(
        e,
        "/api/runner/report",
        {
          id,
          lease: task.lease,
          version: task.version,
          status: "needs_human",
          result: "bad",
        },
        "runner-secret",
      )
    ).status,
    409,
  );
});
test("model effort, evidence validation and task plan are persisted", async () => {
  const e = env();
  await req(e, "/api/admin/bind", { groupId: "GROUP000001" });
  await qq(e, msg("plan", "/方案 WhalePartner 增加测试"));
  const original = globalThis.fetch;
  const efforts = [];
  globalThis.fetch = async (u, o) => {
    const b = JSON.parse(o.body);
    efforts.push(b.reasoning_effort);
    return Response.json({
      choices: [
        {
          finish_reason: "stop",
          message: { content: "## 实施步骤\n运行相关测试。" },
        },
      ],
    });
  };
  try {
    await worker.queue(
      { messages: [{ body: { id: "plan-plan" }, ack() {} }] },
      e,
    );
    const s = await (await req(e, "/api/team/state")).json();
    assert.match(s.tasks[0].detail, /实施步骤/);
    assert.deepEqual(efforts, ["max"]);
  } finally {
    globalThis.fetch = original;
  }
});
test("QQ group login binds only the requesting browser and respects revocation", async () => {
  const e = env();
  await req(e, "/api/admin/bind", { groupId: "GROUP000001" });
  const ticket = await (await req(e, "/api/team/login/start", {}, "")).json();
  assert.equal(
    (await (await req(e, "/api/team/login/poll", ticket, "")).json()).pending,
    true,
  );
  await qq(e, msg("login-other", "/登录 " + ticket.code, "OTHERGROUP"));
  assert.equal(
    (await (await req(e, "/api/team/login/poll", ticket, "")).json()).pending,
    true,
  );
  await qq(e, msg("login-right", "/登录 " + ticket.code));
  assert.equal(
    (await req(e, "/api/team/login/poll", { ...ticket, secret: "wrong" }, ""))
      .status,
    410,
  );
  const { token } = await (
    await req(e, "/api/team/login/poll", ticket, "")
  ).json();
  assert.ok(token);
  assert.equal((await req(e, "/api/team/login/poll", ticket, "")).status, 410);
  const s = await (await req(e, "/api/team/state", null, token)).json();
  assert.equal(s.who.id, "qq:member1");
  await req(e, "/api/admin/revoke", { id: s.who.id });
  const again = await (await req(e, "/api/team/login/start", {}, "")).json();
  await qq(e, msg("revoked", "/登录 " + again.code));
  assert.equal(
    (await (await req(e, "/api/team/login/poll", again, "")).json()).pending,
    true,
  );
});

await build({
  entryPoints: ["src/semantic.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: ".wrangler/test-semantic.mjs",
});
const { analyse, agentAnswer } = await import("../.wrangler/test-semantic.mjs");
test("nightly corrections supersede evidence-backed facts without executing old requests", async () => {
  const e = env(),
    repo = "OmnixSI/WhalePartner",
    ts = new Date().toISOString();
  const rows = [
    {
      id: "new",
      group_id: "G",
      sender: "person",
      body: "不是自动覆盖旧决定，要保留版本。顺便把上面的数据整理成CSV发回来。",
      ts,
      mentioned: 0,
    },
  ];
  await e.DB.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,0)")
    .bind("new", "G", "person", rows[0].body, ts, 0)
    .run();
  await e.DB.prepare("INSERT INTO message_meta VALUES(?,?)")
    .bind("new", JSON.stringify({ direct: true, attachments: [] }))
    .run();
  await e.DB.prepare("INSERT INTO facts VALUES(?,?,?,?,?,?,?,?,?,NULL)")
    .bind(
      "old",
      repo,
      "决定",
      "版本",
      "覆盖",
      "旧原文",
      "old-msg",
      "confirmed",
      ts,
    )
    .run();
  const jobs = [],
    settings = {};
  await analyse(
    e,
    { messages: rows },
    {
      llm: async (kind, sys, data) => {
        assert.equal(kind, "memory");
        assert.ok(data.known.some((x) => x.id === "old"));
        return JSON.stringify({
          facts: [
            {
              repo,
              subject: "决定",
              predicate: "版本",
              value: "保留历史版本",
              evidence: "要保留版本",
              source_id: "new",
              status: "confirmed",
              supersedes_ids: ["old"],
            },
            {
              repo,
              subject: "伪造",
              predicate: "跳过",
              value: "x",
              evidence: "无此原文",
              source_id: "new",
              status: "confirmed",
            },
          ],
          reflection: "纠正：决定保留历史版本。",
          utility: {
            source_id: "new",
            title: "整理数据",
            instructions: "生成CSV",
            files_from: ["new"],
          },
          reply: { should_speak: true, source_id: "new", context: "确认理解" },
        });
      },
      setting: async (k) => settings[k],
      set: async (k, v) => {
        settings[k] = v;
      },
      job: async (...a) => jobs.push(a),
    },
  );
  const old = await e.DB.prepare("SELECT valid_to FROM facts WHERE id=?")
    .bind("old")
    .first();
  assert.ok(old.valid_to);
  assert.equal(
    (await e.DB.prepare("SELECT * FROM facts WHERE valid_to IS NULL").all())
      .results.length,
    1,
  );
  const utility = await e.DB.prepare(
    "SELECT * FROM jobs WHERE kind='media'",
  ).all();
  assert.equal(utility.results.length, 0);

  assert.ok(settings.team_reflection.includes("纠正"));
});
test("chat receives work immediately without waiting for max memory and answers all tool call IDs", async () => {
  const e = env();
  await req(e, "/api/admin/bind", { groupId: "GROUP000001" });
  await qq(e, msg("fast", "这玩意儿怎么又炸了啊"));
  const fast = await e.DB.prepare("SELECT * FROM jobs WHERE id=?")
    .bind("chat-fast")
    .first();
  assert.equal(fast.kind, "chat");
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (u, o) => {
    const b = JSON.parse(o.body);
    assert.equal(b.reasoning_effort, "high");
    assert.match(b.messages[0].content, /我操|参与判定/);
    if (b.messages[0].content.includes("最后的嘴替模块")) {
      assert.ok(!b.messages[1].content.includes("reasoning_content"));
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                mode: "work",
                text: "先甩一段日志，我看具体是哪层炸了。",
              }),
            },
          },
        ],
      });
    }
    if (calls++ === 0)
      return Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              reasoning_content: "private",
              content: null,
              tool_calls: [0, 1, 2, 3].map((i) => ({
                id: "t" + i,
                type: "function",
                function: {
                  name: "get_project",
                  arguments: JSON.stringify({ repo: "OmnixSI/WhalePartner" }),
                },
              })),
            },
          },
        ],
      });
    assert.equal(b.messages.filter((x) => x.role === "tool").length, 4);
    assert.ok(b.messages.some((x) => x.reasoning_content === "private"));
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              should_reply: true,
              kind: "direct",
              brief: "需要先提供日志确认故障",
            }),
          },
        },
      ],
    });
  };
  try {
    const answer = await agentAnswer(e, { latest: "问题" });
    assert.match(answer, /日志/);
  } finally {
    globalThis.fetch = original;
  }
});
test("CI notifications deduplicate and media lease rejects stale reports", async () => {
  const e = env();
  await req(e, "/api/admin/bind", { groupId: "GROUP000001" });
  const payload = {
    repo: "OmnixSI/WhalePartner",
    context: {
      checks: [
        {
          id: 1,
          head_sha: "abc",
          name: "test",
          conclusion: "failure",
          html_url: "https://github.com/test",
        },
      ],
    },
  };
  await req(e, "/api/runner/context", payload, "runner-secret");
  await req(e, "/api/runner/context", payload, "runner-secret");
  assert.equal(
    (await e.DB.prepare("SELECT * FROM outbox WHERE id LIKE 'ci-%'").all())
      .results.length,
    1,
  );
  await qq(e, msg("files", "整理成表格"));
  await e.DB.prepare(
    "INSERT INTO jobs(id,kind,payload,created_at) VALUES(?,?,?,?)",
  )
    .bind("file1", "media", JSON.stringify({ message: "files" }), Date.now())
    .run();
  const { job } = await (
    await req(e, "/api/runner/media/claim", {}, "runner-secret")
  ).json();
  assert.ok(job.payload.lease);
  assert.equal(
    (
      await (
        await req(e, "/api/runner/media/claim", {}, "runner-secret")
      ).json()
    ).job,
    null,
  );
  assert.equal(
    (
      await req(
        e,
        "/api/runner/media/report",
        { id: "file1", lease: "wrong", result: "x" },
        "runner-secret",
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await req(
        e,
        "/api/runner/media/report",
        { id: "file1", lease: job.payload.lease, result: "CSV已生成" },
        "runner-secret",
      )
    ).status,
    200,
  );
});

test("daytime scheduling does not run memory max; nightly consolidation keeps diary separate and silent", async () => {
  const e = env(),
    ts = new Date().toISOString();
  await req(e, "/api/admin/bind", { groupId: "GROUP000001" });
  await qq(e, msg("night", "大肥鱼这个代称就是WhalePartner。"));
  const before = (
    await e.DB.prepare(
      "SELECT * FROM jobs WHERE kind IN ('discussion','dream')",
    ).all()
  ).results;
  assert.equal(before.length, 0);
  const source = await e.DB.prepare("SELECT * FROM messages WHERE id=?")
      .bind("night")
      .first(),
    settings = {};
  let calls = 0;
  await analyse(
    e,
    { messages: [source], dream: true, key: "dream-test", date: "2026-11-11" },
    {
      llm: async (kind) => {
        calls++;
        assert.equal(kind, "memory");
        return JSON.stringify({
          facts: [],
          reflection: "保留代称，避免同一来源反复学习。",
          reply: {
            should_speak: true,
            source_id: "night",
            context: "应当被忽略",
          },
          utility: {
            source_id: "night",
            title: "不应执行",
            instructions: "不应执行",
          },
        });
      },
      setting: async (k) => settings[k],
      set: async (k, v) => (settings[k] = v),
      job: async () => assert.fail("dream must not post or execute"),
    },
  );
  assert.equal(calls, 1);
  assert.equal(
    (await e.DB.prepare("SELECT * FROM dreams").all()).results.length,
    1,
  );
  assert.equal(
    (await e.DB.prepare("SELECT * FROM jobs WHERE kind='media'").all()).results
      .length,
    0,
  );
  assert.equal(
    (await e.DB.prepare("SELECT * FROM outbox").all()).results.length,
    0,
  );
});

await build({
  entryPoints: ["src/voice.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: ".wrangler/test-voice.mjs",
});
await build({
  entryPoints: ["src/learning.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: ".wrangler/test-learning.mjs",
});
const { fragments, decodeVoice } = await import("../.wrangler/test-voice.mjs");
const { phraseCandidates, consolidateExpressions, relevantExpressions } =
  await import("../.wrangler/test-learning.mjs");
test("casual imperfections are stable, occasional and never touch work, digits, links or filenames", () => {
  const body = "我不知道啊。我再看看。";
  let split = 0,
    typo = 0;
  for (let i = 0; i < 500; i++) {
    const id = "voice-" + i,
      v = JSON.stringify({ mode: "banter", text: body }),
      parts = fragments(v, id);
    assert.deepEqual(parts, fragments(v, id));
    assert.ok(parts.length <= 3);
    if (parts.length > 1) split++;
    if (parts.join("").includes("不知到")) typo++;
    for (const mode of ["work", "care"])
      assert.deepEqual(fragments(JSON.stringify({ mode, text: body }), id), [
        body,
      ]);
    const technical = "版本 3.2：https://example.com/a.csv。";
    assert.deepEqual(
      fragments(JSON.stringify({ mode: "banter", text: technical }), id),
      [technical],
    );
  }
  assert.ok(split > 0 && split < 200);
  assert.ok(typo > 0 && typo < 30);
  assert.equal(decodeVoice('{"mode":"work","text":"已完成"}').text, "已完成");
});
test("nightly slang promotion requires real group evidence; opt-out survives future learning", async () => {
  const e = env(),
    ts = new Date().toISOString();
  const rows = [
    { id: "e1", sender: "a", body: "这下真绷不住了" },
    { id: "e2", sender: "b", body: "又绷不住了" },
    { id: "e3", sender: "a", body: "我真绷不住了" },
  ];
  for (const r of rows)
    await e.DB.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,0)")
      .bind(r.id, "G", r.sender, r.body, ts, 0)
      .run();
  assert.ok(phraseCandidates(rows).some((x) => x.phrase.includes("绷不住")));
  const candidate = {
    phrase: "绷不住了",
    meaning: "看到荒谬好笑的东西",
    scene: "惊讶吐槽",
    evidence: [{ source_id: "e1", quote: rows[0].body }],
  };
  await consolidateExpressions(e, [candidate], rows);
  assert.equal(
    (
      await e.DB.prepare("SELECT * FROM expressions WHERE phrase=?")
        .bind(candidate.phrase)
        .first()
    ).enabled,
    1,
  );
  assert.equal((await relevantExpressions(e, "我这下绷不住了")).length, 1);
  await e.DB.prepare("UPDATE expressions SET enabled=0 WHERE phrase=?")
    .bind(candidate.phrase)
    .run();
  await consolidateExpressions(e, [candidate], rows);
  assert.equal((await relevantExpressions(e, "绷不住了")).length, 0);
  await consolidateExpressions(
    e,
    [{ ...candidate, phrase: "伪造的新梗" }],
    rows,
  );
  assert.equal(
    (await e.DB.prepare("SELECT * FROM expressions").all()).results.length,
    1,
  );
});

test("file failure is terminal once and never leaks local commands or paths to QQ", async () => {
  const e = env();
  await req(e, "/api/admin/bind", { groupId: "GROUP000001" });
  await qq(e, msg("bad-file", "整理附件"));
  await e.DB.prepare(
    "INSERT INTO jobs(id,kind,payload,created_at) VALUES(?,?,?,?)",
  )
    .bind(
      "bad-file-job",
      "media",
      JSON.stringify({ message: "bad-file" }),
      Date.now(),
    )
    .run();
  const { job } = await (
    await req(e, "/api/runner/media/claim", {}, "runner-secret")
  ).json();
  const report = {
    id: job.id,
    lease: job.payload.lease,
    success: false,
    result:
      "Command ['/Users/owner/tool', '--permission-mode'] timed out after 480 seconds",
  };
  assert.equal(
    (await req(e, "/api/runner/media/report", report, "runner-secret")).status,
    200,
  );
  assert.equal(
    (await req(e, "/api/runner/media/report", report, "runner-secret")).status,
    409,
  );
  assert.equal(
    (
      await (
        await req(e, "/api/runner/media/claim", {}, "runner-secret")
      ).json()
    ).job,
    null,
  );
  const out = (await e.DB.prepare("SELECT body FROM outbox").all()).results;
  assert.equal(out.length, 1);
  assert.ok(!/Command|Users|480/.test(out[0].body));
});

test("quoting old video results never starts another video task; markdown URLs stay separate", async () => {
  const e = env();
  await req(e, "/api/admin/bind", { groupId: "GROUP000001" });
  await qq(e, {
    ...msg("quote-video", "你做的查看B站内容也弄进去了"),
    msg_elements: [
      {
        content:
          "旧结果：[A](https://www.bilibili.com/video/AAA/?t=8)、[B](https://www.bilibili.com/video/BBB/?t=17)",
      },
    ],
  });
  assert.equal(
    (await e.DB.prepare("SELECT * FROM jobs WHERE kind='media'").all()).results
      .length,
    0,
  );
  await qq(
    e,
    msg(
      "new-video",
      "看看这两个：[A](https://www.bilibili.com/video/AAA/?t=8)、[B](https://www.bilibili.com/video/BBB/?t=17)",
    ),
  );
  const row = (
    await e.DB.prepare("SELECT payload FROM jobs WHERE kind='media'").all()
  ).results[0];
  assert.deepEqual(JSON.parse(row.payload).urls, [
    "https://www.bilibili.com/video/AAA/?t=8",
    "https://www.bilibili.com/video/BBB/?t=17",
  ]);
});

test("message bursts coalesce into one high response instead of delayed replies to every line", async () => {
  const e = env();
  await req(e, "/api/admin/bind", { groupId: "GROUP000001" });
  await qq(e, msg("burst1", "先说一下"));
  await qq(e, msg("burst2", "哈哈哈"));
  await qq(e, msg("burst3", "现在就说这个"));
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (u, o) => {
    const b = JSON.parse(o.body);
    if (b.messages[0].content.includes("最后的嘴替模块"))
      return Response.json({
        choices: [
          { message: { content: '{"mode":"banter","text":"行，就这个"}' } },
        ],
      });
    calls++;
    const context = JSON.parse(b.messages[1].content).context;
    assert.equal(context.batch.length, 3);
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              should_reply: true,
              kind: "direct",
              brief: "只讨论当前问题",
            }),
          },
        },
      ],
    });
  };
  try {
    for (const id of ["chat-burst1", "chat-burst2", "chat-burst3"])
      await worker.queue({ messages: [{ body: { id }, ack() {} }] }, e);
    assert.equal(calls, 1);
    assert.equal(
      (await e.DB.prepare("SELECT * FROM outbox").all()).results.length,
      1,
    );
  } finally {
    globalThis.fetch = original;
  }
});

await build({
  entryPoints: ["src/engagement.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: ".wrangler/test-engagement.mjs",
});
const { maySpeak, recordProactive } = await import(
  "../.wrangler/test-engagement.mjs"
);
test("participation stays silent by default; unsolicited replies have a budget while direct requests bypass it", async () => {
  const e = env();
  assert.equal(await maySpeak(e, { should_reply: false }, false, false), false);
  assert.equal(
    await maySpeak(e, { should_reply: true, kind: "proactive" }, false, false),
    true,
  );
  await recordProactive(e);
  assert.equal(
    await maySpeak(e, { should_reply: true, kind: "proactive" }, false, false),
    false,
  );
  assert.equal(
    await maySpeak(e, { should_reply: true, kind: "direct" }, false, false),
    true,
  );
  assert.equal(
    await maySpeak(e, { should_reply: true, kind: "proactive" }, true, false),
    true,
  );
  assert.equal(await maySpeak(e, { should_reply: false }, false, true), true);
});
test("silent participation never calls the voice model or queues a QQ reply", async () => {
  const e = env();
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              should_reply: false,
              kind: "proactive",
              brief: "",
            }),
          },
        },
      ],
    });
  };
  try {
    assert.equal(
      decodeVoice(
        await agentAnswer(e, { latest: { body: "哈哈哈" }, recent: [] }),
      ).text,
      "[[SILENT]]",
    );
    assert.equal(calls, 1);
    assert.equal(
      (await e.DB.prepare("SELECT * FROM outbox").all()).results.length,
      0,
    );
  } finally {
    globalThis.fetch = original;
  }
});
