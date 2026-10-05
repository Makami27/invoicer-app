CREATE TABLE IF NOT EXISTS users(
  id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL, payment_info TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS clients(
  id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, email TEXT NOT NULL, UNIQUE(user_id,email));
CREATE TABLE IF NOT EXISTS invoices(
  id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id INT NOT NULL REFERENCES clients(id), seq INT NOT NULL,
  token TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN('draft','sent','paid','void')),
  issue_date DATE NOT NULL DEFAULT CURRENT_DATE, due_date DATE NOT NULL, notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(user_id,seq));
CREATE TABLE IF NOT EXISTS invoice_items(
  id SERIAL PRIMARY KEY, invoice_id INT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description TEXT NOT NULL, quantity NUMERIC(10,2) NOT NULL CHECK(quantity>0), unit_cents INT NOT NULL CHECK(unit_cents>=0));
CREATE INDEX IF NOT EXISTS invoices_user_idx ON invoices(user_id, seq DESC);
