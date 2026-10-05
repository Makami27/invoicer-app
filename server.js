import "dotenv/config";
import express from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import pg from "pg";

const PgStore = connectPgSimple(session);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const app = express();
app.set("view engine", "ejs");
app.locals.money = (c) => "$" + (Number(c) / 100).toFixed(2);
app.locals.num = (s) => "INV-" + String(s).padStart(4, "0");
app.locals.day = (d) => new Date(d).toISOString().slice(0, 10);
app.use(express.urlencoded({ extended: false }));
app.use(express.static("public"));
app.use(
  session({
    store: new PgStore({ pool, createTableIfMissing: true }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax", maxAge: 6048e5 },
  })
);
app.use((req, res, next) => {
  res.locals.user = req.session.name || null;
  res.locals.error = null;
  next();
});
const q = (t, p) => pool.query(t, p).then((r) => r.rows);
const auth = (req, res, next) =>
  req.session.uid ? next() : res.redirect("/login");
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

async function load(where, params) {
  const [inv] = await q(
    `SELECT i.*, c.name client_name, c.email client_email, u.name from_name,
    u.email from_email, u.payment_info FROM invoices i JOIN clients c ON c.id=i.client_id
    JOIN users u ON u.id=i.user_id WHERE ${where}`,
    params
  );
  if (!inv) return null;
  inv.items = await q(
    "SELECT * FROM invoice_items WHERE invoice_id=$1 ORDER BY id",
    [inv.id]
  );
  inv.total = inv.items.reduce(
    (s, x) => s + Math.round(x.quantity * x.unit_cents),
    0
  );
  return inv;
}

// ---- Auth ----
app.get("/", (req, res) =>
  res.redirect(req.session.uid ? "/dashboard" : "/login")
);
app.get("/register", (req, res) => res.render("register"));
app.post(
  "/register",
  wrap(async (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password || password.length < 8)
      return res
        .status(400)
        .render("register", {
          error: "All fields required; password min 8 characters.",
        });
    try {
      const [u] = await q(
        "INSERT INTO users(name,email,password_hash) VALUES($1,lower($2),$3) RETURNING id,name",
        [name.trim(), email.trim(), await bcrypt.hash(password, 12)]
      );
      req.session.regenerate(() => {
        req.session.uid = u.id;
        req.session.name = u.name;
        res.redirect("/dashboard");
      });
    } catch (e) {
      if (e.code === "23505")
        return res
          .status(400)
          .render("register", { error: "Email already registered." });
      throw e;
    }
  })
);
app.get("/login", (req, res) => res.render("login"));
app.post(
  "/login",
  wrap(async (req, res) => {
    const [u] = await q("SELECT * FROM users WHERE email=lower($1)", [
      req.body.email || "",
    ]);
    if (!u || !(await bcrypt.compare(req.body.password || "", u.password_hash)))
      return res
        .status(401)
        .render("login", { error: "Invalid email or password." });
    req.session.regenerate(() => {
      req.session.uid = u.id;
      req.session.name = u.name;
      res.redirect("/dashboard");
    });
  })
);
app.post("/logout", (req, res) =>
  req.session.destroy(() => res.redirect("/login"))
);

// ---- Settings: payment instructions shown on invoices ----
app.post(
  "/settings",
  auth,
  wrap(async (req, res) => {
    await q("UPDATE users SET payment_info=$1 WHERE id=$2", [
      (req.body.payment_info || "").slice(0, 1000),
      req.session.uid,
    ]);
    res.redirect("/dashboard");
  })
);

