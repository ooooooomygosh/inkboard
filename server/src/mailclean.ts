// Mail often arrives through a "forward" rule (school and work accounts that a desktop mail app cannot
// sign in to), so the sender is the user and the real sender/subject sit in the quoted header block.
// Unpack that, and drop boilerplate (legal disclaimers, "you don't often get email from…",
// "Get Outlook for Mac") so the AI sees only what matters.
export interface RawMail { sender: string; subject: string; snippet: string }

const FWD = /^\s*(轉寄|转发|轉發|FW|Fwd|TR|WG)\s*[:：]\s*/i;
const FROM = /^(寄件者|发件人|發件人|From)\s*[:：]\s*(.+)$/i;
const SUBJ = /^(主旨|主题|主題|Subject)\s*[:：]\s*(.*)$/i;
const HEAD = /^(已傳送|发送时间|發送時間|Sent|Date|收件者|收件人|To|副本|抄送|Cc)\s*[:：]/i;
const NOISE = [
  /^(您不常收到來自|您不经常收到来自|You don't often get email from|Some people who received this message don't often get email from).*/i,
  /^(获取|獲取|Get) Outlook for (Mac|iOS|Android).*/i,
  /^_{5,}$|^-{5,}$/,
];
const CUT = /(CRICOS Provider Code|DISCLAIMER: This email message|This email and any attachments are confidential|本邮件及其附件含有|Think\. Green\. Do\.)/i;

export function cleanMail(m: RawMail): RawMail {
  let lines = (m.snippet || '').split(/\s*⏎\s*/).map((l) => l.trim());
  let { sender, subject } = m;
  if (FWD.test(subject)) {
    const i = lines.findIndex((l) => FROM.test(l));
    if (i >= 0) {
      sender = FROM.exec(lines[i])![2].trim();
      let j = i + 1;
      for (; j < lines.length; j++) {
        const s = SUBJ.exec(lines[j]);
        if (s) { if (s[2].trim()) subject = s[2].trim(); j++; break; }
        if (!HEAD.test(lines[j]) && lines[j]) break;
      }
      lines = lines.slice(j);
    }
    subject = subject.replace(FWD, '');
  }
  const body: string[] = [];
  for (const l of lines) {
    if (CUT.test(l)) { const k = l.search(CUT); if (k > 0) body.push(l.slice(0, k)); break; }
    if (!l || NOISE.some((r) => r.test(l))) continue;
    body.push(l);
  }
  return { sender, subject, snippet: body.join(' ').replace(/\s+/g, ' ').trim() };
}
