// Hall Pass reminders. GitHub Actions runs this every 15 minutes. For every device that turned
// reminders on (users/{uid}/push), it looks at that person's classes and tasks in their own time
// zone and sends what's coming up:
//   - a class starting in the next 17 minutes (so roughly 10 minutes before, given the schedule)
//   - work due tomorrow, once, from 8 PM the evening before
//   - work due within the next 75 minutes, once
//   - the daily medicine reminder (users/{uid}/meds/daily), at the time the person chose, until they mark it taken, with one nudge an hour later
// Each reminder is recorded in users/{uid}/sent so it goes out only once, even if runs overlap.
//
// Env: FIREBASE_SERVICE_ACCOUNT (the service account JSON), VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY.
// DRY_RUN=1 prints what would be sent and sends nothing. FIRESTORE_EMULATOR_HOST works for tests.
import admin from "firebase-admin";
import webpush from "web-push";

const DRY = process.env.DRY_RUN === "1";
const CLASS_LEAD = 17, HOUR_LEAD = 75, EVENING_HOUR = 20, KEEP_DAYS = 14;

if (process.env.FIRESTORE_EMULATOR_HOST) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || "demo-hall-pass" });
else admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
if (!DRY) webpush.setVapidDetails("https://hall-pass-gemz.web.app", process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);

// Wall-clock time in a time zone, as "naive" milliseconds: the same scale as Date.UTC(y, m, d, h, min),
// so it compares directly with the app's local "YYYY-MM-DDTHH:MM" strings.
function localNow(tz) {
  const p = {};
  for (const x of new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" }).formatToParts(new Date())) p[x.type] = x.value;
  const ms = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return { ms, day: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday), hour: +p.hour, date: `${p.year}-${p.month}-${p.day}` };
}
const naive = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s || ""); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null; };
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const t12 = (ms) => { const d = new Date(ms), h = d.getUTCHours(), m = String(d.getUTCMinutes()).padStart(2, "0"); return `${h % 12 || 12}:${m} ${h < 12 ? "am" : "pm"}`; };
const validTz = (tz) => { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; } };

// Medicine: sent once a day, from the chosen time until 2 hours later (a missed run still catches up),
// and never if today is already marked taken (users/{uid}/medlog/YYYY-MM-DD).
function medPlan(now, cfg, taken) {
  if (!cfg || cfg.on !== true || !/^([01]\d|2[0-3]):[0-5]\d$/.test(cfg.time || "") || taken) return [];
  const mins = Math.round((now.ms - naive(`${now.date}T${cfg.time}`)) / 6e4);
  if (mins < 0 || mins > 120) return [];
  const title = String(cfg.msg || "").slice(0, 120) || "خدي الدوا يرنوشتي";
  // First at the chosen time, then one gentle nudge an hour later if it still isn't marked taken.
  return mins < 60
    ? [{ key: `m_${now.date}`, title, body: "Hall Pass · tap Taken when you have", tag: "med" }]
    : [{ key: `m2_${now.date}`, title, body: "Still not marked as taken", tag: "med" }];
}

function plan(now, classes, tasks) {
  const out = [];
  for (const k of classes) {
    if (+k.d !== now.day || k.kind === "Activity" || !/^\d{2}:\d{2}$/.test(k.start || "")) continue;
    const start = naive(`${now.date}T${k.start}`), mins = Math.round((start - now.ms) / 6e4);
    if (mins <= 0 || mins > CLASS_LEAD) continue;
    out.push({ key: `c_${k.id}_${now.date}`, title: `${k.short || k.course} in ${mins} min`,
      body: [k.kind, k.room].filter(Boolean).join(" · ") + `, ${t12(start)}`, tag: `class-${k.id}` });
  }
  const tomorrow = ymd(now.ms + 864e5);
  for (const t of tasks) {
    if (t.done || !t.due) continue;
    const due = naive(t.due); if (due == null) continue;
    const name = (t.title || "Task").slice(0, 80), where = t.course ? `${t.course} · ` : "";
    const left = Math.round((due - now.ms) / 6e4);
    if (left > 0 && left <= HOUR_LEAD) {
      out.push({ key: `h_${t.id}_${t.due}`, title: `Due in ${left < 60 ? left + " min" : "an hour"}: ${name}`, body: `${where}due ${t12(due)}`, tag: `task-${t.id}` });
    } else if (t.due.slice(0, 10) === tomorrow && now.hour >= EVENING_HOUR) {
      out.push({ key: `e_${t.id}_${t.due}`, title: `Due tomorrow: ${name}`, body: `${where}${t12(due)}`, tag: `task-${t.id}` });
    }
  }
  return out;
}

async function run() {
  const subs = await db.collectionGroup("push").get();
  const byUser = new Map();
  subs.forEach((s) => { const uid = s.ref.parent.parent.id; (byUser.get(uid) || byUser.set(uid, []).get(uid)).push(s); });
  let sent = 0, gone = 0;
  for (const [uid, devices] of byUser) {
    const user = db.collection("users").doc(uid);
    const [me, cls, tsk, med] = await Promise.all([user.get(), user.collection("classes").get(), user.collection("tasks").get(), user.collection("meds").doc("daily").get()]);
    const tz = me.exists && validTz(me.get("tz")) ? me.get("tz") : "Africa/Cairo";
    const now = localNow(tz);
    const due = plan(now, cls.docs.map((d) => ({ id: d.id, ...d.data() })), tsk.docs.map((d) => ({ id: d.id, ...d.data() })));
    const taken = (await user.collection("medlog").doc(now.date).get()).exists;
    due.push(...medPlan(now, med.exists ? med.data() : null, taken));
    for (const n of due) {
      // Claim it first: create() fails if another run already sent this one.
      if (!DRY) { try { await user.collection("sent").doc(n.key).create({ at: admin.firestore.Timestamp.now() }); } catch { continue; } }
      const payload = JSON.stringify({ title: n.title, body: n.body, tag: n.tag, url: "/" });
      if (DRY) { console.log(`[dry] ${uid} ${tz}: ${n.title} | ${n.body}`); sent++; continue; }
      for (const d of devices) {
        const v = d.data();
        try { await webpush.sendNotification({ endpoint: v.endpoint, keys: { p256dh: v.p256dh, auth: v.auth } }, payload, { TTL: 1800, urgency: "high" }); sent++; }
        catch (e) { if (e.statusCode === 404 || e.statusCode === 410) { await d.ref.delete(); gone++; } else console.error(`push failed (${e.statusCode || e.message})`); }
      }
    }
    // Forget old "already sent" markers.
    if (!DRY) {
      const old = await user.collection("sent").where("at", "<", admin.firestore.Timestamp.fromMillis(Date.now() - KEEP_DAYS * 864e5)).get();
      await Promise.all(old.docs.map((d) => d.ref.delete()));
    }
  }
  console.log(`${byUser.size} people, ${sent} notifications sent, ${gone} expired devices removed`);
}

run().catch((e) => { console.error(e.message); process.exit(1); });
