# Invoicer
Stack: Node.js, Express, EJS, PostgreSQL, vanilla JS/CSS.
1. `npm install`   2. `cp .env.example .env` and edit   3. `createdb invoicer && npm run db`   4. `npm start` -> http://localhost:3000
Flow: register -> set payment instructions -> create invoice (draft) -> mark as sent -> share the client link -> mark as paid.