// ---- Dashboard ----
app.get(
  "/dashboard",
  auth,
  wrap(async (req, res) => {
    const rows = await q(
      `SELECT i.id,i.seq,i.status,i.due_date,c.name client,
    (SELECT COALESCE(SUM(ROUND(quantity*unit_cents)),0) FROM invoice_items WHERE invoice_id=i.id)::bigint total,
    (i.status='sent' AND i.due_date<CURRENT_DATE) overdue
    FROM invoices i JOIN clients c ON c.id=i.client_id WHERE i.user_id=$1 ORDER BY i.seq DESC`,
      [req.session.uid]
    );
    const sum = (f) => rows.filter(f).reduce((s, r) => s + Number(r.total), 0);
    const [{ payment_info }] = await q(
      "SELECT payment_info FROM users WHERE id=$1",
      [req.session.uid]
    );
    res.render("dashboard", {
      rows,
      payment_info,
      outstanding: sum((r) => r.status === "sent"),
      paid: sum((r) => r.status === "paid"),
      overdue: sum((r) => r.overdue),
    });
  })
);

// ---- Invoices ----
app.get("/invoices/new", auth, (req, res) =>
  res.render("new", { today: new Date().toISOString().slice(0, 10) })
);
app.post(
  "/invoices",
  auth,
  wrap(async (req, res) => {
    const b = req.body,
      uid = req.session.uid;
    const D = [].concat(b.desc || []),
      Q = [].concat(b.qty || []),
      P = [].concat(b.price || []);
    const items = D.map((d, i) => ({
      d: String(d).trim().slice(0, 300),
      q: parseFloat(Q[i]),
      c: Math.round(parseFloat(P[i]) * 100),
    })).filter((i) => i.d && i.q > 0 && i.c >= 0);
    if (!b.client_name || !b.client_email || !b.due_date || !items.length)
      return res
        .status(400)
        .render("new", {
          today: b.issue_date,
          error:
            "Client, due date and at least one valid line item are required.",
        });
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      const cl = (
        await db.query(
          `INSERT INTO clients(user_id,name,email) VALUES($1,$2,lower($3))
      ON CONFLICT(user_id,email) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
          [uid, b.client_name.trim(), b.client_email.trim()]
        )
      ).rows[0];
      const seq = (
        await db.query(
          "SELECT COALESCE(MAX(seq),0)+1 n FROM invoices WHERE user_id=$1",
          [uid]
        )
      ).rows[0].n;
      const inv = (
        await db.query(
          `INSERT INTO invoices(user_id,client_id,seq,token,due_date,notes)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
          [
            uid,
            cl.id,
            seq,
            crypto.randomBytes(16).toString("hex"),
            b.due_date,
            (b.notes || "").slice(0, 1000),
          ]
        )
      ).rows[0];
      for (const i of items)
        await db.query(
          "INSERT INTO invoice_items(invoice_id,description,quantity,unit_cents) VALUES($1,$2,$3,$4)",
          [inv.id, i.d, i.q, i.c]
        );
      await db.query("COMMIT");
      res.redirect("/invoices/" + inv.id);
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    } finally {
      db.release();
    }
  })
);
app.get(
  "/invoices/:id(\\d+)",
  auth,
  wrap(async (req, res) => {
    const inv = await load("i.id=$1 AND i.user_id=$2", [
      req.params.id,
      req.session.uid,
    ]);
    if (!inv) return res.status(404).send("Not found");
    res.render("invoice", {
      inv,
      owner: true,
      link: `${req.protocol}://${req.get("host")}/i/${inv.token}`,
    });
  })
);
app.post(
  "/invoices/:id(\\d+)/status",
  auth,
  wrap(async (req, res) => {
    if (!["sent", "paid", "void"].includes(req.body.status))
      return res.status(400).send("Bad status");
    await q(
      "UPDATE invoices SET status=$1 WHERE id=$2 AND user_id=$3 AND status<>'void'",
      [req.body.status, req.params.id, req.session.uid]
    );
    res.redirect("/invoices/" + req.params.id);
  })
);
// Public, unguessable client-facing link (drafts hidden)
app.get(
  "/i/:token([a-f0-9]{32})",
  wrap(async (req, res) => {
    const inv = await load("i.token=$1 AND i.status<>'draft'", [
      req.params.token,
    ]);
    if (!inv) return res.status(404).send("Invoice not found");
    res.render("invoice", { inv, owner: false, link: null });
  })
);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send("Something went wrong.");
});
app.listen(process.env.PORT || 3000, () => console.log("Invoicer running"));
